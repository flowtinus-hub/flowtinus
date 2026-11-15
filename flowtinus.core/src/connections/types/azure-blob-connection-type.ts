import type { ConnectionType } from './connection-types';
import { join, select } from './connection-fields';

export const AZURE_BLOB_CONNECTION_TYPE: ConnectionType = {
    type: 'azure-blob',
    label: 'Azure Blob Storage',
    group: 'storage',
    description: 'An Azure Blob Storage container. No component uses it yet.',
    fields: [
        select(
            'auth',
            'Authentication',
            [
                ['connectionString', 'Connection string'],
                ['accountKey', 'Account name and key'],
                ['sas', 'SAS token'],
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
        { key: 'account', label: 'Account name', kind: 'text', required: true, when: { key: 'auth', values: ['accountKey', 'sas'] } },
        { key: 'accountKey', label: 'Account key', kind: 'secret', required: true, when: { key: 'auth', values: ['accountKey'] } },
        { key: 'sasToken', label: 'SAS token', kind: 'secret', required: true, when: { key: 'auth', values: ['sas'] } },
        { key: 'container', label: 'Container', kind: 'text', required: true },
    ],
    summary: config => join(config.account, config.container),
};
