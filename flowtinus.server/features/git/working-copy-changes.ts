import { flowCalls, flowResources, flowScriptUses, repoEntry, repoFlowFromYaml, repoFlowToYaml, scriptImports, toExecutableFlow, type RepoEntry } from '@flowtinus/core';
import { workspaceSlug } from '#features/folders/project-tree';
import { saveBlob, scriptBlobs } from '#features/scripts/script-store';
import { withUpdatedByName } from '#features/users/user-names';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { commitTree } from './git-first';
import { lockReconcile } from './reconcile';
import { ENVIRONMENT_BRANCH, isChange, workingRows, type WorkingRow } from './working-copy';
import { committedFlowText, exportTree, flowsInRepo, type GitChanges, type RepoFiles } from './workspace-export';
import { importStructure } from './workspace-import';

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

type Item = WorkingChange & { rows: WorkingRow[] };

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

async function workingItems(ctx: UseCaseContext): Promise<{ items: Item[]; files: RepoFiles; ids: Record<string, string> }> {
    const [rows, tree] = await Promise.all([workingRows(ctx.db, ctx.workspaceId), exportTree(ctx.db, ctx.workspaceId)]);
    const items = itemsOf(rows, ctx.userId);
    addRequirements(items, tree.files);
    const named = await withUpdatedByName(
        ctx.db,
        items.map(item => ({ updatedBy: item.editedBy })),
    );
    items.forEach((item, i) => {
        if (named[i]?.updatedByName) {
            item.editedByName = named[i].updatedByName;
        }
    });
    return { items, files: tree.files, ids: tree.ids };
}

export async function workingChanges(ctx: UseCaseContext): Promise<WorkingChange[]> {
    return (await workingItems(ctx)).items.map(({ rows: _rows, ...change }) => change);
}

const chosenBy = (items: Item[], paths: string[]) => items.filter(item => pathsOf(item).some(path => paths.includes(path)));

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
    const committed = await commitTree(ctx, request.message, async (db, tip) => {
        const at = { ...ctx, db };
        const { items, files, ids } = await workingItems(at);
        const chosen = withRequirements(items, chosenBy(items, request.paths));
        const conflicted = chosen.find(item => item.conflict);
        if (conflicted) {
            return {
                code: 'conflict',
                message: `${conflicted.path} conflicts with git's commit ${conflicted.conflict!.slice(0, 7)}: resolve or discard it first.`,
            } satisfies UseCaseError;
        }

        const changes: GitChanges = {};
        for (const row of chosen.flatMap(item => item.rows)) {
            changes[row.path] = row.deleted ? null : (row.content ?? '');
        }
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

async function markCommitted(ctx: UseCaseContext, changes: GitChanges): Promise<void> {
    for (const [path, content] of Object.entries(changes)) {
        await ctx.db.query(
            `UPDATE working_copy SET base = $4, content = coalesce($5, content), conflict = NULL, updated_at = now()
           WHERE workspace_id = $1 AND branch = $2 AND path = $3`,
            [
                ctx.workspaceId,
                ENVIRONMENT_BRANCH,
                path,
                content === null ? null : await saveBlob(ctx.db, ctx.workspaceId, content),
                content,
            ],
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
    return ctx.db.transaction(async db => {
        const at = { ...ctx, db };
        await lockReconcile(db, ctx.workspaceId);
        const { items, files } = await workingItems(at);
        const chosen = withDependents(items, which === 'mine' ? items.filter(i => i.mine) : chosenBy(items, which.paths));
        if (chosen.length === 0) {
            return fail('not-found', 'No such change.');
        }
        const rows = chosen.flatMap(item => item.rows);
        const bases = await scriptBlobs(
            db,
            ctx.workspaceId,
            rows.flatMap(r => (r.base ? [r.base] : [])),
        );
        // a file in conflict goes back to what git has now, not to the base it could not be merged from
        const committed = new Map<WorkingRow, string | null>();
        for (const row of rows) {
            committed.set(row, row.conflict ? await committedText(at, row) : row.base ? (bases.get(row.base) ?? '') : null);
        }
        const working = { ...files };
        for (const [row, text] of committed) {
            if (text === null) {
                delete working[row.path];
            } else {
                working[row.path] = text;
            }
        }
        await importStructure(at, await workspaceSlug(at), working, { keep: true });
        for (const [row, text] of committed) {
            await db.query(
                `UPDATE working_copy SET content = coalesce($4, content), deleted = $5, base = $6, conflict = NULL, edited_by = $7,
               revision = revision + 1, updated_at = now() WHERE workspace_id = $1 AND branch = $2 AND path = $3`,
                [
                    ctx.workspaceId,
                    ENVIRONMENT_BRANCH,
                    row.path,
                    text,
                    text === null,
                    text === null ? null : await saveBlob(db, ctx.workspaceId, text),
                    ctx.userId,
                ],
            );
        }
        return success({ discarded: chosen.map(item => item.path).sort() });
    });
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
