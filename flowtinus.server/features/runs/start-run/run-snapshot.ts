import { COMPONENT_TYPE, dynamicTargets, scriptCodeOf, type FlowFile } from '@flowtinus/core';
import type { ProjectTree } from '#features/folders/project-tree';
import { isGitOn } from '#features/git/git-config';
import { scriptContents, scriptsForRun, type ScriptSource } from '#features/scripts/script-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { calledFlows, type CalledFlow } from './called-flows';
import type { WorkBranch } from '#features/git/branch-read';

export type RunSnapshot = { ok: true; calledFlows: CalledFlow[]; scripts: Record<string, string> } | { ok: false; error: string };

export async function runSnapshot(
    ctx: UseCaseContext,
    tree: ProjectTree,
    root: FlowFile,
    source: 'draft' | 'deployed',
    branch: WorkBranch | null = null,
): Promise<RunSnapshot> {
    const called = await calledFlows(ctx, tree, root, source, branch);
    const scripts: ScriptSource = branch
        ? { branch }
        : source === 'deployed' && (await isGitOn(ctx.db, ctx.workspaceId))
          ? 'deployed'
          : 'editing';
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
        const missing = own.length ? (await scriptsForRun(ctx.db, ctx.workspaceId, own, scripts)).error : undefined;
        if (missing) {
            c.unavailable = missing;
        } else {
            users.push(...own);
        }
    }
    // a Script Invoker that names its function by expression may call any script of the workspace: every one that resolves goes
    const files = [root, ...called.flatMap(c => (c.flow && !c.unavailable ? [c.flow] : []))];
    if (files.some(file => dynamicTargets(file.nodes).scripts)) {
        for (const script of await scriptContents(ctx.db, ctx.workspaceId, scripts)) {
            const user = { label: 'Script Invoker (by path)', code: `import '${script.path}';` };
            if (!(await scriptsForRun(ctx.db, ctx.workspaceId, [user], scripts)).error) {
                users.push(user);
            }
        }
    }

    const imported = await scriptsForRun(ctx.db, ctx.workspaceId, users, scripts);
    return imported.error ? { ok: false, error: imported.error } : { ok: true, calledFlows: called, scripts: imported.scripts };
}
