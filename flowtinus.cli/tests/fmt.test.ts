import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { GITATTRIBUTES, connectionToYaml, projectToYaml, repoFlowFromYaml, repoFlowToYaml, workspaceToYaml, type FlowFile } from '@flowtinus/core';
import { main } from '../src/main';

const folders: string[] = [];

afterEach(() => {
    for (const folder of folders.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
});

function folderWith(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'flowtinus-cli-'));
    folders.push(root);
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
}

const contents = (root: string): Record<string, string> =>
    Object.fromEntries(
        readdirSync(root, { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => [
                relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'),
                readFileSync(join(entry.parentPath, entry.name), 'utf8'),
            ]),
    );

const at = (x: number) => ({ x, y: 0 });

const LOAD: FlowFile = {
    version: 1,
    id: '00000000-0000-4000-8000-00000000f001',
    name: '',
    nodes: [
        { id: 'start', type: 'start', position: at(0), config: { acceptsInput: true } },
        {
            id: 'read',
            type: 'sqlserver',
            label: 'Orders',
            position: at(100),
            config: { query: 'SELECT 1', connection: '00000000-0000-4000-8000-00000000c001' },
            notes: 'why it is here',
        },
        {
            id: 'ts',
            type: 'typescript',
            position: at(200),
            config: { code: 'async function process($input: Data) {\n  return $input;\n}\n' },
            disabled: true,
        },
        { id: 'end', type: 'end', position: at(900), config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'read', targetPort: 'in-0' },
        { source: 'read', sourcePort: 'out-0', target: 'ts', targetPort: 'in-0' },
        { source: 'ts', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
    groups: [{ id: 'g1', title: 'Read', color: '#3b82f6', position: { x: -32, y: -48 }, size: { width: 640, height: 352 } }],
};

const EXPORTED = {
    '.gitattributes': GITATTRIBUTES,
    'acme/workspace.yaml': workspaceToYaml(),
    'acme/connections/Warehouse.yaml': connectionToYaml({ id: '00000000-0000-4000-8000-00000000c001', type: 'sqlserver' }),
    'acme/projects/Sales/project.yaml': projectToYaml({
        id: '00000000-0000-4000-8000-00000000b001',
        description: 'Sales\nand more',
        icon: 'cart',
        color: '#f00',
    }),
    'acme/projects/Sales/flows/Load.flow.yaml': repoFlowToYaml(LOAD, {
        deployed: false,
        schedules: [{ id: '00000000-0000-4000-8000-00000000a001', cron: '0 * * * *', timezone: 'UTC', misfire: 'strict', parameters: {} }],
        webhooks: [{ id: '00000000-0000-4000-8000-00000000a002', name: 'orders', response: 'wait' }],
    }),
    'acme/projects/Sales/flows/Daily/Sum.flow.yaml': repoFlowToYaml({ ...LOAD, id: '00000000-0000-4000-8000-00000000f002', groups: [] }),
    'acme/projects/Sales/scripts/util.ts': 'export const a=1\n',
};

const fmt = (cwd: string, ...args: string[]) => main(['fmt', ...args], cwd);

describe('flowtinus fmt', () => {
    test('a tree the app exported is left byte for byte', async () => {
        const root = folderWith(EXPORTED);
        expect(await fmt(root)).toEqual({ code: 0, output: expect.stringMatching(/^\d+ files already formatted\.\n$/) });
        expect(contents(root)).toEqual(EXPORTED);
    });

    test('a hand-written file in another order is rewritten in the canonical form and reads back the same', async () => {
        const flow = [
            'edges:',
            '  - { target: end, targetPort: in-0, source: log, sourcePort: out-0 }',
            '  - { target: log, targetPort: in-0, source: start, sourcePort: out-0 }',
            'nodes:',
            '  - { id: end, type: end, position: { y: 0, x: 900 }, config: {} }',
            '  - { id: log, type: log, position: { y: 0, x: 100 }, config: { message: hi } }',
            '  - { type: start, id: start, position: { x: 0, y: 0 }, config: {} }',
            'id: 00000000-0000-4000-8000-00000000f009',
            'version: 1',
            '',
        ].join('\n');
        const root = folderWith({
            ...EXPORTED,
            'acme/connections/Warehouse.yaml': 'type: sqlserver\nid: 00000000-0000-4000-8000-00000000c001\n',
            'acme/projects/Sales/flows/Hand.flow.yaml': flow,
        });
        expect(await fmt(root)).toEqual({
            code: 0,
            output: 'acme/connections/Warehouse.yaml: formatted\nacme/projects/Sales/flows/Hand.flow.yaml: formatted\n2 files formatted.\n',
        });
        const after = contents(root);
        expect(after['acme/connections/Warehouse.yaml']).toBe(EXPORTED['acme/connections/Warehouse.yaml']);
        expect(repoFlowFromYaml(after['acme/projects/Sales/flows/Hand.flow.yaml']!, 'Hand')).toEqual(repoFlowFromYaml(flow, 'Hand'));
        expect(after['acme/projects/Sales/flows/Hand.flow.yaml']).toStartWith(
            'version: 1\nid: 00000000-0000-4000-8000-00000000f009\nnodes:\n  - id: end\n',
        );
        expect(await fmt(root)).toEqual({ code: 0, output: expect.stringMatching(/^\d+ files already formatted\.\n$/) });
    });

    test('--check writes nothing, names each file that would change and exits 1; 0 on a canonical tree', async () => {
        const hand = { ...EXPORTED, 'acme/connections/Warehouse.yaml': 'type: sqlserver\nid: 00000000-0000-4000-8000-00000000c001\n' };
        const root = folderWith(hand);
        expect(await fmt(root, '--check')).toEqual({
            code: 1,
            output: 'acme/connections/Warehouse.yaml: not formatted\n1 file not formatted.\n',
        });
        expect(contents(root)).toEqual(hand);
        expect(await fmt(folderWith(EXPORTED), '--check')).toEqual({
            code: 0,
            output: expect.stringMatching(/^\d+ files already formatted\.\n$/),
        });
    });

    test('file by file: the tree errors between files change nothing; a file that cannot be read is left as it is and reported', async () => {
        const broken = 'nodes: [';
        const noId = 'type: sqlserver\n';
        const root = folderWith({
            ...EXPORTED,
            'acme/connections/Warehouse.yaml': noId,
            'acme/projects/Sales/flows/Broken.flow.yaml': broken,
            'acme/projects/Sales/project.yaml': 'description: x\nid: 00000000-0000-4000-8000-00000000f001\n',
        });
        const result = await fmt(root);
        expect(result.code).toBe(1);
        expect(result.output).toMatch(
            /^acme\/connections\/Warehouse\.yaml: error: The connection has no id: add one, such as "id: [0-9a-f-]{36}"\.\n/,
        );
        expect(result.output).toContain('acme/projects/Sales/flows/Broken.flow.yaml: error: Not valid YAML');
        expect(result.output).toEndWith('acme/projects/Sales/project.yaml: formatted\n1 file formatted, 2 files not read.\n');
        const after = contents(root);
        expect(after['acme/connections/Warehouse.yaml']).toBe(noId);
        expect(after['acme/projects/Sales/flows/Broken.flow.yaml']).toBe(broken);
        expect(after['acme/projects/Sales/project.yaml']).toBe(
            projectToYaml({ id: '00000000-0000-4000-8000-00000000f001', description: 'x' }),
        );
    });

    test('a file with an unknown key is left as it is and reported, as one its reader refuses', async () => {
        const misspelt = 'descripton: x\nid: 00000000-0000-4000-8000-00000000b001\n';
        const root = folderWith({ ...EXPORTED, 'acme/projects/Sales/project.yaml': misspelt });
        expect(await fmt(root)).toEqual({
            code: 1,
            output: 'acme/projects/Sales/project.yaml: error: Unknown key "descripton".\n1 file not read.\n',
        });
        expect(contents(root)['acme/projects/Sales/project.yaml']).toBe(misspelt);
    });

    test('each file where a comment was dropped is named', async () => {
        const commented = `# the warehouse\n${EXPORTED['acme/connections/Warehouse.yaml']}`;
        const flow = EXPORTED['acme/projects/Sales/flows/Load.flow.yaml'].replace('nodes:\n', 'nodes: # in order\n');
        const root = folderWith({
            ...EXPORTED,
            'acme/connections/Warehouse.yaml': commented,
            'acme/projects/Sales/flows/Load.flow.yaml': flow,
        });
        const comment = (path: string, how: string) => `${path}: warning: ${how}: a node's notes keep what a comment would.`;
        expect(await fmt(root, '--check')).toEqual({
            code: 1,
            output: [
                'acme/connections/Warehouse.yaml: not formatted',
                comment('acme/connections/Warehouse.yaml', 'It has a comment, which fmt drops'),
                'acme/projects/Sales/flows/Load.flow.yaml: not formatted',
                comment('acme/projects/Sales/flows/Load.flow.yaml', 'It has a comment, which fmt drops'),
                '2 files not formatted.',
                '',
            ].join('\n'),
        });
        expect((await fmt(root)).output).toBe(
            [
                'acme/connections/Warehouse.yaml: formatted',
                comment('acme/connections/Warehouse.yaml', 'Its comments were dropped'),
                'acme/projects/Sales/flows/Load.flow.yaml: formatted',
                comment('acme/projects/Sales/flows/Load.flow.yaml', 'Its comments were dropped'),
                '2 files formatted.',
                '',
            ].join('\n'),
        );
        expect(contents(root)).toEqual(EXPORTED);
    });

    test('the same files as validate: scripts, files outside the format, workspaces without a workspace.yaml and ignored files untouched', async () => {
        const hand = 'type: sqlserver\nid: 00000000-0000-4000-8000-00000000c001\n';
        const untouched = {
            'acme/projects/Sales/scripts/util.ts': 'export const a=1\n',
            'acme/projects/Sales/flows/README.md': '# Sales\n',
            'beta/connections/Warehouse.yaml': hand,
            'acme/connections/Ignored.yaml': hand,
        };
        const root = folderWith({ ...EXPORTED, ...untouched, '.gitignore': 'acme/connections/Ignored.yaml\n' });
        git(root, 'init', '--quiet');
        expect(await fmt(root)).toEqual({ code: 0, output: expect.stringMatching(/^\d+ files already formatted\.\n$/) });
        expect(contents(root)).toMatchObject(untouched);
    });

    test('a folder without a workspace is an error; a wrong argument or option exits 2 with the usage', async () => {
        expect(await fmt(folderWith({ 'notes.md': '# notes\n' }))).toEqual({
            code: 1,
            output: '.: error: No workspace here: no folder with a workspace.yaml.\n',
        });
        expect(await fmt(folderWith(EXPORTED), '--chek')).toMatchObject({
            code: 2,
            output: expect.stringContaining('Usage: flowtinus fmt [dir | file...] [--check]'),
        });
        expect((await fmt(folderWith(EXPORTED), 'a', 'b')).code).toBe(2);
    });

    test('the folder given, the current one by default', async () => {
        const root = folderWith(
            prefixed('repo', {
                ...EXPORTED,
                'acme/connections/Warehouse.yaml': 'type: sqlserver\nid: 00000000-0000-4000-8000-00000000c001\n',
            }),
        );
        expect((await fmt(root, 'repo', '--check')).output).toBe('acme/connections/Warehouse.yaml: not formatted\n1 file not formatted.\n');
        expect((await fmt(join(root, 'repo'))).output).toBe('acme/connections/Warehouse.yaml: formatted\n1 file formatted.\n');
    });
});

function git(cwd: string, ...args: string[]): void {
    const done = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (done.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`);
    }
}

function prefixed(folder: string, files: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(files).map(([path, text]) => [`${folder}/${path}`, text]));
}
