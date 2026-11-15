import type { ConnectionType } from './connection-types';
import { awsKeys, join, region } from './connection-fields';

export const S3_CONNECTION_TYPE: ConnectionType = {
    type: 's3',
    label: 'Amazon S3',
    group: 'storage',
    description: 'An Amazon S3 (or S3-compatible) bucket. No component uses it yet.',
    fields: [
        region,
        { key: 'bucket', label: 'Bucket', kind: 'text', required: true },
        ...awsKeys,
        { key: 'endpoint', label: 'Endpoint (S3-compatible storage)', kind: 'text' },
    ],
    summary: config => join(config.bucket, config.region),
};
