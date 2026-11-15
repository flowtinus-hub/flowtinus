import type { ConnectionType } from './connection-types';
import { awsKeys, region } from './connection-fields';

export const SQS_CONNECTION_TYPE: ConnectionType = {
    type: 'sqs',
    label: 'Amazon SQS',
    group: 'messaging',
    description: 'An Amazon SQS queue. No component uses it yet.',
    fields: [region, { key: 'queueUrl', label: 'Queue URL', kind: 'text', required: true }, ...awsKeys],
    summary: config => config.queueUrl ?? '',
};
