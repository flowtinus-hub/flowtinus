import type { ConnectionType } from './connection-types';
import { select } from './connection-fields';

export const KAFKA_CONNECTION_TYPE: ConnectionType = {
    type: 'kafka',
    label: 'Kafka',
    group: 'messaging',
    description: 'A Kafka cluster. No component uses it yet.',
    fields: [
        {
            key: 'bootstrapServers',
            label: 'Bootstrap servers (comma separated)',
            kind: 'text',
            required: true,
            placeholder: 'broker1:9092,broker2:9092',
        },
        select(
            'security',
            'Security protocol',
            [
                ['PLAINTEXT', 'PLAINTEXT'],
                ['SSL', 'SSL'],
                ['SASL_SSL', 'SASL_SSL'],
            ],
            'SASL_SSL',
        ),
        select(
            'mechanism',
            'SASL mechanism',
            [
                ['PLAIN', 'PLAIN'],
                ['SCRAM-SHA-256', 'SCRAM-SHA-256'],
                ['SCRAM-SHA-512', 'SCRAM-SHA-512'],
            ],
            'PLAIN',
            { key: 'security', values: ['SASL_SSL'] },
        ),
        { key: 'user', label: 'Username', kind: 'text', required: true, when: { key: 'security', values: ['SASL_SSL'] } },
        { key: 'password', label: 'Password', kind: 'secret', required: true, when: { key: 'security', values: ['SASL_SSL'] } },
        { key: 'clientId', label: 'Client ID', kind: 'text' },
    ],
    summary: config => config.bootstrapServers ?? '',
};
