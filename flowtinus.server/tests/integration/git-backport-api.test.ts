import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectionToYaml, repoFlowFromYaml, repoFlowToYaml } from '@flowtinus/core';
import { ANA, insertMember, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(60_000);

const TOPOLOGY = `environments:
  - env: DEV
    label: Development
    branch: dev
    promotesTo: [QA]
    mode: direct
  - env: QA
    label: Quality
    branch: qa
    promotesTo: [PROD]
    mode: pull-request
  - env: PROD
    label: Production
    branch: main
    promotesTo: []
    mode: protected
`;

const short = (sha: string) => sha.slice(0, 12);

describe("backporting an environment ahead of its source: a merge of its tip cut from the source's branch, opened on the source's server", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const callIn = (workspace: string) => (user: string) => async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(workspace, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const callAs = callIn(id);
        const call = callAs(ANA);
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const flowId = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('POST', `/flows/${flowId}/deploy`)).status).toBe(200);
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY }, 'DEV, QA and PROD');

        const handle = workspaceHandleOf(id);
        const at = (path: string) => `${handle}/projects/Sales/${path}`;
        const show = (ref: string, file: string) =>
            Bun.spawnSync(['git', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const filesOf = (ref: string): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', ref)
                    .split('\n')
                    .filter(Boolean)
                    .map(file => [file, show(ref, file)]),
            );
        const branchAt = (branch: string, from: string) => git(repo, 'update-ref', `refs/heads/${branch}`, git(repo, 'rev-parse', from));
        const tip = (branch: string) => git(repo, 'rev-parse', branch);
        const has = (branch: string) => git(repo, 'branch', '--list', branch) !== '';
        const parents = (ref: string) => git(repo, 'rev-list', '--parents', '-n', '1', ref).split(' ').slice(1);
        const write = (branch: string, files: Record<string, string>) =>
            commitFiles(repo, branch, { ...filesOf(branch), ...files }, `Change ${Object.keys(files).join(', ')}`);
        const addFile = (branch: string, path: string) => write(branch, { [path]: path });
        const mergeInto = (into: string, from: string) => {
            const tree = git(repo, 'merge-tree', '--write-tree', into, from);
            const who = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
            const commit = git(repo, ...who, 'commit-tree', tree, '-p', tip(into), '-p', tip(from), '-m', `Merge ${from} into ${into}`);
            git(repo, 'update-ref', `refs/heads/${into}`, commit);
            return commit;
        };
        const squashInto = (into: string, from: string) => {
            const tree = git(repo, 'merge-tree', '--write-tree', into, from);
            const who = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
            const commit = git(repo, ...who, 'commit-tree', tree, '-p', tip(into), '-m', `Squash ${from} into ${into}`);
            git(repo, 'update-ref', `refs/heads/${into}`, commit);
            return commit;
        };
        const deleteBranch = (branch: string) => git(repo, 'update-ref', '-d', `refs/heads/${branch}`);
        const poll = () => call('POST', '/git/reconcile');
        const promotions = async () => (await call('GET', '/git/environments')).body.promotions;
        const backport = (as = call) => as('POST', '/git/backports', { target: 'QA' });
        const backportPreflight = () => call('GET', '/git/backports/preflight?target=QA');
        const otherServer = async (environment: string) => {
            const other = crypto.randomUUID();
            await insertWorkspace(db, other);
            const there = callIn(other)(ANA);
            await there('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
            expect(
                (await there('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment })).status,
            ).toBe(200);
            expect((await there('POST', '/git/on', { choice: 'git' })).status).toBe(200);
            return there;
        };
        return {
            id,
            handle,
            call,
            callAs,
            repo,
            flowId,
            at,
            filesOf,
            branchAt,
            tip,
            has,
            parents,
            write,
            addFile,
            mergeInto,
            squashInto,
            deleteBranch,
            poll,
            promotions,
            backport,
            backportPreflight,
            otherServer,
        };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-backport-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("clean: backport/<E>-<E's tip> is a merge commit of the source's tip and E's tip, pushed and written as a backport row", async () => {
        const { call, at, filesOf, branchAt, tip, parents, write, addFile, promotions, backport, backportPreflight } = await newWorkspace();
        branchAt('qa', 'dev');
        const hotfix = write('qa', { [at('scripts/hotfix.ts')]: 'export const fix = 1;\n' });
        const source = addFile('dev', 'work.txt');
        const branch = `backport/QA-${short(hotfix)}`;

        const checked = await backportPreflight();
        expect(checked.status).toBe(200);
        expect(checked.body).toMatchObject({ sha: hotfix, branch, blocks: [], warnings: [], conflicts: [], open: [] });

        const opened = await backport();
        expect(opened.status).toBe(200);
        expect(opened.body).toMatchObject({
            reused: false,
            alsoOpen: [],
            conflicts: [],
            provider: null,
            promotion: {
                kind: 'backport',
                source: 'QA',
                target: 'DEV',
                sha: hotfix,
                branch,
                state: 'open',
                openedBy: 'Ana',
                inTopology: true,
            },
        });
        expect(parents(branch)).toEqual([source, hotfix]);
        expect(filesOf(branch)[at('scripts/hotfix.ts')]).toBe('export const fix = 1;\n');
        expect(tip('dev')).toBe(source);
        expect(await promotions()).toEqual([opened.body.promotion]);

        const edge = (await call('GET', '/git/environments')).body.edges.find((e: { target: string }) => e.target === 'QA');
        expect(edge).toMatchObject({ ahead: true, broken: [], backports: [{ id: opened.body.promotion.id, state: 'open' }] });
    });

    test("conflicts: the branch is pushed at the source's tip with a pending merge here; once resolved, its commit takes the whole merge", async () => {
        const { callAs, id, at, filesOf, branchAt, tip, parents, write, backport } = await newWorkspace();
        const path = at('scripts/tools.ts');
        write('dev', { [path]: 'export const tool = "base";\n' });
        branchAt('qa', 'dev');
        const hotfix = write('qa', { [path]: 'export const tool = "qa";\n', [at('scripts/hotfix.ts')]: 'export const fix = 1;\n' });
        const source = write('dev', { [path]: 'export const tool = "dev";\n' });
        const branch = `backport/QA-${short(hotfix)}`;

        const opened = await backport();
        expect(opened.status).toBe(200);
        expect(opened.body).toMatchObject({ reused: false, conflicts: [path], promotion: { kind: 'backport', branch, state: 'open' } });
        expect(tip(branch)).toBe(source);

        const editor = await insertMember(db, id, { name: 'Eve', role: 'editor' });
        const eve = callAs(editor);
        expect((await eve('PUT', '/git/current-branch', { branch })).body).toMatchObject({ branch, editable: true });
        const listed = (await eve('GET', '/git/changes')).body;
        expect(listed.merge).toEqual({ from: 'qa', theirs: hotfix, ours: source, conflicts: [path] });

        const early = await eve('POST', '/git/pull-request');
        expect(early.status).toBe(409);
        expect(early.body.error.message).toContain('pending');

        const conflict = await eve('GET', `/git/conflict?path=${encodeURIComponent(path)}`);
        const hunks = conflict.body.conflict.segments.filter((s: object) => 'hunk' in s).map(() => 'theirs');
        expect((await eve('POST', '/git/conflict', { path, revision: conflict.body.revision, hunks })).status).toBe(200);
        const committed = await commitAll(eve, 'Backport QA into dev');
        expect(committed.status).toBe(200);
        expect(parents(branch)).toEqual([source, hotfix]);
        expect(filesOf(branch)[path]).toBe('export const tool = "qa";\n');

        const pr = await eve('POST', '/git/pull-request');
        expect(pr.status).toBe(200);
        expect(pr.body).toMatchObject({ branch, target: 'dev', commits: 2 });
    });

    test('refused: E not ahead, a merge result with validation errors, a non-admin; nothing pushed', async () => {
        const { id, callAs, repo, at, branchAt, write, addFile, backport, backportPreflight } = await newWorkspace();
        const kinds = async () => (await backportPreflight()).body.blocks.map((b: { kind: string }) => b.kind);
        branchAt('qa', 'dev');
        addFile('dev', 'work.txt');

        expect(await kinds()).toEqual(['not-ahead']);
        const notAhead = await backport();
        expect(notAhead.status).toBe(409);
        expect(notAhead.body.error.message).toContain('not ahead');

        write('qa', { [at('project.yaml')]: 'id: [not a project' });
        const invalid = (await backportPreflight()).body.blocks;
        expect(invalid.map((b: { kind: string }) => b.kind)).toEqual(['invalid']);
        expect(invalid[0].issues.map((i: { path: string }) => i.path)).toContain(at('project.yaml'));
        expect((await backport()).status).toBe(409);

        const editor = await insertMember(db, id, { name: 'Eve', role: 'editor' });
        expect((await backport(callAs(editor))).status).toBe(403);

        expect(git(repo, 'for-each-ref', 'refs/heads/backport/')).toBe('');
    });

    test('a conflict outside the workspace’s files blocks it: nothing pushed, no pending merge', async () => {
        const { id, repo, write, branchAt, backport, backportPreflight } = await newWorkspace();
        const outside = 'shared/readme.md';
        write('dev', { [outside]: 'base\n' });
        branchAt('qa', 'dev');
        write('qa', { [outside]: 'qa\n' });
        write('dev', { [outside]: 'dev\n' });
        const message = `Merging qa into dev conflicts outside this workspace (${outside}): backport it in git.`;

        expect((await backportPreflight()).body.blocks).toEqual([{ kind: 'outside', message }]);
        const refused = await backport();
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain(message);
        expect(git(repo, 'for-each-ref', 'refs/heads/backport/')).toBe('');
        expect(await db.query('SELECT branch FROM pending_merges WHERE workspace_id = $1', [id])).toEqual([]);
    });

    test('the warnings: connections and triggers new to the source, declared in the merge result', async () => {
        const { handle, at, flowId, branchAt, filesOf, write, backportPreflight } = await newWorkspace();
        branchAt('qa', 'dev');
        const flowPath = at('flows/Orders.flow.yaml');
        const read = repoFlowFromYaml(filesOf('qa')[flowPath]!, 'Orders');
        if (!read.ok) {
            throw new Error(read.errors.join(' '));
        }
        expect(read.value.flow.id).toBe(flowId);
        write('qa', {
            [flowPath]: repoFlowToYaml(read.value.flow, {
                ...read.value,
                schedules: [{ id: crypto.randomUUID(), cron: '0 * * * *', timezone: 'UTC', misfire: 'relaxed', parameters: {} }],
                webhooks: [{ id: crypto.randomUUID(), name: 'Shop', response: 'async' }],
            }),
            [`${handle}/connections/Shop.yaml`]: connectionToYaml({ id: crypto.randomUUID(), type: 'kafka' }),
        });

        const checked = (await backportPreflight()).body;
        expect(checked.blocks).toEqual([]);
        expect(checked.warnings.map((w: { kind: string; items: string[] }) => [w.kind, w.items])).toEqual([
            ['connections', ['Shop']],
            ['triggers', ['Sales/Orders: schedule 0 * * * *', 'Sales/Orders: webhook Shop']],
        ]);
        expect(checked.warnings.map((w: { message: string }) => w.message)).toEqual([
            'New to DEV: they arrive not configured.',
            'New to DEV: they arrive disabled.',
        ]);
    });

    const states = (promotions: { sha: string; state: string }[]) => promotions.map(p => [p.sha, p.state]);

    test('the same tip links to the open backport; a later one opens beside it; the poll: merged when a later one is, closed when deleted', async () => {
        const { branchAt, has, addFile, mergeInto, deleteBranch, poll, promotions, backport } = await newWorkspace();
        branchAt('qa', 'dev');
        addFile('dev', 'work.txt');
        const first = addFile('qa', 'a.txt');
        const opened = (await backport()).body.promotion;
        expect((await backport()).body).toMatchObject({ reused: true, alsoOpen: [], promotion: { id: opened.id } });

        const second = addFile('qa', 'b.txt');
        const beside = await backport();
        expect(beside.body).toMatchObject({ reused: false, alsoOpen: [{ id: opened.id, sha: first }], promotion: { sha: second } });

        mergeInto('dev', `backport/QA-${short(second)}`);
        await poll();
        expect(states(await promotions())).toEqual([
            [second, 'merged'],
            [first, 'merged'],
        ]);

        const third = addFile('qa', 'c.txt');
        expect((await backport()).status).toBe(200);
        deleteBranch(`backport/QA-${short(third)}`);
        await poll();
        expect(states(await promotions())[0]).toEqual([third, 'closed']);
        expect(has(`backport/QA-${short(third)}`)).toBe(false);
    });

    test("once merged, the promotion from the source is no longer blocked as ahead; an open backport blocks nothing; the source's own source sees it ahead", async () => {
        const { tip, branchAt, addFile, mergeInto, poll, backport, otherServer, call } = await newWorkspace();
        branchAt('qa', 'dev');
        branchAt('main', 'dev');
        addFile('qa', 'hotfix.txt');
        const work = addFile('dev', 'work.txt');
        const kinds = async (sha: string) =>
            (await call('GET', `/git/promotions/preflight?target=QA&sha=${sha}`)).body.blocks.map((b: { kind: string }) => b.kind);
        expect(await kinds(work)).toEqual(['ahead']);

        const opened = (await backport()).body.promotion;
        expect(await kinds(work)).toEqual(['ahead']);

        mergeInto('dev', opened.branch);
        await poll();
        expect(await kinds(tip('dev'))).toEqual([]);
        expect((await call('POST', '/git/promotions', { target: 'QA', sha: tip('dev') })).status).toBe(200);

        addFile('main', 'prod-fix.txt');
        const qa = await otherServer('QA');
        const edge = (await qa('GET', '/git/environments')).body.edges.find((e: { target: string }) => e.target === 'PROD');
        expect(edge.ahead).toBe(true);
        expect((await qa('GET', '/git/backports/preflight?target=PROD')).body.blocks).toEqual([]);
    });

    test('a squashed backport is found as a broken lineage and stays broken through a revert; it blocks neither the promotion nor another backport', async () => {
        const { call, repo, filesOf, tip, branchAt, addFile, squashInto, deleteBranch, poll, promotions, backport, backportPreflight } =
            await newWorkspace();
        branchAt('qa', 'dev');
        addFile('dev', 'work.txt');
        const sha = addFile('qa', 'hotfix.txt');
        const opened = (await backport()).body.promotion;
        const before = filesOf('dev');

        squashInto('dev', opened.branch);
        deleteBranch(opened.branch);
        await poll();
        expect(states(await promotions())).toEqual([[sha, 'broken']]);

        const preflight = await call('GET', `/git/promotions/preflight?target=QA&sha=${tip('dev')}`);
        expect(preflight.body.blocks).toEqual([]);
        expect((await call('POST', '/git/promotions', { target: 'QA', sha: tip('dev') })).status).toBe(200);
        const promoted = (await promotions()).find((p: { kind: string }) => p.kind === 'promotion');

        commitFiles(repo, 'dev', before, 'Revert the squash');
        await poll();
        expect(states(await promotions())).toEqual([
            [promoted.sha, 'open'],
            [sha, 'broken'],
        ]);

        const next = addFile('qa', 'second-fix.txt');
        expect((await backportPreflight()).body).toMatchObject({ sha: next, blocks: [], open: [] });
        expect((await backport()).body).toMatchObject({ reused: false, alsoOpen: [], promotion: { sha: next, state: 'open' } });

        const edge = (await call('GET', '/git/environments')).body.edges.find((e: { target: string }) => e.target === 'QA');
        expect(edge.ahead).toBe(true);
        expect(edge.broken).toEqual([]);
        expect(states(edge.backports)).toEqual([
            [next, 'open'],
            [sha, 'broken'],
        ]);
    });

    test("the repair of a broken backport: an admin's merge of the sha that keeps the source's tree; once merged, the row is merged", async () => {
        const { id, call, callAs, repo, tip, has, branchAt, addFile, squashInto, mergeInto, poll, promotions, backport } =
            await newWorkspace();
        branchAt('qa', 'dev');
        addFile('dev', 'work.txt');
        const sha = addFile('qa', 'hotfix.txt');
        const opened = (await backport()).body.promotion;
        squashInto('dev', opened.branch);
        await poll();
        const repair = (as = call) => as('POST', `/git/promotions/${opened.id}/repair`);
        const branch = `repair/DEV-${short(sha)}`;

        const editor = await insertMember(db, id, { name: 'Eve', role: 'editor' });
        expect((await repair(callAs(editor))).status).toBe(403);
        expect(has(branch)).toBe(false);

        const pushed = await repair();
        expect(pushed.status).toBe(200);
        expect(pushed.body).toMatchObject({ branch, reused: false, url: null, provider: null });
        expect(git(repo, 'rev-list', '--parents', '-n', '1', branch).split(' ').slice(1)).toEqual([tip('dev'), sha]);
        expect(git(repo, 'rev-parse', `${branch}^{tree}`)).toBe(git(repo, 'rev-parse', 'dev^{tree}'));
        expect((await repair()).body).toMatchObject({ branch, reused: true });

        mergeInto('dev', branch);
        await poll();
        expect(states(await promotions())).toEqual([[sha, 'merged']]);
        const edge = (await call('GET', '/git/environments')).body.edges.find((e: { target: string }) => e.target === 'QA');
        expect(edge.backports).toEqual([]);
        expect((await repair()).status).toBe(409);
    });

    test("the branch is shared on the source's server, whatever its mode, and read only on every other server", async () => {
        const { branchAt, addFile, backport, call, otherServer } = await newWorkspace();
        branchAt('qa', 'dev');
        addFile('qa', 'hotfix.txt');
        const branch = (await backport()).body.promotion.branch as string;

        const listed = (await call('GET', '/git/branches')).body.branches.find((b: { name: string }) => b.name === branch);
        expect(listed).toMatchObject({ kind: 'backport', editable: true });

        const qa = await otherServer('QA');
        expect((await qa('PUT', '/git/current-branch', { branch })).body).toMatchObject({ branch, editable: false });
        const refused = await qa('POST', '/git/pull-request');
        expect(refused.status).toBe(409);
        expect((await qa('GET', '/git/branches')).body.branches.map((b: { name: string }) => b.name)).not.toContain(branch);
    });

    test('an edge out of the topology keeps its backport rows, no longer polled; turning git off keeps them', async () => {
        const { call, repo, branchAt, addFile, deleteBranch, poll, promotions, backport } = await newWorkspace();
        branchAt('qa', 'dev');
        const sha = addFile('qa', 'hotfix.txt');
        expect((await backport()).status).toBe(200);

        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY.replace('promotesTo: [QA]', 'promotesTo: []') }, 'Nowhere');
        deleteBranch(`backport/QA-${short(sha)}`);
        await poll();
        expect(await promotions()).toMatchObject([{ kind: 'backport', sha, state: 'open', inTopology: false }]);

        const config = (await call('GET', '/git')).body.config;
        expect((await call('DELETE', '/git')).status).toBe(200);
        expect((await call('PUT', '/git', config)).status).toBe(200);
        expect((await call('POST', '/git/on', { choice: 'git' })).status).toBe(200);
        expect(await promotions()).toMatchObject([{ kind: 'backport', sha, state: 'open', inTopology: false }]);
    });
});
