import type { ConnectionType } from './connection-types';
import { headers } from './connection-fields';

export const REST_BASIC_CONNECTION_TYPE: ConnectionType = {
    type: 'rest-basic',
    label: 'REST Basic Authentication',
    group: 'api',
    description: 'A REST API with HTTP Basic authentication (user and password). Used by the HTTP Request component.',
    fields: [
        { key: 'user', label: 'Username', kind: 'text', required: true },
        { key: 'password', label: 'Password', kind: 'secret', required: true },
        headers,
    ],
    summary: config => (config.user ? `User ${config.user}` : ''),
};
