import { expect, test } from 'bun:test';
import { flowResources, type FlowFile } from '../../src/index';

const flow = (nodes: unknown[]): FlowFile => ({ name: 'F', nodes, edges: [] }) as unknown as FlowFile;

test('what a flow takes from its workspace: the profiles it picks, the secrets its fields name and its expressions read, the variables', () => {
    const used = flowResources(
        flow([
            { id: 'q', type: 'sqlserver', position: { x: 0, y: 0 }, config: { connection: 'c1', query: 'SELECT 1' } },
            {
                id: 'h',
                type: 'http-request',
                position: { x: 0, y: 0 },
                config: { connection: '$dynamic', connectionName: '$name', url: '`${$VARIABLES.baseUrl}/x`' },
            },
            {
                id: 'm',
                type: 'mapper',
                position: { x: 0, y: 0 },
                config: { fields: [{ target: 't', value: `$SECRETS.token + SECRETS['api-key'] + VARIABLES["region"]`, expression: true }] },
            },
        ]),
    );
    expect(used).toEqual({ connectionIds: ['c1'], secrets: ['api-key', 'token'], variables: ['baseUrl', 'region'] });
});
