import type { ConnectionType } from './connection-types';
import { database, join, onOff } from './connection-fields';

export const SQLSERVER_CONNECTION_TYPE: ConnectionType = {
    type: 'sqlserver',
    label: 'SQL Server',
    group: 'database',
    description: 'A SQL Server database. Used by the SQL Server Query component.',
    fields: database('1433', [onOff('encrypt', 'Encrypt', 'on'), onOff('trustServerCertificate', 'Trust server certificate', 'off')]),
    summary: config => join(config.host, config.database),
};
