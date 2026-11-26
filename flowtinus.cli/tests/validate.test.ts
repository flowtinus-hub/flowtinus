import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GITATTRIBUTES, connectionToYaml, projectToYaml, repoFlowToYaml, workspaceToYaml, type FlowFile } from '@flowtinus/core';
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

function git(cwd: string, ...args: string[]): void {
    const done = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (done.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`);
    }
}

function repoWith(files: Record<string, string>): string {
    const root = folderWith(files);
    git(root, 'init', '--quiet');
    git(root, 'add', '.');
    return root;
}

const at = (x: number) => ({ x, y: 0 });

const flow = (id: string, nodes: FlowFile['nodes'] = []): FlowFile => ({
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

const LOAD = flow('00000000-0000-4000-8000-00000000f001', [
    { id: 'read', type: 'sqlserver', position: at(100), config: { connection: '00000000-0000-4000-8000-00000000c001', query: 'SELECT 1' } },
    {
        id: 'ts',
        type: 'typescript',
        position: at(200),
        config: { code: 'async function process($input: Data) {\n  return $SECRETS.token + VARIABLES.region;\n}\n' },
    },
]);

const workspace = (name: string, ids = 'a'): Record<string, string> => ({
    [`${name}/workspace.yaml`]: workspaceToYaml(),
    [`${name}/connections/Warehouse.yaml`]: connectionToYaml({ id: `00000000-0000-4000-8000-0000000${ids}c001`, type: 'sqlserver' }),
    [`${name}/projects/Sales/project.yaml`]: projectToYaml({ id: `00000000-0000-4000-8000-0000000${ids}b001`, description: '' }),
    [`${name}/projects/Sales/flows/Load.flow.yaml`]: repoFlowToYaml({ ...LOAD, id: `00000000-0000-4000-8000-0000000${ids}f001` }).replace(
        '00000000-0000-4000-8000-00000000c001',
        `00000000-0000-4000-8000-0000000${ids}c001`,
    ),
});

const VALID = { '.gitattributes': GITATTRIBUTES, ...workspace('acme') };

const validate = (cwd: string, ...args: string[]) => main(['validate', ...args], cwd);

describe('flowtinus validate', () => {
    test('a valid tree exits 0, with no warning about connections, secrets or variables on a server', async () => {
        expect(await validate(folderWith(VALID))).toEqual({ code: 0, output: 'No errors, no warnings.\n' });
    });

    test('an error exits 1: one line per issue, then the count', async () => {
        const root = folderWith({ ...VALID, 'acme/connections/Warehouse.yaml': 'type: oracle\nid: x\n' });
        expect(await validate(root)).toEqual({
            code: 1,
            output: [
                'acme/connections/Warehouse.yaml: error: Unknown connection type "oracle".',
                'acme/connections/Warehouse.yaml: error: The id "x" is not a UUID in lower case.',
                'acme/projects/Sales/flows/Load.flow.yaml: error: Node "read" uses the connection "00000000-0000-4000-8000-0000000ac001", which is not declared in acme/connections.',
                '3 errors, 0 warnings.',
                '',
            ].join('\n'),
        });
    });

    test('warnings only exit 0, and 1 with --strict', async () => {
        const root = folderWith({ ...VALID, 'acme/projects/Sales/flows/README.md': '# Sales\n' });
        const output =
            'acme/projects/Sales/flows/README.md: warning: It is not part of the repository format: it is left out.\n0 errors, 1 warning.\n';
        expect(await validate(root)).toEqual({ code: 0, output });
        expect(await validate(root, '--strict')).toEqual({ code: 1, output });
    });

    test('every workspace of the folder given, the current one by default; a repository-wide issue once', async () => {
        const root = folderWith({ 'repo/acme/workspace.yaml': 'format: 7\n', ...prefixed('repo', workspace('beta', 'b')) });
        const output = [
            'acme/workspace.yaml: error: Unknown format 7 (this app reads 1).',
            '.gitattributes: warning: The repository has no .gitattributes: a clone on Windows may get CRLF line endings.',
            '1 error, 1 warning.',
            '',
        ].join('\n');
        expect(await validate(root, 'repo')).toEqual({ code: 1, output });
        expect(await validate(join(root, 'repo'))).toEqual({ code: 1, output });
    });

    test('a folder without a workspace is an error', async () => {
        expect(await validate(folderWith({ 'notes.md': '# notes\n' }))).toEqual({
            code: 1,
            output: '.: error: No workspace here: no folder with a workspace.yaml.\n1 error, 0 warnings.\n',
        });
    });

    test('in a git repository, the files git would see: tracked, and untracked but not ignored', async () => {
        const root = repoWith({
            ...VALID,
            '.gitignore': 'acme/projects/Sales/flows/Broken.flow.yaml\n',
            'acme/projects/Sales/flows/Broken.flow.yaml': 'nodes: [',
        });
        expect(await validate(root)).toEqual({ code: 0, output: 'No errors, no warnings.\n' });
        writeFileSync(join(root, 'acme/projects/Sales/flows/Extra.flow.yaml'), 'nodes: [');
        expect((await validate(root)).output).toContain('acme/projects/Sales/flows/Extra.flow.yaml: error: Not valid YAML');
    });

    test('outside git, the whole folder but .git', async () => {
        const root = folderWith({ ...VALID, '.git/config': 'not a repository', 'acme/projects/Sales/flows/README.md': '# Sales\n' });
        expect((await validate(root)).output).toBe(
            'acme/projects/Sales/flows/README.md: warning: It is not part of the repository format: it is left out.\n0 errors, 1 warning.\n',
        );
    });

    test('a wrong argument or option exits 2 with the usage', async () => {
        expect((await validate(folderWith(VALID), '--strcit')).code).toBe(2);
        expect((await validate(folderWith(VALID), 'a', 'b')).code).toBe(2);
        expect((await main(['nope'], folderWith(VALID))).output).toStartWith('Unknown command "nope".\nUsage: flowtinus <command>');
    });
});

function prefixed(folder: string, files: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(files).map(([path, text]) => [`${folder}/${path}`, text]));
}
