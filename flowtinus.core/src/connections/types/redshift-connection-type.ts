import type { ConnectionType } from './connection-types';
import { database, join, onOff } from './connection-fields';

export const REDSHIFT_CONNECTION_TYPE: ConnectionType = {
    type: 'redshift',
    label: 'Amazon Redshift',
    group: 'database',
    description:
        'An Amazon Redshift database. Used by the Redshift components (Query, Insert, Upsert, Delete, Execute). Its Test connection says which server it reaches (kept with the profile): one that answers as PostgreSQL gets a warning, since SQL written for one may not run on the other.',
    fields: database('5439', [onOff('ssl', 'SSL', 'on')]),
    summary: config => join(config.host, config.database),
};
