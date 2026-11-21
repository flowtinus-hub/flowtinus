import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowFromYaml, repoFlowToYaml } from '@flowtinus/core';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type DiffLine = { kind: ' ' | '-' | '+'; text: string; old?: number; new?: number };
type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] };

const raw = (repo: string, ref: string, path: string) =>
    Bun.spawnSync(['git', 'show', `${ref}:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();

const linesOf = (hunks: Hunk[]) => hunks.flatMap(h => h.lines);

describe("a changed file's diff, and a discard of what was never committed", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const call = async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        const flows: Record<string, string> = {};
        for (const name of ['Orders', 'Invoices']) {
            flows[name] = (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
            expect((await call('POST', `/flows/${flows[name]}/deploy`)).status).toBe(200);
        }
        await app.gitPoller.poll(id);

        const handle = workspaceHandleOf(id);
        const at = (path: string) => `${handle}/${path}`;
        const pathOf = (name: string) => at(`projects/Sales/flows/${name}.flow.yaml`);
        const userHandle = async () => (await call('GET', '/me')).body.handle as string;
        const diff = (path: string) => call('GET', `/git/diff?path=${encodeURIComponent(path)}`);
        const relabel = async (flowId: string, type: string, label: string) => {
            const current = (await call('GET', `/flows/${flowId}/draft`)).body;
            current.flow.nodes = current.flow.nodes.map((n: { type: string }) => (n.type === type ? { ...n, label } : n));
            expect((await call('PUT', `/flows/${flowId}/draft`, { revision: current.revision, flow: current.flow })).status).toBe(200);
        };
        const tombstones = (branch: string) =>
            db.query('SELECT path FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND deleted AND base IS NULL', [id, branch]);
        return { id, call, projectId, flows, repo, at, pathOf, userHandle, diff, relabel, tombstones };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-diff-discard-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("on dev: the committed text against the working copy's, line-numbered; an added file from nothing, a deleted one to nothing, a rename from its old path", async () => {
        const { call, projectId, flows, repo, pathOf, diff, relabel } = await workspace();
        const committed = raw(repo, 'dev', pathOf('Orders')).split('\n');

        await relabel(flows.Orders!, 'start', 'Begin');
        const modified = await diff(pathOf('Orders'));
        expect(modified.status).toBe(200);
        expect(modified.body).toMatchObject({ path: pathOf('Orders'), change: 'modified', kind: 'flow' });
        const lines = linesOf(modified.body.hunks);
        expect(lines.filter(l => l.kind === '+').some(l => l.text.includes('label: Begin'))).toBe(true);
        expect(lines.filter(l => l.kind === '-').every(l => !l.text.includes('Begin'))).toBe(true);
        for (const line of lines.filter(l => l.old !== undefined)) {
            expect(committed[line.old! - 1]).toBe(line.text);
        }
        const hunk = modified.body.hunks[0] as Hunk;
        expect(hunk.lines[0]).toMatchObject({ kind: ' ', old: hunk.oldStart, new: hunk.newStart });

        const fresh = (await call('POST', `/projects/${projectId}/flows`, { name: 'Fresh' })).body.id as string;
        const added = await diff(pathOf('Fresh'));
        expect(added.body).toMatchObject({ change: 'added', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1 }] });
        const addedLines = linesOf(added.body.hunks);
        expect(addedLines.every(l => l.kind === '+')).toBe(true);
        expect(addedLines.map(l => l.new)).toEqual(addedLines.map((_, i) => i + 1));
        expect(addedLines.some(l => l.text.includes(fresh))).toBe(true);

        expect((await call('PATCH', `/flows/${flows.Invoices}`, { name: 'Bills' })).status).toBe(200);
        for (const path of [pathOf('Bills'), pathOf('Invoices')]) {
            const renamed = await diff(path);
            expect(renamed.body).toMatchObject({ path: pathOf('Bills'), from: pathOf('Invoices'), change: 'renamed' });
            expect(linesOf(renamed.body.hunks).every(l => l.kind === ' ')).toBe(true);
        }

        expect((await call('POST', `/flows/${flows.Orders}/archive`)).status).toBe(200);
        const deleted = await diff(pathOf('Orders'));
        expect(deleted.body).toMatchObject({ change: 'deleted', hunks: [{ oldStart: 1, newStart: 0, newLines: 0 }] });
        expect(linesOf(deleted.body.hunks).map(l => l.text)).toEqual(committed.filter((_, i) => i < committed.length - 1));
        expect(linesOf(deleted.body.hunks).every(l => l.kind === '-')).toBe(true);

        expect((await diff(pathOf('Nothing'))).status).toBe(404);
        expect((await call('GET', '/git/diff')).status).toBe(400);
    });

    test('on a work branch, and during a pending merge: each file against its base', async () => {
        const { call, projectId, flows, repo, pathOf, userHandle, diff, relabel } = await workspace();
        const branch = `users/${await userHandle()}/diff`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        await relabel(flows.Orders!, 'start', 'Ana start');
        expect((await commitAll(call, 'Ana start')).status).toBe(200);
        const files: Record<string, string> = {};
        for (const path of git(repo, 'ls-tree', '-r', '--name-only', 'dev').split('\n').filter(Boolean)) {
            files[path] = raw(repo, 'dev', path);
        }
        for (const [name, type, label] of [
            ['Orders', 'start', 'Dev start'],
            ['Invoices', 'end', 'Dev end'],
        ] as const) {
            const read = repoFlowFromYaml(files[pathOf(name)]!, name);
            if (!read.ok) {
                throw new Error(`${name} does not read`);
            }
            const flow = { ...read.value.flow, nodes: read.value.flow.nodes.map(n => (n.type === type ? { ...n, label } : n)) };
            files[pathOf(name)] = repoFlowToYaml(flow, { deployed: read.value.deployed });
        }
        commitFiles(repo, 'dev', files, 'dev labels');

        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Branch only' })).status).toBe(201);
        const added = await diff(pathOf('Branch only'));
        expect(added.body.change).toBe('added');
        expect(linesOf(added.body.hunks).every(l => l.kind === '+')).toBe(true);

        const updated = await call('POST', '/git/update');
        expect(updated.body).toMatchObject({ outcome: 'pending', conflicts: [pathOf('Orders')] });
        const conflicted = linesOf((await diff(pathOf('Orders'))).body.hunks);
        expect(conflicted.find(l => l.kind === '+' && l.text.includes('Ana start'))).toBeDefined();
        const merged = linesOf((await diff(pathOf('Invoices'))).body.hunks);
        expect(merged.find(l => l.kind === '+' && l.text.includes('Dev end'))).toBeDefined();
        expect(merged.find(l => l.kind === '-' && l.text.includes('Dev end'))).toBeUndefined();
    });

    test('on dev: a discarded flow, folder, project or connection never committed is gone, nothing of it in the archive', async () => {
        const { id, call, projectId, flows, at, pathOf, relabel, tombstones } = await workspace();
        const ids = (table: string, list: string[]) =>
            db.query(`SELECT id FROM ${table} WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [id, list]);

        const fresh = (await call('POST', `/projects/${projectId}/flows`, { name: 'Fresh' })).body.id as string;
        expect((await call('POST', '/git/discard', { paths: [pathOf('Fresh')] })).status).toBe(200);
        expect(await ids('flows', [fresh])).toEqual([]);
        const renamed = (await call('POST', `/projects/${projectId}/flows`, { name: 'Draft one' })).body.id as string;
        expect((await call('PATCH', `/flows/${renamed}`, { name: 'Draft two' })).status).toBe(200);
        expect((await tombstones('')).length).toBe(1);
        expect((await call('POST', '/git/discard', { paths: [pathOf('Draft two')] })).status).toBe(200);
        expect(await ids('flows', [renamed])).toEqual([]);
        expect(await tombstones('')).toEqual([]);

        const later = (await call('POST', `/projects/${projectId}/folders`, { name: 'Later' })).body.id as string;
        const inLater = (await call('POST', `/projects/${projectId}/flows`, { name: 'Inside', folderId: later })).body.id as string;
        const ops = (await call('POST', '/projects', { name: 'Ops' })).body.id as string;
        const restock = (await call('POST', `/projects/${ops}/flows`, { name: 'Restock' })).body.id as string;
        await relabel(restock, 'start', 'Count');
        const shop = (
            await call('POST', '/connections', {
                name: 'Shop',
                type: 'kafka',
                config: { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' },
                newSecrets: [{ name: 'kafka-pass', value: 's3cret' }],
            })
        ).body.id as string;
        expect((await call('PATCH', `/flows/${flows.Invoices}`, { name: 'Bills' })).status).toBe(200);
        expect((await call('POST', `/flows/${flows.Orders}/archive`)).status).toBe(200);
        expect(((await call('GET', '/git/changes')).body.changes as unknown[]).length).toBe(6);

        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect((await call('GET', '/git/changes')).body.changes).toEqual([]);
        expect(await ids('flows', [inLater, restock])).toEqual([]);
        expect(await ids('folders', [later])).toEqual([]);
        expect(await ids('projects', [ops])).toEqual([]);
        expect(await ids('connections', [shop])).toEqual([]);
        expect(await tombstones('')).toEqual([]);
        expect(
            await db.query('SELECT path FROM working_copy WHERE workspace_id = $1 AND path LIKE $2', [id, at('projects/Ops/%')]),
        ).toEqual([]);
        expect((await call('GET', `/flows/${flows.Invoices}`)).body).toMatchObject({ name: 'Invoices', archivedAt: null });
        expect((await call('GET', `/flows/${flows.Orders}`)).body.archivedAt).toBeNull();
        expect((await call('GET', `/projects/${projectId}/contents`)).status).toBe(200);
        expect(await db.query('SELECT id FROM flows WHERE workspace_id = $1 AND deleted_at IS NOT NULL', [id])).toEqual([]);
    });

    test('on a work branch: a discarded new flow leaves no row, nor the tombstone of its rename', async () => {
        const { id, call, projectId, pathOf, userHandle, tombstones } = await workspace();
        const branch = `users/${await userHandle()}/discard`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        const fresh = (await call('POST', `/projects/${projectId}/flows`, { name: 'Fresh' })).body.id as string;
        expect((await call('PATCH', `/flows/${fresh}`, { name: 'Fresher' })).status).toBe(200);
        expect(((await call('GET', '/git/changes')).body.changes as { path: string }[]).map(c => c.path)).toEqual([pathOf('Fresher')]);

        expect((await call('POST', '/git/discard', { paths: [pathOf('Fresher')] })).status).toBe(200);
        expect((await call('GET', '/git/changes')).body.changes).toEqual([]);
        expect(await db.query('SELECT path FROM working_copy WHERE workspace_id = $1 AND branch = $2', [id, branch])).toEqual([]);
        expect(await tombstones(branch)).toEqual([]);
        expect(await db.query('SELECT id FROM flows WHERE id = $1', [fresh])).toEqual([]);
        expect((await call('GET', `/flows/${fresh}`)).status).toBe(404);
    });
});
