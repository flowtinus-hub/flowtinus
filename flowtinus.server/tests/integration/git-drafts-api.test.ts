import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

type Node = { id: string; type: string; label?: string };

describe('a draft when git changes its flow', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function deployedOrders() {
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

        const path = `${slugOf(id)}/projects/Sales/flows/Orders.flow.yaml`;
        const show = (file: string) => Bun.spawnSync(['git', 'show', `dev:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const onBranch = (): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                    .split('\n')
                    .map(file => [file, show(file)]),
            );
        const draft = async (flowId = orders) => (await call('GET', `/flows/${flowId}/draft`)).body;
        const labels = async (flowId = orders) =>
            Object.fromEntries(((await draft(flowId)).flow.nodes as Node[]).map(n => [n.id, n.label ?? null]));
        // the draft with these components relabelled, saved
        const edit = async (relabel: Record<string, string>) => {
            const { flow, revision } = await draft();
            const nodes = flow.nodes.map((n: Node) => (relabel[n.id] ? { ...n, label: relabel[n.id] } : n));
            expect((await call('PUT', `/flows/${orders}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
        };
        // a commit made in git that labels a component of Orders (its label replaced, if it has one)
        const commitInGit = (nodeId: string, label: string) => {
            const files = onBranch();
            const labelled = /  - id: (\w+)\n    type: (\w+)\n(    label: .*\n)?/g;
            const file = files[path]!.replace(labelled, (block, id: string, type: string) =>
                id === nodeId ? `  - id: ${id}\n    type: ${type}\n    label: ${label}\n` : block,
            );
            return commitFiles(repo, 'dev', { ...files, [path]: file }, `Label ${nodeId} in git`);
        };
        const reconcile = async () => (await call('POST', '/git/reconcile')).body.outcome as string;
        return { call, repo, projectId, orders, path, show, draft, labels, edit, commitInGit, reconcile };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-drafts-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a draft equal to its base follows the commit', async () => {
        const { draft, labels, commitInGit, reconcile } = await deployedOrders();
        const before = (await draft()).revision;
        commitInGit('start', 'From git');
        expect(await reconcile()).toBe('applied');
        expect(await labels()).toEqual({ end: null, start: 'From git' });
        expect((await draft()).revision).toBe(before + 1);
        expect((await draft()).conflict).toBeUndefined();
    });

    test("a draft whose change does not overlap the commit's keeps it on top; the next Commit takes both", async () => {
        const { call, orders, path, show, labels, edit, commitInGit, reconcile } = await deployedOrders();
        await edit({ end: 'Mine' });
        commitInGit('start', 'From git');
        expect(await reconcile()).toBe('applied');
        expect(await labels()).toEqual({ end: 'Mine', start: 'From git' });

        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        expect(show(path)).toContain('label: Mine');
        expect(show(path)).toContain('label: From git');
    });

    test("a conflicting draft is marked and cannot be committed; discarding it takes git's, a copy keeps the draft", async () => {
        const { call, repo, projectId, orders, path, show, draft, labels, edit, commitInGit, reconcile } = await deployedOrders();
        await edit({ start: 'Mine' });
        const theirs = commitInGit('start', 'Theirs');
        expect(await reconcile()).toBe('applied');
        expect(await labels()).toEqual({ end: null, start: 'Mine' });
        expect((await draft()).conflict).toBe(theirs);
        expect((await call('GET', `/flows/${orders}/deployments`)).body.draftConflict).toBe(theirs);

        const refused = await call('POST', `/flows/${orders}/deploy`);
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe(
            `The draft conflicts with git's commit ${theirs.slice(0, 7)}: discard it, or duplicate it as a new flow.`,
        );
        expect(git(repo, 'rev-parse', 'dev')).toBe(theirs);

        // a later commit keeps the mark, on that commit
        const later = commitInGit('end', 'Later');
        expect(await reconcile()).toBe('applied');
        expect((await draft()).conflict).toBe(later);

        const discarded = await call('POST', `/flows/${orders}/draft/discard`, { copyAs: 'Orders mine' });
        expect(discarded.status).toBe(200);
        expect(await labels()).toEqual({ end: 'Later', start: 'Theirs' });
        expect((await draft()).conflict).toBeUndefined();
        const copy = discarded.body.copy.id as string;
        expect(await labels(copy)).toEqual({ end: null, start: 'Mine' });
        const flows = (await call('GET', `/projects/${projectId}/contents`)).body.flows as { id: string; name: string }[];
        expect(flows.find(f => f.id === copy)?.name).toBe('Orders mine');
        expect(show(path)).toContain('label: Theirs');
        expect(git(repo, 'ls-tree', '-r', '--name-only', 'dev')).not.toContain('Orders mine');

        await edit({ end: 'Again' });
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        expect(show(path)).toContain('label: Again');
    });

    test('a Commit on a branch that moved since the draft was based merges the same way, and refuses a conflict', async () => {
        const { call, repo, orders, path, show, draft, edit, commitInGit } = await deployedOrders();
        await edit({ end: 'Mine' });
        commitInGit('start', 'From git');
        expect((await call('POST', `/flows/${orders}/deploy`, { message: 'Label the end' })).status).toBe(200);
        expect(git(repo, 'log', '-2', '--format=%s', 'dev').split('\n')).toEqual(['Label the end', 'Label start in git']);
        expect(show(path)).toContain('label: Mine');
        expect(show(path)).toContain('label: From git');

        await edit({ end: 'Mine again' });
        const theirs = commitInGit('end', 'Theirs');
        const refused = await call('POST', `/flows/${orders}/deploy`);
        expect(refused.status).toBe(409);
        expect(git(repo, 'rev-parse', 'dev')).toBe(theirs);
        expect((await draft()).conflict).toBe(theirs);
        expect(show(path)).toContain('label: Theirs');
    });

    test('discarding needs a file in git', async () => {
        const { call, projectId } = await deployedOrders();
        const fresh = (await call('POST', `/projects/${projectId}/flows`, { name: 'New' })).body.id as string;
        const refused = await call('POST', `/flows/${fresh}/draft/discard`);
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe('The flow has no file in git: there is nothing to take.');
    });
});
