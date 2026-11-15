import type { ConnectionType } from './connection-types';
import { database, join } from './connection-fields';

export const MYSQL_CONNECTION_TYPE: ConnectionType = {
    type: 'mysql',
    label: 'MySQL',
    group: 'database',
    description: 'A MySQL database. No component uses it yet.',
    fields: database('3306'),
    summary: config => join(config.host, config.database),
};
