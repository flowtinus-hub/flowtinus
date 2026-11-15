import { z } from 'zod';

/*
 * A token's run scope (api_tokens.run_scope): what its runs:execute may run for real
 * through the MCP (run_for_real). A token without one (every token made before) may run any flow of its user's
 * workspaces, each run only with the user's own words authorizing it (userApproval). A token with one may run only the
 * flows in its folders (and their subfolders) or among its flows: there the scope is the user's approval, given once
 * when the token was made, and no userApproval is needed; any other flow is refused by the server. The flows a run
 * calls (a Flow Invoker) are held to it too: one outside it cannot be called in that run (start-run-handler.ts).
 */

export type RunScope = { folders: string[]; flows: string[] };

export const RunScopeInput = z
    .object({
        folders: z.array(z.uuid('Invalid')).max(100).default([]),
        flows: z.array(z.uuid('Invalid')).max(500).default([]),
    })
    .refine(scope => scope.folders.length + scope.flows.length > 0, 'A run scope names at least one folder or flow.');

export function readRunScope(value: unknown): RunScope | null {
    if (value === null || value === undefined) {
        return null;
    }
    const parsed = RunScopeInput.safeParse(value);
    // something unreadable is never "any flow": a scope that lets nothing run
    return parsed.success ? parsed.data : { folders: [], flows: [] };
}

export type ScopeFlow = { id: string; folderId: string | null };
export type ScopeFolder = { id: string; parentId: string | null };

export function inRunScope(scope: RunScope, flow: ScopeFlow, folders: ScopeFolder[]): boolean {
    if (scope.flows.includes(flow.id)) {
        return true;
    }
    const allowed = new Set(scope.folders);
    const seen = new Set<string>();
    for (let id = flow.folderId; id !== null && !seen.has(id);) {
        if (allowed.has(id)) {
            return true;
        }
        seen.add(id);
        id = folders.find(f => f.id === id)?.parentId ?? null;
    }
    return false;
}

export type RunForRealCheck = { ok: true; byScope: boolean } | { ok: false; code: 'forbidden' | 'validation'; message: string };

export function runForRealCheck(
    scope: RunScope | null,
    flow: ScopeFlow & { name?: string },
    folders: ScopeFolder[],
    approval: string | undefined,
): RunForRealCheck {
    if (!scope) {
        return approval?.trim()
            ? { ok: true, byScope: false }
            : {
                  ok: false,
                  code: 'validation',
                  message:
                      "userApproval is required: quote the user's message that authorized running this flow for real (this token has no run scope).",
              };
    }
    if (inRunScope(scope, flow, folders)) {
        return { ok: true, byScope: true };
    }
    const what = [
        scope.folders.length ? `the folders ${scope.folders.join(', ')} (and their subfolders)` : '',
        scope.flows.length ? `the flows ${scope.flows.join(', ')}` : '',
    ]
        .filter(Boolean)
        .join(' and ');
    return {
        ok: false,
        code: 'forbidden',
        message: `This token may run for real only ${what || 'no flow'}: the flow ${flow.name ? `"${flow.name}" ` : ''}(${flow.id}) is outside its run scope. Use test_run, or ask the user to run it in the editor.`,
    };
}
