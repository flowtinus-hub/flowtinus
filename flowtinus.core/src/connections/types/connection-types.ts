import { REST_BASIC_CONNECTION_TYPE } from './rest-basic-connection-type';
import { REST_OAUTH2_CONNECTION_TYPE } from './rest-oauth2-connection-type';
import { HTTP_CLIENT_CONNECTION_TYPE } from './http-client-connection-type';
import { SOAP_CONNECTION_TYPE } from './soap-connection-type';
import { S3_CONNECTION_TYPE } from './s3-connection-type';
import { AZURE_BLOB_CONNECTION_TYPE } from './azure-blob-connection-type';
import { GCS_CONNECTION_TYPE } from './gcs-connection-type';
import { SFTP_CONNECTION_TYPE } from './sftp-connection-type';
import { POSTGRESQL_CONNECTION_TYPE } from './postgresql-connection-type';
import { SQLSERVER_CONNECTION_TYPE } from './sqlserver-connection-type';
import { MYSQL_CONNECTION_TYPE } from './mysql-connection-type';
import { MONGODB_CONNECTION_TYPE } from './mongodb-connection-type';
import { REDSHIFT_CONNECTION_TYPE } from './redshift-connection-type';
import { KAFKA_CONNECTION_TYPE } from './kafka-connection-type';
import { RABBITMQ_CONNECTION_TYPE } from './rabbitmq-connection-type';
import { AZURE_SERVICE_BUS_CONNECTION_TYPE } from './azure-service-bus-connection-type';
import { SQS_CONNECTION_TYPE } from './sqs-connection-type';

export type FieldKind = 'text' | 'number' | 'textarea' | 'select' | 'secret';

export type ConnectionField = {
    key: string;
    label: string;
    kind: FieldKind;
    required?: boolean;
    default?: string;
    placeholder?: string;
    /** for selects; `disabled`: shown, not selectable yet (a profile saved with it still shows it) */
    options?: { value: string; label: string; disabled?: boolean }[];
    when?: { key: string; values: string[] };
};

export type ConnectionGroup = 'api' | 'storage' | 'database' | 'messaging';

export const CONNECTION_GROUPS: { group: ConnectionGroup; label: string }[] = [
    { group: 'api', label: 'APIs' },
    { group: 'storage', label: 'Storage' },
    { group: 'database', label: 'Databases' },
    { group: 'messaging', label: 'Messaging' },
];

export type ConnectionTypeName =
    | 'rest-basic'
    | 'rest-oauth2'
    | 'http-client'
    | 'soap'
    | 's3'
    | 'azure-blob'
    | 'gcs'
    | 'sftp'
    | 'postgresql'
    | 'sqlserver'
    | 'mysql'
    | 'mongodb'
    | 'redshift'
    | 'kafka'
    | 'rabbitmq'
    | 'azure-service-bus'
    | 'sqs';

export type ConnectionType = {
    type: ConnectionTypeName;
    label: string;
    group: ConnectionGroup;
    description?: string;
    fields: ConnectionField[];
    summary: (config: Record<string, string>) => string;
};

export const CONNECTION_TYPES: ConnectionType[] = [
    // APIs
    REST_BASIC_CONNECTION_TYPE,
    REST_OAUTH2_CONNECTION_TYPE,
    HTTP_CLIENT_CONNECTION_TYPE,
    SOAP_CONNECTION_TYPE,

    // Storage
    S3_CONNECTION_TYPE,
    AZURE_BLOB_CONNECTION_TYPE,
    GCS_CONNECTION_TYPE,
    SFTP_CONNECTION_TYPE,

    // Databases
    POSTGRESQL_CONNECTION_TYPE,
    SQLSERVER_CONNECTION_TYPE,
    MYSQL_CONNECTION_TYPE,
    MONGODB_CONNECTION_TYPE,
    REDSHIFT_CONNECTION_TYPE,

    // Messaging
    KAFKA_CONNECTION_TYPE,
    RABBITMQ_CONNECTION_TYPE,
    AZURE_SERVICE_BUS_CONNECTION_TYPE,
    SQS_CONNECTION_TYPE,
];

export const connectionType = (type: ConnectionTypeName) => CONNECTION_TYPES.find(t => t.type === type)!;

export function typesByGroup(search = ''): { group: ConnectionGroup; label: string; types: ConnectionType[] }[] {
    const term = search.trim().toLowerCase();
    return CONNECTION_GROUPS.map(({ group, label }) => ({
        group,
        label,
        types: CONNECTION_TYPES.filter(
            t => t.group === group && (!term || t.label.toLowerCase().includes(term) || label.toLowerCase().includes(term)),
        ),
    })).filter(g => g.types.length > 0);
}

export const visibleFields = (type: ConnectionTypeName, config: Record<string, string>) =>
    connectionType(type).fields.filter(field => !field.when || field.when.values.includes(config[field.when.key] ?? ''));

export const defaultConfig = (type: ConnectionTypeName): Record<string, string> =>
    Object.fromEntries(
        connectionType(type)
            .fields.filter(f => f.default !== undefined)
            .map(f => [f.key, f.default!]),
    );
