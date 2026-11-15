import { connectionServerWarning, connectionType, isConnectionType, serverOfVersion, validateProfile, type ConnectionTypeName, type DetectedServer } from '@flowtinus/core';
import { workspaceSecrets } from '#features/secrets/secret-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { safeMessage, type ConnectionTest } from './connection-test';
import { MongoDbConnectionTest } from './mongodb-connection-test';
import { RestOAuth2ConnectionTest } from './rest-oauth2-connection-test';
import { SqlServerConnectionTest } from './sqlserver-connection-test';
import { RedshiftConnectionTest } from './redshift-connection-test';

export type TestConnectionResponse = { message: string; ms: number; server?: DetectedServer; warning?: string };

export type ConnectionTests = Partial<Record<ConnectionTypeName, ConnectionTest>>;

export const LIVE_TESTS: ConnectionTests = {
    mongodb: new MongoDbConnectionTest(),
    sqlserver: new SqlServerConnectionTest(),
    redshift: new RedshiftConnectionTest(),
    'rest-oauth2': new RestOAuth2ConnectionTest(),
};

/** an API profile holds how to get in, not what to call: the HTTP Request that uses it sets the URL */
const NOTHING_TO_CALL: ConnectionTypeName[] = ['rest-basic', 'http-client'];

export const untestedMessage = (type: ConnectionTypeName) =>
    NOTHING_TO_CALL.includes(type)
        ? 'Complete. Nothing to call yet: the HTTP Request that uses it sets the URL.'
        : "Complete. A live test comes with this connection's component.";

export async function testProfile(
    ctx: UseCaseContext,
    tests: ConnectionTests,
    fields: { type: string; config: Record<string, string> },
    newSecrets: { name: string; value: string }[] = [],
): Promise<UseCaseResult<TestConnectionResponse>> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    if (!isConnectionType(fields.type)) {
        return fail('validation', `Unknown connection type "${fields.type}".`, { type: 'Unknown type' });
    }

    const stored = await workspaceSecrets(ctx.db, ctx.workspaceId);
    const typed = newSecrets.filter(s => s.value !== '');
    const { value, errors } = validateProfile(
        { name: 'test', type: fields.type, config: fields.config },
        [],
        [...stored.map(s => s.name), ...typed.map(s => s.name)],
    );
    const problems = Object.entries(errors).map(([field, error]) => `${field}: ${error}`);
    if (problems.length > 0) {
        return fail('validation', `Incomplete: ${problems.join('; ')}.`, errors);
    }

    const live = tests[fields.type];
    if (!live) {
        return success({ message: untestedMessage(fields.type), ms: ms() });
    }

    const secrets: Record<string, string> = {};
    for (const field of connectionType(fields.type).fields.filter(f => f.kind === 'secret' && value.config[f.key])) {
        const name = value.config[field.key];
        const fresh = typed.find(s => s.name === name);
        if (fresh) {
            secrets[field.key] = fresh.value;
            continue;
        }

        if (!ctx.keyring) {
            return fail('unavailable', 'No keyring: the secrets cannot be read to connect.');
        }

        const secret = stored.find(s => s.name === name)!;
        secrets[field.key] = await ctx.keyring.decrypt(secret, secret.id, secret.name);
    }

    try {
        const reached = await live.test({ config: value.config, secrets });
        if (typeof reached !== 'string') {
            return success({ message: reached.message, ms: ms() });
        }
        const server = serverOfVersion(reached);
        const warning = connectionServerWarning(fields.type, server);
        return success({ message: `Connected to ${reached}.`, ms: ms(), ...(server ? { server } : {}), ...(warning ? { warning } : {}) });
    } catch (error) {
        return fail('unavailable', safeMessage(error, Object.values(secrets)));
    }
}
