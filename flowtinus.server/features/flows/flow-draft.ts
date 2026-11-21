import { dropDanglingEdges, folderPath, newFlowFile, repoFlowFromYaml, repoFlowToYaml, repoPath, validateFlowFile, type FlowFile, type RepoTriggers } from '@flowtinus/core';
import { loadTree } from '#features/folders/project-tree';
import { committedFlowText, flowsInRepo } from '#features/git/workspace-export';
import { ENVIRONMENT_BRANCH, fileRow, writeFile } from '#features/git/working-copy';
import { withoutPinned } from '#features/pins/pins';
import { refuseOffEditableBranch } from '#features/git/current-branch';
import type { Database } from '#shared/database/database';
import type { Flow } from './flow';

/*
 * A flow's draft: its file in the working copy of the environment's branch, else its file as committed (the version in
 * the repo), else a new flow (its Start and its End). A save names the revision it started from; when another save
 * came in between, it is refused (409) instead of overwriting it. The pinned outputs are no part of the file: they are
 * the user's (features/pins).
 */

/** conflict: with git on, the commit the draft could not be merged with (it cannot be committed until it is discarded) */
export type FlowDraft = { flow: FlowFile; revision: number; conflict?: string };

function readText(row: Flow, text: string): FlowFile | null {
    const read = repoFlowFromYaml(text, row.name);
    return read.ok ? read.value.flow : null;
}

export async function loadDraft(db: Database, workspaceId: string, row: Flow): Promise<FlowDraft> {
    const draft = await fileRow(db, workspaceId, row.id);
    let flow: FlowFile | null = draft?.content ? readText(row, draft.content) : null;
    if (!flow) {
        const [inRepo] = await flowsInRepo(db, workspaceId, [row.id]);
        const checked = inRepo ? validateFlowFile(dropDanglingEdges(inRepo.definition)) : null;
        flow = checked?.ok ? checked.value : null;
    }
    flow ??= newFlowFile(row.name, row.id);
    return {
        flow: withoutPinned({ ...flow, id: row.id, name: row.name }),
        revision: draft?.revision ?? 0,
        ...(draft?.conflict ? { conflict: draft.conflict } : {}),
    };
}

const triggersOf = (from: RepoTriggers | undefined): RepoTriggers => ({ schedules: from?.schedules ?? [], webhooks: from?.webhooks ?? [] });

async function draftAndRepo(db: Database, workspaceId: string, row: Flow) {
    const draft = await fileRow(db, workspaceId, row.id);
    const live = draft && !draft.deleted ? draft : null;
    const read = live?.content ? repoFlowFromYaml(live.content, row.name) : null;
    const [inRepo] = await flowsInRepo(db, workspaceId, [row.id]);
    return { draft, live, inDraft: read?.ok ? read.value : null, inRepo };
}

export async function draftTriggers(db: Database, workspaceId: string, row: Flow): Promise<RepoTriggers> {
    const { inDraft, inRepo } = await draftAndRepo(db, workspaceId, row);
    return triggersOf(inDraft ?? inRepo);
}

const triggersText = (triggers: Parameters<typeof repoFlowToYaml>[1]) => repoFlowToYaml(newFlowFile('', ''), triggers);

export async function draftTriggersChanged(db: Database, workspaceId: string, row: Flow): Promise<boolean> {
    const { inDraft, inRepo } = await draftAndRepo(db, workspaceId, row);
    return inDraft !== null && triggersText(inDraft) !== triggersText(triggersOf(inRepo));
}

export async function draftsTakeEnvironmentTriggers(db: Database, workspaceId: string): Promise<void> {
    const drafts = await db.query<{ path: string; file_id: string; name: string; content: string }>(
        `SELECT w.path, w.file_id, f.name, w.content FROM working_copy w JOIN flows f ON f.workspace_id = w.workspace_id AND f.id::text = w.file_id
      WHERE w.workspace_id = $1 AND w.branch = $2 AND NOT w.deleted AND w.content IS NOT NULL`,
        [workspaceId, ENVIRONMENT_BRANCH],
    );
    const inRepo = new Map(
        (
            await flowsInRepo(
                db,
                workspaceId,
                drafts.map(d => d.file_id),
            )
        ).map(f => [f.flow_id, f]),
    );
    for (const draft of drafts) {
        const read = repoFlowFromYaml(draft.content, draft.name);
        if (!read.ok) {
            continue;
        }
        const text = repoFlowToYaml(read.value.flow, { ...read.value, ...triggersOf(inRepo.get(draft.file_id)) });
        if (text !== draft.content) {
            await db.query('UPDATE working_copy SET content = $4 WHERE workspace_id = $1 AND branch = $2 AND path = $3', [
                workspaceId,
                ENVIRONMENT_BRANCH,
                draft.path,
                text,
            ]);
        }
    }
}

export async function flowRepoPath(db: Database, workspaceId: string, row: Flow): Promise<string> {
    const [[names], tree] = await Promise.all([
        db.query<{ handle: string; project: string }>(
            'SELECT w.handle, p.name AS project FROM workspaces w JOIN projects p ON p.workspace_id = w.id WHERE w.id = $1 AND p.id = $2',
            [workspaceId, row.projectId],
        ),
        loadTree(db, workspaceId, row.projectId),
    ]);
    return repoPath.flow(
        names!.handle,
        names!.project,
        folderPath(tree.folders, row.folderId).map(f => f.name),
        row.name,
    );
}

export async function writeDraft(
    db: Database,
    workspaceId: string,
    row: Flow,
    flow: FlowFile,
    userId: string | null,
    expected?: number,
    options: { asNew?: boolean; triggers?: RepoTriggers } = {},
): Promise<number | null> {
    await refuseOffEditableBranch(db, workspaceId, userId);
    await db.query('UPDATE flows SET updated_at = now(), updated_by = $3 WHERE workspace_id = $1 AND id = $2', [
        workspaceId,
        row.id,
        userId,
    ]);

    const { draft, live, inDraft, inRepo } = await draftAndRepo(db, workspaceId, row);
    const deployed = live?.content ? !/^deployed: false$/m.test(live.content) : (inRepo?.deployed ?? true);
    const triggers = options.triggers ?? (inDraft ? triggersOf(inDraft) : inRepo && !options.asNew ? triggersOf(inRepo) : {});
    const text = repoFlowToYaml({ ...flow, id: row.id, name: row.name }, { ...triggers, deployed });
    if (live) {
        const [saved] = await db.query<{ revision: number }>(
            `UPDATE working_copy SET content = $4, edited_by = $5, revision = revision + 1, updated_at = now()
           WHERE workspace_id = $1 AND branch = $2 AND path = $3 AND ($6::int IS NULL OR revision = $6) RETURNING revision`,
            [workspaceId, ENVIRONMENT_BRANCH, live.path, text, userId, expected ?? null],
        );
        return saved?.revision ?? null;
    }

    if (expected !== undefined && expected !== (draft?.revision ?? 0)) {
        return null;
    }
    return writeFile(db, workspaceId, {
        path: await flowRepoPath(db, workspaceId, row),
        content: text,
        fileId: row.id,
        userId,
        ...(inRepo && !options.asNew ? { committed: committedFlowText(row.id, inRepo) } : {}),
    });
}
