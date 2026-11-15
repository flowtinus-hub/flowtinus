import type { ExpressionField } from '#types/expression-field.type';
import type { SettingField } from '#types/setting-field.type';
import { connectionType, visibleFields, type ConnectionField, type ConnectionTypeName } from './types/connection-types';

export const CONNECTION_KEY = 'connection';
export const DYNAMIC_CONNECTION = '$dynamic';
export const CONNECTION_NAME_KEY = 'connectionName';
export const CONNECTION_NAME_VARIABLES = ['$PARAMETERS', '$VARIABLES', '$SECRETS'];

export function connectionNameReads(expression: string): string[] {
    const names = new Set(expression.match(/\$[A-Za-z_][\w$]*/g) ?? []);
    return [...names].filter(n => !CONNECTION_NAME_VARIABLES.includes(n));
}

export const INLINE_FIELDS: Partial<Record<ConnectionTypeName, string[]>> = {
    sqlserver: ['host', 'port', 'database', 'user', 'password', 'encrypt', 'trustServerCertificate'],
    redshift: ['host', 'port', 'database', 'user', 'password', 'ssl'],
    mongodb: ['connectionString'],
    'http-client': ['auth', 'token', 'apiKeyHeader', 'apiKey'],
};

const forFields = { key: 'connectWith', values: ['fields'] };

const SQL_SERVER_MODES: { first: ConnectionField[]; last: ConnectionField[] } = {
    first: [
        {
            key: 'connectWith',
            label: 'Connect with',
            kind: 'select',
            required: true,
            default: 'fields',
            options: [
                { value: 'fields', label: 'Fields' },
                { value: 'string', label: 'Connection string' },
            ],
        },
    ],
    last: [
        {
            key: 'connectionString',
            label: 'Connection string',
            kind: 'secret',
            required: true,
            when: { key: 'connectWith', values: ['string'] },
        },
    ],
};

/** the API connection types an HTTP request can use: their authentication goes on its requests (SOAP is apart) */
export const API_CONNECTION_TYPES: ConnectionTypeName[] = ['http-client', 'rest-basic', 'rest-oauth2'];

export type ConnectionProfileData = { name?: string; type: string; config: Record<string, string> };
export type ConnectionUse = { profile: string } | { inline: Record<string, string> };
export type ResolvedConnection = { type: ConnectionTypeName; config: Record<string, string>; secrets: Record<string, string> };

export function inlineFields(type: ConnectionTypeName): ConnectionField[] {
    const fields = connectionType(type).fields.filter(f => INLINE_FIELDS[type]?.includes(f.key));
    if (type !== 'sqlserver') {
        return fields;
    }
    return [...SQL_SERVER_MODES.first, ...fields.map(f => ({ ...f, when: f.when ?? forFields })), ...SQL_SERVER_MODES.last];
}

const applying = (fields: ConnectionField[], config: Record<string, string>) =>
    fields.filter(field => !field.when || field.when.values.includes(config[field.when.key] ?? ''));

const noProfile = { key: CONNECTION_KEY, values: [''] };

const toSetting = (f: ConnectionField): SettingField => ({
    key: f.key,
    label: f.label,
    kind: f.kind === 'textarea' ? 'code' : f.kind,
    required: f.required,
    default: f.default,
    placeholder: f.placeholder,
    options: f.options,
    when: f.when ? [noProfile, f.when] : noProfile,
});

export function connectionSettings(
    type: ConnectionTypeName,
    accepted: ConnectionTypeName[] = [type],
    label = 'Connection',
    dynamic = true,
): SettingField[] {
    const picker: SettingField = {
        key: CONNECTION_KEY,
        label,
        kind: 'connection',
        connectionType: type,
        connectionTypes: accepted,
        default: '',
        ...(dynamic ? { connectionDynamic: true } : {}),
    };
    const byName: SettingField[] = dynamic
        ? [
              {
                  key: CONNECTION_NAME_KEY,
                  label: 'Connection name',
                  kind: 'value',
                  required: true,
                  default: { value: '', expression: true },
                  placeholder: "'Orders_' + $PARAMETERS.env",
                  description:
                      'The name of a connection of the workspace, from $PARAMETERS, $VARIABLES and $SECRETS only: the same for every envelope. To use another connection per item, call a flow (Flow Invoker) with the name as a parameter.',
                  when: { key: CONNECTION_KEY, values: [DYNAMIC_CONNECTION] },
              },
          ]
        : [];
    return [picker, ...byName, ...inlineFields(type).map(toSetting)];
}

export function dynamicConnection(config: Record<string, unknown>): ExpressionField | undefined {
    if (config[CONNECTION_KEY] !== DYNAMIC_CONNECTION) {
        return undefined;
    }
    const f = config[CONNECTION_NAME_KEY] as Partial<ExpressionField> | undefined;
    return { value: typeof f?.value === 'string' ? f.value : '', expression: typeof f?.expression === 'boolean' ? f.expression : true };
}

export function connectionUse(type: ConnectionTypeName, config: Record<string, unknown>): ConnectionUse {
    const id = typeof config[CONNECTION_KEY] === 'string' ? (config[CONNECTION_KEY] as string).trim() : '';
    if (id) {
        return { profile: id };
    }
    return { inline: Object.fromEntries(inlineFields(type).map(f => [f.key, String(config[f.key] ?? f.default ?? '').trim()])) };
}

export const usesProfile = (type: ConnectionTypeName, config: Record<string, unknown>) => 'profile' in connectionUse(type, config);

export function connectionIssues(type: ConnectionTypeName, config: Record<string, unknown>): string[] {
    const dynamic = dynamicConnection(config);
    if (dynamic) {
        if (!dynamic.value.trim()) {
            return ['has no connection name.'];
        }
        const reads = dynamic.expression ? connectionNameReads(dynamic.value) : [];
        return reads.length
            ? [
                  `has a connection name that reads ${reads.join(', ')}: it may only use $PARAMETERS, $VARIABLES and $SECRETS (a component's connection is the same for every envelope; to use another per item, call a flow with a Flow Invoker and pass the name as a parameter).`,
              ]
            : [];
    }
    const use = connectionUse(type, config);
    if ('profile' in use) {
        return [];
    }
    const missing = applying(inlineFields(type), use.inline).filter(f => f.required && !use.inline[f.key]);
    if (missing.length === 0) {
        return [];
    }
    return [`has no connection (choose one, or fill in ${missing.map(f => f.label.toLowerCase()).join(', ')}).`];
}

/** a profile by its id or, failing that, by its name (unique in the workspace, whatever the case) */
export function findProfile(
    profiles: Record<string, ConnectionProfileData> | undefined,
    ref: string,
): { id: string; profile: ConnectionProfileData } | undefined {
    if (!profiles) {
        return undefined;
    }
    if (profiles[ref]) {
        return { id: ref, profile: profiles[ref] };
    }
    const name = ref.trim().toLowerCase();
    const found = Object.entries(profiles).find(([, p]) => p.name?.trim().toLowerCase() === name);
    return found && { id: found[0], profile: found[1] };
}

export function resolveConnection(
    type: ConnectionTypeName,
    use: ConnectionUse,
    profiles: Record<string, ConnectionProfileData> | undefined,
    secrets: Record<string, string> | undefined,
    accepted: ConnectionTypeName[] = [type],
): ResolvedConnection {
    let config: Record<string, string>;
    let fields: ConnectionField[];
    if ('profile' in use) {
        const profile = findProfile(profiles, use.profile)?.profile;
        if (!profile) {
            throw new Error(`The connection "${use.profile}" does not exist in this runner.`);
        }
        if (!accepted.includes(profile.type as ConnectionTypeName)) {
            throw new Error(
                `The connection "${profile.name ?? use.profile}" is not a ${accepted.map(t => connectionType(t).label).join(' or ')} connection.`,
            );
        }
        type = profile.type as ConnectionTypeName;
        config = profile.config;
        fields = visibleFields(type, config);
    } else {
        config = use.inline;
        fields = applying(inlineFields(type), config);
    }
    const values: Record<string, string> = {};
    for (const field of fields.filter(f => f.kind === 'secret' && config[f.key])) {
        const name = config[field.key] as string;
        const value = secrets?.[name];
        if (value === undefined) {
            throw new Error(`The secret "${name}" does not exist in this runner.`);
        }
        values[field.key] = value;
    }
    return { type, config, secrets: values };
}

const sqlValue = (value: string) => (/[;{}=]|^\s|\s$/.test(value) ? `{${value.replace(/}/g, '}}')}}` : value);

export function connectionString(connection: ResolvedConnection): string {
    const { config, secrets } = connection;
    switch (connection.type) {
        case 'mongodb':
            return secrets.connectionString ?? '';
        case 'sqlserver':
            if (config.connectWith === 'string') {
                return secrets.connectionString ?? '';
            }
            return [
                `Server=${sqlValue(`${config.host ?? ''},${config.port || '1433'}`)}`,
                `Database=${sqlValue(config.database ?? '')}`,
                `User Id=${sqlValue(config.user ?? '')}`,
                `Password=${sqlValue(secrets.password ?? '')}`,
                `Encrypt=${config.encrypt !== 'off'}`,
                `TrustServerCertificate=${config.trustServerCertificate === 'on'}`,
            ].join(';');
        case 'redshift': {
            // a postgres:// URL (Redshift speaks the Postgres protocol); SSL on unless the profile turns it off
            const part = (value: string | undefined) => encodeURIComponent(value ?? '');
            const ssl = config.ssl === 'off' ? 'disable' : 'require';
            return `postgres://${part(config.user)}:${part(secrets.password)}@${config.host ?? ''}:${config.port || '5439'}/${part(config.database)}?sslmode=${ssl}`;
        }
        default:
            throw new Error(`A ${connectionType(connection.type).label} connection has no connection string.`);
    }
}

/** text as base64, as UTF-8 (a user name with an accent goes as it is) */
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

export function connectionHeaders(connection: ResolvedConnection, oauthAccessToken?: string): Record<string, string> {
    const { type, config, secrets } = connection;
    const headers: Record<string, string> = {};
    for (const line of (config.headers ?? '').split('\n')) {
        const at = line.indexOf(':');
        if (at > 0) {
            headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
    }
    if (type === 'rest-basic') {
        headers.Authorization = `Basic ${base64(`${config.user ?? ''}:${secrets.password ?? ''}`)}`;
    }
    if (type === 'rest-oauth2' && oauthAccessToken) {
        headers.Authorization = `Bearer ${oauthAccessToken}`;
    }
    if (type === 'http-client' && config.auth === 'bearer' && secrets.token) {
        headers.Authorization = `Bearer ${secrets.token}`;
    }
    if (type === 'http-client' && config.auth === 'apiKey' && secrets.apiKey) {
        headers[config.apiKeyHeader?.trim() || 'X-API-Key'] = secrets.apiKey;
    }
    return headers;
}

export type OAuthToken = { accessToken: string; expiresAt: number };

/** a token is renewed this long before it expires, so a request does not go with one about to end */
const TOKEN_MARGIN_MS = 30_000;

export const tokenStillGood = (token: OAuthToken | undefined, now = Date.now()): token is OAuthToken =>
    !!token && token.expiresAt - TOKEN_MARGIN_MS > now;

/**
 * An OAuth 2.0 connection's access token (client credentials): asked from its token URL with the client id and secret
 * (form-encoded, as RFC 6749 says), with the scopes and the audience when set. The authorization code grant needs a
 * person to log in: not in a run.
 */
export async function oauthToken(
    connection: ResolvedConnection,
    send: (request: {
        method: string;
        url: string;
        headers: Record<string, string>;
        body: string;
    }) => Promise<{ status: number; body: string }>,
    now = Date.now(),
): Promise<OAuthToken> {
    const { config, secrets } = connection;
    if (config.grant === 'authorizationCode') {
        throw new Error('An OAuth 2.0 connection with the authorization code grant cannot be used in a run yet; use client credentials.');
    }
    const form = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId ?? '',
        client_secret: secrets.clientSecret ?? '',
    });
    if (config.scopes?.trim()) {
        form.set('scope', config.scopes.trim());
    }
    if (config.audience?.trim()) {
        form.set('audience', config.audience.trim());
    }
    const response = await send({
        method: 'POST',
        url: config.tokenUrl ?? '',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
    });
    let answer: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } = {};
    try {
        answer = JSON.parse(response.body) as typeof answer;
    } catch {
        // not JSON: no token below
    }
    if (response.status < 200 || response.status >= 300 || typeof answer.access_token !== 'string') {
        // the provider's reason (RFC 6749: error, error_description), or the start of its answer
        const reason =
            [answer.error, answer.error_description].filter(v => typeof v === 'string' && v).join(': ') ||
            response.body.slice(0, 200).trim();
        throw new Error(
            `The OAuth 2.0 token request to ${config.tokenUrl} failed (HTTP ${response.status})${reason ? `: ${reason}` : ''}.`,
        );
    }
    const seconds = Number(answer.expires_in);
    return { accessToken: answer.access_token, expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000 };
}
