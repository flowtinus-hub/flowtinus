import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectionToYaml, repoFlowFromYaml, repoFlowToYaml, type FlowFile } from '@flowtinus/core';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Change = { path: string; from?: string; change: string; conflict?: string };
type Hunk = { mine: string[]; base: string[]; theirs: string[] };
type Segment = { lines: string[] } | { hunk: Hunk };

const raw = (repo: string, ref: string, path: string) =>
    Bun.spawnSync(['git', 'show', `${ref}:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();

const labelOf = (flow: FlowFile, type: string) => flow.nodes.find(n => n.type === type)?.label;

const hunks = (segments: Segment[]) => segments.flatMap(s => ('hunk' in s ? [s.hunk] : []));

describe('the conflict screen: a marked file resolved per hunk, or by a choice when it is not about content', () => {
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
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        await app.gitPoller.poll(id);

        const slug = slugOf(id);
        const at = (path: string) => `${slug}/${path}`;
        const ordersPath = at('projects/Sales/flows/Orders.flow.yaml');
        const handle = (await call('GET', '/me')).body.handle as string;
        const changes = async () => (await call('GET', '/git/changes')).body.changes as Change[];
        const draft = async () => (await call('GET', `/flows/${orders}/draft`)).body;
        const conflict = (path: string) => call('GET', `/git/conflict?path=${encodeURIComponent(path)}`);
        const relabel = async (labels: Record<string, string>) => {
            const current = await draft();
            current.flow.nodes = current.flow.nodes.map((n: { type: string }) => (labels[n.type] ? { ...n, label: labels[n.type] } : n));
            return call('PUT', `/flows/${orders}/draft`, { revision: current.revision, flow: current.flow });
        };
        /** a commit on the branch from a laptop: the tree as it is, changed by `change` */
        const push = (branch: string, change: (files: Record<string, string>) => Record<string, string>, message = 'from a laptop') => {
            const files: Record<string, string> = {};
            for (const path of git(repo, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean)) {
                files[path] = raw(repo, branch, path);
            }
            return commitFiles(repo, branch, change(files), message);
        };
        const pushLabels = (branch: string, labels: Record<string, string>) =>
            push(branch, files => {
                const read = repoFlowFromYaml(files[ordersPath]!, 'Orders');
                if (!read.ok) {
                    throw new Error('Orders does not read');
                }
                const flow = {
                    ...read.value.flow,
                    nodes: read.value.flow.nodes.map(n => (labels[n.type] ? { ...n, label: labels[n.type] } : n)),
                };
                return { ...files, [ordersPath]: repoFlowToYaml(flow, { deployed: read.value.deployed }) };
            });
        const inGit = (branch: string, path = ordersPath) => {
            const text = raw(repo, branch, path);
            const read = repoFlowFromYaml(text, path.split('/').pop()!.replace('.flow.yaml', ''));
            return read.ok ? read.value.flow : null;
        };
        const poll = () => app.gitPoller.poll(id);
        return { id, call, repo, at, orders, ordersPath, handle, changes, draft, conflict, relabel, push, pushLabels, inGit, poll };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-conflicts-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a content conflict on a work branch: per hunk, an invalid result refused with its errors, the resolution committed', async () => {
        const { call, ordersPath, handle, changes, draft, conflict, relabel, pushLabels, inGit, poll } = await workspace();
        const branch = `users/${handle}/clash`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await relabel({ start: 'Ana start', end: 'Ana end' })).status).toBe(200);
        const laptop = pushLabels(branch, { start: 'Laptop start', end: 'Laptop end' });
        await poll();
        expect((await changes()).map(c => c.conflict)).toEqual([laptop]);

        const read = await conflict(ordersPath);
        expect(read.status).toBe(200);
        expect(read.body).toMatchObject({ path: ordersPath, commit: laptop, duplicable: false, conflict: { type: 'content' } });
        const [first, second] = hunks(read.body.conflict.segments);
        expect(hunks(read.body.conflict.segments)).toHaveLength(2);
        expect(first!.mine.join('\n')).toContain('Ana');
        expect(first!.theirs.join('\n')).toContain('Laptop');
        // what did not conflict is there already
        expect(read.body.conflict.segments.some((s: Segment) => 'lines' in s && s.lines.some(l => l.includes('type: start')))).toBe(true);

        const startHunk = first!.mine.join('\n').includes('Ana start') ? 0 : 1;
        const pick = (start: unknown, end: unknown) => (startHunk === 0 ? [start, end] : [end, start]);

        // both labels: the key twice, the file does not parse; nothing is written, the mark stays
        const both = await call('POST', '/git/conflict', { path: ordersPath, revision: read.body.revision, hunks: pick('both', 'theirs') });
        expect(both.status).toBe(400);
        expect(Object.keys(both.body.error.fields)).toEqual([ordersPath]);
        expect((await changes()).map(c => c.conflict)).toEqual([laptop]);

        const stale = await call('POST', '/git/conflict', {
            path: ordersPath,
            revision: read.body.revision - 1,
            hunks: pick('mine', 'theirs'),
        });
        expect(stale.status).toBe(409);

        const edited = (startHunk === 0 ? first : second)!.mine.join('\n').replace('Ana start', 'Both starts');
        const resolved = await call('POST', '/git/conflict', {
            path: ordersPath,
            revision: read.body.revision,
            hunks: pick({ edit: edited }, 'theirs'),
        });
        expect(resolved.status).toBe(200);
        expect((await changes()).map(c => [c.path, c.change, c.conflict])).toEqual([[ordersPath, 'modified', undefined]]);
        const now = await draft();
        expect(now.conflict).toBeUndefined();
        expect(labelOf(now.flow, 'start')).toBe('Both starts');
        expect(labelOf(now.flow, 'end')).toBe('Laptop end');
        expect((await conflict(ordersPath)).status).toBe(404);

        expect((await commitAll(call, 'Resolved')).status).toBe(200);
        expect(labelOf(inGit(branch)!, 'start')).toBe('Both starts');
        expect(labelOf(inGit(branch)!, 'end')).toBe('Laptop end');
    });

    test('one edited, the other deleted: keep it with the edit, or delete it', async () => {
        const { call, repo, at, orders, ordersPath, handle, changes, conflict, relabel, push, pushLabels, inGit, poll } = await workspace();
        const branch = `users/${handle}/gone`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);

        // edited here, deleted there: kept with the edit
        expect((await relabel({ start: 'Kept start' })).status).toBe(200);
        const deleted = push(branch, ({ [ordersPath]: _orders, ...rest }) => rest);
        await poll();
        const read = await conflict(ordersPath);
        expect(read.body).toMatchObject({ commit: deleted, conflict: { type: 'deleted', deletedBy: 'theirs' } });
        expect(read.body.conflict.text).toContain('Kept start');
        expect((await call('POST', '/git/conflict', { path: ordersPath, revision: read.body.revision, keep: true })).status).toBe(200);
        expect((await changes()).map(c => [c.path, c.change, c.conflict])).toEqual([[ordersPath, 'added', undefined]]);
        expect((await commitAll(call, 'Keep Orders')).status).toBe(200);
        expect(labelOf(inGit(branch)!, 'start')).toBe('Kept start');

        // deleted here, edited there: deleted
        expect((await call('POST', `/flows/${orders}/archive`)).status).toBe(200);
        const edited = pushLabels(branch, { end: 'Laptop end' });
        await poll();
        const archived = await conflict(ordersPath);
        expect(archived.body).toMatchObject({ commit: edited, conflict: { type: 'deleted', deletedBy: 'mine' } });
        expect(archived.body.conflict.text).toContain('Laptop end');
        expect((await call('POST', '/git/conflict', { path: ordersPath, revision: archived.body.revision, keep: false })).status).toBe(200);
        expect((await changes()).map(c => [c.path, c.change, c.conflict])).toEqual([[ordersPath, 'deleted', undefined]]);
        expect((await commitAll(call, 'Remove Orders')).status).toBe(200);
        expect(git(repo, 'ls-tree', '-r', '--name-only', branch)).not.toContain(at('projects/Sales/flows/Orders'));
    });

    test('both renamed the same flow: one of the two names', async () => {
        const { call, repo, at, orders, ordersPath, handle, changes, conflict, push, inGit, poll } = await workspace();
        const branch = `users/${handle}/names`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        const mine = at('projects/Sales/flows/Orders A.flow.yaml');
        const theirs = at('projects/Sales/flows/Orders B.flow.yaml');

        expect((await call('PATCH', `/flows/${orders}`, { name: 'Orders A' })).status).toBe(200);
        const renamed = push(branch, ({ [ordersPath]: text, ...rest }) => ({ ...rest, [theirs]: text! }));
        await poll();
        expect((await changes()).map(c => [c.from, c.path, c.conflict])).toEqual([[ordersPath, mine, renamed]]);

        const read = await conflict(mine);
        expect(read.body).toMatchObject({ path: mine, from: ordersPath, conflict: { type: 'content', names: { mine, theirs } } });
        expect(hunks(read.body.conflict.segments)).toEqual([]);
        expect((await call('POST', '/git/conflict', { path: mine, revision: read.body.revision, hunks: [] })).status).toBe(400);

        expect((await call('POST', '/git/conflict', { path: mine, revision: read.body.revision, hunks: [], name: 'mine' })).status).toBe(
            200,
        );
        expect((await changes()).map(c => [c.from, c.path, c.change, c.conflict])).toEqual([[theirs, mine, 'renamed', undefined]]);
        expect((await call('GET', `/flows/${orders}`)).body.name).toBe('Orders A');
        expect((await commitAll(call, 'Orders A')).status).toBe(200);
        expect(inGit(branch, mine)?.id).toBe(orders);
        expect(git(repo, 'ls-tree', '-r', '--name-only', branch)).not.toContain(theirs);
    });

    test("both added a connection with the same name: one is renamed, on the environment's branch, and both are committed", async () => {
        const { call, at, push, poll, changes, conflict, repo } = await workspace();
        const created = await call('POST', '/connections', {
            name: 'Shop',
            type: 'kafka',
            config: { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' },
            newSecrets: [{ name: 'kafka-pass', value: 's3cret' }],
        });
        expect(created.status).toBe(201);
        const path = at('connections/Shop.yaml');
        const theirsId = crypto.randomUUID();
        const added = push('dev', files => ({ ...files, [path]: connectionToYaml({ id: theirsId, type: 'kafka' }) }));
        await poll();
        expect((await changes()).map(c => [c.path, c.change, c.conflict])).toEqual([[path, 'added', added]]);

        const read = await conflict(path);
        expect(read.body).toMatchObject({ conflict: { type: 'added', name: 'Shop' } });
        expect(read.body.conflict.theirs).toContain(theirsId);
        const taken = await call('POST', '/git/conflict', { path, revision: read.body.revision, rename: 'Shop' });
        expect(taken.status).toBe(400);

        const renamed = await call('POST', '/git/conflict', { path, revision: read.body.revision, rename: 'Shop mine' });
        expect(renamed.status).toBe(200);
        const mine = at('connections/Shop mine.yaml');
        expect((await changes()).map(c => [c.path, c.change, c.conflict])).toEqual([[mine, 'added', undefined]]);
        const connections = (await call('GET', '/connections')).body.items as { id: string; name: string }[];
        expect(connections.map(c => [c.id, c.name]).sort()).toEqual(
            [
                [created.body.id, 'Shop mine'],
                [theirsId, 'Shop'],
            ].sort(),
        );
        expect((await commitAll(call, 'Shop mine')).status).toBe(200);
        expect(raw(repo, 'dev', mine)).toContain(created.body.id);
        expect(raw(repo, 'dev', path)).toContain(theirsId);
    });

    test("a draft's conflict on the environment's branch: resolved per hunk, then the flow's Commit", async () => {
        const { call, orders, ordersPath, changes, draft, conflict, relabel, pushLabels, inGit, poll } = await workspace();
        expect((await relabel({ start: 'Ana start' })).status).toBe(200);
        const laptop = pushLabels('dev', { start: 'Laptop start', end: 'Laptop end' });
        await poll();
        expect((await draft()).conflict).toBe(laptop);

        const read = await conflict(ordersPath);
        expect(read.body).toMatchObject({ commit: laptop, duplicable: true, conflict: { type: 'content' } });
        expect(hunks(read.body.conflict.segments)).toHaveLength(1);
        expect((await call('POST', '/git/conflict', { path: ordersPath, revision: read.body.revision, hunks: ['mine'] })).status).toBe(200);
        expect((await changes()).map(c => c.conflict)).toEqual([undefined]);
        const now = await draft();
        expect(now.conflict).toBeUndefined();
        expect(labelOf(now.flow, 'start')).toBe('Ana start');
        expect(labelOf(now.flow, 'end')).toBe('Laptop end');

        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        expect(labelOf(inGit('dev')!, 'start')).toBe('Ana start');
        expect(labelOf(inGit('dev')!, 'end')).toBe('Laptop end');
    });
});
