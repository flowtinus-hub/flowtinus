import { parse, stringify } from 'yaml';
import { CONNECTION_TYPES, type ConnectionTypeName } from '../connections/types/connection-types';
import { FLOW_FILE_VERSION, leanFlow, validateFlowFile, type FlowFile } from '../flows/flow-file';
import { DEFAULT_MISFIRE, DEFAULT_WEBHOOK_RESPONSE, MISFIRE_MODES, WEBHOOK_RESPONSES, type MisfireMode, type TriggerKind, type WebhookResponse } from '../triggers/triggers';

export const REPO_FORMAT = 1;

export const GITATTRIBUTES = '* text=auto eol=lf\n';

// lower case only: a flow names its connections and called flows by the id as written, and Postgres gives a uuid back in
// lower case
export const REPO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isRepoId = (id: string) => REPO_ID.test(id);

export type RepoSchedule = {
    id: string;
    cron: string;
    timezone: string;
    misfire: MisfireMode;
    parameters: Record<string, string>;
    input?: unknown;
};
export type RepoWebhook = { id: string; name: string; response: WebhookResponse };
export type RepoTriggers = { schedules: RepoSchedule[]; webhooks: RepoWebhook[] };
export type RepoFlow = { flow: FlowFile; deployed: boolean } & RepoTriggers;
export type RepoProject = { id: string; description: string; icon?: string; color?: string };
export type RepoConnection = { id: string; type: ConnectionTypeName };
export type RepoWorkspace = { format: typeof REPO_FORMAT };

export type RepoFileResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toYaml = (value: unknown) => stringify(value, { blockQuote: 'literal', lineWidth: 0, indent: 2 });

function readYaml(text: string): RepoFileResult<unknown> {
    try {
        return { ok: true, value: parse(text) };
    } catch (e) {
        return { ok: false, errors: [`Not valid YAML: ${e instanceof Error ? e.message : String(e)}`] };
    }
}

function readObject(text: string, what: string): RepoFileResult<Record<string, unknown>> {
    const read = readYaml(text);
    if (!read.ok) {
        return read;
    }
    return isObject(read.value) ? { ok: true, value: read.value } : { ok: false, errors: [`Not a ${what} file.`] };
}

const hasId = (data: Record<string, unknown>): data is Record<string, unknown> & { id: string } =>
    typeof data.id === 'string' && data.id !== '';

const missingId = (what: string): { ok: false; errors: string[] } => ({
    ok: false,
    errors: [`The ${what} has no id: add one, such as "id: ${crypto.randomUUID()}".`],
});

export function projectToYaml(project: RepoProject): string {
    return toYaml({
        id: project.id,
        ...(project.description ? { description: project.description } : {}),
        icon: project.icon,
        color: project.color,
    });
}

export function projectFromYaml(text: string): RepoFileResult<RepoProject> {
    const read = readObject(text, 'project');
    if (!read.ok) {
        return read;
    }
    const data = read.value;
    if (!hasId(data)) {
        return missingId('project');
    }
    const notText = (['description', 'icon', 'color'] as const).filter(key => data[key] !== undefined && typeof data[key] !== 'string');
    if (notText.length) {
        return { ok: false, errors: notText.map(key => `"${key}" is a text.`) };
    }
    return {
        ok: true,
        value: {
            id: data.id,
            description: (data.description as string | undefined) ?? '',
            ...(data.icon !== undefined ? { icon: data.icon as string } : {}),
            ...(data.color !== undefined ? { color: data.color as string } : {}),
        },
    };
}

export function connectionToYaml(connection: RepoConnection): string {
    return toYaml({ id: connection.id, type: connection.type });
}

export function connectionFromYaml(text: string): RepoFileResult<RepoConnection> {
    const read = readObject(text, 'connection');
    if (!read.ok) {
        return read;
    }
    const data = read.value;
    if (!hasId(data)) {
        return missingId('connection');
    }
    const type = CONNECTION_TYPES.find(t => t.type === data.type)?.type;
    return type
        ? { ok: true, value: { id: data.id, type } }
        : { ok: false, errors: [`Unknown connection type ${JSON.stringify(data.type)}.`] };
}

export function workspaceToYaml(): string {
    return toYaml({ format: REPO_FORMAT });
}

export function workspaceFromYaml(text: string): RepoFileResult<RepoWorkspace> {
    const read = readYaml(text);
    if (!read.ok) {
        return read;
    }
    const format = isObject(read.value) ? read.value.format : undefined;
    return format === REPO_FORMAT
        ? { ok: true, value: { format: REPO_FORMAT } }
        : { ok: false, errors: [`Unknown format ${JSON.stringify(format)} (this app reads ${REPO_FORMAT}).`] };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const byKeys =
    <T>(...keys: ((item: T) => string)[]) =>
    (a: T, b: T) =>
        keys.reduce((order, key) => order || compare(key(a), key(b)), 0);

const sortedKeys = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(sortedKeys)
        : isObject(value)
          ? Object.fromEntries(
                Object.keys(value)
                    .sort(compare)
                    .map(key => [key, sortedKeys(value[key])]),
            )
          : value;

const scheduleToYaml = (s: RepoSchedule) =>
    sortedKeys({
        id: s.id,
        cron: s.cron,
        timezone: s.timezone,
        ...(s.misfire === DEFAULT_MISFIRE ? {} : { misfire: s.misfire }),
        ...(Object.keys(s.parameters).length ? { parameters: s.parameters } : {}),
        ...(s.input === undefined ? {} : { input: s.input }),
    });

const webhookToYaml = (w: RepoWebhook) =>
    sortedKeys({ id: w.id, name: w.name, ...(w.response === DEFAULT_WEBHOOK_RESPONSE ? {} : { response: w.response }) });

export function repoFlowToYaml(
    flow: FlowFile,
    { deployed = true, schedules = [], webhooks = [] }: Partial<Omit<RepoFlow, 'flow'>> = {},
): string {
    const { nodes, edges, groups } = leanFlow(flow);
    return toYaml({
        version: FLOW_FILE_VERSION,
        id: flow.id,
        ...(deployed ? {} : { deployed: false }),
        nodes: nodes.map(({ pinned: _pinned, ...node }) => ({ ...node, config: sortedKeys(node.config) })).sort(byKeys(n => n.id)),
        edges: edges.sort(
            byKeys(
                e => e.source,
                e => e.target,
                e => e.sourcePort,
                e => e.targetPort,
            ),
        ),
        ...(groups
            ? {
                  groups: groups
                      .map(g => ({
                          id: g.id,
                          title: g.title,
                          color: g.color,
                          position: { x: g.position.x, y: g.position.y },
                          size: { width: g.size.width, height: g.size.height },
                          ...(g.locked ? { locked: true } : {}),
                      }))
                      .sort(byKeys(g => g.id)),
              }
            : {}),
        ...(schedules.length ? { schedules: [...schedules].sort(byKeys(s => s.id)).map(scheduleToYaml) } : {}),
        ...(webhooks.length ? { webhooks: [...webhooks].sort(byKeys(w => w.id)).map(webhookToYaml) } : {}),
    });
}

function triggerList<T>(
    value: unknown,
    kind: TriggerKind,
    read: (item: Record<string, unknown>, at: string) => T | string,
): RepoFileResult<T[]> {
    if (value === undefined) {
        return { ok: true, value: [] };
    }
    if (!Array.isArray(value)) {
        return { ok: false, errors: [`"${kind}s" is a list.`] };
    }
    const items: T[] = [];
    const errors: string[] = [];
    value.forEach((item, i) => {
        const at = `${kind[0]!.toUpperCase()}${kind.slice(1)} ${i + 1}`;
        const trigger = isObject(item) ? read(item, at) : `${at} is not a ${kind}.`;
        if (typeof trigger === 'string') {
            errors.push(trigger);
        } else {
            items.push(trigger);
        }
    });
    return errors.length ? { ok: false, errors } : { ok: true, value: items };
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const noTriggerId = (at: string) => `${at} has no id: add one, such as "id: ${crypto.randomUUID()}".`;

function readSchedule(data: Record<string, unknown>, at: string): RepoSchedule | string {
    const { id, cron, timezone, misfire = DEFAULT_MISFIRE, parameters = {}, input } = data;
    if (!isText(id)) {
        return noTriggerId(at);
    }
    if (!isText(cron) || !isText(timezone)) {
        return `${at} has no cron or no timezone.`;
    }
    if (!MISFIRE_MODES.includes(misfire as MisfireMode)) {
        return `${at}: "misfire" is one of ${MISFIRE_MODES.join(', ')}.`;
    }
    if (!isObject(parameters) || Object.values(parameters).some(v => typeof v !== 'string')) {
        return `${at}: "parameters" are names and texts.`;
    }
    return {
        id,
        cron,
        timezone,
        misfire: misfire as MisfireMode,
        parameters: parameters as Record<string, string>,
        ...(input === undefined ? {} : { input }),
    };
}

function readWebhook(data: Record<string, unknown>, at: string): RepoWebhook | string {
    const { id, name, response = DEFAULT_WEBHOOK_RESPONSE } = data;
    if (!isText(id)) {
        return noTriggerId(at);
    }
    if (!isText(name)) {
        return `${at} has no name.`;
    }
    if (!WEBHOOK_RESPONSES.includes(response as WebhookResponse)) {
        return `${at}: "response" is one of ${WEBHOOK_RESPONSES.join(', ')}.`;
    }
    return { id, name, response: response as WebhookResponse };
}

export function repoFlowFromYaml(text: string, name: string): RepoFileResult<RepoFlow> {
    const read = readObject(text, 'flow');
    if (!read.ok) {
        return read;
    }
    const { deployed = true, schedules: scheduleData, webhooks: webhookData, ...data } = read.value;
    if (!hasId(data)) {
        return missingId('flow');
    }
    if (typeof deployed !== 'boolean') {
        return { ok: false, errors: ['"deployed" is true or false.'] };
    }
    const nodes = Array.isArray(data.nodes) ? data.nodes.map(n => (isObject(n) ? { ...n, pinned: undefined } : n)) : data.nodes;
    const flow = validateFlowFile({ ...data, nodes, name });
    const schedules = triggerList(scheduleData, 'schedule', readSchedule);
    const webhooks = triggerList(webhookData, 'webhook', readWebhook);
    const errors = [flow, schedules, webhooks].flatMap(r => (r.ok ? [] : r.errors));
    return flow.ok && schedules.ok && webhooks.ok
        ? { ok: true, value: { flow: flow.value, deployed, schedules: schedules.value, webhooks: webhooks.value } }
        : { ok: false, errors };
}
