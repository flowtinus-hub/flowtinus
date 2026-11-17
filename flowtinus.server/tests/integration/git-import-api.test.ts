import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectionToYaml, GITATTRIBUTES, projectToYaml, repoFlowToYaml, workspaceToYaml, type FlowFile, type FlowFileNode } from '@flowtinus/core';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitFiles, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { exportWorkspace } from '#features/git/workspace-export';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

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

function sampleTree(slug: string) {
    const ids = {
        warehouse: crypto.randomUUID(),
        sales: crypto.randomUUID(),
        loadOrders: crypto.randomUUID(),
        notify: crypto.randomUUID(),
    };
    const loadOrders = flow(ids.loadOrders, [
        { id: 'read', type: 'sqlserver', position: at(100), config: { connection: ids.warehouse, query: 'SELECT 1' } },
        {
            id: 'ts',
            type: 'typescript',
            position: at(200),
            config: {
                code: "import { total } from '@myproject/scripts/lib/totals';\nasync function process($input: Data) {\n  return $SECRETS.token + VARIABLES.region;\n}\n",
            },
        },
        { id: 'call', type: 'flow', position: at(300), config: { flowId: ids.notify } },
    ]);
    const notify = flow(ids.notify, [{ id: 'log', type: 'log', position: at(100), config: { message: 'done' } }]);
    const files: Record<string, string> = {
        '.gitattributes': GITATTRIBUTES,
        [`${slug}/connections/Warehouse.yaml`]: connectionToYaml({ id: ids.warehouse, type: 'sqlserver' }),
        [`${slug}/projects/Sales/flows/Daily/Load orders.flow.yaml`]: repoFlowToYaml(loadOrders),
        [`${slug}/projects/Sales/flows/Later/.gitkeep`]: '',
        [`${slug}/projects/Sales/flows/Notify.flow.yaml`]: repoFlowToYaml(notify, { deployed: false }),
        [`${slug}/projects/Sales/project.yaml`]: projectToYaml({ id: ids.sales, description: 'Money in', icon: 'cart', color: 'green' }),
        [`${slug}/projects/Sales/scripts/drafts/.gitkeep`]: '',
        [`${slug}/projects/Sales/scripts/lib/totals.ts`]: 'export const total = 1;\n',
        [`${slug}/workspace.yaml`]: workspaceToYaml(),
    };
    return { ids, files, loadOrders, notify };
}

describe('turning git on, an empty workspace imports the workspace its branch holds', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace() {
        const id = crypto.randomUUID();
        const slug = slugOf(id);
        await insertWorkspace(db, id);
        const call = async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        const onBranch = (files: Record<string, string>) => commitFiles(repo, 'dev', files);
        return { id, slug, call, repo, onBranch };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-import-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('projects, folders, flows, scripts and connection declarations arrive; a flow with deployed: false has no deploy', async () => {
        const { slug, call, onBranch } = await newWorkspace();
        const { ids, files, loadOrders, notify } = sampleTree(slug);
        onBranch(files);

        const imported = await call('POST', '/git/on', {});
        expect(imported.status).toBe(200);

        const projects = (await call('GET', '/projects')).body.items;
        expect(projects).toEqual([
            expect.objectContaining({ id: ids.sales, name: 'Sales', description: 'Money in', icon: 'cart', color: 'green' }),
        ]);

        const contents = (await call('GET', `/projects/${ids.sales}/contents`)).body;
        const folder = (name: string) => contents.folders.find((f: { name: string }) => f.name === name);
        expect(contents.folders.map((f: { name: string; parentId: string | null }) => [f.name, f.parentId])).toEqual(
            expect.arrayContaining([
                ['Daily', null],
                ['Later', null],
            ]),
        );
        expect(contents.folders).toHaveLength(2);
        expect(contents.flows.map((f: { id: string; name: string; folderId: string | null; deployedVersion: number | null }) => f)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: ids.loadOrders, name: 'Load orders', folderId: folder('Daily').id, deployedVersion: 1 }),
                expect.objectContaining({ id: ids.notify, name: 'Notify', folderId: null, deployedVersion: null }),
            ]),
        );
        expect(contents.flows).toHaveLength(2);

        const deployments = (await call('GET', `/flows/${ids.notify}/deployments`)).body;
        expect(deployments.versions.map((v: { number: number }) => v.number)).toEqual([1]);
        expect(deployments.deployed).toBeNull();
        const draft = (await call('GET', `/flows/${ids.loadOrders}/draft`)).body;
        expect(draft.flow.nodes.map((n: { id: string }) => n.id).sort()).toEqual(loadOrders.nodes.map(n => n.id).sort());
        expect((await call('GET', `/flows/${ids.notify}/draft`)).body.flow.nodes).toHaveLength(notify.nodes.length);

        expect((await call('GET', '/connections')).body.items).toEqual([
            expect.objectContaining({ id: ids.warehouse, name: 'Warehouse', type: 'sqlserver', config: {} }),
        ]);

        const scripts = (await call('GET', `/projects/${ids.sales}/scripts`)).body;
        expect(JSON.stringify(scripts)).toContain('lib/totals');
        const content = (await call('GET', `/projects/${ids.sales}/scripts/content?path=lib/totals`)).body;
        expect(content.content).toBe('export const total = 1;\n');
    });

    test('exporting the imported workspace again gives the same tree, and nothing was committed on the branch', async () => {
        const { id, slug, call, repo, onBranch } = await newWorkspace();
        const { files } = sampleTree(slug);
        const commit = onBranch(files);

        expect((await call('POST', '/git/on', {})).status).toBe(200);
        expect(await exportWorkspace(db, id)).toEqual(files);
        expect(git(repo, 'rev-parse', 'dev')).toBe(commit);
        expect((await call('GET', '/git/status')).body.status.pending).toBe(0);
    });

    test('a tree with any error is refused whole, its reasons listed by path: nothing is imported', async () => {
        const { slug, call, onBranch } = await newWorkspace();
        const { ids, files } = sampleTree(slug);
        const notify = `${slug}/projects/Sales/flows/Notify.flow.yaml`;
        const warehouse = `${slug}/connections/Warehouse.yaml`;
        const loadOrders = `${slug}/projects/Sales/flows/Daily/Load orders.flow.yaml`;
        onBranch({
            ...files,
            [loadOrders]: `owner: ana\n${files[loadOrders]}`,
            [notify]: files[notify]!.replace(`id: ${ids.notify}`, 'id: f2'),
            [warehouse]: files[warehouse]!.replace('type: sqlserver', 'type: oracle'),
        });

        const refused = await call('POST', '/git/on', {});
        expect(refused.status).toBe(400);
        expect(refused.body.error.message).toBe('The workspace on dev is not valid: nothing was imported.');
        expect(refused.body.error.fields).toEqual({
            [warehouse]: 'Unknown connection type "oracle".',
            [notify]: 'The id "f2" is not a UUID in lower case.',
            [loadOrders]: `Unknown key "owner".\nNode "call" calls the flow "${ids.notify}", which is not in the workspace.`,
        });
        expect((await call('GET', '/projects')).body.items).toEqual([]);
        expect((await call('GET', '/connections')).body.items).toEqual([]);
    });

    test("the validation's warnings are shown and do not refuse; the .gitattributes the branch lacks is committed", async () => {
        const { slug, call, repo, onBranch } = await newWorkspace();
        const { files } = sampleTree(slug);
        const { '.gitattributes': _gitattributes, ...withoutAttributes } = files;
        onBranch(withoutAttributes);

        const imported = await call('POST', '/git/on', {});
        expect(imported.status).toBe(200);
        const loadOrders = `${slug}/projects/Sales/flows/Daily/Load orders.flow.yaml`;
        expect(imported.body.warnings).toEqual([
            { path: `${slug}/connections/Warehouse.yaml`, message: 'The connection "Warehouse" is not configured on this server.' },
            { path: '.gitattributes', message: 'The repository has no .gitattributes: a clone on Windows may get CRLF line endings.' },
            { path: loadOrders, message: 'The secret "token" has no value on this server.' },
            { path: loadOrders, message: 'The variable "region" has no value on this server.' },
        ]);
        expect(git(repo, 'log', '-1', '--format=%an|%s', 'dev')).toBe(`Ana|Canonical form of ${slug}`);
        expect(git(repo, 'diff', '--name-only', 'dev~1', 'dev')).toBe('.gitattributes');
    });

    test('names arrive in NFC, however the repository wrote them, and the branch gets them in NFC', async () => {
        const { id, slug, call, repo, onBranch } = await newWorkspace();
        const { ids, files } = sampleTree(slug);
        const decomposed = 'Café';
        onBranch(
            Object.fromEntries(
                Object.entries(files).map(([path, text]) => [
                    path.replace('/Sales/', `/${decomposed}/`).replace('/Daily/', `/${decomposed}/`),
                    text,
                ]),
            ),
        );

        expect((await call('POST', '/git/on', {})).status).toBe(200);
        expect((await call('GET', '/projects')).body.items.map((p: { name: string }) => p.name)).toEqual(['Café']);
        expect(git(repo, 'log', '-1', '--format=%s', 'dev')).toBe(`Canonical form of ${slug}`);
        expect(git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'dev').split('\n')).toEqual(
            Object.keys(await exportWorkspace(db, id)),
        );
        const contents = (await call('GET', `/projects/${ids.sales}/contents`)).body;
        expect(contents.folders.map((f: { name: string }) => f.name).sort()).toEqual(['Café', 'Later']);
    });

    test('an id another workspace of this server already has refuses the tree', async () => {
        const first = await newWorkspace();
        const { files } = sampleTree(first.slug);
        first.onBranch(files);
        expect((await first.call('POST', '/git/on', {})).status).toBe(200);

        const second = await newWorkspace();
        second.onBranch(Object.fromEntries(Object.entries(files).map(([path, text]) => [path.replace(first.slug, second.slug), text])));
        const refused = await second.call('POST', '/git/on', {});
        expect(refused.status).toBe(400);
        expect(Object.keys(refused.body.error.fields).sort()).toEqual(
            [
                'connections/Warehouse.yaml',
                'projects/Sales/flows/Daily/Load orders.flow.yaml',
                'projects/Sales/flows/Notify.flow.yaml',
                'projects/Sales/project.yaml',
            ].map(path => `${second.slug}/${path}`),
        );
        expect(refused.body.error.fields[`${second.slug}/projects/Sales/project.yaml`]).toMatch(/is already used by another workspace\.$/);
    });
});
