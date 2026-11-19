import { projectFromYaml, repoEntry } from '@flowtinus/core';
import { readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { forgetWorkBranch, type WorkBranch } from './branch-read';
import { editorOf, readOnlyBranch } from './current-branch';
import { gitBranch, HEADS_SETTING } from './git-config';
import type { Heads } from './git-heads';
import type { RepoFiles } from './workspace-export';
import { idOfFile, overlayRows, recordChanges, scriptFileId, workingRows, writeFile } from './working-copy';

/*
 * Edits on a work branch: nothing of it is in the tables, so a change is made to its files (the tip with its working
 * copy over it) and every file that differs is recorded in the branch's working copy, as changeTree does for the
 * environment's branch.
 */

/** `discarding`: a removed branch's changes may still be discarded by whoever may change it */
export async function refuseReadOnly(ctx: UseCaseContext, branch: WorkBranch, discarding = false): Promise<void> {
    if (branch.removed && branch.mayChange && !discarding) {
        throw new UseCaseFailure(
            'conflict',
            `The branch ${branch.branch} was removed on the remote: create a branch with its changes, or discard them.`,
        );
    }
    if (!branch.editable && !(discarding && branch.removed && branch.mayChange)) {
        const [editor, git] = await Promise.all([editorOf(ctx.db, ctx.workspaceId, ctx.userId), gitBranch(ctx.db, ctx.workspaceId)]);
        throw new UseCaseFailure('conflict', readOnlyBranch(branch.branch, editor, git?.branch ?? null));
    }
}

export const lockBranch = (db: Database, workspaceId: string, branch: string) =>
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`working-copy:${workspaceId}:${branch}`]);

/** by path, the id of what each file holds (a flow's, a project's, a connection's; a script's scriptFileId) */
export function branchIds(files: RepoFiles, slug: string): Record<string, string> {
    const projects = new Map<string, string>();
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        if (entry.kind === 'project' && entry.workspace === slug) {
            const read = projectFromYaml(text);
            if (read.ok) {
                projects.set(entry.project, read.value.id);
            }
        }
    }
    const ids: Record<string, string> = {};
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        const id =
            entry.kind === 'script'
                ? projects.has(entry.project)
                    ? scriptFileId(projects.get(entry.project)!, entry.path)
                    : null
                : idOfFile(path, text);
        if (id) {
            ids[path] = id;
        }
    }
    return ids;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

const isKeep = (path: string) => path.endsWith('/.gitkeep');

/**
 * Folders as the export makes them: a folder of flows emptied by the change keeps a .gitkeep, and a .gitkeep goes
 * once something else is in its folder.
 */
function tidyKeeps(before: RepoFiles, after: RepoFiles, gone: string[]): RepoFiles {
    const files = { ...after };
    const flowDirs = new Set<string>();
    for (const path of Object.keys(before)) {
        const entry = repoEntry(path);
        if ((entry.kind === 'flow' || entry.kind === 'folder') && entry.folders.length > 0) {
            const root = `${entry.workspace}/projects/${entry.project}/flows/`;
            for (let i = 1; i <= entry.folders.length; i++) {
                flowDirs.add(`${root}${entry.folders.slice(0, i).join('/')}/`);
            }
        }
    }
    const paths = () => Object.keys(files);
    for (const dir of [...flowDirs].filter(dir => !gone.some(prefix => dir.startsWith(prefix)))) {
        const project = dir.slice(0, dir.indexOf('/flows/'));
        if (`${project}/project.yaml` in files && !paths().some(path => path.startsWith(dir))) {
            files[`${dir}.gitkeep`] = '';
        }
    }
    for (const keep of paths().filter(isKeep)) {
        const dir = dirOf(keep);
        if (paths().some(path => path !== keep && path.startsWith(dir))) {
            delete files[keep];
        }
    }
    return files;
}

/**
 * A change of a work branch's files (`change` answers them changed), recorded in its working copy. `gone`: folders
 * (paths ending in /) that left with the change (archived, renamed, moved), so no .gitkeep keeps them; `also`: more
 * work in the same transaction (a connection's configuration, kept in the environment); `archives`: the change archives
 * folders, whose deleted .gitkeeps keep their text for the branch's archive to find (any other change forgets it: a
 * folder renamed, moved or filled is not archived).
 */
export async function changeBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    change: (files: RepoFiles) => RepoFiles,
    { gone = [], also, archives = false }: { gone?: string[]; also?: (db: Database) => Promise<void>; archives?: boolean } = {},
): Promise<void> {
    await refuseReadOnly(ctx, branch);
    await ctx.db.transaction(async db => {
        await lockBranch(db, ctx.workspaceId, branch.branch);
        await also?.(db);
        const before = overlayRows(branch.tipFiles, await workingRows(db, ctx.workspaceId, branch.branch));
        const after = tidyKeeps(before, change({ ...before }), gone);
        await recordChanges(
            db,
            ctx.workspaceId,
            { files: before, ids: branchIds(before, branch.slug) },
            { files: after, ids: branchIds(after, branch.slug) },
            ctx.userId,
            branch.branch,
        );
        const keeps = Object.keys(before).filter(path => isKeep(path) && !(path in after));
        if (!archives && keeps.length > 0) {
            await db.query(
                'UPDATE working_copy SET content = NULL WHERE workspace_id = $1 AND branch = $2 AND deleted AND path = ANY($3::text[])',
                [ctx.workspaceId, branch.branch, keeps],
            );
        }
    });
    forgetWorkBranch(ctx);
}

/**
 * A file's new text on a work branch (a draft's, a script's), if it is still at `expected`: answers its new revision,
 * or null when another save came in between.
 */
export async function saveBranchFile(
    ctx: UseCaseContext,
    branch: WorkBranch,
    file: { path: string; content: string; fileId: string; expected: number },
): Promise<number | null> {
    await refuseReadOnly(ctx, branch);
    forgetWorkBranch(ctx);
    return ctx.db.transaction(async db => {
        await lockBranch(db, ctx.workspaceId, branch.branch);
        const row = (await workingRows(db, ctx.workspaceId, branch.branch)).find(r => r.path === file.path);
        if (row && !row.deleted) {
            const [saved] = await db.query<{ revision: number }>(
                `UPDATE working_copy SET content = $4, edited_by = $5, revision = revision + 1, updated_at = now()
               WHERE workspace_id = $1 AND branch = $2 AND path = $3 AND revision = $6 RETURNING revision`,
                [ctx.workspaceId, branch.branch, file.path, file.content, ctx.userId, file.expected],
            );
            return saved?.revision ?? null;
        }
        if (file.expected !== (row?.revision ?? 0)) {
            return null;
        }
        const committed = branch.tipFiles[file.path];
        return writeFile(
            db,
            ctx.workspaceId,
            {
                path: file.path,
                content: file.content,
                fileId: file.fileId,
                userId: ctx.userId,
                ...(committed === undefined ? {} : { committed }),
            },
            branch.branch,
        );
    });
}

/** a head this server pushed, known at once (the next poll would find it too) */
export async function noteHead(db: Database, workspaceId: string, userId: string, name: string, sha: string): Promise<void> {
    const heads = (await readWorkspaceSetting(db, workspaceId, HEADS_SETTING)) as Heads | null;
    if (!heads) {
        return;
    }
    const others = heads.heads.filter(h => h.name !== name);
    const list = [...others, { name, sha, merged: false }].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    await writeWorkspaceSetting(db, workspaceId, HEADS_SETTING, { ...heads, heads: list }, userId);
}
