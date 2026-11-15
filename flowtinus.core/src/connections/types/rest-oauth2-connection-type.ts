import type { ConnectionType } from './connection-types';
import { join, select } from './connection-fields';

export const REST_OAUTH2_CONNECTION_TYPE: ConnectionType = {
    type: 'rest-oauth2',
    label: 'REST OAuth 2.0',
    group: 'api',
    description:
        'A REST API with OAuth 2.0 client credentials: the token is fetched and cached by the runner. Used by the HTTP Request component.',
    fields: [
        // the authorization code grant needs a person to log in (a Connect in the profile): not in a run yet
        select(
            'grant',
            'Grant type',
            [
                ['clientCredentials', 'Client credentials'],
                ['authorizationCode', 'Authorization code (soon)', true],
            ],
            'clientCredentials',
        ),
        {
            key: 'authorizeUrl',
            label: 'Authorization URL',
            kind: 'text',
            required: true,
            when: { key: 'grant', values: ['authorizationCode'] },
        },
        {
            key: 'tokenUrl',
            label: 'Token URL',
            kind: 'text',
            required: true,
            placeholder: 'https://auth.example.com/oauth/token',
        },
        { key: 'clientId', label: 'Client ID', kind: 'text', required: true },
        { key: 'clientSecret', label: 'Client secret', kind: 'secret', required: true },
        { key: 'scopes', label: 'Scopes (space separated)', kind: 'text' },
        { key: 'audience', label: 'Audience', kind: 'text' },
    ],
    summary: config => join(config.grant === 'authorizationCode' ? 'Authorization code' : 'Client credentials', config.clientId),
};
