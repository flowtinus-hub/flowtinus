import type { ConnectionType } from './connection-types';
import { headers, select } from './connection-fields';

export const HTTP_CLIENT_CONNECTION_TYPE: ConnectionType = {
    type: 'http-client',
    label: 'HTTP Client Account',
    group: 'api',
    description:
        'Any HTTP API: no authentication, a bearer token or an API key header, plus default headers. Used by the HTTP Request component.',
    fields: [
        select(
            'auth',
            'Authentication',
            [
                ['none', 'None'],
                ['bearer', 'Bearer token'],
                ['apiKey', 'API key'],
            ],
            'none',
        ),
        { key: 'token', label: 'Token', kind: 'secret', required: true, when: { key: 'auth', values: ['bearer'] } },
        {
            key: 'apiKeyHeader',
            label: 'Header name',
            kind: 'text',
            required: true,
            default: 'X-API-Key',
            when: { key: 'auth', values: ['apiKey'] },
        },
        { key: 'apiKey', label: 'API key', kind: 'secret', required: true, when: { key: 'auth', values: ['apiKey'] } },
        headers,
        { key: 'timeout', label: 'Timeout (seconds)', kind: 'number', default: '30' },
    ],
    summary: config =>
        ({ none: 'No authentication', bearer: 'Bearer token', apiKey: `API key (${config.apiKeyHeader ?? ''})` })[config.auth ?? 'none'] ??
        '',
};
