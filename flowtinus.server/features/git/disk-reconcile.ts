import { HANDLE, type TreeIssue } from '@flowtinus/core';
import { readRepository, type Repository } from '@flowtinus/core/disk';
import { workspaceHandleIn } from '#features/workspaces/workspace';
import { readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { caseOnlyRenames } from './case-renames';
import { DISK_SETTING } from './git-config';
import { localRepoOf } from './local-server';
import { lockReconcile } from './reconcile';
import type { RepoFiles } from './workspace-export';
import { importWorkspace, validateImport } from './workspace-import';

// tree: the hash of the workspace's files, what keeps an unchanged invalid tree from being validated again (no sha here)
export type DiskState = {
    applied: { tree: string; at: string } | null;
    refused: { tree: string; errors: TreeIssue[]; since: string } | null;
    warnings: TreeIssue[];
    caseRenames: TreeIssue[];
    gone: string | null;
};

export type DiskOutcome = 'applied' | 'up-to-date' | 'refused';

export type DiskReconcile = { outcome: DiskOutcome; errors: TreeIssue[]; warnings: TreeIssue[] };

export const DISK_USER = 'disk';

const EMPTY: DiskState = { applied: null, refused: null, warnings: [], caseRenames: [], gone: null };

export const readDiskState = async (db: Database, workspaceId: string) =>
    (await readWorkspaceSetting(db, workspaceId, DISK_SETTING)) as DiskState | null;

const writeDiskState = (db: Database, workspaceId: string, state: DiskState) =>
    writeWorkspaceSetting(db, workspaceId, DISK_SETTING, state, DISK_USER);

const inWorkspace = (files: RepoFiles, handle: string) =>
    Object.keys(files)
        .filter(path => path === '.gitattributes' || path.startsWith(`${handle}/`))
        .sort();

function treeHash(files: RepoFiles, handle: string): string {
    const hash = new Bun.CryptoHasher('sha256');
    for (const path of inWorkspace(files, handle)) {
        hash.update(`${path}\0${files[path]}\0`);
    }
    return hash.digest('hex');
}

export async function reconcileDiskWorkspace(ctx: UseCaseContext, files: RepoFiles, root: string): Promise<DiskReconcile> {
    const handle = await workspaceHandleIn(ctx.db, ctx.workspaceId);
    const tree = treeHash(files, handle);
    const caseRenames = caseOnlyRenames(root, inWorkspace(files, handle));
    return ctx.db.transaction(async db => {
        const tx = { ...ctx, db, userId: DISK_USER };
        await lockReconcile(db, ctx.workspaceId);
        const stored = await readDiskState(db, ctx.workspaceId);
        const state = { ...EMPTY, ...stored, caseRenames, gone: null };
        const renamesChanged = JSON.stringify(stored?.caseRenames ?? []) !== JSON.stringify(caseRenames);
        if (state.applied?.tree === tree) {
            if (stored?.refused || stored?.gone || renamesChanged) {
                await writeDiskState(db, ctx.workspaceId, { ...state, refused: null });
            }
            return { outcome: 'up-to-date', errors: [], warnings: [...state.warnings, ...caseRenames] };
        }
        if (state.refused?.tree === tree) {
            if (stored?.gone || renamesChanged) {
                await writeDiskState(db, ctx.workspaceId, state);
            }
            return { outcome: 'refused', errors: state.refused.errors, warnings: [] };
        }

        const validation = await validateImport(db, ctx.workspaceId, handle, files);
        const now = new Date().toISOString();
        if (validation.errors.length > 0) {
            const refused = { tree, errors: validation.errors, since: state.refused?.since ?? now };
            await writeDiskState(db, ctx.workspaceId, { ...state, refused });
            return { outcome: 'refused', errors: validation.errors, warnings: [] };
        }

        await importWorkspace(tx, handle, files, { from: 'disk' });
        await writeDiskState(db, ctx.workspaceId, {
            applied: { tree, at: now },
            refused: null,
            warnings: validation.warnings,
            caseRenames,
            gone: null,
        });
        return { outcome: 'applied', errors: [], warnings: [...validation.warnings, ...caseRenames] };
    });
}

export async function reconcileFromDisk(ctx: UseCaseContext): Promise<UseCaseResult<DiskReconcile>> {
    const root = localRepoOf(ctx.git);
    if (!root) {
        return fail('conflict', 'This is no local server: there is no disk to reconcile.');
    }
    const repository = readRepository(root);
    const handle = await workspaceHandleIn(ctx.db, ctx.workspaceId);
    if (!repository.workspaces.includes(handle)) {
        return fail('conflict', `The folder ${handle} of this workspace is no longer on the disk.`);
    }
    return success(await reconcileDiskWorkspace(ctx, repository.files, repository.root));
}

export const diskRefusal = (errors: TreeIssue[]) =>
    `The disk is not valid, so it cannot run as it is: ${errors.map(e => `${e.path}: ${e.message}`).join(' ')}`;

export type DiskWorkspaceReconcile = { handle: string; workspaceId?: string } & (DiskReconcile | { outcome: 'not-a-handle' | 'gone' });

async function diskWorkspace(db: Database, handle: string): Promise<string> {
    const [existing] = await db.query<{ id: string }>('SELECT id FROM workspaces WHERE handle = $1', [handle]);
    if (existing) {
        return existing.id;
    }

    const id = crypto.randomUUID();
    await db.transaction(async tx => {
        await tx.query('INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $2)', [id, handle]);
        // the server's admins (on a local server, the one it seeds) are its admins
        await tx.query(`INSERT INTO workspace_members (workspace_id, user_id, role) SELECT $1, id, 'admin' FROM users WHERE is_admin`, [
            id,
        ]);
        await writeDiskState(tx, id, EMPTY);
    });
    return id;
}

export async function reconcileDisk(
    base: Omit<UseCaseContext, 'workspaceId' | 'userId'>,
    root: string,
    repository: Repository = readRepository(root),
): Promise<DiskWorkspaceReconcile[]> {
    const results: DiskWorkspaceReconcile[] = [];
    const seen = new Set<string>();
    for (const handle of repository.workspaces) {
        if (!HANDLE.test(handle)) {
            results.push({ handle, outcome: 'not-a-handle' });
            continue;
        }
        const workspaceId = await diskWorkspace(base.db, handle);
        seen.add(workspaceId);
        results.push({
            handle,
            workspaceId,
            ...(await reconcileDiskWorkspace({ ...base, workspaceId, userId: DISK_USER }, repository.files, repository.root)),
        });
    }

    const known = await base.db.query<{ workspace_id: string; handle: string; value: DiskState }>(
        `SELECT s.workspace_id, w.handle, s.value FROM workspace_settings s JOIN workspaces w ON w.id = s.workspace_id WHERE s.key = $1`,
        [DISK_SETTING],
    );
    for (const { workspace_id: workspaceId, handle, value } of known.filter(k => !seen.has(k.workspace_id))) {
        if (!value.gone) {
            await writeDiskState(base.db, workspaceId, { ...EMPTY, ...value, gone: new Date().toISOString() });
        }
        results.push({ handle, workspaceId, outcome: 'gone' });
    }
    return results;
}
