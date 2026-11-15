import type { ConnectionType } from './connection-types';

export const MONGODB_CONNECTION_TYPE: ConnectionType = {
    type: 'mongodb',
    label: 'MongoDB',
    group: 'database',
    description: 'A MongoDB database (a connection string kept as a secret). Used by the MongoDB Pipeline, Upsert and Delete components.',
    fields: [
        { key: 'connectionString', label: 'Connection string', kind: 'secret', required: true },
        { key: 'database', label: 'Database', kind: 'text', required: true },
    ],
    summary: config => config.database ?? '',
};
