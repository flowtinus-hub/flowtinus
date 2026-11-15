import { z } from 'zod';
import { checkFlowYaml, type FlowCheck, type FlowIssue } from '@flowtinus/core';
import type { ApiScope } from '#features/api-tokens/api-tokens';
import type { RunScope } from '#features/api-tokens/run-scope';
import { GetDraftHandler } from '#features/flows/get-draft/get-draft-handler';
import { GetFlowHandler } from '#features/flows/get-flow/get-flow-handler';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseError, UseCaseResult } from '#shared/use-cases/use-case-result';
import { projectIssues } from '../project-checks';

export type McpOptions = {
    ctx: UseCaseContext;
    scopes: readonly ApiScope[];
    runScope?: RunScope | null;
    editorUrl?: string;
    pollMs?: number;
    maxWaitS?: number;
};

export const MAX_YAML_BYTES = 512 * 1024;

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

export const failed = (error: UseCaseError & Record<string, unknown>): ToolResult => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
});

export const answer = <T>(result: UseCaseResult<T>, map: (value: T) => unknown = v => v): ToolResult =>
    result.ok ? ok(map(result.value)) : failed(result.error);

export const id = (what: string) => z.string().describe(what);

export const MIN_APPROVAL_CHARS = 2;
export const MAX_APPROVAL_CHARS = 1000;

/**
 * The argument of a tool that needs the user's explicit approval (run_for_real, archive_flow): the user's own words,
 * quoted. The server cannot tell whether they really are the user's: the tool's own scope is the hard switch, this
 * makes the agent point at the message and leaves it in the server's log.
 */
export const userApproval = (what: string) =>
    z
        .string()
        .trim()
        .min(MIN_APPROVAL_CHARS)
        .max(MAX_APPROVAL_CHARS)
        .describe(
            `the user's message in this conversation that explicitly authorized ${what}, quoted word for word (kept in the server's log)`,
        );

export const logApproval = (tool: string, what: string, ctx: UseCaseContext, approval: string) =>
    console.info(`MCP ${tool}: ${what} by user ${ctx.userId} (workspace ${ctx.workspaceId}); userApproval: ${JSON.stringify(approval)}`);

export type ToolContext = ReturnType<typeof toolContext>;

export function toolContext(options: McpOptions, workspace?: string) {
    const { ctx } = options;
    const editorBase = options.editorUrl?.replace(/\/+$/, '');
    const link = (path: string): { editorUrl: string } | { editorPath: string } => {
        const full = workspace && path.startsWith('/projects') ? `/w/${workspace}${path}` : path;
        return editorBase ? { editorUrl: `${editorBase}${full}` } : { editorPath: full };
    };

    const flowAndDraft = async (flowId: string) => {
        const flow = await new GetFlowHandler().handle({ id: flowId }, ctx);
        if (!flow.ok) {
            return flow;
        }
        if (flow.value.archivedAt) {
            return { ok: false as const, error: { code: 'not-found' as const, message: 'Flow not found (it is archived).' } };
        }
        const draft = await new GetDraftHandler().handle({ id: flowId }, ctx);
        return draft.ok ? { ok: true as const, value: { flow: flow.value, draft: draft.value } } : draft;
    };

    const check = async (projectId: string, yaml: string, selfId?: string): Promise<FlowCheck> => {
        if (Buffer.byteLength(yaml) > MAX_YAML_BYTES) {
            return { ok: false, issues: [{ message: `The flow file takes more than ${MAX_YAML_BYTES / 1024} KB.` }], warnings: [] };
        }
        const checked = checkFlowYaml(yaml);
        if (!checked.flow) {
            return checked;
        }
        const project = await projectIssues(ctx, projectId, checked.flow, selfId);
        const issues: FlowIssue[] = [...checked.issues, ...project.issues];
        return { ...checked, ok: issues.length === 0, issues, warnings: [...checked.warnings, ...project.warnings] };
    };

    return {
        ctx,
        options,
        workspace,
        link,
        flowLink: (projectId: string, flowId: string) => link(`/projects/${projectId}/flows/${flowId}`),
        runLink: (runId: string) => (editorBase ? `${editorBase}/runs/${runId}` : undefined),
        flowAndDraft,
        check,
        invalid: (checked: FlowCheck): ToolResult =>
            failed({
                code: 'validation',
                message: 'The flow is not valid: nothing was saved. Fix the issues and try again.',
                issues: checked.issues,
                warnings: checked.warnings,
            }),
    };
}

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };

export type McpTool = {
    name: string;
    scope: ApiScope;
    description: string;
    input: z.ZodRawShape;
    annotations?: ToolAnnotations;
    run: (args: never, t: ToolContext) => Promise<ToolResult>;
};

export const defineTool = <S extends z.ZodRawShape>(tool: {
    name: string;
    scope: ApiScope;
    description: string;
    input: S;
    annotations?: ToolAnnotations;
    run: (args: z.infer<z.ZodObject<S>>, t: ToolContext) => Promise<ToolResult>;
}): McpTool => tool as McpTool;

export const workspaceArg = z.string().describe("the workspace's slug, from list_workspaces or resolve_url");
