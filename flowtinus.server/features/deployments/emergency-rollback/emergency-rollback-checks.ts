import { dynamicTargets, inputTypeRef, repoEntry, repoFlowFromYaml, repoFlowToYaml, scriptTypeShape, START, startConfig, validateWorkspaceTree, type FlowFile, type TreeIssue } from '@flowtinus/core';
import { importEnvironment } from '#features/git/workspace-import';
import { exportTree } from '#features/git/workspace-export';
import { callsOf } from '#features/runs/start-run/called-flows';
import { typeSources } from '#features/scripts/script-store';
import { workspaceHandleIn } from '#features/workspaces/workspace';
import type { Flow } from '#features/flows/flow';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { deployedDefinitions } from '../deployments';

export type EmergencyRollbackChecks = { errors: string[]; warnings: string[] };

export type CheckedVersion = { number: number; definition: FlowFile };

const startOf = (file: FlowFile) => file.nodes.find(n => n.type === START)?.config ?? {};

function inputOf(file: FlowFile): string | null {
    const config = startOf(file);
    return startConfig(config).acceptsInput ? (typeof config.inputType === 'string' ? config.inputType : '') : null;
}

const describedInput = (input: string | null) => (input === null ? 'no input' : (inputTypeRef(input)?.name ?? 'any input'));

async function inputTypeGone(ctx: UseCaseContext, file: FlowFile): Promise<string | null> {
    const input = inputOf(file);
    const ref = input === null ? null : inputTypeRef(input);
    if (!ref) {
        return null;
    }

    const shape = scriptTypeShape(await typeSources(ctx.db, ctx.workspaceId, ref.path, 'deployed'), ref.path, ref.name);
    return shape ? null : `The Start's input type ${ref.name} no longer exists in the script ${ref.path}.`;
}

const issueKey = (issue: TreeIssue) => `${issue.path}\n${issue.message}`;

const issueText = (issue: TreeIssue, path: string) => (issue.path === path ? issue.message : `${issue.path}: ${issue.message}`);

function newIssues(after: TreeIssue[], before: TreeIssue[], path: string): string[] {
    const known = new Set(before.map(issueKey));
    return after.filter(i => !known.has(issueKey(i))).map(i => issueText(i, path));
}

// a called flow, script or connection missing from this flow's file blocks even when the running version misses it too
function blockingIssues(after: TreeIssue[], before: TreeIssue[], path: string): string[] {
    return [
        ...after.filter(i => i.path === path).map(i => issueText(i, path)),
        ...newIssues(
            after.filter(i => i.path !== path),
            before,
            path,
        ),
    ];
}

async function calledNotDeployed(ctx: UseCaseContext, flow: Flow, to: FlowFile, running: FlowFile, names: Map<string, string>) {
    const alreadyCalled = new Set(callsOf(running));
    const calls = to.nodes.flatMap(node => {
        const [id] = callsOf({ ...to, nodes: [node] });
        return id && id !== flow.id && names.has(id) && !alreadyCalled.has(id) ? [{ node: node.id, id }] : [];
    });
    const deployed = await deployedDefinitions(
        ctx.db,
        ctx.workspaceId,
        calls.map(c => c.id),
    );
    return calls.filter(c => !deployed.has(c.id)).map(c => `Node "${c.node}" calls "${names.get(c.id)}", which is not deployed here.`);
}

async function callersWarning(ctx: UseCaseContext, flow: Flow, to: CheckedVersion, git: CheckedVersion): Promise<string | null> {
    const [was, now] = [inputOf(git.definition), inputOf(to.definition)];
    if (was === now) {
        return null;
    }

    const deployed = await ctx.db.query<{ name: string; project_id: string; definition: FlowFile }>(
        `SELECT f.name, f.project_id, v.definition FROM deployments d
       JOIN flows f ON f.id = d.flow_id JOIN flow_versions v ON v.id = d.flow_version_id
      WHERE d.workspace_id = $1 AND f.id <> $2 ORDER BY f.name`,
        [ctx.workspaceId, flow.id],
    );
    const callers = deployed.filter(f => callsOf(f.definition).includes(flow.id)).map(f => f.name);
    const byExpression = deployed.filter(f => f.project_id === flow.projectId && dynamicTargets(f.definition.nodes).flows).map(f => f.name);
    return [
        `The Start's input type of v${to.number} (${describedInput(now)}) differs from git's v${git.number} (${describedInput(was)}): callers may send an input v${to.number} does not accept.`,
        ...(callers.length ? [`The deployed flows that call it: ${callers.join(', ')}.`] : []),
        ...(byExpression.length
            ? [`Flows call others by expression in this project (${byExpression.join(', ')}): they may call it too.`]
            : []),
    ].join(' ');
}

/**
 * The tree as this server deploys it (git's version of every flow, the deployed scripts), with this flow's file at the
 * old version, checked without git. A called flow not deployed here and the Start's input type gone block only when
 * new: a defect the running version has too would block the way out without making anything better.
 */
export async function emergencyRollbackChecks(
    ctx: UseCaseContext,
    flow: Flow,
    to: CheckedVersion,
    running: CheckedVersion,
    git: CheckedVersion,
): Promise<EmergencyRollbackChecks> {
    const [{ files, ids }, handle, environment] = await Promise.all([
        exportTree(ctx.db, ctx.workspaceId, 'git'),
        workspaceHandleIn(ctx.db, ctx.workspaceId),
        importEnvironment(ctx.db, ctx.workspaceId),
    ]);
    const path = Object.keys(ids).find(p => ids[p] === flow.id);
    const read = path ? repoFlowFromYaml(files[path]!, flow.name) : null;
    if (!path || !read?.ok) {
        return { errors: [], warnings: [] };
    }

    const validated = (file: FlowFile) =>
        validateWorkspaceTree({
            workspace: handle,
            files: { ...files, [path]: repoFlowToYaml({ ...file, id: flow.id }, read.value) },
            environment,
        });
    const [after, before] = [validated(to.definition), validated(running.definition)];
    const names = new Map(
        Object.entries(ids).flatMap(([p, id]) => {
            const entry = repoEntry(p);
            return entry.kind === 'flow' ? [[id, entry.name] as const] : [];
        }),
    );
    const [gone, wasGone] = await Promise.all([inputTypeGone(ctx, to.definition), inputTypeGone(ctx, running.definition)]);
    const callers = await callersWarning(ctx, flow, to, git);
    return {
        errors: [
            ...blockingIssues(after.errors, before.errors, path),
            ...(await calledNotDeployed(ctx, flow, to.definition, running.definition, names)),
            ...(gone && !wasGone ? [gone] : []),
        ],
        warnings: [...newIssues(after.warnings, before.warnings, path), ...(callers ? [callers] : [])],
    };
}
