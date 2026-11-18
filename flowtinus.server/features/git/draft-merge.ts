import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoFlowFromYaml, repoFlowToYaml, validateFlowFile, type FlowFile } from '@flowtinus/core';
import { contentHash } from '#features/deployments/deployments';
import { readDraft, type StoredDraft } from '#features/flows/flow-draft';
import { FlowRepository } from '#features/folders/project-tree';
import type { Database } from '#shared/database/database';
import { pgJson } from '#shared/database/jsonb';
import { exportsOf, scriptBlobs, scriptHash } from '#features/scripts/script-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseError } from '#shared/use-cases/use-case-result';
import { flowsInRepo } from './workspace-export';

export type DraftOutcome = 'same' | 'followed' | 'merged' | 'conflict';

export type ArrivedFlow = { definition: FlowFile; hash: string };

/**
 * A draft when git changes its flow: equal to its base, it follows git; with changes of its own, it is merged three
 * ways (its base, what arrived, the draft) and its base moves on; a merge that conflicts marks it with the commit.
 * `previous`: the flow's content in git before, the base of a draft that has none.
 */
export async function draftFollowsGit(
    db: Database,
    workspaceId: string,
    flowId: string,
    arrived: ArrivedFlow,
    previous: string | null,
    commit: string,
): Promise<DraftOutcome> {
    const row = await new FlowRepository(db, workspaceId).findById(flowId);
    if (!row) {
        return 'same';
    }

    const draft = readDraft(row);
    if (contentHash(draft.flow) === arrived.hash) {
        await db.query('UPDATE flows SET draft_base = $2, draft_conflict = NULL WHERE id = $1', [flowId, arrived.hash]);
        return 'same';
    }
    if (row.draftConflict) {
        await markConflict(db, flowId, commit);
        return 'conflict';
    }

    const base = row.draftBase ?? previous;
    if (base === contentHash(draft.flow)) {
        await replaceDraft(db, flowId, { revision: draft.revision + 1, flow: arrived.definition }, row.name, arrived.hash);
        return 'followed';
    }

    const [baseVersion] = base
        ? await db.query<{ definition: FlowFile }>(
              'SELECT definition FROM flow_versions WHERE flow_id = $1 AND content_hash = $2 ORDER BY number DESC LIMIT 1',
              [flowId, base],
          )
        : [];
    const merged = baseVersion ? await mergeFlows(flowId, row.name, baseVersion.definition, arrived.definition, draft.flow) : null;
    if (!merged) {
        await markConflict(db, flowId, commit);
        return 'conflict';
    }

    await replaceDraft(db, flowId, { revision: draft.revision + 1, flow: merged }, row.name, arrived.hash);
    return 'merged';
}

/** a draft that takes git's content: no conflict, its base is what it took */
export async function replaceDraft(db: Database, flowId: string, draft: StoredDraft, name: string, base: string): Promise<void> {
    const stored: StoredDraft = { revision: draft.revision, flow: { ...draft.flow, id: flowId, name } };
    await db.query(
        'UPDATE flows SET draft_definition = $2::text::jsonb, draft_base = $3, draft_conflict = NULL, updated_at = now() WHERE id = $1',
        [flowId, pgJson(stored), base],
    );
}

const markConflict = (db: Database, flowId: string, commit: string) =>
    db.query('UPDATE flows SET draft_conflict = $2 WHERE id = $1', [flowId, commit]);

// on the flow's file in git's stable order, so that a change made on either side is the same lines on both
async function mergeFlows(id: string, name: string, base: FlowFile, theirs: FlowFile, ours: FlowFile): Promise<FlowFile | null> {
    const yaml = (flow: FlowFile) => repoFlowToYaml({ ...flow, id });
    const merged = await mergeText(yaml(ours), yaml(base), yaml(theirs));
    const read = merged === null ? null : repoFlowFromYaml(merged, name);
    const checked = read?.ok ? validateFlowFile({ ...read.value.flow, id, name }) : null;
    return checked?.ok ? checked.value : null;
}

/** git merge-file: the merged text, or null when the two changes conflict */
async function mergeText(ours: string, base: string, theirs: string): Promise<string | null> {
    const dir = await mkdtemp(join(tmpdir(), 'flowtinus-draft-merge-'));
    try {
        const files = [join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')];
        await Promise.all([ours, base, theirs].map((text, i) => Bun.write(files[i]!, text)));
        const merge = Bun.spawnSync(['git', 'merge-file', '-p', ...files], { stdout: 'pipe', stderr: 'pipe' });
        return merge.exitCode === 0 ? merge.stdout.toString() : null;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** a script's editing copy when git changes the script: as a flow's draft (see draftFollowsGit) */
export async function scriptFollowsGit(
    ctx: UseCaseContext,
    projectId: string,
    path: string,
    arrived: { text: string; hash: string },
    previous: string | null,
    commit: string,
): Promise<DraftOutcome> {
    const { db, workspaceId } = ctx;
    const where = 'workspace_id = $1 AND project_id = $2 AND path = $3';
    const [row] = await db.query<{ content: string; draft_base: string | null; draft_conflict: string | null }>(
        `SELECT content, draft_base, draft_conflict FROM scripts WHERE ${where}`,
        [workspaceId, projectId, path],
    );
    const ours = scriptHash(row!.content);
    if (ours === arrived.hash) {
        await db.query(`UPDATE scripts SET draft_base = $4, draft_conflict = NULL WHERE ${where}`, [
            workspaceId,
            projectId,
            path,
            arrived.hash,
        ]);
        return 'same';
    }
    if (row!.draft_conflict) {
        await db.query(`UPDATE scripts SET draft_conflict = $4 WHERE ${where}`, [workspaceId, projectId, path, commit]);
        return 'conflict';
    }

    const base = row!.draft_base ?? previous;
    const baseText = base === ours ? row!.content : base ? (await scriptBlobs(db, workspaceId, [base])).get(base) : undefined;
    const merged = base === ours ? arrived.text : baseText === undefined ? null : await mergeText(row!.content, baseText, arrived.text);
    if (merged === null) {
        await db.query(`UPDATE scripts SET draft_conflict = $4 WHERE ${where}`, [workspaceId, projectId, path, commit]);
        return 'conflict';
    }

    await db.query(
        `UPDATE scripts SET content = $4, exports = $5::text::jsonb, revision = revision + 1, draft_base = $6, draft_conflict = NULL,
           updated_by = $7, updated_at = now() WHERE ${where}`,
        [workspaceId, projectId, path, merged, exportsOf(merged), arrived.hash, ctx.userId],
    );
    return base === ours ? 'followed' : 'merged';
}

const conflicted = (commit: string): UseCaseError => ({
    code: 'conflict',
    message: `The draft conflicts with git's commit ${commit.slice(0, 7)}: discard it, or duplicate it as a new flow.`,
});

/** the draft a Commit takes: merged first when git changed the flow since its base, refused while it conflicts */
export async function draftToCommit(db: Database, workspaceId: string, flowId: string): Promise<FlowFile | UseCaseError> {
    const repository = new FlowRepository(db, workspaceId);
    let row = (await repository.findById(flowId))!;
    if (row.draftConflict) {
        return conflicted(row.draftConflict);
    }

    const [inRepo] = await flowsInRepo(db, workspaceId, [flowId]);
    if (inRepo && row.draftBase && row.draftBase !== inRepo.content_hash) {
        const [version] = await db.query<{ commit_sha: string | null }>(
            'SELECT commit_sha FROM flow_versions WHERE flow_id = $1 AND content_hash = $2 ORDER BY number DESC LIMIT 1',
            [flowId, inRepo.content_hash],
        );
        const commit = version?.commit_sha ?? inRepo.content_hash;
        const arrived = { definition: inRepo.definition, hash: inRepo.content_hash };
        if ((await draftFollowsGit(db, workspaceId, flowId, arrived, null, commit)) === 'conflict') {
            return conflicted(commit);
        }
        row = (await repository.findById(flowId))!;
    }

    const checked = validateFlowFile(readDraft(row).flow);
    return checked.ok ? checked.value : { code: 'validation', message: `The flow cannot be deployed: ${checked.errors.join(' ')}` };
}
