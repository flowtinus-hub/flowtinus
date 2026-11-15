import type { ConnectionType } from './connection-types';
import { join } from './connection-fields';

export const GCS_CONNECTION_TYPE: ConnectionType = {
    type: 'gcs',
    label: 'Google Cloud Storage',
    group: 'storage',
    description: 'A Google Cloud Storage bucket. No component uses it yet.',
    fields: [
        { key: 'projectId', label: 'Project ID', kind: 'text', required: true },
        { key: 'bucket', label: 'Bucket', kind: 'text', required: true },
        { key: 'serviceAccountKey', label: 'Service account key (JSON)', kind: 'secret', required: true },
    ],
    summary: config => join(config.bucket, config.projectId),
};
