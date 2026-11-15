import type { ConnectionType } from './connection-types';
import { select } from './connection-fields';

export const AZURE_SERVICE_BUS_CONNECTION_TYPE: ConnectionType = {
    type: 'azure-service-bus',
    label: 'Azure Service Bus',
    group: 'messaging',
    description: 'An Azure Service Bus namespace. No component uses it yet.',
    fields: [
        { key: 'namespace', label: 'Namespace', kind: 'text', required: true, placeholder: 'my-namespace.servicebus.windows.net' },
        select(
            'auth',
            'Authentication',
            [
                ['connectionString', 'Connection string'],
                ['sasKey', 'SAS key name and key'],
            ],
            'connectionString',
        ),
        {
            key: 'connectionString',
            label: 'Connection string',
            kind: 'secret',
            required: true,
            when: { key: 'auth', values: ['connectionString'] },
        },
        { key: 'keyName', label: 'SAS key name', kind: 'text', required: true, when: { key: 'auth', values: ['sasKey'] } },
        { key: 'key', label: 'SAS key', kind: 'secret', required: true, when: { key: 'auth', values: ['sasKey'] } },
    ],
    summary: config => config.namespace ?? '',
};
