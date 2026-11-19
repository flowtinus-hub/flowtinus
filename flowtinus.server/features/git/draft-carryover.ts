import { dropDanglingEdges, repoFlowToYaml, repoPath, validateFlowFile, type FlowFile } from '@flowtinus/core';
import { flowRepoPath } from '#features/flows/flow-draft';
import { FlowRepository } from '#features/folders/project-tree';
import type { Database } from '#shared/database/database';
import { ENVIRONMENT_BRANCH, scriptFileId, writeFile } from './working-copy';
import { committedFlowText, flowsInRepo } from './workspace-export';

const CARRYOVER_LOCK = 4_771_191;

type Carried = { workspace_id: string; flow_id: string; draft: { revision?: number; flow?: FlowFile } | null; updated_by: string | null };

// runs once: the two carryover tables are dropped at the end, and their absence is the marker
export async function carryOverDrafts(db: Database): Promise<void> {
    await db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [CARRYOVER_LOCK]);
        const [left] = await tx.query<{ drafts: string | null; scripts: string | null }>(
            "SELECT to_regclass('draft_carryover')::text AS drafts, to_regclass('scripts_carryover')::text AS scripts",
        );
        if (left?.drafts) {
            for (const carried of await tx.query<Carried>('SELECT workspace_id, flow_id, draft, updated_by FROM draft_carryover')) {
                await carryDraft(tx, carried);
            }
            await tx.query('DROP TABLE draft_carryover');
        }
        if (left?.scripts) {
            await carryScripts(tx);
            await tx.query('DROP TABLE scripts_carryover');
        }
    });
}

async function carryDraft(db: Database, carried: Carried): Promise<void> {
    const [row] = await new FlowRepository(db, carried.workspace_id).findAll().then(rows => rows.filter(r => r.id === carried.flow_id));
    const checked = carried.draft?.flow ? validateFlowFile(dropDanglingEdges(carried.draft.flow)) : null;
    if (!row || row.removedAt || !checked?.ok) {
        return;
    }

    const flow = checked.value;
    const [inRepo] = await flowsInRepo(db, carried.workspace_id, [row.id]);
    const text = repoFlowToYaml({ ...flow, id: row.id, name: row.name }, { deployed: inRepo?.deployed ?? true });
    const committed = inRepo ? committedFlowText(row.id, inRepo) : undefined;
    if (text === committed) {
        return;
    }

    const path = await flowRepoPath(db, carried.workspace_id, row);
    const [taken] = await db.query<{ file_id: string | null }>(
        'SELECT file_id FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND path = $3',
        [carried.workspace_id, ENVIRONMENT_BRANCH, path],
    );
    if (taken && taken.file_id !== row.id) {
        return;
    }
    const revision = typeof carried.draft?.revision === 'number' ? carried.draft.revision : 0;
    if (row.deletedAt && !taken) {
        await db.query(
            `INSERT INTO working_copy (workspace_id, branch, path, content, deleted, file_id, edited_by, revision)
           VALUES ($1, $2, $3, $4, true, $5, $6, $7)`,
            [carried.workspace_id, ENVIRONMENT_BRANCH, path, text, row.id, carried.updated_by, revision],
        );
        return;
    }
    await writeFile(db, carried.workspace_id, {
        path,
        content: text,
        fileId: row.id,
        userId: carried.updated_by,
        revision,
        ...(committed === undefined ? {} : { committed }),
    });
}

async function carryScripts(db: Database): Promise<void> {
    const scripts = await db.query<{
        workspace_id: string;
        project_id: string;
        path: string;
        content: string;
        revision: number;
        updated_by: string | null;
        slug: string;
        project: string;
        committed: string | null;
    }>(
        `SELECT s.workspace_id, s.project_id, s.path, s.content, s.revision, s.updated_by, w.slug, p.name AS project, b.content AS committed
       FROM scripts_carryover s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN deployed_scripts d ON d.project_id = s.project_id AND d.path = s.path
       LEFT JOIN script_blobs b ON b.workspace_id = d.workspace_id AND b.hash = d.hash`,
    );
    for (const script of scripts.filter(s => s.content !== s.committed)) {
        await writeFile(db, script.workspace_id, {
            path: repoPath.script(script.slug, script.project, script.path),
            content: script.content,
            fileId: scriptFileId(script.project_id, script.path),
            userId: script.updated_by,
            revision: script.revision,
            ...(script.committed === null ? {} : { committed: script.committed }),
        });
    }
}
