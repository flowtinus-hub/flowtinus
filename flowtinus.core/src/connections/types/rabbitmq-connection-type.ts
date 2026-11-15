import type { ConnectionType } from './connection-types';
import { join, onOff } from './connection-fields';

export const RABBITMQ_CONNECTION_TYPE: ConnectionType = {
    type: 'rabbitmq',
    label: 'RabbitMQ',
    group: 'messaging',
    description: 'A RabbitMQ broker. No component uses it yet.',
    fields: [
        { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'rabbit.example.com' },
        { key: 'port', label: 'Port', kind: 'number', required: true, default: '5672' },
        { key: 'vhost', label: 'Virtual host', kind: 'text', default: '/' },
        { key: 'user', label: 'Username', kind: 'text', required: true },
        { key: 'password', label: 'Password', kind: 'secret', required: true },
        onOff('tls', 'TLS', 'off'),
    ],
    summary: config => join(config.host, config.vhost),
};
