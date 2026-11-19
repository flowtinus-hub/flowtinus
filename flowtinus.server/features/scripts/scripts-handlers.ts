import { createScriptOnBranch, deleteScriptOnBranch, moveScriptOnBranch, saveScriptOnBranch } from '#features/git/branch-edits';
import { refuseOffEditableBranch } from '#features/git/current-branch';
import { z } from 'zod';
import { changeTree } from '#features/git/git-first';
import { rewriteMovedScript, scriptStates, type ScriptState } from './script-git';
import { movedScriptPath, normalizeScriptPath, scriptContentIssue, scriptExports } from '@flowtinus/core';
import { branchScripts, workBranch } from '#features/git/branch-read';
import { pathTooLong, requireActiveProject } from '#features/folders/project-tree';
import { GetProjectHandler } from '#features/projects/get-project/get-project-handler';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { allFolders, deleteScriptPath, getScript, listScripts, moveScriptPath, newPathIssue, scriptUsage, writeScript, type ScriptEntry } from './script-store';

const projectId = z.uuid('Invalid');
const path = z.string().transform(normalizeScriptPath);
const invalidPath = (error: string) => fail('validation', 'The request has invalid fields.', { path: error });
const conflict = () => fail('conflict', 'This script was changed elsewhere. Reload it to see the latest version.');
const NEW_SCRIPT = `export function example(): string {\n  return 'hello';\n}\n`;
const tooLarge = (error: string) => fail('validation', 'The request has invalid fields.', { content: error });

export type ScriptsView = { scripts: (ScriptEntry & Partial<ScriptState>)[]; folders: string[] };

export class ListScriptsHandler implements UseCaseHandler<ScriptsView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ScriptsView>> {
        const parsed = validate(z.object({ projectId }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const project = await new GetProjectHandler().handle({ id: parsed.value.projectId }, ctx);
        if (!project.ok) {
            return project;
        }

        const branch = await workBranch(ctx);
        if (branch) {
            const states = await scriptStates(ctx.db, ctx.workspaceId, parsed.value.projectId, branch.branch);
            const scripts = branchScripts(branch, parsed.value.projectId).map(({ content, ...script }) => ({
                ...script,
                exports: scriptExports(content),
                ...states?.get(script.path),
            }));
            return success({ scripts, folders: allFolders(scripts, branch.scriptFolders.get(parsed.value.projectId) ?? []) });
        }

        const { scripts, folders } = await listScripts(ctx.db, ctx.workspaceId, parsed.value.projectId);
        const states = await scriptStates(ctx.db, ctx.workspaceId, parsed.value.projectId);
        return success({ scripts: scripts.map(s => ({ ...s, ...states?.get(s.path) })), folders: allFolders(scripts, folders) });
    }
}

export class CreateScriptPathHandler implements UseCaseHandler<{ path: string; revision: number }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ path: string; revision: number }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(z.object({ projectId, path, kind: z.enum(['script', 'folder']), content: z.string().optional() }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const { projectId: id, path: target, kind, content } = parsed.value;
        const branch = await workBranch(ctx);
        if (branch) {
            const code = content ?? NEW_SCRIPT;
            const large = scriptContentIssue(code);
            return large ? tooLarge(large) : createScriptOnBranch(ctx, branch, { projectId: id, path: target, kind, content: code });
        }
        const missing = await requireActiveProject(ctx, id);
        if (missing && !missing.ok) {
            return missing;
        }

        const issue = await newPathIssue(ctx.db, ctx.workspaceId, id, target);
        if (issue) {
            return issue.includes('already exists') ? fail('conflict', issue, { path: issue }) : invalidPath(issue);
        }

        const current = await listScripts(ctx.db, ctx.workspaceId, id);
        const scripts = current.scripts.map(s => s.path);
        const tooLong = await pathTooLong(
            ctx,
            id,
            {
                scripts:
                    kind === 'folder'
                        ? { scripts, folders: [...current.folders, target] }
                        : { scripts: [...scripts, target], folders: current.folders },
            },
            'path',
        );
        if (tooLong) {
            return tooLong;
        }

        const code = content ?? NEW_SCRIPT;
        const large = scriptContentIssue(code);
        if (large) {
            return tooLarge(large);
        }

        if (kind === 'folder') {
            await changeTree(ctx, db =>
                db.query('INSERT INTO script_folders (workspace_id, project_id, path) VALUES ($1, $2, $3)', [ctx.workspaceId, id, target]),
            );
            return success({ path: target, revision: 0 });
        }

        const revision = await changeTree(ctx, db => writeScript(db, ctx.workspaceId, id, target, code, ctx.userId));
        return success({ path: target, revision: revision ?? 0 });
    }
}

export class SaveScriptHandler implements UseCaseHandler<{ revision: number }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ revision: number }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(z.object({ projectId, path, content: z.string(), revision: z.number().int().min(0) }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const { projectId: id, path: target, content, revision } = parsed.value;
        const branch = await workBranch(ctx);
        if (branch) {
            const large = scriptContentIssue(content);
            return large ? tooLarge(large) : saveScriptOnBranch(ctx, branch, parsed.value);
        }
        await refuseOffEditableBranch(ctx.db, ctx.workspaceId, ctx.userId);
        const missing = await requireActiveProject(ctx, id);
        if (missing && !missing.ok) {
            return missing;
        }

        const large = scriptContentIssue(content);
        if (large) {
            return tooLarge(large);
        }

        if (!(await getScript(ctx.db, ctx.workspaceId, id, target))) {
            return fail('not-found', 'Script not found.');
        }
        const saved = await ctx.db.transaction(db => writeScript(db, ctx.workspaceId, id, target, content, ctx.userId, revision));
        return saved === null ? conflict() : success({ revision: saved });
    }
}

export class MoveScriptPathHandler implements UseCaseHandler<{ path: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ path: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(z.object({ projectId, from: path, to: path }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const { projectId: id, from, to } = parsed.value;
        const branch = await workBranch(ctx);
        if (branch) {
            return moveScriptOnBranch(ctx, branch, parsed.value);
        }
        const missing = await requireActiveProject(ctx, id);
        if (missing && !missing.ok) {
            return missing;
        }

        if (from === to) {
            return success({ path: to });
        }

        const issue = await newPathIssue(ctx.db, ctx.workspaceId, id, to, from);
        if (issue) {
            return issue.includes('already exists') ? fail('conflict', issue, { path: issue }) : invalidPath(issue);
        }

        const current = await listScripts(ctx.db, ctx.workspaceId, id);
        const moved = (path: string) => movedScriptPath(path, from, to);
        const tooLong = await pathTooLong(
            ctx,
            id,
            { scripts: { scripts: current.scripts.map(s => moved(s.path)), folders: current.folders.map(moved) } },
            'path',
        );
        if (tooLong) {
            return tooLong;
        }

        await changeTree(ctx, async db => {
            await moveScriptPath(db, ctx.workspaceId, id, from, to, ctx.userId);
            await rewriteMovedScript({ ...ctx, db }, id, from, to);
        });
        return success({ path: to });
    }
}

export class DeleteScriptPathHandler implements UseCaseHandler<{ path: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ path: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(z.object({ projectId, path }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const branch = await workBranch(ctx);
        if (branch) {
            return deleteScriptOnBranch(ctx, branch, parsed.value);
        }
        const missing = await requireActiveProject(ctx, parsed.value.projectId);
        if (missing && !missing.ok) {
            return missing;
        }

        await changeTree(ctx, db => deleteScriptPath(db, ctx.workspaceId, parsed.value.projectId, parsed.value.path, ctx.userId));
        return success({ path: parsed.value.path });
    }
}

export class ScriptUsageHandler implements UseCaseHandler<{ flows: { id: string; name: string }[]; scripts: string[] }> {
    async handle(
        input: unknown,
        ctx: UseCaseContext,
    ): Promise<UseCaseResult<{ flows: { id: string; name: string }[]; scripts: string[] }>> {
        const parsed = validate(z.object({ projectId, path }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const project = await new GetProjectHandler().handle({ id: parsed.value.projectId }, ctx);
        if (!project.ok) {
            return project;
        }

        return success(await scriptUsage(ctx.db, ctx.workspaceId, parsed.value.projectId, parsed.value.path, await workBranch(ctx)));
    }
}

export class GetScriptHandler implements UseCaseHandler<{ path: string; content: string; revision: number }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ path: string; content: string; revision: number }>> {
        const parsed = validate(z.object({ projectId, path }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const project = await new GetProjectHandler().handle({ id: parsed.value.projectId }, ctx);
        if (!project.ok) {
            return project;
        }

        const branch = await workBranch(ctx);
        const onBranch = branch ? branchScripts(branch, parsed.value.projectId).find(s => s.path === parsed.value.path) : undefined;
        const script = branch
            ? onBranch && { path: onBranch.path, content: onBranch.content, revision: onBranch.revision }
            : await getScript(ctx.db, ctx.workspaceId, parsed.value.projectId, parsed.value.path);
        return script ? success(script) : fail('not-found', 'Script not found.');
    }
}
