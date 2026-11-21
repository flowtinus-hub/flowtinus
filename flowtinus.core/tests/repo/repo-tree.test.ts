import { describe, expect, test } from 'bun:test';
import { GITATTRIBUTES, connectionToYaml, projectToYaml, repoFlowToYaml, validateWorkspaceTree, workspaceToYaml, type FlowFile, type FlowFileNode } from '../../src/index';

const at = (x: number) => ({ x, y: 0 });

const flow = (id: string, nodes: FlowFileNode[] = []): FlowFile => ({
    version: 1,
    id,
    name: '',
    nodes: [
        { id: 'start', type: 'start', position: at(0), config: {} },
        ...nodes,
        { id: 'end', type: 'end', position: at(900), config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: nodes[0]?.id ?? 'end', targetPort: 'in-0' },
        ...nodes.map((n, i) => ({ source: n.id, sourcePort: 'out-0', target: nodes[i + 1]?.id ?? 'end', targetPort: 'in-0' })),
    ],
});

const LOAD_ORDERS = flow('00000000-0000-4000-8000-00000000f001', [
    { id: 'read', type: 'sqlserver', position: at(100), config: { connection: '00000000-0000-4000-8000-00000000c001', query: 'SELECT 1' } },
    {
        id: 'ts',
        type: 'typescript',
        position: at(200),
        config: {
            code: "import { total } from '@myproject/scripts/lib/totals';\nasync function process($input: Data) {\n  return $SECRETS.token + VARIABLES.region;\n}\n",
        },
    },
    { id: 'call', type: 'flow', position: at(300), config: { flowId: '00000000-0000-4000-8000-00000000f002' } },
]);

const NOTIFY = flow('00000000-0000-4000-8000-00000000f002', [{ id: 'log', type: 'log', position: at(100), config: { message: 'done' } }]);

const W = 'acme';

const validTree = (): Record<string, string> => ({
    '.gitattributes': GITATTRIBUTES,
    'acme/workspace.yaml': workspaceToYaml(),
    'acme/connections/Warehouse.yaml': connectionToYaml({ id: '00000000-0000-4000-8000-00000000c001', type: 'sqlserver' }),
    'acme/projects/Sales/project.yaml': projectToYaml({ id: '00000000-0000-4000-8000-00000000b001', description: '' }),
    'acme/projects/Sales/flows/Daily/Load orders.flow.yaml': repoFlowToYaml(LOAD_ORDERS),
    'acme/projects/Sales/flows/Notify.flow.yaml': repoFlowToYaml(NOTIFY),
    'acme/projects/Sales/flows/Empty/.gitkeep': '',
    'acme/projects/Sales/scripts/lib/totals.ts': 'export const total = 1;\n',
    'other/workspace.yaml': 'format: 9\n',
});

const HERE = { connections: ['00000000-0000-4000-8000-00000000c001'], secrets: ['token'], variables: ['region'] };

const validate = (files: Record<string, string>, here = HERE) => validateWorkspaceTree({ workspace: W, files, environment: here });

describe('the validation of a whole workspace tree', () => {
    test('a consistent tree, with everything configured here, has no errors and no warnings; other workspaces are not read', () => {
        expect(validate(validTree())).toEqual({ errors: [], warnings: [] });
    });
});

const NOTIFY_PATH = 'acme/projects/Sales/flows/Notify.flow.yaml';

const errorsOf = (changes: Record<string, string | undefined>, here = HERE) => {
    const files = { ...validTree(), ...changes };
    for (const [path, text] of Object.entries(changes)) {
        if (text === undefined) {
            delete files[path];
        }
    }
    return validate(files as Record<string, string>, here).errors;
};

describe('errors, which refuse the tree', () => {
    test('a file that is not valid YAML, or that its reader refuses', () => {
        expect(errorsOf({ [NOTIFY_PATH]: 'nodes: [' })).toContainEqual({
            path: NOTIFY_PATH,
            message: expect.stringContaining('Not valid YAML'),
        });
        expect(errorsOf({ 'acme/connections/Warehouse.yaml': 'id: 00000000-0000-4000-8000-00000000c001\ntype: oracle\n' })).toEqual([
            { path: 'acme/connections/Warehouse.yaml', message: 'Unknown connection type "oracle".' },
        ]);
        expect(errorsOf({ 'acme/workspace.yaml': 'format: 2\n' })).toEqual([
            { path: 'acme/workspace.yaml', message: 'Unknown format 2 (this app reads 1).' },
        ]);
        expect(errorsOf({ 'acme/projects/Sales/project.yaml': 'icon: cart\n' })).toEqual([
            { path: 'acme/projects/Sales/project.yaml', message: expect.stringMatching(/^The project has no id/) },
        ]);
    });

    test('a key its schema does not have, at any depth', () => {
        expect(
            errorsOf({ 'acme/connections/Warehouse.yaml': 'id: 00000000-0000-4000-8000-00000000c001\ntype: sqlserver\nhost: db1\n' }),
        ).toEqual([{ path: 'acme/connections/Warehouse.yaml', message: 'Unknown key "host".' }]);
        const notify = repoFlowToYaml(NOTIFY)
            .replace('version: 1', 'version: 1\nname: Notify')
            .replace('  - id: log\n', '  - id: log\n    colour: red\n');
        expect(errorsOf({ [NOTIFY_PATH]: notify })).toEqual([
            { path: NOTIFY_PATH, message: 'Unknown key "name".' },
            { path: NOTIFY_PATH, message: 'Unknown key "nodes[1].colour".' },
        ]);
    });

    test('an id missing, or the same id in two files of a kind', () => {
        expect(
            errorsOf({ [NOTIFY_PATH]: repoFlowToYaml(NOTIFY).replace('id: 00000000-0000-4000-8000-00000000f002\n', '') }),
        ).toContainEqual({
            path: NOTIFY_PATH,
            message: expect.stringMatching(/^The flow has no id/),
        });
        expect(
            errorsOf({
                'acme/projects/Sales/flows/Copy.flow.yaml': repoFlowToYaml(NOTIFY),
                'acme/projects/Billing/project.yaml': projectToYaml({ id: '00000000-0000-4000-8000-00000000b001', description: '' }),
                'acme/connections/Backup.yaml': connectionToYaml({ id: '00000000-0000-4000-8000-00000000c001', type: 'sqlserver' }),
            }),
        ).toEqual([
            {
                path: 'acme/projects/Sales/flows/Copy.flow.yaml',
                message: `The id "00000000-0000-4000-8000-00000000f002" is also in ${NOTIFY_PATH}.`,
            },
            {
                path: 'acme/projects/Billing/project.yaml',
                message: 'The id "00000000-0000-4000-8000-00000000b001" is also in acme/projects/Sales/project.yaml.',
            },
            {
                path: 'acme/connections/Backup.yaml',
                message: 'The id "00000000-0000-4000-8000-00000000c001" is also in acme/connections/Warehouse.yaml.',
            },
        ]);
    });

    test('an id that is not a UUID in lower case', () => {
        const upper = '00000000-0000-4000-8000-00000000F002';
        expect(
            errorsOf({
                [NOTIFY_PATH]: repoFlowToYaml(flow(upper, NOTIFY.nodes.slice(1, 2))),
                'acme/projects/Sales/project.yaml': projectToYaml({ id: 'sales', description: '' }),
            }),
        ).toEqual([
            { path: 'acme/projects/Sales/project.yaml', message: 'The id "sales" is not a UUID in lower case.' },
            { path: NOTIFY_PATH, message: `The id "${upper}" is not a UUID in lower case.` },
            {
                path: 'acme/projects/Sales/flows/Daily/Load orders.flow.yaml',
                message: 'Node "call" calls the flow "00000000-0000-4000-8000-00000000f002", which is not in the workspace.',
            },
        ]);
    });

    test('an edge to a node that does not exist (the flow keeps its id: the flows that call it are not in error too)', () => {
        const notify = repoFlowToYaml(NOTIFY).replace('target: end', 'target: gone');
        expect(errorsOf({ [NOTIFY_PATH]: notify })).toEqual([
            { path: NOTIFY_PATH, message: 'Edge 1 connects a node that is not in the flow.' },
        ]);
    });

    test('a call to a flow that is not in the workspace, or to a script that is not in the project', () => {
        const LOAD_ORDERS_PATH = 'acme/projects/Sales/flows/Daily/Load orders.flow.yaml';
        expect(errorsOf({ [NOTIFY_PATH]: undefined })).toEqual([
            {
                path: LOAD_ORDERS_PATH,
                message: 'Node "call" calls the flow "00000000-0000-4000-8000-00000000f002", which is not in the workspace.',
            },
        ]);
        expect(
            errorsOf({
                'acme/projects/Sales/scripts/lib/totals.ts': undefined,
                'acme/projects/Billing/project.yaml': projectToYaml({ id: '00000000-0000-4000-8000-00000000b002', description: '' }),
                'acme/projects/Billing/scripts/lib/totals.ts': 'export const total = 1;\n',
                'acme/projects/Billing/scripts/lib/tax.ts': "import { rate } from '@myproject/scripts/lib/rates';\n",
            }),
        ).toEqual([
            { path: LOAD_ORDERS_PATH, message: 'Node "ts" uses the script "lib/totals", which is not in the project.' },
            {
                path: 'acme/projects/Billing/scripts/lib/tax.ts',
                message: 'It imports the script "lib/rates", which is not in the project.',
            },
        ]);
    });

    test('a connection a flow uses and the workspace does not declare', () => {
        expect(errorsOf({ 'acme/connections/Warehouse.yaml': undefined }, { ...HERE, connections: [] })).toEqual([
            {
                path: 'acme/projects/Sales/flows/Daily/Load orders.flow.yaml',
                message:
                    'Node "read" uses the connection "00000000-0000-4000-8000-00000000c001", which is not declared in acme/connections.',
            },
        ]);
    });

    test('a project whose handle another project has, archived ones included, or whose name makes no handle', () => {
        const project = (id: string) => projectToYaml({ id: `00000000-0000-4000-8000-00000000b00${id}`, description: '' });
        const files = {
            ...validTree(),
            'acme/projects/sales!/project.yaml': project('2'),
            'acme/projects/Old Reports/project.yaml': project('3'),
            'acme/projects/!!!/project.yaml': project('4'),
        };
        expect(validateWorkspaceTree({ workspace: W, files, environment: HERE, archivedProjects: ['old-reports'] }).errors).toEqual([
            {
                path: 'acme/projects/!!!',
                message: 'The project name "!!!" is not valid: No letter or digit (a-z, 0-9) to make its handle from.',
            },
            { path: 'acme/projects/sales!', message: 'The handle "sales" is taken by the project "Sales".' },
            { path: 'acme/projects/Old Reports', message: 'The handle "old-reports" is taken by the archived project "old-reports".' },
        ]);
    });

    test('names that collide whatever the case or after NFC normalization, once per name', () => {
        const nfc = 'Café';
        const nfd = nfc.normalize('NFD');
        expect(
            errorsOf({
                'acme/projects/Sales/flows/daily/A.flow.yaml': repoFlowToYaml(
                    flow('00000000-0000-4000-8000-00000000f003', NOTIFY.nodes.slice(1, 2)),
                ),
                'acme/projects/Sales/flows/daily/B.flow.yaml': repoFlowToYaml(
                    flow('00000000-0000-4000-8000-00000000f004', NOTIFY.nodes.slice(1, 2)),
                ),
                'acme/connections/WAREHOUSE.yaml': connectionToYaml({ id: '00000000-0000-4000-8000-00000000c002', type: 'sqlserver' }),
                [`acme/projects/Sales/scripts/${nfc}.ts`]: '',
                [`acme/projects/Sales/scripts/${nfd}.ts`]: '',
            }).filter(e => !e.message.startsWith('The script path')),
        ).toEqual([
            { path: 'acme/projects/Sales/flows/daily', message: 'It differs only in case from "acme/projects/Sales/flows/Daily".' },
            { path: 'acme/connections/WAREHOUSE.yaml', message: 'It differs only in case from "acme/connections/Warehouse.yaml".' },
            {
                path: `acme/projects/Sales/scripts/${nfd}.ts`,
                message: `It differs only in Unicode normalization from "acme/projects/Sales/scripts/${nfc}.ts".`,
            },
        ]);
    });

    test('a name breaking the name rule, and a path too long for a clone on Windows', () => {
        const long = 'L'.repeat(60);
        expect(
            errorsOf({
                [NOTIFY_PATH]: undefined,
                'acme/projects/Sales/flows/nul.flow.yaml': repoFlowToYaml(NOTIFY),
                'acme/projects/Sales/flows/x.flow.yaml/.gitkeep': '',
                'acme/connections/con.yaml': connectionToYaml({ id: '00000000-0000-4000-8000-00000000c002', type: 'sqlserver' }),
                'acme/projects/Sales./project.yaml': projectToYaml({ id: '00000000-0000-4000-8000-00000000b002', description: '' }),
                'acme/projects/Sales/scripts/lib/bad name.ts': '',
                [`acme/projects/Sales/flows/${long}/${long}.flow.yaml`]: repoFlowToYaml(
                    flow('00000000-0000-4000-8000-00000000f003', NOTIFY.nodes.slice(1, 2)),
                ),
            }),
        ).toEqual([
            {
                path: 'acme/projects/Sales/flows/nul.flow.yaml',
                message: 'The flow name "nul" is not valid: "nul" is a name Windows reserves.',
            },
            {
                path: 'acme/projects/Sales/flows/x.flow.yaml',
                message: 'The folder name "x.flow.yaml" is not valid: A folder name cannot end in .flow.yaml.',
            },
            { path: 'acme/connections/con.yaml', message: 'The connection name "con" is not valid: "con" is a name Windows reserves.' },
            { path: 'acme/projects/Sales.', message: 'The project name "Sales." is not valid: Not ending in a dot.' },
            {
                path: 'acme/projects/Sales/scripts/lib/bad name.ts',
                message:
                    'The script path "lib/bad name" is not valid: "bad name" is not a valid name: use letters, numbers, - and _ (starting with a letter or a number).',
            },
            {
                path: `acme/projects/Sales/flows/${long}/${long}.flow.yaml`,
                message: 'The path has 157 characters (at most 150), too long for a clone on Windows.',
            },
        ]);
    });

    test('a workspace without its workspace.yaml, a project without its project.yaml', () => {
        expect(errorsOf({ 'acme/workspace.yaml': undefined, 'acme/projects/Sales/project.yaml': undefined })).toEqual([
            { path: 'acme/workspace.yaml', message: 'The workspace has no workspace.yaml.' },
            { path: 'acme/projects/Sales/project.yaml', message: 'The project has no project.yaml (it holds its id).' },
        ]);
    });
});

const warningsOf = (changes: Record<string, string | undefined>, here = HERE) => {
    const files = { ...validTree(), ...changes };
    for (const [path, text] of Object.entries(changes)) {
        if (text === undefined) {
            delete files[path];
        }
    }
    const result = validate(files as Record<string, string>, here);
    expect(result.errors).toEqual([]);
    return result.warnings;
};

describe('warnings, which do not refuse the tree', () => {
    test('a declared connection not configured on this server', () => {
        expect(warningsOf({}, { ...HERE, connections: [] })).toEqual([
            { path: 'acme/connections/Warehouse.yaml', message: 'The connection "Warehouse" is not configured on this server.' },
        ]);
    });

    test('a secret or a variable a flow reads with no value on this server', () => {
        expect(warningsOf({}, { ...HERE, secrets: [], variables: [] })).toEqual([
            { path: 'acme/projects/Sales/flows/Daily/Load orders.flow.yaml', message: 'The secret "token" has no value on this server.' },
            {
                path: 'acme/projects/Sales/flows/Daily/Load orders.flow.yaml',
                message: 'The variable "region" has no value on this server.',
            },
        ]);
    });

    test('a comment in a flow file, which the next save drops', () => {
        expect(warningsOf({ [NOTIFY_PATH]: `# sends the mail\n${repoFlowToYaml(NOTIFY)}` })).toEqual([
            { path: NOTIFY_PATH, message: "It has a comment, which the app's next save drops: a node's notes keep what a comment would." },
        ]);
    });

    test('a repository without .gitattributes', () => {
        expect(warningsOf({ '.gitattributes': undefined })).toEqual([
            { path: '.gitattributes', message: 'The repository has no .gitattributes: a clone on Windows may get CRLF line endings.' },
        ]);
    });

    test('a file of the workspace that is not part of the format', () => {
        expect(warningsOf({ 'acme/projects/Sales/flows/README.md': '# Sales\n' })).toEqual([
            { path: 'acme/projects/Sales/flows/README.md', message: 'It is not part of the repository format: it is left out.' },
        ]);
    });
});
