import { GetFlowHandler } from '#features/flows/get-flow/get-flow-handler';
import { GetProjectHandler } from '#features/projects/get-project/get-project-handler';
import { GetRunHandler } from '#features/runs/get-run/get-run-handler';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { z } from 'zod';
import { workspaceOfCall } from '../workspace-of-call';
import { defineTool, ok } from './tool';

/*
 * What an editor link points at, for an agent the user gave one to. Host and port do not matter (the user may paste it
 * from any environment); the workspace and the ids are checked against the database and the user's workspaces, so a
 * link to another environment or to a workspace the user is not in fails clearly instead of being used blindly.
 */

export type ResolvedUrl =
    | { kind: 'flow'; workspace: string; projectId: string; projectName: string; flowId: string; flowName: string }
    | { kind: 'project'; workspace: string; projectId: string; projectName: string }
    | { kind: 'workspace'; workspace: string }
    | { kind: 'run'; workspace: string; runId: string; flowId: string; projectId: string | null; status: string }
    | { error: string };

const NOT_HERE = 'it is not in this environment, or not in your workspaces (check the link was copied from the same Flowtinus)';

function pathOf(url: string): string | null {
    const text = url.trim();
    try {
        return new URL(text).pathname;
    } catch {
        return text.startsWith('/') ? (text.split(/[?#]/)[0] ?? null) : null;
    }
}

const WORKSPACE_PAGES = ['projects', 'connections', 'secrets', 'settings'];

export async function resolveEditorUrl(ctx: UseCaseContext, url: string): Promise<ResolvedUrl> {
    const path = pathOf(url);
    const parts = path?.split('/').filter(Boolean) ?? [];

    if (parts[0] === 'w' && parts[1]) {
        const found = await workspaceOfCall(ctx, { workspace: parts[1] });
        if (!found.ok || !found.value) {
            return { error: `The workspace of this link was not found: ${NOT_HERE}.` };
        }
        const { ctx: inWorkspace, handle: workspace } = found.value;
        const rest = parts.slice(2);
        if (rest[0] === 'projects' && rest[1]) {
            const project = await new GetProjectHandler().handle({ id: rest[1] }, inWorkspace);
            if (!project.ok) {
                return { error: `The project of this link was not found: ${NOT_HERE}.` };
            }
            if (rest[2] === 'flows' && rest[3]) {
                const flow = await new GetFlowHandler().handle({ id: rest[3] }, inWorkspace);
                if (!flow.ok || flow.value.projectId !== project.value.id) {
                    return { error: `The flow of this link was not found: ${NOT_HERE}.` };
                }
                return {
                    kind: 'flow',
                    workspace,
                    projectId: project.value.id,
                    projectName: project.value.name,
                    flowId: flow.value.id,
                    flowName: flow.value.name,
                };
            }
            if (rest.length === 2 || (rest.length === 3 && ['flows', 'scripts'].includes(rest[2]!))) {
                return { kind: 'project', workspace, projectId: project.value.id, projectName: project.value.name };
            }
        }
        if (rest.length === 0 || (rest.length === 1 && WORKSPACE_PAGES.includes(rest[0]!))) {
            return { kind: 'workspace', workspace };
        }
    }

    if (parts[0] === 'runs' && parts[1] && (parts.length === 2 || (parts.length === 3 && parts[2] === 'logs'))) {
        const found = await workspaceOfCall(ctx, { runId: parts[1] });
        const run = found.ok && found.value ? await new GetRunHandler().handle({ id: parts[1] }, found.value.ctx) : null;
        if (!run?.ok || !found.ok || !found.value) {
            return { error: `The run of this link was not found: ${NOT_HERE}.` };
        }
        return {
            kind: 'run',
            workspace: found.value.handle,
            runId: run.value.id,
            flowId: run.value.flowId,
            projectId: run.value.projectId,
            status: run.value.status,
        };
    }

    return {
        error: 'Not a Flowtinus link: expected /w/<workspace>/projects/<projectId>/flows/<flowId>, /w/<workspace>/projects/<projectId>, /w/<workspace> or /runs/<runId>.',
    };
}

export const resolveUrl = defineTool({
    name: 'resolve_url',
    scope: 'flows:read',
    description:
        'What an editor link the user pasted points at: /w/<workspace>/projects/<id>/flows/<id> (a flow), /w/<workspace>/projects/<id>[/flows|scripts] (a project), /w/<workspace>[/projects|connections|secrets|settings] (a workspace), /runs/<id> (a run). Call it first whenever the user gives a link.',
    input: { url: z.string().describe('the link, as the user pasted it (host and port do not matter)') },
    run: async ({ url }, t) => ok(await resolveEditorUrl(t.ctx, url)),
});
