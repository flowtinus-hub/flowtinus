import { branchKind, editorOf, gitBranchNameError, refuseOffEditableBranch } from './current-branch';
import { flowCalls, flowResources, flowScriptUses, repoEntry, repoFlowFromYaml, repoFlowToYaml, scriptImports, toExecutableFlow, type RepoEntry } from '@flowtinus/core';
import { workspaceSlug } from '#features/folders/project-tree';
import { saveBlob, scriptBlobs } from '#features/scripts/script-store';
import { withUpdatedByName } from '#features/users/user-names';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { commitTree } from './git-first';
import { onClone, workBranch, type WorkBranch } from './branch-read';
import { branchIds, lockBranch, noteHead, refuseReadOnly } from './branch-write';
import { gitAuthorOf, gitBranch } from './git-config';
import { GitError } from './git-remote';
import { pendingMerge, pendingMergeRefusal } from './pending-merge';
import { lockReconcile } from './reconcile';
import { abortMerge, commitPendingMerge } from './update';
import { ENVIRONMENT_BRANCH, followGit, isChange, overlayRows, workingRows, type WorkingRow } from './working-copy';
import { committedFlowText, exportTree, flowsInRepo, type GitChanges, type RepoFiles } from './workspace-export';
import { importStructure, issueFields, readBranchWorkspace, validateImport } from './workspace-import';

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** what a change needs for the tree to stay valid when it is committed alone: another change, and why */
export type Requirement = { path: string; reason: string };

export type WorkingChange = {
    path: string;
    /** a rename: the path it had (the two files, paired by the file's id, are one change) */
    from?: string;
    change: ChangeKind;
    kind: RepoEntry['kind'];
    fileId: string | null;
    editedBy: string | null;
    editedByName?: string;
    mine: boolean;
    conflict?: string;
    requires: Requirement[];
};

/** a change with its rows: in a rename, the added row first, then the deleted one */
export type Item = WorkingChange & { rows: WorkingRow[] };

const pathsOf = (item: Pick<WorkingChange, 'path' | 'from'>) => (item.from ? [item.path, item.from] : [item.path]);

const nameOf = (path: string) => {
    const entry = repoEntry(path);
    return 'name' in entry ? entry.name : 'project' in entry ? entry.project : path;
};

function itemsOf(rows: WorkingRow[], userId: string): Item[] {
    const changed = rows.filter(isChange);
    const deletedById = new Map(changed.filter(r => r.deleted && r.file_id).map(r => [r.file_id!, r]));
    const paired = new Set<WorkingRow>();
    const items: Item[] = [];
    for (const row of changed) {
        if (paired.has(row)) {
            continue;
        }
        const was = !row.deleted && row.base === null && row.file_id ? deletedById.get(row.file_id) : undefined;
        if (was) {
            paired.add(was);
        }
        const editor = was && was.updated_at > row.updated_at ? was.edited_by : row.edited_by;
        const conflict = row.conflict ?? was?.conflict;
        items.push({
            path: row.path,
            ...(was ? { from: was.path } : {}),
            change: was ? 'renamed' : row.deleted ? 'deleted' : row.base === null ? 'added' : 'modified',
            kind: repoEntry(row.path).kind,
            fileId: row.file_id,
            editedBy: editor,
            mine: editor === userId,
            ...(conflict ? { conflict } : {}),
            requires: [],
            rows: was ? [row, was] : [row],
        });
    }
    return items.filter(item => !(item.change === 'deleted' && items.some(other => other.from === item.path)));
}

/** how many changes these rows make, as the Changes list shows them (a rename is one) */
export const changeCount = (rows: WorkingRow[]) => itemsOf(rows, '').length;

/** the working tree's scripts of a project, by path */
function projectScripts(files: RepoFiles, workspace: string, project: string): Map<string, string> {
    const scripts = new Map<string, string>();
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        if (entry.kind === 'script' && entry.workspace === workspace && entry.project === project) {
            scripts.set(entry.path, text);
        }
    }
    return scripts;
}

function addRequirements(items: Item[], files: RepoFiles): void {
    const byPath = new Map(items.flatMap(item => pathsOf(item).map(path => [path, item] as const)));
    const require = (item: Item, needed: Item | undefined, reason: string) => {
        if (needed && needed !== item && !item.requires.some(r => r.path === needed.path)) {
            item.requires.push({ path: needed.path, reason });
        }
    };

    for (const item of items) {
        for (const path of pathsOf(item)) {
            const entry = repoEntry(path);
            if (entry.kind === 'unknown' || entry.kind === 'gitattributes' || entry.kind === 'workspace' || entry.kind === 'connection') {
                continue;
            }
            const projectFile = `${entry.workspace}/projects/${entry.project}/project.yaml`;
            const project = byPath.get(projectFile);
            if (entry.kind !== 'project' && project && project.path === projectFile && project.change !== 'modified') {
                require(item, project, `${project.change === 'renamed' ? 'The renamed' : 'The new'} project ${entry.project}`);
            }
            if (entry.kind === 'project' && (item.change === 'deleted' || (item.change === 'renamed' && path === item.from))) {
                const inside = projectFile.slice(0, -'project.yaml'.length);
                for (const other of items.filter(o => o !== item && pathsOf(o).some(p => p.startsWith(inside)))) {
                    require(item, other, `It is in the project ${entry.project}`);
                }
            }
        }

        const entry = repoEntry(item.path);
        const content = item.rows[0]!.deleted ? null : item.rows[0]!.content;
        if (content === null || (entry.kind !== 'flow' && entry.kind !== 'script')) {
            continue;
        }
        const scripts = projectScripts(files, entry.workspace, entry.project);
        let wanted: string[];
        if (entry.kind === 'flow') {
            const read = repoFlowFromYaml(content, entry.name);
            if (!read.ok) {
                continue;
            }
            const flow = read.value.flow;
            for (const call of flowCalls([toExecutableFlow(flow, entry.project)])) {
                const called = items.find(o => o.fileId === call.to && o.change === 'added');
                require(item, called, `It calls the new flow ${called ? nameOf(called.path) : ''}`);
            }
            for (const id of flowResources(flow).connectionIds) {
                const connection = items.find(o => o.fileId === id && o.change === 'added');
                require(item, connection, `It uses the new connection ${connection ? nameOf(connection.path) : ''}`);
            }
            wanted = flowScriptUses([toExecutableFlow(flow, entry.project)]).map(u => u.path);
        } else {
            wanted = scriptImports(content);
        }
        const seen = new Set<string>();
        while (wanted.length > 0) {
            const path = wanted.shift()!;
            if (seen.has(path) || !scripts.has(path)) {
                continue;
            }
            seen.add(path);
            wanted.push(...scriptImports(scripts.get(path)!));
            const script = items.find(o => {
                const at = repoEntry(o.path);
                return (
                    o.change !== 'deleted' &&
                    at.kind === 'script' &&
                    at.workspace === entry.workspace &&
                    at.project === entry.project &&
                    at.path === path
                );
            });
            require(item, script, `It imports the script ${path}`);
        }
    }
}

/** the items chosen and what they need, whatever they need in turn */
function withRequirements(items: Item[], chosen: Item[]): Item[] {
    const byPath = new Map(items.map(item => [item.path, item]));
    const all = new Set(chosen);
    const queue = [...chosen];
    while (queue.length > 0) {
        for (const { path } of queue.shift()!.requires) {
            const needed = byPath.get(path);
            if (needed && !all.has(needed)) {
                all.add(needed);
                queue.push(needed);
            }
        }
    }
    return [...all];
}

/** the items chosen and those that need them */
function withDependents(items: Item[], chosen: Item[]): Item[] {
    const all = new Set(chosen);
    for (let grew = true; grew;) {
        grew = false;
        for (const item of items.filter(i => !all.has(i))) {
            if (item.requires.some(r => [...all].some(c => c.path === r.path))) {
                all.add(item);
                grew = true;
            }
        }
    }
    return [...all];
}

export async function workingItems(
    ctx: UseCaseContext,
    branch: WorkBranch | null = null,
): Promise<{ items: Item[]; files: RepoFiles; ids: Record<string, string> }> {
    const [rows, tree] = await Promise.all([
        workingRows(ctx.db, ctx.workspaceId, branch?.branch ?? ENVIRONMENT_BRANCH),
        branch ? null : exportTree(ctx.db, ctx.workspaceId),
    ]);
    const files = branch ? overlayRows(branch.tipFiles, rows) : tree!.files;
    const ids = branch ? branchIds(files, branch.slug) : tree!.ids;
    const items = itemsOf(rows, ctx.userId);
    addRequirements(items, files);
    const named = await withUpdatedByName(
        ctx.db,
        items.map(item => ({ updatedBy: item.editedBy })),
    );
    items.forEach((item, i) => {
        if (named[i]?.updatedByName) {
            item.editedByName = named[i].updatedByName;
        }
    });
    return { items, files, ids };
}

/** the uncommitted changes of the user's current branch */
export async function workingChanges(ctx: UseCaseContext): Promise<WorkingChange[]> {
    return (await workingItems(ctx, await workBranch(ctx))).items.map(({ rows: _rows, ...change }) => change);
}

export const chosenBy = (items: Item[], paths: string[]) => items.filter(item => pathsOf(item).some(path => paths.includes(path)));

export type CommitRequest = {
    paths: string[];
    message: string;
    /** a flow committed deployed (the flow's Commit button), changed or not */
    deploy?: { flowId: string };
};

/**
 * A Commit of the working copy's files chosen and what they need: the one write to git. A conflicted file refuses it.
 * The files committed stay in the working copy as committed (their revision goes on).
 */
export async function commitWorkingCopy(ctx: UseCaseContext, request: CommitRequest): Promise<UseCaseResult<string>> {
    const branch = await workBranch(ctx);
    if (branch) {
        return commitOnBranch(ctx, branch, request);
    }
    await refuseOffEditableBranch(ctx.db, ctx.workspaceId, ctx.userId);
    const committed = await commitTree(ctx, request.message, async (db, tip) => {
        const at = { ...ctx, db };
        const { items, files, ids } = await workingItems(at);
        const chosen = chosenChanges(items, request.paths);
        if ('code' in chosen) {
            return chosen;
        }
        const { changes } = chosen;
        const deployed = request.deploy && Object.keys(ids).find(path => ids[path] === request.deploy!.flowId);
        if (deployed) {
            changes[deployed] = deployedText(deployed, files[deployed]!);
        }
        for (const [path, content] of Object.entries(changes)) {
            if (content === (tip[path] ?? null)) {
                delete changes[path];
            }
        }
        await markCommitted(at, changes);
        return { changes };
    });
    if (!committed.ok) {
        return committed;
    }
    return committed.value ? success(committed.value) : fail('validation', 'Nothing to commit.');
}

/** the files chosen and what they need, as changes to commit; refused when one is conflicted */
function chosenChanges(items: Item[], paths: string[]): { changes: GitChanges } | UseCaseError {
    const chosen = withRequirements(items, chosenBy(items, paths));
    const conflicted = chosen.find(item => item.conflict);
    if (conflicted) {
        return {
            code: 'conflict',
            message: `${conflicted.path} conflicts with git's commit ${conflicted.conflict!.slice(0, 7)}: resolve or discard it first.`,
        };
    }
    const changes: GitChanges = {};
    for (const row of chosen.flatMap(item => item.rows)) {
        changes[row.path] = row.deleted ? null : (row.content ?? '');
    }
    return { changes };
}

/**
 * A Commit on a work branch: pushed on its tip as git has it now, after the whole tree is validated (an invalid one is
 * refused with its errors). Only the environment's branch is reconciled into the tables: here nothing else changes.
 */
async function commitOnBranch(ctx: UseCaseContext, branch: WorkBranch, request: CommitRequest): Promise<UseCaseResult<string>> {
    await refuseReadOnly(ctx, branch);
    if (request.deploy) {
        return fail('conflict', `A flow is deployed from the environment's branch: on ${branch.branch}, Commit its changes.`);
    }
    if (await pendingMerge(ctx.db, ctx.workspaceId, branch.branch)) {
        return commitPendingMerge(ctx, branch, request.message);
    }
    const author = await gitAuthorOf(ctx);
    return onClone(ctx, `Git could not be reached, nothing was committed`, remote =>
        ctx.db.transaction(async (db): Promise<UseCaseResult<string>> => {
            const at = { ...ctx, db };
            await lockBranch(db, ctx.workspaceId, branch.branch);
            const tip = await remote.fetch(branch.branch);
            if (!tip) {
                return fail('conflict', `The branch ${branch.branch} is not in the repository any more: nothing was committed.`);
            }
            // the branch may have moved since the last poll: its files are merged onto the tip first (a conflict stays marked)
            const tipFiles = tip === branch.tip ? branch.tipFiles : await readBranchWorkspace(remote, tip, branch.slug);
            await followGit(db, ctx.workspaceId, tipFiles, tip, branch.branch);
            if (tip !== branch.tip) {
                await noteHead(db, ctx.workspaceId, ctx.userId, branch.branch, tip);
            }
            const { items } = await workingItems(at, { ...branch, tip, tipFiles });
            const chosen = chosenChanges(items, request.paths);
            if ('code' in chosen) {
                return { ok: false, error: chosen };
            }
            const { changes } = chosen;
            for (const [path, content] of Object.entries(changes)) {
                if (content === (tipFiles[path] ?? null)) {
                    delete changes[path];
                }
            }
            if (Object.keys(changes).length === 0) {
                return fail('validation', 'Nothing to commit.');
            }

            const commit = await remote.commit({ parent: tip, changes, message: request.message, author });
            const files = await readBranchWorkspace(remote, commit, branch.slug);
            const { errors } = await validateImport(db, ctx.workspaceId, branch.slug, files);
            if (errors.length > 0) {
                return fail('validation', `The commit on ${branch.branch} would not be valid: nothing was committed.`, issueFields(errors));
            }
            try {
                await remote.push(commit, branch.branch, tip);
            } catch (e) {
                if (e instanceof GitError && (await remote.branches()).get(branch.branch) !== tip) {
                    return fail('conflict', `The branch ${branch.branch} moved during the push: nothing was committed, try again.`);
                }
                throw e;
            }
            await markCommitted(at, changes, branch.branch);
            await noteHead(db, ctx.workspaceId, ctx.userId, branch.branch, commit);
            return success(commit);
        }),
    );
}

async function markCommitted(ctx: UseCaseContext, changes: GitChanges, branch = ENVIRONMENT_BRANCH): Promise<void> {
    for (const [path, content] of Object.entries(changes)) {
        await ctx.db.query(
            `UPDATE working_copy SET base = $4, content = coalesce($5, content), conflict = NULL, updated_at = now()
           WHERE workspace_id = $1 AND branch = $2 AND path = $3`,
            [ctx.workspaceId, branch, path, content === null ? null : await saveBlob(ctx.db, ctx.workspaceId, content), content],
        );
    }
}

/**
 * Discard of these files (and of what needs them), or of all one's own: each goes back as committed; a new file goes, a
 * deleted one comes back, a rename goes back to its old path; the tables follow (a new connection keeps its
 * configuration, archived).
 */
export async function discardWorkingCopy(
    ctx: UseCaseContext,
    which: { paths: string[] } | 'mine',
): Promise<UseCaseResult<{ discarded: string[] }>> {
    const branch = await workBranch(ctx);
    if (branch) {
        await refuseReadOnly(ctx, branch, true);
    } else {
        await refuseOffEditableBranch(ctx.db, ctx.workspaceId, ctx.userId, { discard: true });
    }
    return ctx.db.transaction(async db => {
        const at = { ...ctx, db };
        if (branch) {
            await lockBranch(db, ctx.workspaceId, branch.branch);
        } else {
            await lockReconcile(db, ctx.workspaceId);
        }
        // while a merge is pending, Discard all only aborts it: one's other changes stay
        const merge = branch && which === 'mine' ? await pendingMerge(db, ctx.workspaceId, branch.branch) : null;
        if (branch && merge) {
            await abortMerge(db, at, branch, merge);
            return success({ discarded: [...merge.paths].sort() });
        }
        const { items, files } = await workingItems(at, branch);
        const chosen = withDependents(items, which === 'mine' ? items.filter(i => i.mine) : chosenBy(items, which.paths));
        if (chosen.length === 0) {
            return fail('not-found', 'No such change.');
        }
        await putBack(at, branch, chosen, files);
        return success({ discarded: chosen.map(item => item.path).sort() });
    });
}

/** these changes back as committed: the tables follow on the environment's branch (a work branch has none) */
async function putBack(ctx: UseCaseContext, branch: WorkBranch | null, chosen: Item[], files: RepoFiles): Promise<void> {
    const rows = chosen.flatMap(item => item.rows);
    const bases = await scriptBlobs(
        ctx.db,
        ctx.workspaceId,
        rows.flatMap(r => (r.base ? [r.base] : [])),
    );
    // a file in conflict goes back to what git has now, not to the base it could not be merged from
    const committed = new Map<WorkingRow, string | null>();
    for (const row of rows) {
        if (row.conflict) {
            committed.set(row, branch ? (branch.tipFiles[row.path] ?? null) : await committedText(ctx, row));
        } else {
            committed.set(row, row.base ? (bases.get(row.base) ?? '') : null);
        }
    }
    if (!branch) {
        const working = { ...files };
        for (const [row, text] of committed) {
            if (text === null) {
                delete working[row.path];
            } else {
                working[row.path] = text;
            }
        }
        await importStructure(ctx, await workspaceSlug(ctx), working, { keep: true });
    }
    for (const [row, text] of committed) {
        if (text === null) {
            // a file the branch does not have: no row (a deleted row with no base would stand for a file git never had)
            await ctx.db.query('DELETE FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND path = $3', [
                ctx.workspaceId,
                branch?.branch ?? ENVIRONMENT_BRANCH,
                row.path,
            ]);
            continue;
        }
        await ctx.db.query(
            `UPDATE working_copy SET content = $4, deleted = false, base = $5, conflict = NULL, edited_by = $6,
           revision = revision + 1, updated_at = now() WHERE workspace_id = $1 AND branch = $2 AND path = $3`,
            [
                ctx.workspaceId,
                branch?.branch ?? ENVIRONMENT_BRANCH,
                row.path,
                text,
                await saveBlob(ctx.db, ctx.workspaceId, text),
                ctx.userId,
            ],
        );
    }
}

/** a file's text as the branch has it now (a flow's version in the repo, a script in the deployed set), else its base */
async function committedText(ctx: UseCaseContext, row: WorkingRow): Promise<string | null> {
    const entry = repoEntry(row.path);
    if (entry.kind === 'flow' && row.file_id) {
        const [inRepo] = await flowsInRepo(ctx.db, ctx.workspaceId, [row.file_id]);
        if (inRepo) {
            return committedFlowText(row.file_id, inRepo);
        }
    }
    if (entry.kind === 'script' && row.file_id) {
        const at = row.file_id.indexOf('/');
        const [deployed] = await ctx.db.query<{ content: string }>(
            `SELECT b.content FROM deployed_scripts d JOIN script_blobs b ON b.workspace_id = d.workspace_id AND b.hash = d.hash
           WHERE d.workspace_id = $1 AND d.project_id = $2 AND d.path = $3`,
            [ctx.workspaceId, row.file_id.slice(0, at), row.file_id.slice(at + 1)],
        );
        if (deployed) {
            return deployed.content;
        }
    }
    return row.base ? ((await scriptBlobs(ctx.db, ctx.workspaceId, [row.base])).get(row.base) ?? null) : null;
}

/** the flow's file as the flow's Commit makes it: deployed */
export function deployedText(path: string, text: string): string {
    const entry = repoEntry(path);
    const read = entry.kind === 'flow' ? repoFlowFromYaml(text, entry.name) : null;
    return read?.ok ? repoFlowToYaml(read.value.flow) : text;
}

export type CreatedBranch = { branch: string; taken: string[] };

/**
 * A new branch, cut from the tip of the user's current branch and pushed at once; it becomes their current branch. It
 * takes the working copy along, as `git switch -c` does: from one's own branch all of it, from the environment's or a
 * shared branch only one's own changes (and what needs them); they leave the branch they were on.
 */
export async function createBranch(ctx: UseCaseContext, name: string): Promise<UseCaseResult<CreatedBranch>> {
    const git = await gitBranch(ctx.db, ctx.workspaceId);
    if (!git?.branch) {
        return fail('conflict', 'Git is off in this workspace: there are no branches.');
    }
    if (git.mode === 'protected') {
        return fail('conflict', "This server's environment is protected: no branch is created or changed from here.");
    }
    const invalid = gitBranchNameError(name);
    if (invalid) {
        return fail('validation', 'The request has invalid fields.', { name: invalid });
    }
    const editor = await editorOf(ctx.db, ctx.workspaceId, ctx.userId);
    const { kind, owner } = branchKind(name, [...editor.environments, git.branch]);
    if (kind === 'environment' || kind === 'app') {
        return fail('validation', 'The request has invalid fields.', {
            name: kind === 'environment' ? "That is an environment's branch." : 'That name is kept for the branches the app makes.',
        });
    }
    if (kind === 'user' && owner !== editor.handle) {
        return fail('validation', 'The request has invalid fields.', {
            name: `users/${owner}/… is ${owner}'s: name yours users/${editor.handle}/…`,
        });
    }
    const [held] = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM working_copy WHERE workspace_id = $1 AND branch = $2',
        [ctx.workspaceId, name],
    );
    if (held!.n > 0) {
        return fail('conflict', `This server still has changes on a branch ${name}: pick another name.`);
    }

    const source = await workBranch(ctx);
    const merging = source && (await pendingMerge(ctx.db, ctx.workspaceId, source.branch));
    if (merging) {
        return fail('conflict', pendingMergeRefusal(merging));
    }
    const from = source?.branch ?? git.branch;
    return onClone(ctx, `Git could not be reached, no branch was created`, async remote => {
        const branches = await remote.branches();
        if ([...branches.keys()].some(b => b.toLowerCase() === name.toLowerCase())) {
            return fail('conflict', `The branch ${name} already exists.`, { name: 'Already exists' });
        }
        // a branch removed on the remote is cut from its last tip, which this server still has
        const tip = source?.removed ? source.tip : await remote.fetch(from, branches);
        if (!tip) {
            return fail('conflict', `The branch ${from} is not in the repository any more.`);
        }
        await remote.push(tip, name, null);
        const tipFiles =
            tip === source?.tip ? source.tipFiles : await readBranchWorkspace(remote, tip, source?.slug ?? (await workspaceSlug(ctx)));

        return ctx.db.transaction(async db => {
            const at = { ...ctx, db };
            if (source) {
                await lockBranch(db, ctx.workspaceId, source.branch);
            } else {
                await lockReconcile(db, ctx.workspaceId);
            }
            const { items, files } = await workingItems(at, source);
            const own = source !== null && branchKind(source.branch, editor.environments).owner === editor.handle;
            const taken = own
                ? items
                : withDependents(
                      items,
                      items.filter(i => i.mine),
                  );
            const paths = taken.flatMap(item => item.rows.map(r => r.path));
            await db.query(
                `INSERT INTO working_copy (workspace_id, branch, path, content, deleted, file_id, base, edited_by, conflict, revision, updated_at)
               SELECT workspace_id, $3, path, content, deleted, file_id, base, edited_by, conflict, revision, updated_at
                 FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND path = ANY($4::text[])`,
                [ctx.workspaceId, source?.branch ?? ENVIRONMENT_BRANCH, name, paths],
            );
            if (source) {
                await db.query('DELETE FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND path = ANY($3::text[])', [
                    ctx.workspaceId,
                    source.branch,
                    paths,
                ]);
            } else if (taken.length > 0) {
                await putBack(at, null, taken, files);
            }
            // the changes' bases are what their branch held when they were made: onto the tip the new branch starts from
            await followGit(db, ctx.workspaceId, tipFiles, tip, name);
            await noteHead(db, ctx.workspaceId, ctx.userId, name, tip);
            await db.query(
                `INSERT INTO user_branches (workspace_id, user_id, branch) VALUES ($1, $2, $3)
                 ON CONFLICT (workspace_id, user_id) DO UPDATE SET branch = EXCLUDED.branch, updated_at = now()`,
                [ctx.workspaceId, ctx.userId, name],
            );
            return success({ branch: name, taken: taken.map(item => item.path).sort() });
        });
    });
}
