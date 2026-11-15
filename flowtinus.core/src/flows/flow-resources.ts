import { componentSettings } from '#components/settings';
import { CONNECTION_KEY, DYNAMIC_CONNECTION } from '../connections/connection-access';
import type { FlowFile } from './flow-file';

/**
 * What a flow takes from its workspace: the connection profiles its components pick (by id), the secrets their own
 * fields name, and the secrets and variables its expressions and scripts read ($SECRETS.name, SECRETS['name'],
 * $VARIABLES.name...). A profile named by an expression (an HTTP Request's dynamic connection) is not known here.
 * Disabled components count too: they may be turned on again.
 */
export type FlowResources = { connectionIds: string[]; secrets: string[]; variables: string[] };

// $SECRETS.name (a JavaScript name) or SECRETS['name'] (any name), with or without the $
const QUOTE = `['"\`]`;
const READ = (root: 'SECRETS' | 'VARIABLES') =>
    new RegExp(String.raw`\$?\b${root}(?:\.([A-Za-z_$][\w$]*)|\[\s*(${QUOTE})(.+?)\2\s*\])`, 'g');
const SECRET_READS = READ('SECRETS');
const VARIABLE_READS = READ('VARIABLES');

function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') {
        out.push(value);
    } else if (Array.isArray(value)) {
        value.forEach(v => strings(v, out));
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(v => strings(v, out));
    }
    return out;
}

function reads(texts: string[], pattern: RegExp): string[] {
    const found = new Set<string>();
    for (const text of texts) {
        for (const match of text.matchAll(pattern)) {
            found.add(match[1] ?? match[3]!);
        }
    }
    return [...found];
}

export function flowResources(flow: FlowFile): FlowResources {
    const connectionIds = new Set<string>();
    const secrets = new Set<string>();
    for (const node of flow.nodes) {
        for (const setting of componentSettings(node.type)) {
            const value = node.config[setting.key ?? CONNECTION_KEY];
            if (typeof value !== 'string' || !value.trim()) {
                continue;
            }
            if (setting.kind === 'connection' && value !== DYNAMIC_CONNECTION) {
                connectionIds.add(value.trim());
            } else if (setting.kind === 'secret') {
                secrets.add(value.trim());
            }
        }
    }

    const texts = strings(flow.nodes.map(n => n.config));
    reads(texts, SECRET_READS).forEach(name => secrets.add(name));
    return { connectionIds: [...connectionIds], secrets: [...secrets].sort(), variables: reads(texts, VARIABLE_READS).sort() };
}
