import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GITATTRIBUTES, isRepoId, repoFlowFromYaml, workspaceToYaml } from '@flowtinus/core';
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

const WORKSPACE = { '.gitattributes': GITATTRIBUTES, 'acme/workspace.yaml': workspaceToYaml() };

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');

const idOf = (text: string) => /^id: (.+)$/m.exec(text)?.[1] ?? '';

const validates = async (root: string) => expect(await main(['validate'], root)).toEqual({ code: 0, output: 'No errors, no warnings.\n' });

describe('flowtinus new flow', () => {
    test('makes a flow file with a fresh id, its Start and its End, as the editor does', async () => {
        const root = folderWith(WORKSPACE);
        expect(await main(['new', 'project', 'acme/projects/Sales'], root)).toMatchObject({ code: 0 });

        const path = 'acme/projects/Sales/flows/Orders/Load.flow.yaml';
        expect(await main(['new', 'flow', path], root)).toEqual({ code: 0, output: `Created ${path}.\n` });

        const flow = repoFlowFromYaml(read(root, path), 'Load');
        expect(flow.ok && flow.value.flow.nodes.map(n => n.type)).toEqual(['end', 'start']);
        expect(isRepoId(idOf(read(root, path)))).toBe(true);
        await validates(root);
    });

    test('each flow gets its own id', async () => {
        const root = folderWith(WORKSPACE);
        await main(['new', 'project', 'acme/projects/Sales'], root);
        await main(['new', 'flow', 'acme/projects/Sales/flows/A.flow.yaml'], root);
        await main(['new', 'flow', 'acme/projects/Sales/flows/B.flow.yaml'], root);
        expect(idOf(read(root, 'acme/projects/Sales/flows/A.flow.yaml'))).not.toBe(
            idOf(read(root, 'acme/projects/Sales/flows/B.flow.yaml')),
        );
        await validates(root);
    });

    test('the path is taken from the current folder', async () => {
        const root = folderWith(WORKSPACE);
        await main(['new', 'project', 'acme/projects/Sales'], root);
        mkdirSync(join(root, 'acme/projects/Sales/flows'));
        expect(await main(['new', 'flow', 'Load.flow.yaml'], join(root, 'acme/projects/Sales/flows'))).toEqual({
            code: 0,
            output: 'Created Load.flow.yaml.\n',
        });
        expect(existsSync(join(root, 'acme/projects/Sales/flows/Load.flow.yaml'))).toBe(true);
    });
});

describe('flowtinus new project', () => {
    test("makes the project's project.yaml with a fresh id", async () => {
        const root = folderWith(WORKSPACE);
        expect(await main(['new', 'project', 'acme/projects/Sales'], root)).toEqual({
            code: 0,
            output: 'Created acme/projects/Sales/project.yaml.\n',
        });
        expect(isRepoId(idOf(read(root, 'acme/projects/Sales/project.yaml')))).toBe(true);
        await validates(root);
    });
});

describe('flowtinus new connection', () => {
    test('makes a connection of the type given, with a fresh id', async () => {
        const root = folderWith(WORKSPACE);
        expect(await main(['new', 'connection', 'acme/connections/Warehouse.yaml', '--type', 'sqlserver'], root)).toEqual({
            code: 0,
            output: 'Created acme/connections/Warehouse.yaml.\n',
        });
        const text = read(root, 'acme/connections/Warehouse.yaml');
        expect(text).toContain('type: sqlserver\n');
        expect(isRepoId(idOf(text))).toBe(true);
        await validates(root);
    });

    test('--type is required', async () => {
        const root = folderWith(WORKSPACE);
        const done = await main(['new', 'connection', 'acme/connections/Warehouse.yaml'], root);
        expect(done.code).toBe(2);
        expect(done.output).toStartWith('A connection needs --type <type>.\n');
        expect(existsSync(join(root, 'acme/connections/Warehouse.yaml'))).toBe(false);
    });

    test('an unknown type is refused with the known ones', async () => {
        const root = folderWith(WORKSPACE);
        const done = await main(['new', 'connection', 'acme/connections/Warehouse.yaml', '--type', 'oracle'], root);
        expect(done.code).toBe(2);
        expect(done.output).toStartWith('Unknown connection type "oracle". The types: ');
        expect(done.output).toContain('postgresql, ');
        expect(done.output).toContain('sqlserver');
        expect(existsSync(join(root, 'acme/connections/Warehouse.yaml'))).toBe(false);
    });
});

describe('flowtinus new refuses', () => {
    test('a file that is already there, which it leaves as it is', async () => {
        const root = folderWith({ ...WORKSPACE, 'acme/connections/Warehouse.yaml': 'mine\n' });
        expect(await main(['new', 'connection', 'acme/connections/Warehouse.yaml', '--type', 'sqlserver'], root)).toEqual({
            code: 1,
            output: 'acme/connections/Warehouse.yaml is already there.\n',
        });
        expect(read(root, 'acme/connections/Warehouse.yaml')).toBe('mine\n');
    });

    test('a path where that kind of file does not live', async () => {
        const root = folderWith(WORKSPACE);
        expect(await main(['new', 'flow', 'acme/projects/Sales/Load.flow.yaml'], root)).toEqual({
            code: 1,
            output: 'acme/projects/Sales/Load.flow.yaml is not where a flow lives: <workspace>/projects/<project>/flows/[<folder>/…]<name>.flow.yaml.\n',
        });
        expect(await main(['new', 'connection', 'acme/connections/db/Warehouse.yaml', '--type', 'sqlserver'], root)).toEqual({
            code: 1,
            output: 'acme/connections/db/Warehouse.yaml is not where a connection lives: <workspace>/connections/<name>.yaml.\n',
        });
        expect(await main(['new', 'project', 'acme/Sales'], root)).toEqual({
            code: 1,
            output: 'acme/Sales/project.yaml is not where a project lives: <workspace>/projects/<project>/project.yaml.\n',
        });
        expect(existsSync(join(root, 'acme/projects'))).toBe(false);
    });

    test('a path outside a workspace', async () => {
        const root = folderWith({});
        expect(await main(['new', 'project', 'acme/projects/Sales'], root)).toEqual({
            code: 1,
            output: 'acme/projects/Sales/project.yaml is in no workspace: no folder above it has a workspace.yaml.\n',
        });
    });

    test('a name validate would refuse', async () => {
        const root = folderWith(WORKSPACE);
        expect(await main(['new', 'connection', 'acme/connections/Ware..yaml', '--type', 'sqlserver'], root)).toEqual({
            code: 1,
            output: 'acme/connections/Ware..yaml: error: The connection name "Ware." is not valid: Not ending in a dot.\n',
        });
        expect(existsSync(join(root, 'acme/connections/Ware..yaml'))).toBe(false);
    });

    test('a workspace, which has no id to give', async () => {
        const done = await main(['new', 'workspace', 'acme'], folderWith({}));
        expect(done.code).toBe(2);
        expect(done.output).toStartWith('Unknown kind "workspace": flow, project or connection.\n');
    });

    test('a missing or extra path', async () => {
        expect((await main(['new', 'flow'], folderWith(WORKSPACE))).code).toBe(2);
        expect((await main(['new', 'flow', 'a', 'b'], folderWith(WORKSPACE))).code).toBe(2);
        expect((await main(['new', 'flow', 'a.flow.yaml', '--type', 'sqlserver'], folderWith(WORKSPACE))).code).toBe(2);
    });
});
