import type { ConnectionField } from './connection-types';

/** the fields and helpers more than one connection type shares */

export const select = (
    key: string,
    label: string,
    options: ([string, string] | [string, string, true])[],
    fallback: string,
    when?: ConnectionField['when'],
): ConnectionField => ({
    key,
    label,
    kind: 'select',
    required: true,
    default: fallback,
    options: options.map(([value, text, disabled]) => ({ value, label: text, ...(disabled ? { disabled } : {}) })),
    when,
});

export const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' / ');

export const onOff = (key: string, label: string, fallback: 'on' | 'off'): ConnectionField =>
    select(
        key,
        label,
        [
            ['on', 'Enabled'],
            ['off', 'Disabled'],
        ],
        fallback,
    );

export const headers: ConnectionField = { key: 'headers', label: 'Default headers (one "Name: value" per line)', kind: 'textarea' };

export const database = (defaultPort: string, extra: ConnectionField[] = []): ConnectionField[] => [
    { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'db.example.com' },
    { key: 'port', label: 'Port', kind: 'number', required: true, default: defaultPort },
    { key: 'database', label: 'Database', kind: 'text', required: true },
    { key: 'user', label: 'User', kind: 'text', required: true },
    { key: 'password', label: 'Password', kind: 'secret', required: true },
    ...extra,
];

export const awsKeys: ConnectionField[] = [
    { key: 'accessKeyId', label: 'Access key ID', kind: 'text', required: true },
    { key: 'secretAccessKey', label: 'Secret access key', kind: 'secret', required: true },
];

export const region: ConnectionField = { key: 'region', label: 'Region', kind: 'text', required: true, placeholder: 'us-east-1' };
