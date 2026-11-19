import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowFromYaml, repoFlowToYaml, type FlowFile } from '@flowtinus/core';
import { ANA, BIA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Change = { path: string; from?: string; change: string; conflict?: string };

const raw = (repo: string, ref: string, path: string) =>
    Bun.spawnSync(['git', 'show', `${ref}:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();

const labelOf = (flow: FlowFile, type: string) => flow.nodes.find(n => n.type === type)?.label;

describe('a moved branch is merged into its working copy; a removed one keeps its changes', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const as = (user: string) => async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const call = as(ANA);
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
        const handle = async (user: string) => (await as(user)('GET', '/me')).body.handle as string;
        const changes = async (user = ANA) => (await as(user)('GET', '/git/changes')).body.changes as Change[];
        const draft = async (user = ANA) => (await as(user)('GET', `/flows/${orders}/draft`)).body;
        const relabel = async (user: string, type: string, label: string) => {
            const current = await draft(user);
            current.flow.nodes = current.flow.nodes.map((n: { type: string }) => (n.type === type ? { ...n, label } : n));
            return as(user)('PUT', `/flows/${orders}/draft`, { revision: current.revision, flow: current.flow });
        };
        const pushLabel = (branch: string, type: string, label: string) => {
            const files: Record<string, string> = {};
            for (const path of git(repo, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean)) {
                files[path] = raw(repo, branch, path);
            }
            const read = repoFlowFromYaml(files[ordersPath]!, 'Orders');
            if (!read.ok) {
                throw new Error('Orders does not read');
            }
            const flow = { ...read.value.flow, nodes: read.value.flow.nodes.map(n => (n.type === type ? { ...n, label } : n)) };
            files[ordersPath] = repoFlowToYaml(flow, { deployed: read.value.deployed });
            return commitFiles(repo, branch, files, `${label} from a laptop`);
        };
        const inGit = (branch: string) => {
            const read = repoFlowFromYaml(raw(repo, branch, ordersPath), 'Orders');
            return read.ok ? read.value.flow : null;
        };
        return { id, as, call, projectId, orders, repo, at, ordersPath, handle, changes, draft, relabel, pushLabel, inGit };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-branch-merge-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a push on a work branch is merged into its working copy by the poll: clean, silently; a file equal to its base follows', async () => {
        const { id, call, ordersPath, handle, changes, draft, relabel, pushLabel, inGit } = await workspace();
        const branch = `users/${await handle(ANA)}/merge`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);

        expect((await relabel(ANA, 'start', 'Ana start')).status).toBe(200);
        const read = await draft();
        pushLabel(branch, 'end', 'Laptop end');
        await app.gitPoller.poll(id);

        const merged = await draft();
        expect(labelOf(merged.flow, 'start')).toBe('Ana start');
        expect(labelOf(merged.flow, 'end')).toBe('Laptop end');
        expect(merged.conflict).toBeUndefined();
        expect(merged.revision).toBeGreaterThan(read.revision);
        expect((await changes()).map(c => [c.path, c.change, c.conflict])).toEqual([[ordersPath, 'modified', undefined]]);

        const committed = await commitAll(call, 'Ana start');
        expect(committed.status).toBe(200);
        expect(labelOf(inGit(branch)!, 'start')).toBe('Ana start');
        expect(labelOf(inGit(branch)!, 'end')).toBe('Laptop end');

        pushLabel(branch, 'start', 'Laptop start');
        await app.gitPoller.poll(id);
        expect(labelOf((await draft()).flow, 'start')).toBe('Laptop start');
        expect(await changes()).toEqual([]);
    });

    test('a push that conflicts with an uncommitted change marks the file: no Commit until it is discarded', async () => {
        const { id, call, ordersPath, handle, changes, draft, relabel, pushLabel, inGit } = await workspace();
        const branch = `users/${await handle(ANA)}/clash`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);

        expect((await relabel(ANA, 'start', 'Ana start')).status).toBe(200);
        const laptop = pushLabel(branch, 'start', 'Laptop start');
        await app.gitPoller.poll(id);

        const marked = await draft();
        expect(marked.conflict).toBe(laptop);
        expect(labelOf(marked.flow, 'start')).toBe('Ana start');
        expect((await changes()).map(c => [c.path, c.conflict])).toEqual([[ordersPath, laptop]]);
        const listed = (await call('GET', '/git/branches')).body.branches as { name: string; changes: number }[];
        expect(listed.find(b => b.name === branch)?.changes).toBe(1);

        const refused = await commitAll(call, 'Mine over theirs');
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain(`conflicts with git's commit ${laptop.slice(0, 7)}`);
        expect(labelOf(inGit(branch)!, 'start')).toBe('Laptop start');

        expect((await call('POST', '/git/discard', { paths: [ordersPath] })).status).toBe(200);
        expect(labelOf((await draft()).flow, 'start')).toBe('Laptop start');
        expect(await changes()).toEqual([]);
    });

    test('a Commit on a branch that moved since the last poll merges first, then commits on the new tip', async () => {
        const { call, repo, handle, relabel, pushLabel, inGit } = await workspace();
        const branch = `users/${await handle(ANA)}/race`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);

        expect((await relabel(ANA, 'start', 'Ana start')).status).toBe(200);
        const laptop = pushLabel(branch, 'end', 'Laptop end');
        const committed = await commitAll(call, 'Ana start');
        expect(committed.status).toBe(200);
        expect(git(repo, 'rev-parse', `${branch}^`)).toBe(laptop);
        expect(labelOf(inGit(branch)!, 'start')).toBe('Ana start');
        expect(labelOf(inGit(branch)!, 'end')).toBe('Laptop end');
    });

    test("a branch made from dev while dev moved in git has the changes it takes merged onto dev's tip", async () => {
        const { call, repo, handle, draft, relabel, pushLabel } = await workspace();
        expect((await relabel(ANA, 'start', 'Ana start')).status).toBe(200);
        const devTip = pushLabel('dev', 'end', 'Laptop end');

        const branch = `users/${await handle(ANA)}/late`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect(git(repo, 'rev-parse', branch)).toBe(devTip);
        const taken = await draft();
        expect(labelOf(taken.flow, 'start')).toBe('Ana start');
        expect(labelOf(taken.flow, 'end')).toBe('Laptop end');
        expect(taken.conflict).toBeUndefined();
    });

    test('a branch removed on the remote with changes here keeps them, marked: they go to a new branch or are discarded', async () => {
        const { id, as, call, repo, ordersPath, handle, changes, draft, relabel } = await workspace();
        const ana = await handle(ANA);
        const gone = `users/${ana}/gone`;
        expect((await call('POST', '/git/branches', { name: gone })).status).toBe(201);
        expect((await relabel(ANA, 'start', 'Kept start')).status).toBe(200);
        const lastTip = git(repo, 'rev-parse', gone);
        expect((await as(BIA)('POST', '/git/branches', { name: 'fix/empty' })).status).toBe(201);

        git(repo, 'update-ref', '-d', `refs/heads/${gone}`);
        git(repo, 'update-ref', '-d', 'refs/heads/fix/empty');
        await app.gitPoller.poll(id);

        const listed = (await call('GET', '/git/branches')).body.branches as {
            name: string;
            removed?: true;
            editable: boolean;
            changes: number;
        }[];
        expect(listed.find(b => b.name === gone)).toMatchObject({ removed: true, editable: false, changes: 1 });
        expect(listed.some(b => b.name === 'fix/empty')).toBe(false);
        expect((await as(BIA)('GET', '/git/current-branch')).body).toEqual({ branch: 'dev', editable: true });

        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch: gone, editable: false, removed: true });
        expect((await changes()).map(c => c.path)).toEqual([ordersPath]);
        expect(labelOf((await draft()).flow, 'start')).toBe('Kept start');
        const refused = await relabel(ANA, 'start', 'More');
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain('was removed on the remote');
        expect((await commitAll(call, 'Too late')).status).toBe(409);
        await app.gitPoller.poll(id);
        expect((await changes()).map(c => c.path)).toEqual([ordersPath]);

        const rescued = `users/${ana}/rescued`;
        const created = await call('POST', '/git/branches', { name: rescued });
        expect(created.status).toBe(201);
        expect(created.body.taken).toEqual([ordersPath]);
        expect(git(repo, 'rev-parse', rescued)).toBe(lastTip);
        expect(labelOf((await draft()).flow, 'start')).toBe('Kept start');
        expect((await relabel(ANA, 'start', 'Saved start')).status).toBe(200);

        await app.gitPoller.poll(id);
        const after = (await call('GET', '/git/branches')).body.branches as { name: string }[];
        expect(after.some(b => b.name === gone)).toBe(false);
        expect(after.some(b => b.name === rescued)).toBe(true);
    });

    test("a removed branch's changes can be discarded instead; then it goes", async () => {
        const { id, call, repo, handle, changes, relabel } = await workspace();
        const gone = `users/${await handle(ANA)}/dropped`;
        expect((await call('POST', '/git/branches', { name: gone })).status).toBe(201);
        expect((await relabel(ANA, 'start', 'Dropped start')).status).toBe(200);
        git(repo, 'update-ref', '-d', `refs/heads/${gone}`);
        await app.gitPoller.poll(id);
        expect((await call('GET', '/git/current-branch')).body.removed).toBe(true);

        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect(await changes()).toEqual([]);
        await app.gitPoller.poll(id);
        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch: 'dev', editable: true });
    });
});
