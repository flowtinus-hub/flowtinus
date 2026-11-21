import { scriptExports, type ScriptExport } from '@flowtinus/core';
import { branchScripts, workBranch } from '#features/git/branch-read';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { importPathIn, scriptScope, workingScripts } from './script-store';

export type WorkspaceScripts = {
    projects: { id: string; name: string; handle: string; scripts: { path: string; importPath: string; exports: ScriptExport[] }[] }[];
};

export class ListWorkspaceScriptsHandler implements UseCaseHandler<WorkspaceScripts> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<WorkspaceScripts>> {
        const branch = await workBranch(ctx);
        const scope = await scriptScope(ctx.db, ctx.workspaceId, branch ? { branch } : 'editing');
        const names = new Map(
            branch
                ? branch.projects.map(p => [p.id, p.name])
                : (
                      await ctx.db.query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE workspace_id = $1', [
                          ctx.workspaceId,
                      ])
                  ).map(p => [p.id, p.name]),
        );
        const projects: WorkspaceScripts['projects'] = [];
        for (const [id, handle] of scope.handleOf) {
            const scripts = branch ? branchScripts(branch, id) : await workingScripts(ctx.db, ctx.workspaceId, id);
            projects.push({
                id,
                name: names.get(id) ?? handle,
                handle,
                scripts: scripts.map(s => ({
                    path: s.path,
                    importPath: importPathIn(scope, id, s.path),
                    exports: scriptExports(s.content),
                })),
            });
        }
        return success({ projects: projects.sort((a, b) => a.name.localeCompare(b.name)) });
    }
}
