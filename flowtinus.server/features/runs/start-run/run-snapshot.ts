import { COMPONENT_TYPE, dynamicTargets, scriptCodeOf, scriptImport, type FlowFile } from '@flowtinus/core';
import type { ProjectTree } from '#features/folders/project-tree';
import { listScripts, scriptsForRun } from '#features/scripts/script-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { calledFlows, type CalledFlow } from './called-flows';

export type RunSnapshot = { ok: true; calledFlows: CalledFlow[]; scripts: Record<string, string> } | { ok: false; error: string };

export async function runSnapshot(
    ctx: UseCaseContext,
    projectId: string,
    tree: ProjectTree,
    root: FlowFile,
    source: 'draft' | 'deployed',
): Promise<RunSnapshot> {
    const called = await calledFlows(ctx, projectId, tree, root, source);
    const usersOf = (file: FlowFile) =>
        file.nodes.flatMap(n => {
            const code = scriptCodeOf(n.type, n.config);
            const label = n.label || (n.type === COMPONENT_TYPE.typescript ? 'TypeScript' : 'Script Invoker');
            return code === undefined ? [] : [{ label: file === root ? label : `${file.name} › ${label}`, code }];
        });
    const users = [root, ...called.flatMap(c => (c.flow && !c.anyFlow ? [c.flow] : []))].flatMap(usersOf);
    // a flow taken only because one is named by expression: a script it lacks makes it one that cannot be called
    for (const c of called.filter(c => c.flow && c.anyFlow && !c.unavailable)) {
        const own = usersOf(c.flow!);
        const missing = own.length ? (await scriptsForRun(ctx.db, ctx.workspaceId, projectId, own)).error : undefined;
        if (missing) {
            c.unavailable = missing;
        } else {
            users.push(...own);
        }
    }
    // a Script Invoker that names its function by expression may call any script: every one that resolves goes
    const files = [root, ...called.flatMap(c => (c.flow && !c.unavailable ? [c.flow] : []))];
    if (files.some(file => dynamicTargets(file.nodes).scripts)) {
        for (const script of (await listScripts(ctx.db, ctx.workspaceId, projectId)).scripts) {
            const user = { label: 'Script Invoker (by path)', code: `import '${scriptImport(script.path)}';` };
            if (!(await scriptsForRun(ctx.db, ctx.workspaceId, projectId, [user])).error) {
                users.push(user);
            }
        }
    }

    const imported = await scriptsForRun(ctx.db, ctx.workspaceId, projectId, users);
    return imported.error ? { ok: false, error: imported.error } : { ok: true, calledFlows: called, scripts: imported.scripts };
}
