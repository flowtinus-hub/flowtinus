import { workBranch } from '#features/git/branch-read';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { flowWithScriptsMoved, movedScriptImports, normalizeScriptPath, scriptCodeOf, scriptImports, type FlowFile } from '@flowtinus/core';
import { loadDraft, writeDraft } from '#features/flows/flow-draft';
import { flows as flowsTable } from '#features/flows/flow';
import { FlowRepository, requireActiveProject } from '#features/folders/project-tree';
import { isGitOn } from '#features/git/git-config';
import { bestRows, ENVIRONMENT_BRANCH, isChange, scriptFileId, type WorkingRow } from '#features/git/working-copy';
import { commitWorkingCopy, discardWorkingCopy } from '#features/git/working-copy-changes';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { workingScripts, writeScript } from './script-store';

export type ScriptState = { changed: boolean; conflict?: string };

/** a project's scripts' rows in the working copy of a branch (the environment's by default), by script path */
async function scriptRows(
    db: Database,
    workspaceId: string,
    projectId: string,
    branch = ENVIRONMENT_BRANCH,
): Promise<Map<string, WorkingRow>> {
    const prefix = scriptFileId(projectId, '');
    const rows = await db.query<WorkingRow>(
        `SELECT path, content, deleted, file_id, base, edited_by, conflict, revision, updated_at FROM working_copy
       WHERE workspace_id = $1 AND branch = $2 AND starts_with(file_id, $3)`,
        [workspaceId, branch, prefix],
    );
    return new Map([...bestRows(rows)].map(([fileId, row]) => [fileId.slice(prefix.length), row]));
}

/** with git on, each script against the script as committed: changed (or never committed), in conflict */
export async function scriptStates(
    db: Database,
    workspaceId: string,
    projectId: string,
    branch = ENVIRONMENT_BRANCH,
): Promise<Map<string, ScriptState> | null> {
    if (!(await isGitOn(db, workspaceId))) {
        return null;
    }
    const rows = await scriptRows(db, workspaceId, projectId, branch);
    return new Map([...rows].map(([path, row]) => [path, { changed: isChange(row), ...(row.conflict ? { conflict: row.conflict } : {}) }]));
}

/** the changed scripts a flow imports, directly or through another script */
export async function changedImports(db: Database, workspaceId: string, projectId: string, flow: FlowFile): Promise<string[]> {
    const states = await scriptStates(db, workspaceId, projectId);
    if (!states) {
        return [];
    }
    const contents = new Map((await workingScripts(db, workspaceId, projectId)).map(s => [s.path, s.content]));
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

/** a script (or a folder) moved: the scripts that import it and the flows' drafts are rewritten. After moveScriptPath. */
export async function rewriteMovedScript(ctx: UseCaseContext, projectId: string, from: string, to: string): Promise<void> {
    const { db, workspaceId } = ctx;
    for (const script of await workingScripts(db, workspaceId, projectId)) {
        const content = movedScriptImports(script.content, from, to);
        if (content !== script.content) {
            await writeScript(db, workspaceId, projectId, script.path, content, ctx.userId);
        }
    }

    const live = await new FlowRepository(db, workspaceId).findMany(and(eq(flowsTable.projectId, projectId), isNull(flowsTable.deletedAt)));
    for (const flow of live) {
        const moved = flowWithScriptsMoved((await loadDraft(db, workspaceId, flow)).flow, from, to);
        if (moved) {
            await writeDraft(db, workspaceId, flow, moved, ctx.userId);
        }
    }
}

const projectId = z.uuid('Invalid');

export async function workingScriptPaths(
    db: Database,
    workspaceId: string,
    projectId: string,
    paths: string[],
    branch = ENVIRONMENT_BRANCH,
): Promise<string[]> {
    const rows = await scriptRows(db, workspaceId, projectId, branch);
    return paths.flatMap(path => {
        const row = rows.get(path);
        return row ? [row.path] : [];
    });
}

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
        const branch = (await workBranch(ctx))?.branch ?? ENVIRONMENT_BRANCH;
        const missing = branch === ENVIRONMENT_BRANCH ? await requireActiveProject(ctx, id) : null;
        if (missing && !missing.ok) {
            return missing;
        }

        const files = await workingScriptPaths(ctx.db, ctx.workspaceId, id, paths, branch);
        if (files.length === 0) {
            return fail('validation', 'Nothing to commit: the scripts are as committed.');
        }
        const rows = await scriptRows(ctx.db, ctx.workspaceId, id, branch);
        const conflicted = paths.find(path => rows.get(path)?.conflict);
        if (conflicted) {
            const commit = rows.get(conflicted)!.conflict!.slice(0, 7);
            return fail('conflict', `The script ${conflicted} conflicts with git's commit ${commit}: discard its changes first.`);
        }
        if (!paths.some(path => rows.get(path) && isChange(rows.get(path)!))) {
            return fail('validation', 'Nothing to commit: the scripts are as committed.');
        }
        const committed = await commitWorkingCopy(ctx, { paths: files, message: message ?? `Update ${paths.join(', ')}` });
        return committed.ok ? success({ commit: committed.value }) : committed;
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
        const branch = (await workBranch(ctx))?.branch ?? ENVIRONMENT_BRANCH;
        const row = (await scriptRows(ctx.db, ctx.workspaceId, id, branch)).get(path);
        if (!row) {
            return fail('not-found', 'Script not found.');
        }
        if (!row.base) {
            return fail('conflict', 'The script has no file in git: there is nothing to take.');
        }
        const discarded = await discardWorkingCopy(ctx, { paths: [row.path] });
        if (!discarded.ok) {
            return discarded;
        }
        return success({ revision: (await scriptRows(ctx.db, ctx.workspaceId, id, branch)).get(path)?.revision ?? 0 });
    }
}
