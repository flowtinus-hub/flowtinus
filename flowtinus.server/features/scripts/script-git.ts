import { z } from 'zod';
import { flowWithScriptsMoved, movedScriptImports, normalizeScriptPath, scriptCodeOf, scriptImports, type FlowFile } from '@flowtinus/core';
import { readDraft, type StoredDraft } from '#features/flows/flow-draft';
import { FlowRepository, requireActiveProject } from '#features/folders/project-tree';
import { flows as flowsTable } from '#features/flows/flow';
import { isGitOn } from '#features/git/git-config';
import { commitTree } from '#features/git/git-first';
import { flowsInRepo, scriptKey, type TreeOverrides } from '#features/git/workspace-export';
import type { Database } from '#shared/database/database';
import { pgJson } from '#shared/database/jsonb';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { and, eq, isNull } from 'drizzle-orm';
import { exportsOf, scriptHash } from './script-store';

export type ScriptState = { changed: boolean; conflict?: string };

/** with git on, each editing copy against the script as committed: changed (or never committed), in conflict */
export async function scriptStates(db: Database, workspaceId: string, projectId: string): Promise<Map<string, ScriptState> | null> {
    if (!(await isGitOn(db, workspaceId))) {
        return null;
    }
    const rows = await db.query<{ path: string; content: string; draft_conflict: string | null; hash: string | null }>(
        `SELECT s.path, s.content, s.draft_conflict, d.hash FROM scripts s
       LEFT JOIN deployed_scripts d ON d.project_id = s.project_id AND d.path = s.path
       WHERE s.workspace_id = $1 AND s.project_id = $2`,
        [workspaceId, projectId],
    );
    return new Map(
        rows.map(r => [r.path, { changed: r.hash !== scriptHash(r.content), ...(r.draft_conflict ? { conflict: r.draft_conflict } : {}) }]),
    );
}

/** the changed scripts a flow imports, directly or through another script (editing copies) */
export async function changedImports(db: Database, workspaceId: string, projectId: string, flow: FlowFile): Promise<string[]> {
    const states = await scriptStates(db, workspaceId, projectId);
    if (!states) {
        return [];
    }
    const contents = new Map(
        (
            await db.query<{ path: string; content: string }>(
                'SELECT path, content FROM scripts WHERE workspace_id = $1 AND project_id = $2',
                [workspaceId, projectId],
            )
        ).map(s => [s.path, s.content]),
    );
    const seen = new Set<string>();
    const queue = flow.nodes.flatMap(n => scriptImports(scriptCodeOf(n.type, n.config) ?? ''));
    while (queue.length > 0) {
        const path = queue.shift()!;
        if (!seen.has(path) && contents.has(path)) {
            seen.add(path);
            queue.push(...scriptImports(contents.get(path)!));
        }
    }
    return [...seen].filter(path => states.get(path)?.changed).sort();
}

/** the editing copies of these scripts, to commit; refused for one that is missing or in conflict */
export async function scriptsToCommit(
    db: Database,
    workspaceId: string,
    projectId: string,
    paths: string[],
): Promise<Map<string, string> | UseCaseError> {
    const scripts = new Map<string, string>();
    for (const path of paths) {
        const [row] = await db.query<{ content: string; draft_conflict: string | null }>(
            'SELECT content, draft_conflict FROM scripts WHERE workspace_id = $1 AND project_id = $2 AND path = $3',
            [workspaceId, projectId, path],
        );
        if (!row) {
            return { code: 'not-found', message: `The script ${path} does not exist.` };
        }
        if (row.draft_conflict) {
            return {
                code: 'conflict',
                message: `The script ${path} conflicts with git's commit ${row.draft_conflict.slice(0, 7)}: discard its changes first.`,
            };
        }
        scripts.set(scriptKey(projectId, path), row.content);
    }
    return scripts;
}

/**
 * A script (or a folder) moved: the scripts that import it and the flows' drafts are rewritten; with git on, the
 * files of the flows that call it and the scripts that import it, as committed, are rewritten too (the overrides of
 * the commit). After moveScriptPath.
 */
export async function rewriteMovedScript(ctx: UseCaseContext, projectId: string, from: string, to: string): Promise<TreeOverrides> {
    const { db, workspaceId } = ctx;
    for (const script of await db.query<{ path: string; content: string }>(
        'SELECT path, content FROM scripts WHERE workspace_id = $1 AND project_id = $2',
        [workspaceId, projectId],
    )) {
        const content = movedScriptImports(script.content, from, to);
        if (content !== script.content) {
            await db.query(
                `UPDATE scripts SET content = $4, exports = $5::text::jsonb, revision = revision + 1, updated_by = $6, updated_at = now()
         WHERE workspace_id = $1 AND project_id = $2 AND path = $3`,
                [workspaceId, projectId, script.path, content, exportsOf(content), ctx.userId],
            );
        }
    }

    const live = await new FlowRepository(db, workspaceId).findMany(and(eq(flowsTable.projectId, projectId), isNull(flowsTable.deletedAt)));
    for (const flow of live) {
        const draft = readDraft(flow);
        const moved = flowWithScriptsMoved(draft.flow, from, to);
        if (moved) {
            const stored: StoredDraft = { revision: draft.revision + 1, flow: moved };
            await db.query('UPDATE flows SET draft_definition = $2::text::jsonb, updated_at = now() WHERE id = $1', [
                flow.id,
                pgJson(stored),
            ]);
        }
    }

    const flows = new Map<string, { definition: FlowFile; deployed: boolean }>();
    for (const inRepo of await flowsInRepo(
        db,
        workspaceId,
        live.map(f => f.id),
    )) {
        const moved = flowWithScriptsMoved(inRepo.definition, from, to);
        if (moved) {
            flows.set(inRepo.flow_id, { definition: moved, deployed: inRepo.deployed });
        }
    }
    const scripts = new Map<string, string>();
    for (const committed of await db.query<{ path: string; content: string }>(
        `SELECT d.path, b.content FROM deployed_scripts d JOIN script_blobs b ON b.workspace_id = d.workspace_id AND b.hash = d.hash
       WHERE d.workspace_id = $1 AND d.project_id = $2`,
        [workspaceId, projectId],
    )) {
        const content = movedScriptImports(committed.content, from, to);
        if (content !== committed.content) {
            scripts.set(scriptKey(projectId, committed.path), content);
        }
    }
    return { flows, scripts };
}

const projectId = z.uuid('Invalid');

export class CommitScriptsHandler implements UseCaseHandler<{ commit: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ commit: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(
            z.object({
                projectId,
                paths: z.array(z.string().transform(normalizeScriptPath)).min(1),
                message: z.string().trim().min(1).max(1000).optional(),
            }),
            input,
        );
        if (!parsed.ok) {
            return parsed;
        }

        const { projectId: id, paths, message } = parsed.value;
        const missing = await requireActiveProject(ctx, id);
        if (missing && !missing.ok) {
            return missing;
        }

        const committed = await commitTree(ctx, message ?? `Update ${paths.join(', ')}`, async db => {
            const scripts = await scriptsToCommit(db, ctx.workspaceId, id, paths);
            return scripts instanceof Map ? { scripts } : scripts;
        });
        if (!committed.ok) {
            return committed;
        }
        return committed.value
            ? success({ commit: committed.value })
            : fail('validation', 'Nothing to commit: the scripts are as committed.');
    }
}

export class DiscardScriptHandler implements UseCaseHandler<{ revision: number }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ revision: number }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(z.object({ projectId, path: z.string().transform(normalizeScriptPath) }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const { projectId: id, path } = parsed.value;
        const [committed] = await ctx.db.query<{ hash: string; content: string }>(
            `SELECT d.hash, b.content FROM deployed_scripts d JOIN script_blobs b ON b.workspace_id = d.workspace_id AND b.hash = d.hash
       WHERE d.workspace_id = $1 AND d.project_id = $2 AND d.path = $3`,
            [ctx.workspaceId, id, path],
        );
        if (!committed) {
            return fail('conflict', 'The script has no file in git: there is nothing to take.');
        }

        const [row] = await ctx.db.query<{ revision: number }>(
            `UPDATE scripts SET content = $4, exports = $5::text::jsonb, revision = revision + 1, draft_base = $6, draft_conflict = NULL,
         updated_by = $7, updated_at = now() WHERE workspace_id = $1 AND project_id = $2 AND path = $3 RETURNING revision`,
            [ctx.workspaceId, id, path, committed.content, exportsOf(committed.content), committed.hash, ctx.userId],
        );
        return row ? success({ revision: row.revision }) : fail('not-found', 'Script not found.');
    }
}
