import type { ConnectionType } from './connection-types';

export const SFTP_CONNECTION_TYPE: ConnectionType = {
    type: 'sftp',
    label: 'SFTP',
    group: 'storage',
    description: 'An SFTP server and directory. No component uses it yet.',
    fields: [
        { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'sftp.example.com' },
        { key: 'port', label: 'Port', kind: 'number', required: true, default: '22' },
        { key: 'user', label: 'User', kind: 'text', required: true },
        { key: 'privateKey', label: 'Password or private key', kind: 'secret', required: true },
        { key: 'directory', label: 'Directory', kind: 'text', default: '/' },
    ],
    summary: config => config.host ?? '',
};
