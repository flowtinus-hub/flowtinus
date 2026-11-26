import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowFromYaml, repoFlowToYaml, type FlowFile } from '@flowtinus/core';
import { ANA, BIA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Change = { path: string; change: string; conflict?: string };

const raw = (repo: string, ref: string, path: string) =>
    Bun.spawnSync(['git', 'show', `${ref}:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();

const labelOf = (flow: FlowFile, type: string) => flow.nodes.find(n => n.type === type)?.label;

describe('Update merges the environment’s branch into a work branch; a conflicting one is a pending merge', () => {
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
        const flows: Record<string, string> = {};
        for (const name of ['Orders', 'Invoices']) {
            flows[name] = (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
            expect((await call('POST', `/flows/${flows[name]}/deploy`)).status).toBe(200);
        }
        await app.gitPoller.poll(id);

        const handle = workspaceHandleOf(id);
        const pathOf = (name: string) => `${handle}/projects/Sales/flows/${name}.flow.yaml`;
        const userHandle = async (user: string) => (await as(user)('GET', '/me')).body.handle as string;
        const changes = async (user = ANA) => (await as(user)('GET', '/git/changes')).body as { changes: Change[]; merge?: any };
        const draft = async (name: string, user = ANA) => (await as(user)('GET', `/flows/${flows[name]}/draft`)).body;
        const relabel = async (name: string, type: string, label: string, user = ANA) => {
            const current = await draft(name, user);
            current.flow.nodes = current.flow.nodes.map((n: { type: string }) => (n.type === type ? { ...n, label } : n));
            return as(user)('PUT', `/flows/${flows[name]}/draft`, { revision: current.revision, flow: current.flow });
        };
        const pushLabels = (branch: string, labels: [name: string, type: string, label: string][]) => {
            const files: Record<string, string> = {};
            for (const path of git(repo, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean)) {
                files[path] = raw(repo, branch, path);
            }
            for (const [name, type, label] of labels) {
                const read = repoFlowFromYaml(files[pathOf(name)]!, name);
                if (!read.ok) {
                    throw new Error(`${name} does not read`);
                }
                const flow = { ...read.value.flow, nodes: read.value.flow.nodes.map(n => (n.type === type ? { ...n, label } : n)) };
                files[pathOf(name)] = repoFlowToYaml(flow, { deployed: read.value.deployed });
            }
            return commitFiles(repo, branch, files, labels.map(l => l[2]).join(', '));
        };
        const inGit = (ref: string, name: string) => {
            const read = repoFlowFromYaml(raw(repo, ref, pathOf(name)), name);
            return read.ok ? read.value.flow : null;
        };
        return { id, as, call, repo, projectId, pathOf, userHandle, changes, draft, relabel, pushLabels, inGit };
    }

    async function diverged() {
        const ws = await workspace();
        const branch = `users/${await ws.userHandle(ANA)}/update`;
        expect((await ws.call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await ws.relabel('Orders', 'start', 'Ana start')).status).toBe(200);
        expect((await commitAll(ws.call, 'Ana start')).status).toBe(200);
        const ours = git(ws.repo, 'rev-parse', branch);
        const theirs = ws.pushLabels('dev', [
            ['Orders', 'start', 'Dev start'],
            ['Invoices', 'end', 'Dev end'],
        ]);
        return { ...ws, branch, ours, theirs };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-update-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('clean: a merge commit with dev as second parent, pushed; offered on work branches only', async () => {
        const { as, call, repo, userHandle, relabel, pushLabels, inGit, changes, draft } = await workspace();
        const branch = `users/${await userHandle(ANA)}/clean`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await relabel('Orders', 'start', 'Ana start')).status).toBe(200);
        expect((await commitAll(call, 'Ana start')).status).toBe(200);
        const ours = git(repo, 'rev-parse', branch);
        pushLabels('dev', [['Orders', 'end', 'Dev end']]);
        const theirs = pushLabels('dev', [['Invoices', 'end', 'Dev end']]);

        expect((await call('GET', '/git/update')).body).toEqual({ branch, environment: 'dev', behind: 2 });
        const updated = await call('POST', '/git/update');
        expect(updated.status).toBe(200);
        expect(updated.body.outcome).toBe('merged');
        const merge = updated.body.commit as string;
        expect(git(repo, 'rev-parse', branch)).toBe(merge);
        expect(git(repo, 'rev-parse', `${merge}^1`)).toBe(ours);
        expect(git(repo, 'rev-parse', `${merge}^2`)).toBe(theirs);
        expect(git(repo, 'log', '-1', '--format=%s', merge)).toBe(`Merge dev into ${branch}`);
        expect(labelOf(inGit(branch, 'Orders')!, 'start')).toBe('Ana start');
        expect(labelOf(inGit(branch, 'Orders')!, 'end')).toBe('Dev end');
        expect(labelOf(inGit(branch, 'Invoices')!, 'end')).toBe('Dev end');
        expect((await changes()).changes).toEqual([]);
        expect(labelOf((await draft('Orders')).flow, 'end')).toBe('Dev end');

        expect((await call('GET', '/git/update')).body.behind).toBe(0);
        expect((await call('POST', '/git/update')).body).toEqual({ outcome: 'up-to-date' });

        expect((await as(BIA)('POST', '/git/branches', { name: 'fix/shared' })).status).toBe(201);
        pushLabels('dev', [['Orders', 'start', 'Dev again']]);
        expect((await as(BIA)('POST', '/git/update')).body.outcome).toBe('merged');
        expect(labelOf(inGit('fix/shared', 'Orders')!, 'start')).toBe('Dev again');

        expect((await as(BIA)('PUT', '/git/current-branch', { branch: 'dev' })).status).toBe(200);
        const onDev = await as(BIA)('POST', '/git/update');
        expect(onDev.status).toBe(409);
        expect(onDev.body.error.message).toContain('into a work branch');
        expect((await as(BIA)('PUT', '/git/current-branch', { branch })).status).toBe(200);
        expect((await as(BIA)('POST', '/git/update')).status).toBe(409);
        expect((await as(BIA)('GET', '/git/update')).status).toBe(409);
        expect(git(repo, 'rev-parse', branch)).toBe(merge);
    });

    test('refused while a file it brings has an uncommitted change; another uncommitted file stays as it is', async () => {
        const { call, repo, pathOf, userHandle, relabel, pushLabels, inGit, changes, draft } = await workspace();
        const branch = `users/${await userHandle(ANA)}/busy`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        const before = git(repo, 'rev-parse', branch);
        expect((await relabel('Orders', 'start', 'Ana start')).status).toBe(200);
        expect((await relabel('Invoices', 'start', 'Ana invoices')).status).toBe(200);
        pushLabels('dev', [['Orders', 'end', 'Dev end']]);

        const refused = await call('POST', '/git/update');
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain(pathOf('Orders'));
        expect(Object.keys(refused.body.error.fields)).toEqual([pathOf('Orders')]);
        expect(git(repo, 'rev-parse', branch)).toBe(before);

        expect((await call('POST', '/git/discard', { paths: [pathOf('Orders')] })).status).toBe(200);
        const updated = await call('POST', '/git/update');
        expect(updated.body.outcome).toBe('merged');
        expect(labelOf(inGit(branch, 'Orders')!, 'end')).toBe('Dev end');
        expect(labelOf((await draft('Orders')).flow, 'end')).toBe('Dev end');
        expect((await changes()).changes.map(c => [c.path, c.change])).toEqual([[pathOf('Invoices'), 'modified']]);
        expect(labelOf((await draft('Invoices')).flow, 'start')).toBe('Ana invoices');
    });

    test('with conflicts: a pending merge, the conflicted file marked; Commit takes it whole as a merge commit', async () => {
        const { id, call, repo, pathOf, branch, ours, theirs, changes, draft, inGit } = await diverged();

        const updated = await call('POST', '/git/update');
        expect(updated.status).toBe(200);
        expect(updated.body).toEqual({ outcome: 'pending', conflicts: [pathOf('Orders')] });
        expect(git(repo, 'rev-parse', branch)).toBe(ours);

        const listed = await changes();
        expect(listed.merge).toEqual({ from: 'dev', theirs, ours, conflicts: [pathOf('Orders')] });
        expect(listed.changes.map(c => [c.path, c.change, c.conflict])).toEqual([
            [pathOf('Invoices'), 'modified', undefined],
            [pathOf('Orders'), 'modified', theirs],
        ]);
        const orders = await draft('Orders');
        expect(orders.conflict).toBe(theirs);
        expect(labelOf(orders.flow, 'start')).toBe('Ana start');
        expect(labelOf((await draft('Invoices')).flow, 'end')).toBe('Dev end');
        const [stored] = await db.query<{ paths: string[]; conflicts: string[] }>(
            'SELECT paths, conflicts FROM pending_merges WHERE workspace_id = $1 AND branch = $2',
            [id, branch],
        );
        expect(stored).toEqual({ paths: [pathOf('Invoices'), pathOf('Orders')], conflicts: [pathOf('Orders')] });
        expect((await call('GET', '/git/update')).body.pending).toEqual(listed.merge);

        expect((await call('POST', '/git/update')).body.error.message).toContain('is pending');
        const create = await call('POST', '/git/branches', { name: `${branch}-2` });
        expect(create.status).toBe(409);
        expect(create.body.error.message).toContain('is pending');
        const refused = await commitAll(call, 'Too soon');
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain(`conflicts with dev's commit ${theirs.slice(0, 7)}`);
        await app.gitPoller.poll(id);
        expect((await draft('Orders')).conflict).toBe(theirs);

        expect((await call('POST', '/git/discard', { paths: [pathOf('Orders')] })).status).toBe(200);
        const committed = await call('POST', '/git/commit', { paths: [pathOf('Invoices')], message: 'Merge dev, mine kept' });
        expect(committed.status).toBe(200);
        const merge = committed.body.commit as string;
        expect(git(repo, 'rev-parse', branch)).toBe(merge);
        expect(git(repo, 'rev-parse', `${merge}^1`)).toBe(ours);
        expect(git(repo, 'rev-parse', `${merge}^2`)).toBe(theirs);
        expect(labelOf(inGit(branch, 'Orders')!, 'start')).toBe('Ana start');
        expect(labelOf(inGit(branch, 'Invoices')!, 'end')).toBe('Dev end');
        expect(await changes()).toEqual({ changes: [] });
        expect((await call('GET', '/git/update')).body).toEqual({ branch, environment: 'dev', behind: 0 });
    });

    test('a pending merge refuses a second Update, Create branch and Open pull request, each saying how to end it', async () => {
        const { call, repo, branch, ours } = await diverged();
        expect((await call('POST', '/git/update')).body.outcome).toBe('pending');
        const refusal = `A merge of dev is pending on ${branch}: Commit it whole, or Discard all to abort it.`;

        for (const [method, path, body] of [
            ['POST', '/git/update', undefined],
            ['POST', '/git/branches', { name: `${branch}-2` }],
            ['POST', '/git/pull-request', undefined],
        ] as const) {
            const refused = await call(method, path, body);
            expect(refused.status).toBe(409);
            expect(refused.body.error.message).toBe(refusal);
        }
        expect(git(repo, 'rev-parse', branch)).toBe(ours);
        expect(git(repo, 'branch', '--list', `${branch}-2`)).toBe('');
    });

    test('a conflict outside the workspace’s files refuses the Update: nothing merged, nothing pending', async () => {
        const { id, call, repo, userHandle, changes } = await workspace();
        const outside = 'shared/readme.md';
        const files = (branch: string) =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', branch)
                    .split('\n')
                    .filter(Boolean)
                    .map(path => [path, raw(repo, branch, path)]),
            );
        commitFiles(repo, 'dev', { ...files('dev'), [outside]: 'base\n' });
        await app.gitPoller.poll(id);
        const branch = `users/${await userHandle(ANA)}/outside`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        const ours = commitFiles(repo, branch, { ...files(branch), [outside]: 'mine\n' });
        commitFiles(repo, 'dev', { ...files('dev'), [outside]: 'theirs\n' });

        const refused = await call('POST', '/git/update');
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe(
            `The merge of dev conflicts outside this workspace (${outside}): merge it into ${branch} in git.`,
        );
        expect(git(repo, 'rev-parse', branch)).toBe(ours);
        expect((await changes()).merge).toBeUndefined();
        expect((await call('GET', '/git/update')).body.pending).toBeUndefined();
    });

    test('a flow added to a folder the other branch renamed follows the folder instead of conflicting', async () => {
        const { id, call, repo, projectId, userHandle, inGit } = await workspace();
        const flows = (await call('GET', `/projects/${projectId}/contents`)).body.flows as { id: string }[];
        const folderId = (await call('POST', `/projects/${projectId}/folders`, { name: 'Reports' })).body.id as string;
        for (const flow of flows) {
            expect((await call('POST', `/flows/${flow.id}/move`, { folderId })).status).toBe(200);
        }
        expect((await commitAll(call, 'Into Reports')).status).toBe(200);
        const inFolder = (folder: string, name: string) => `${workspaceHandleOf(id)}/projects/Sales/flows/${folder}/${name}.flow.yaml`;
        expect(git(repo, 'ls-tree', '-r', '--name-only', 'dev')).toContain(inFolder('Reports', 'Orders'));

        const branch = `users/${await userHandle(ANA)}/weekly`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        const folderOn = async (name: string) =>
            ((await call('GET', `/projects/${projectId}/contents`)).body.folders as { id: string; name: string }[]).find(
                f => f.name === name,
            )?.id;
        const weekly = (await call('POST', `/projects/${projectId}/flows`, { name: 'Weekly', folderId: await folderOn('Reports') })).body
            .id as string;
        expect((await commitAll(call, 'Weekly')).status).toBe(200);
        expect(git(repo, 'ls-tree', '-r', '--name-only', branch)).toContain(inFolder('Reports', 'Weekly'));

        const devFiles = Object.fromEntries(
            git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                .split('\n')
                .filter(Boolean)
                .map(path => [path.replace('/flows/Reports/', '/flows/Reporting/'), raw(repo, 'dev', path)]),
        );
        commitFiles(repo, 'dev', devFiles, 'Reports is Reporting');

        const updated = await call('POST', '/git/update');
        expect(updated.status).toBe(200);
        expect(updated.body.outcome).toBe('merged');
        const tree = git(repo, 'ls-tree', '-r', '--name-only', branch);
        expect(tree).not.toContain('/flows/Reports/');
        expect(tree).toContain(inFolder('Reporting', 'Weekly'));
        expect(inGit(branch, 'Reporting/Weekly')?.id).toBe(weekly);
        const contents = (await call('GET', `/projects/${projectId}/contents`)).body;
        expect(contents.flows.find((f: { id: string }) => f.id === weekly).folderId).toBe(await folderOn('Reporting'));
        expect(await folderOn('Reports')).toBeUndefined();
    });

    test('with conflicts, resolved on the conflict screen: listed as a change, no longer a conflict, committed as resolved', async () => {
        const { call, repo, pathOf, branch, ours, theirs, changes, inGit } = await diverged();
        expect((await call('POST', '/git/update')).body.outcome).toBe('pending');

        const conflict = await call('GET', `/git/conflict?path=${encodeURIComponent(pathOf('Orders'))}`);
        expect(conflict.status).toBe(200);
        expect(conflict.body).toMatchObject({ commit: theirs, merging: 'dev' });
        const hunks = conflict.body.conflict.segments.filter((s: object) => 'hunk' in s).map(() => 'theirs');
        const resolved = await call('POST', '/git/conflict', { path: pathOf('Orders'), revision: conflict.body.revision, hunks });
        expect(resolved.status).toBe(200);

        const listed = await changes();
        expect(listed.merge.conflicts).toEqual([]);
        expect(listed.changes.map(c => [c.path, c.change, c.conflict])).toEqual([
            [pathOf('Invoices'), 'modified', undefined],
            [pathOf('Orders'), 'modified', undefined],
        ]);

        const committed = await call('POST', '/git/commit', { paths: [], message: 'Merge dev, theirs taken' });
        expect(committed.status).toBe(200);
        const merge = committed.body.commit as string;
        expect(git(repo, 'rev-parse', `${merge}^1`)).toBe(ours);
        expect(git(repo, 'rev-parse', `${merge}^2`)).toBe(theirs);
        expect(labelOf(inGit(branch, 'Orders')!, 'start')).toBe('Dev start');
        expect(labelOf(inGit(branch, 'Invoices')!, 'end')).toBe('Dev end');
        expect(await changes()).toEqual({ changes: [] });
    });

    test('with conflicts, Discard all aborts the pending merge: the branch as it was, its drafts kept, ready for another Update', async () => {
        const { id, call, repo, projectId, pathOf, branch, ours, theirs, changes, draft } = await diverged();
        const before = (await call('POST', `/projects/${projectId}/flows`, { name: 'Before' })).body.id as string;
        expect((await call('POST', '/git/update')).body.outcome).toBe('pending');
        const during = (await call('POST', `/projects/${projectId}/flows`, { name: 'During' })).body.id as string;
        for (const flow of [before, during]) {
            const current = (await call('GET', `/flows/${flow}/draft`)).body;
            current.flow.nodes = current.flow.nodes.map((n: { type: string }) =>
                n.type === 'start' ? { ...n, label: `Kept ${flow}` } : n,
            );
            expect((await call('PUT', `/flows/${flow}/draft`, { revision: current.revision, flow: current.flow })).status).toBe(200);
        }

        const aborted = await call('POST', '/git/discard', { mine: true });
        expect(aborted.status).toBe(200);
        expect(aborted.body.discarded).toEqual([pathOf('Invoices'), pathOf('Orders')]);
        const left = await changes();
        expect(left.merge).toBeUndefined();
        expect(left.changes.map(c => [c.path, c.change, c.conflict])).toEqual([
            [pathOf('Before'), 'added', undefined],
            [pathOf('During'), 'added', undefined],
        ]);
        for (const flow of [before, during]) {
            expect(labelOf((await call('GET', `/flows/${flow}/draft`)).body.flow, 'start')).toBe(`Kept ${flow}`);
        }
        const merged = await db.query('SELECT path FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND path = ANY($3::text[])', [
            id,
            branch,
            [pathOf('Invoices'), pathOf('Orders')],
        ]);
        expect(merged).toEqual([]);

        expect((await call('POST', '/git/discard', { mine: true })).body.discarded).toEqual([pathOf('Before'), pathOf('During')]);
        expect(await changes()).toEqual({ changes: [] });
        const tombstones = await db.query(
            'SELECT path FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND deleted AND base IS NULL',
            [id, branch],
        );
        expect(tombstones).toEqual([]);
        const orders = await draft('Orders');
        expect(orders.conflict).toBeUndefined();
        expect(labelOf(orders.flow, 'start')).toBe('Ana start');
        expect(labelOf((await draft('Invoices')).flow, 'end')).not.toBe('Dev end');
        expect(git(repo, 'rev-parse', branch)).toBe(ours);
        expect((await call('POST', '/git/branches', { name: `${branch}-2` })).status).toBe(201);

        expect((await call('PUT', '/git/current-branch', { branch })).status).toBe(200);
        expect((await call('POST', '/git/update')).body).toEqual({ outcome: 'pending', conflicts: [pathOf('Orders')] });
        expect((await changes()).merge.theirs).toBe(theirs);
    });
});
