import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectionToYaml, repoFlowFromYaml, repoFlowToYaml } from '@flowtinus/core';
import { ANA, insertMember, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

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

describe('promoting along an edge that leaves this server: a branch at a first-parent commit, its state read from git', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const callAs = (user: string) => async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const call = callAs(ANA);
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY }, 'DEV, QA and PROD');

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
        /** a flow created and deployed here: a commit on dev */
        const deployFlow = async (name: string) => {
            const flowId = (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
            expect((await call('POST', `/flows/${flowId}/deploy`)).status).toBe(200);
            return flowId;
        };
        /** a merge commit on `into` of `from`, as a pull request merged without a fast-forward */
        const mergeInto = (into: string, from: string) => {
            const tree = git(repo, 'merge-tree', '--write-tree', into, from);
            const who = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
            const commit = git(repo, ...who, 'commit-tree', tree, '-p', tip(into), '-p', tip(from), '-m', `Merge ${from} into ${into}`);
            git(repo, 'update-ref', `refs/heads/${into}`, commit);
            return commit;
        };
        const addFile = (branch: string, path: string) => commitFiles(repo, branch, { ...filesOf(branch), [path]: path }, `Add ${path}`);
        const deleteBranch = (branch: string) => git(repo, 'update-ref', '-d', `refs/heads/${branch}`);
        const poll = () => call('POST', '/git/reconcile');
        const promotions = async () => (await call('GET', '/git/environments')).body.promotions;
        const promote = (sha: string, target = 'QA', as = call) => as('POST', '/git/promotions', { target, sha });
        const preflight = (sha: string, target = 'QA') => call('GET', `/git/promotions/preflight?target=${target}&sha=${sha}`);
        const graph = (target = 'QA', skip = 0) => call('GET', `/git/promotions/graph?target=${target}&skip=${skip}`);
        return {
            id,
            handle: workspaceHandleOf(id),
            call,
            callAs,
            repo,
            projectId,
            filesOf,
            branchAt,
            tip,
            has,
            deployFlow,
            mergeInto,
            addFile,
            deleteBranch,
            poll,
            promotions,
            promote,
            preflight,
            graph,
        };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-promote-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('opening pushes promote/<source>-<sha> at the chosen commit, with no commit of its own, and writes the row', async () => {
        const { call, branchAt, tip, deployFlow, promotions } = await newWorkspace();
        branchAt('qa', 'dev');
        await deployFlow('Orders');
        const sha = tip('dev');
        const branch = `promote/DEV-${sha.slice(0, 12)}`;

        const opened = await call('POST', '/git/promotions', { target: 'QA', sha });
        expect(opened.status).toBe(200);
        expect(opened.body).toMatchObject({
            reused: false,
            alsoOpen: [],
            provider: null,
            promotion: { source: 'DEV', target: 'QA', sha, branch, state: 'open', openedBy: 'Ana', inTopology: true, url: null },
        });
        expect(tip(branch)).toBe(sha);
        expect(await promotions()).toEqual([opened.body.promotion]);
    });

    const short = (sha: string) => sha.slice(0, 12);

    test('a commit off the first-parent line, an edge that does not leave this server, a non-admin: each refused, nothing pushed', async () => {
        const { id, repo, callAs, branchAt, tip, addFile, mergeInto, promote } = await newWorkspace();
        branchAt('qa', 'dev');
        branchAt('side', 'dev');
        const side = addFile('side', 'side.txt');
        addFile('dev', 'line.txt');
        mergeInto('dev', 'side');

        const offLine = await promote(side);
        expect(offLine.status).toBe(409);
        expect(offLine.body.error.message).toContain('first-parent line');

        const notOut = await promote(tip('dev'), 'PROD');
        expect(notOut.status).toBe(409);
        expect(notOut.body.error.message).toContain('DEV does not promote to PROD');

        const editor = await insertMember(db, id, { name: 'Eve', role: 'editor' });
        expect((await promote(tip('dev'), 'QA', callAs(editor))).status).toBe(403);

        expect(git(repo, 'for-each-ref', 'refs/heads/promote/')).toBe('');
    });

    test('the pre-flight blocks an empty promotion, a target ahead of its source and an invalid merge result; opening refuses them', async () => {
        const { handle, repo, filesOf, branchAt, tip, addFile, promote, preflight } = await newWorkspace();
        branchAt('qa', 'dev');
        const kinds = async (sha: string) => (await preflight(sha)).body.blocks.map((b: { kind: string }) => b.kind);

        expect(await kinds(tip('dev'))).toEqual(['empty']);
        const empty = await promote(tip('dev'));
        expect(empty.status).toBe(409);
        expect(empty.body.error.message).toContain('Nothing to promote');

        addFile('qa', 'hotfix.txt');
        addFile('dev', 'work.txt');
        expect(await kinds(tip('dev'))).toEqual(['ahead']);
        const ahead = await promote(tip('dev'));
        expect(ahead.status).toBe(409);
        expect(ahead.body.error.message).toContain('merge qa into dev first');

        addFile('dev', 'hotfix.txt');
        expect(await kinds(tip('dev'))).toEqual([]);

        const project = `${handle}/projects/Sales/project.yaml`;
        commitFiles(repo, 'dev', { ...filesOf('dev'), [project]: 'id: [not a project' }, 'Break the project');
        const invalid = (await preflight(tip('dev'))).body.blocks;
        expect(invalid.map((b: { kind: string }) => b.kind)).toEqual(['invalid']);
        expect(invalid[0].issues.map((i: { path: string }) => i.path)).toContain(project);
        const refused = await promote(tip('dev'));
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain('not valid');

        expect(git(repo, 'for-each-ref', 'refs/heads/promote/')).toBe('');
    });

    const states = (promotions: { sha: string; state: string }[]) => promotions.map(p => [p.sha, p.state]);

    test('the same commit again takes the open promotion; another one opens beside it with a notice; a closed one is pushed again', async () => {
        const { branchAt, has, addFile, deleteBranch, poll, promotions, promote } = await newWorkspace();
        branchAt('qa', 'dev');
        const first = addFile('dev', 'a.txt');
        const opened = (await promote(first)).body.promotion;

        const again = await promote(first);
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ reused: true, alsoOpen: [], promotion: { id: opened.id } });

        const second = addFile('dev', 'b.txt');
        const beside = await promote(second);
        expect(beside.body).toMatchObject({ reused: false, alsoOpen: [{ id: opened.id, sha: first }] });

        deleteBranch(`promote/DEV-${short(first)}`);
        await poll();
        expect(states(await promotions())).toEqual([
            [second, 'open'],
            [first, 'closed'],
        ]);

        const reopened = await promote(first);
        expect(reopened.body).toMatchObject({ reused: false, promotion: { sha: first, state: 'open' } });
        expect(reopened.body.promotion.id).not.toBe(opened.id);
        expect(has(`promote/DEV-${short(first)}`)).toBe(true);
        expect(states(await promotions())).toEqual([
            [first, 'open'],
            [second, 'open'],
            [first, 'closed'],
        ]);
    });

    test('the poll: merged after a fast-forward, after a merge commit, and when a later promotion is merged first; merged is final', async () => {
        const { branchAt, addFile, mergeInto, deleteBranch, poll, promotions, promote } = await newWorkspace();
        branchAt('qa', 'dev');
        const [a, b, c] = [addFile('dev', 'a.txt'), addFile('dev', 'b.txt'), addFile('dev', 'c.txt')];
        for (const sha of [a, b, c]) {
            expect((await promote(sha)).status).toBe(200);
        }
        const stateBySha = async () => Object.fromEntries(states(await promotions()));

        branchAt('qa', `promote/DEV-${short(a)}`);
        await poll();
        expect(await stateBySha()).toEqual({ [a]: 'merged', [b]: 'open', [c]: 'open' });

        mergeInto('qa', `promote/DEV-${short(c)}`);
        await poll();
        expect(await stateBySha()).toEqual({ [a]: 'merged', [b]: 'merged', [c]: 'merged' });

        deleteBranch(`promote/DEV-${short(a)}`);
        await poll();
        expect((await stateBySha())[a]).toBe('merged');
    });

    test('an edge taken out of the topology keeps its rows, shown as such and no longer polled; turning git off keeps the table', async () => {
        const { call, repo, branchAt, addFile, deleteBranch, poll, promotions, promote } = await newWorkspace();
        branchAt('qa', 'dev');
        const sha = addFile('dev', 'a.txt');
        expect((await promote(sha)).status).toBe(200);

        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY.replace('promotesTo: [QA]', 'promotesTo: []') }, 'Nowhere');
        deleteBranch(`promote/DEV-${short(sha)}`);
        await poll();
        expect(await promotions()).toMatchObject([{ sha, state: 'open', inTopology: false }]);
        expect((await promote(sha)).body.error.message).toContain('DEV does not promote to QA');

        const config = (await call('GET', '/git')).body.config;
        expect((await call('DELETE', '/git')).status).toBe(200);
        expect((await call('PUT', '/git', config)).status).toBe(200);
        expect((await call('POST', '/git/on', { choice: 'git' })).status).toBe(200);
        expect(await promotions()).toMatchObject([{ sha, state: 'open', inTopology: false }]);
    });

    test('the commit graph: the first-parent line back to the merge base, merged-in commits not choosable, a few already in the target', async () => {
        const { callAs, id, branchAt, tip, addFile, mergeInto, graph } = await newWorkspace();
        const [old1, old2] = [addFile('dev', 'old1.txt'), addFile('dev', 'old2.txt')];
        branchAt('qa', 'dev');
        branchAt('side', 'dev');
        const side = addFile('side', 'side.txt');
        const line = addFile('dev', 'line.txt');
        const merge = mergeInto('dev', 'side');
        const last = addFile('dev', 'last.txt');

        const page = (await graph()).body;
        expect(page).toMatchObject({ source: 'DEV', target: 'QA', sourceTip: last, targetTip: tip('qa'), next: null });
        type Shown = { sha: string; choosable: boolean; inTarget: boolean };
        expect(page.commits.map((c: Shown) => [c.sha, c.choosable, c.inTarget])).toEqual([
            [last, true, false],
            [merge, true, false],
            [side, false, false],
            [line, true, false],
            [old2, false, true],
            [old1, false, true],
            [expect.any(String), false, true],
        ]);
        expect(page.commits[1]).toMatchObject({ parents: [line, side], message: 'Merge side into dev', author: 'Someone' });

        const viewer = await insertMember(db, id, { name: 'Vera', role: 'viewer' });
        expect((await callAs(viewer)('GET', '/git/promotions/graph?target=QA')).status).toBe(200);
        expect((await graph('PROD')).status).toBe(409);
    });

    test('the commit graph shows 200 commits at most, and the rest with "load more"', async () => {
        const { repo, branchAt, tip, graph } = await newWorkspace();
        branchAt('qa', 'dev');
        let commit = tip('dev');
        const tree = git(repo, 'rev-parse', `${commit}^{tree}`);
        const who = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
        for (let n = 0; n < 205; n++) {
            commit = git(repo, ...who, 'commit-tree', tree, '-p', commit, '-m', `${n}`);
        }
        git(repo, 'update-ref', 'refs/heads/dev', commit);

        const first = (await graph()).body;
        expect(first.commits.length).toBe(200);
        expect(first.next).toBe(200);
        const rest = (await graph('QA', first.next)).body;
        expect(rest.commits.filter((c: { inTarget: boolean }) => !c.inTarget).length).toBe(5);
        expect(rest.next).toBeNull();
    });

    const flowText = (text: string, name: string, change: (read: any) => any) => {
        const read = repoFlowFromYaml(text, name);
        if (!read.ok) {
            throw new Error(read.errors.join(' '));
        }
        const next = change(read.value);
        return repoFlowToYaml(next.flow, next);
    };

    test("the impact on the target's flows by id and its scripts; the warnings: connections and triggers new to it, drafts left behind", async () => {
        const { handle, call, repo, projectId, filesOf, branchAt, tip, deployFlow, preflight } = await newWorkspace();
        const [orders, invoices, refunds, old] = [
            await deployFlow('Orders'),
            await deployFlow('Invoices'),
            await deployFlow('Refunds'),
            await deployFlow('Old'),
        ];
        branchAt('qa', 'dev');

        const at = (path: string) => `${handle}/projects/Sales/${path}`;
        const files = filesOf('dev');
        const text = (name: string) => files[at(`flows/${name}.flow.yaml`)]!;
        const fresh = crypto.randomUUID();
        const [schedule, webhook, connection] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
        const relabel = (flow: any) => ({
            ...flow,
            nodes: flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: 'Begin' } : n)),
        });
        const next: Record<string, string> = {
            ...files,
            [at('flows/Back office/Orders.flow.yaml')]: text('Orders'),
            [at('flows/Invoices.flow.yaml')]: flowText(text('Invoices'), 'Invoices', read => ({ ...read, flow: relabel(read.flow) })),
            [at('flows/Refunds.flow.yaml')]: flowText(text('Refunds'), 'Refunds', read => ({ ...read, deployed: false })),
            [at('flows/Fresh.flow.yaml')]: flowText(text('Orders'), 'Orders', read => ({
                ...read,
                flow: { ...read.flow, id: fresh },
                schedules: [{ id: schedule, cron: '0 * * * *', timezone: 'UTC', misfire: 'relaxed', parameters: {} }],
                webhooks: [{ id: webhook, name: 'Shop', response: 'async' }],
            })),
            [at('scripts/tools.ts')]: 'export const one = 1;\n',
            [`${handle}/connections/Shop.yaml`]: connectionToYaml({ id: connection, type: 'kafka' }),
        };
        delete next[at('flows/Orders.flow.yaml')];
        delete next[at('flows/Old.flow.yaml')];
        commitFiles(repo, 'dev', next, 'Work for QA');
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Draft' })).status).toBe(201);

        const checked = (await preflight(tip('dev'))).body;
        expect(checked.blocks).toEqual([]);
        expect(checked.impact).toEqual({
            flows: [
                { id: orders, name: 'Sales/Back office/Orders', from: 'Sales/Orders', changes: ['renamed'] },
                { id: fresh, name: 'Sales/Fresh', changes: ['added'] },
                { id: invoices, name: 'Sales/Invoices', changes: ['changed'] },
                { id: old, name: 'Sales/Old', changes: ['removed'] },
                { id: refunds, name: 'Sales/Refunds', changes: ['undeployed'] },
            ],
            scripts: [{ path: 'Sales/tools', change: 'added' }],
        });
        expect(checked.files.length).toBe(8);
        expect(checked.warnings.map((w: { kind: string; items: string[] }) => [w.kind, w.items])).toEqual([
            ['connections', ['Shop']],
            ['triggers', ['Sales/Fresh: schedule 0 * * * *', 'Sales/Fresh: webhook Shop']],
            ['drafts', [at('flows/Draft.flow.yaml')]],
        ]);
    });

    test("activity: this server's reconciles, applied or refused", async () => {
        const { call, handle, repo, filesOf, tip, deployFlow } = await newWorkspace();
        await deployFlow('Orders');
        const applied = tip('dev');
        commitFiles(repo, 'dev', { ...filesOf('dev'), [`${handle}/projects/Sales/project.yaml`]: 'id: [not a project' }, 'Break');
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('refused');

        const { reconciles } = (await call('GET', '/git/environments')).body;
        expect(reconciles.slice(0, 2).map((r: { sha: string; outcome: string }) => [r.sha, r.outcome])).toEqual([
            [tip('dev'), 'refused'],
            [applied, 'applied'],
        ]);
    });
});
