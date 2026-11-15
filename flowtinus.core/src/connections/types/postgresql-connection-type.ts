import type { ConnectionType } from './connection-types';
import { database, join } from './connection-fields';

export const POSTGRESQL_CONNECTION_TYPE: ConnectionType = {
    type: 'postgresql',
    label: 'PostgreSQL',
    group: 'database',
    description: 'A PostgreSQL database. No component uses it yet.',
    fields: database('5432'),
    summary: config => join(config.host, config.database),
};
