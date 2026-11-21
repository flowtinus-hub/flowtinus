import { COMPONENT_TYPE, CONNECTION_KEY, componentSettings, DYNAMIC_CONNECTION, DYNAMIC_TARGET, dynamicConnection, findProfile, inputTypeRef, isFolderVisible, scriptExports, scriptImports, START, startParameters, type ConnectionProfileData, type FlowFile, type FlowIssue, type SettingField } from '@flowtinus/core';
import { eq } from 'drizzle-orm';
import { connections as connectionsTable } from '#features/connections/connection';
import { loadTree } from '#features/folders/project-tree';
import { branchTree, workBranch } from '#features/git/branch-read';
import { secrets as secretsTable } from '#features/secrets/secret';
import { variables as variablesTable } from '#features/variables/variable';
import { scriptContents } from '#features/scripts/script-store';
import { evaluate } from '#shared/runner/evaluate';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';

/*
 * What validate_flow checks that only the project knows (the core checks the rest): the flows a Flow Invoker calls,
 * the connection profiles and secrets the components name, and the scripts and functions they import. Each problem
 * points at the node and the setting, like the core's issues.
 *
 * A connection profile or a secret that the workspace does not have (yet) is a warning, not an issue: an agent cannot
 * create them (a person does, in the editor), and a draft that names them is still worth saving. The run is what needs
 * them: a component whose profile or secret is missing fails in the run (resolveConnection), as it always did.
 */

export type ProjectCheck = { issues: FlowIssue[]; warnings: FlowIssue[] };

const settingsOf = (type: string, kinds: SettingField['kind'][]) => componentSettings(type).filter(s => kinds.includes(s.kind));

const NAMED = /\$[A-Za-z_][\w$]*/g;
const KNOWN_BEFORE_THE_RUN = new Set(['$PARAMETERS', '$VARIABLES']);

export function namedBeforeTheRun(
    field: { value: string; expression: boolean },
    parameters: Record<string, unknown>,
    variables: Record<string, string>,
): string | undefined {
    if (!field.expression) {
        return field.value.trim() || undefined;
    }
    const names = field.value.match(NAMED) ?? [];
    if (names.length === 0 || names.some(n => !KNOWN_BEFORE_THE_RUN.has(n))) {
        return undefined;
    }
    try {
        const name = evaluate(field.value, { $PARAMETERS: parameters, $VARIABLES: variables });
        return typeof name === 'string' && name.trim() ? name.trim() : undefined;
    } catch {
        return undefined;
    }
}

function defaultParameters(flow: FlowFile): Record<string, unknown> {
    return Object.fromEntries(
        startParameters(flow.nodes).map(p => [
            p.name,
            p.type === 'number' ? Number(p.default) : p.type === 'boolean' ? p.default === 'true' : p.default,
        ]),
    );
}

export async function projectIssues(ctx: UseCaseContext, projectId: string, flow: FlowFile, selfId?: string): Promise<ProjectCheck> {
    const branch = await workBranch(ctx);
    const tree = branch ? branchTree(branch, projectId) : await loadTree(ctx.db, ctx.workspaceId, projectId);
    const flows = new Map(
        tree.flows.filter(f => !f.archivedAt && isFolderVisible(tree.folders, f.folderId)).map(f => [f.id, f.name] as const),
    );
    const [connections, secrets, variables, listed] = await Promise.all([
        ctx.db.orm
            .select({ id: connectionsTable.id, name: connectionsTable.name, type: connectionsTable.type })
            .from(connectionsTable)
            .where(eq(connectionsTable.workspaceId, ctx.workspaceId)),
        ctx.db.orm.select({ name: secretsTable.name }).from(secretsTable).where(eq(secretsTable.workspaceId, ctx.workspaceId)),
        ctx.db.orm
            .select({ name: variablesTable.name, value: variablesTable.value })
            .from(variablesTable)
            .where(eq(variablesTable.workspaceId, ctx.workspaceId)),
        scriptContents(ctx.db, ctx.workspaceId, branch ? { branch } : 'editing'),
    ]);
    const connectionById = new Map(connections.map(c => [c.id, c]));
    // by id or by name (whatever the case), as the run finds a dynamic one
    const profiles: Record<string, ConnectionProfileData> = Object.fromEntries(
        connections.map(c => [c.id, { name: c.name, type: c.type, config: {} }]),
    );
    const secretNames = new Set(secrets.map(s => s.name));
    const variableValues = Object.fromEntries(variables.map(v => [v.name, v.value]));
    const parameters = defaultParameters(flow);
    const exportsOf = new Map(listed.map(s => [s.path, new Set(scriptExports(s.content).map(e => e.name))]));

    const issues: FlowIssue[] = [];
    const warnings: FlowIssue[] = [];
    for (const node of flow.nodes) {
        if (node.disabled) {
            continue;
        }
        const name = node.label || node.type;
        const point = (settingKey: string, message: string): FlowIssue => ({
            nodeId: node.id,
            settingKey,
            message: `"${name}": ${message}`,
        });
        const issue = (settingKey: string, message: string) => issues.push(point(settingKey, message));
        const warn = (settingKey: string, message: string) => warnings.push(point(settingKey, message));

        if (node.type === COMPONENT_TYPE.flowInvoker) {
            const flowId = node.config.flowId;
            if (typeof flowId === 'string' && flowId && flowId !== DYNAMIC_TARGET) {
                if (flowId === selfId) {
                    issue('flowId', 'calls its own flow.');
                } else if (!flows.has(flowId)) {
                    issue(
                        'flowId',
                        `calls the flow ${flowId}, which is not an active flow of this project (get_project_contents lists them).`,
                    );
                }
            }
        }

        for (const setting of settingsOf(node.type, ['connection'])) {
            const accepted = setting.connectionTypes ?? (setting.connectionType ? [setting.connectionType] : []);
            const id = node.config[setting.key ?? CONNECTION_KEY];
            if (id === DYNAMIC_CONNECTION) {
                const field = dynamicConnection(node.config);
                const named = field && namedBeforeTheRun(field, parameters, variableValues);
                if (!named) {
                    continue;
                }
                const found = findProfile(profiles, named);
                if (!found) {
                    warn(
                        'connectionName',
                        `picks its connection by name in the run: "${named}" (with the Start's defaults), which is not a connection of this workspace yet (list_connections lists them); the run fails there until a person creates it.`,
                    );
                } else if (accepted.length && !accepted.includes(found.profile.type)) {
                    warn(
                        'connectionName',
                        `picks its connection by name in the run: "${found.profile.name}" is of type ${found.profile.type}; it takes ${accepted.join(', ')}.`,
                    );
                }
                continue;
            }
            if (typeof id !== 'string' || !id.trim()) {
                continue;
            }
            const profile = connectionById.get(id.trim());
            if (!profile) {
                warn(
                    setting.key,
                    `uses the connection ${id}, which is not a connection of this workspace yet (list_connections lists them); saved anyway, the run fails there until a person creates it and the flow names its id.`,
                );
            } else if (accepted.length && !accepted.includes(profile.type)) {
                issue(setting.key, `uses the connection "${profile.name}" of type ${profile.type}; it takes ${accepted.join(', ')}.`);
            }
        }

        for (const setting of settingsOf(node.type, ['secret'])) {
            const secret = node.config[setting.key];
            if (typeof secret === 'string' && secret.trim() && !secretNames.has(secret.trim())) {
                warn(
                    setting.key,
                    `names the secret "${secret}", which this workspace does not have yet (list_secret_names lists them); the run fails there until a person creates it.`,
                );
            }
        }

        const code = typeof node.config.code === 'string' && node.type === COMPONENT_TYPE.typescript ? node.config.code : '';
        for (const path of scriptImports(code)) {
            if (!exportsOf.has(path)) {
                issue('code', `imports the script ${path}, which this workspace does not have (list_scripts lists a project's).`);
            }
        }
        const refs: [string, unknown][] =
            node.type === COMPONENT_TYPE.scriptInvoker
                ? [['function', node.config.function]]
                : node.type === START
                  ? [['inputType', node.config.inputType]]
                  : [];
        for (const [key, value] of refs) {
            if (value === DYNAMIC_TARGET) {
                continue;
            }
            const ref = inputTypeRef(value);
            if (!ref) {
                continue;
            }
            const names = exportsOf.get(ref.path);
            if (!names) {
                issue(key, `names the script ${ref.path}, which this workspace does not have (list_scripts lists a project's).`);
            } else if (!names.has(ref.name)) {
                issue(key, `names ${ref.name}, which the script ${ref.path} does not export.`);
            }
        }
    }
    return { issues, warnings };
}
