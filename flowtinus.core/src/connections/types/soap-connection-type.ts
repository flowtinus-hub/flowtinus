import type { ConnectionType } from './connection-types';
import { select } from './connection-fields';

export const SOAP_CONNECTION_TYPE: ConnectionType = {
    type: 'soap',
    label: 'SOAP',
    group: 'api',
    description: 'A SOAP service (basic or WS-Security authentication). No component uses it yet.',
    fields: [
        select(
            'auth',
            'Authentication',
            [
                ['none', 'None'],
                ['basic', 'Basic'],
                ['wsSecurity', 'WS-Security username token'],
            ],
            'none',
        ),
        { key: 'user', label: 'Username', kind: 'text', required: true, when: { key: 'auth', values: ['basic', 'wsSecurity'] } },
        { key: 'password', label: 'Password', kind: 'secret', required: true, when: { key: 'auth', values: ['basic', 'wsSecurity'] } },
    ],
    summary: config =>
        ({
            none: 'No authentication',
            basic: `Basic, user ${config.user ?? ''}`,
            wsSecurity: `WS-Security, user ${config.user ?? ''}`,
        })[config.auth ?? 'none'] ?? '',
};
