import { scriptExports, type ScriptExport } from '@flowtinus/core';
import { branchScripts, workBranch } from '#features/git/branch-read';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { editingScope, importPathIn, workingScripts } from './script-store';

export type WorkspaceScripts = {
    projects: { id: string; name: string; handle: string; scripts: { path: string; importPath: string; exports: ScriptExport[] }[] }[];
};

export class ListWorkspaceScriptsHandler implements UseCaseHandler<WorkspaceScripts> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<WorkspaceScripts>> {
        const branch = await workBranch(ctx);
        const scope = await editingScope(ctx, branch);
        const projects: WorkspaceScripts['projects'] = [];
        for (const [id, { name, handle }] of scope.projects) {
            const scripts = branch ? branchScripts(branch, id) : await workingScripts(ctx.db, ctx.workspaceId, id);
            projects.push({
                id,
                name,
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
