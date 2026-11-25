import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowFromYaml, repoFlowToYaml, type FlowFile, type RepoTriggers } from '@flowtinus/core';
import { ANA, insertMember, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { fakeGitLab, type FakeGitLab } from '../helpers/fake-gitlab';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Mode = 'direct' | 'pull-request' | 'protected';

type Version = { id: string; number: number };

type File = { flow: FlowFile; triggers: RepoTriggers & { deployed?: boolean } };

const SCOPES = ['api', 'read_repository', 'write_repository'];

describe('"Make git match what runs": the fix of an emergency rollback, a commit of the rolled-back content', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    let gitConfig: string;
    let gitlab: FakeGitLab;
    const globalBefore = process.env.GIT_CONFIG_GLOBAL;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    // Orders deployed three times (labels One, Two, Three), then rolled back to v1 by an admin: v3 is git's
    async function workspace(mode: Mode, { adapter = false } = {}) {
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
        const gitlabPath = `omc/${id}`;
        let repository = pathToFileURL(repo).href;
        if (adapter) {
            repository = gitlab.repository(gitlabPath);
            git(dir, 'config', '--file', gitConfig, '--add', `url.${pathToFileURL(repo).href}.insteadOf`, repository);
            gitlab.token(`token-${id}`, SCOPES);
        }
        await call('POST', '/secrets', { name: 'git-token', value: `token-${id}` });
        await call('PUT', '/git', { repository, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        const deployAs = async (label: string): Promise<Version> => {
            const { flow, revision } = (await call('GET', `/flows/${orders}/draft`)).body;
            const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            expect((await call('PUT', `/flows/${orders}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
            const deployed = await call('POST', `/flows/${orders}/deploy`);
            expect(deployed.status).toBe(200);
            return deployed.body.versions[0];
        };
        const v1 = await deployAs('One');
        await deployAs('Two');
        await deployAs('Three');

        const handle = workspaceHandleOf(id);
        const ordersPath = `${handle}/projects/Sales/flows/Orders.flow.yaml`;
        const show = (ref: string, file: string) =>
            Bun.spawnSync(['git', '-c', 'core.quotePath=false', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const filesOf = (ref: string): Record<string, string> =>
            Object.fromEntries(
                git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', ref)
                    .split('\n')
                    .filter(Boolean)
                    .map(file => [file, show(ref, file)]),
            );
        const tip = (ref: string) => git(repo, 'rev-parse', ref);
        const label = (ref: string, path = ordersPath) => {
            const read = repoFlowFromYaml(show(ref, path), 'Orders');
            if (!read.ok) {
                throw new Error(read.errors.join(' '));
            }
            return read.value.flow.nodes.find(n => n.type === 'start')!.label;
        };
        // a commit pushed straight to a branch; edit gets Orders' file as git has it there
        const pushOrders = (branch: string, edit: (file: File) => File, path = ordersPath) => {
            const files = filesOf(branch);
            const read = repoFlowFromYaml(files[ordersPath]!, 'Orders');
            if (!read.ok) {
                throw new Error(read.errors.join(' '));
            }
            const edited = edit({ flow: read.value.flow, triggers: read.value });
            delete files[ordersPath];
            return commitFiles(repo, branch, { ...files, [path]: repoFlowToYaml(edited.flow, edited.triggers) }, 'From git');
        };
        const relabelled = (flow: FlowFile, to: string): FlowFile => ({
            ...flow,
            nodes: flow.nodes.map(n => (n.type === 'start' ? { ...n, label: to } : n)),
        });
        const setMode = async (next: Mode) => {
            const topology = git(repo, 'show', 'flowtinus/config:topology.yaml');
            commitFiles(repo, 'flowtinus/config', { 'topology.yaml': `${topology.replace(/mode: [a-z-]+/, `mode: ${next}`)}\n` }, next);
            expect((await call('POST', '/git/reconcile')).status).toBe(200);
            expect((await call('GET', '/git/status')).body.mode).toBe(next);
        };
        const deployments = async () => (await call('GET', `/flows/${orders}/deployments`)).body;
        const runs = async () => {
            const view = await deployments();
            return view.versions.find((v: Version) => v.id === view.deployed?.versionId)?.number ?? null;
        };
        // the review: the fix's branch merged into dev, then reconciled
        const merge = async (branch: string) => {
            git(repo, 'update-ref', 'refs/heads/dev', tip(branch));
            expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
        };
        if (mode !== 'direct') {
            await setMode(mode);
        }
        expect((await call('POST', `/flows/${orders}/versions/${v1.id}/emergency-rollback`)).status).toBe(200);
        const fix = (user = ANA) => as(user)('POST', `/flows/${orders}/emergency-rollback/match-git`);
        const short = orders.slice(0, 8);
        const project = () => gitlab.project(gitlabPath);
        return {
            id,
            as,
            call,
            orders,
            short,
            repo,
            ordersPath,
            tip,
            label,
            pushOrders,
            relabelled,
            deployments,
            runs,
            merge,
            fix,
            project,
        };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-emergency-rollback-fix-test-'));
        gitConfig = join(dir, 'gitconfig');
        await Bun.write(gitConfig, '');
        process.env.GIT_CONFIG_GLOBAL = gitConfig;
        gitlab = fakeGitLab();
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        if (globalBefore === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL;
        } else {
            process.env.GIT_CONFIG_GLOBAL = globalBefore;
        }
        await gitlab.stop();
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("in direct, an editor's fix is a commit on the environment's branch: the rollback ends with that content, under a new number", async () => {
        const { id, as, label, fix, deployments, runs, tip } = await workspace('direct');
        const viewer = await insertMember(db, id, { name: 'Vic', role: 'viewer' });
        const editor = await insertMember(db, id, { name: 'Eva', role: 'editor' });
        expect((await fix(viewer)).status).toBe(403);

        const fixed = await fix(editor);
        expect(fixed.status).toBe(200);
        expect(fixed.body.commit).toBe(tip('dev'));
        expect(fixed.body.emergencyRollback).toBeUndefined();
        expect(label('dev')).toBe('One');
        expect(await runs()).toBe(4);
        expect((await deployments()).history.slice(0, 2)).toEqual([
            expect.objectContaining({ action: 'deploy', fromNumber: 1, toNumber: 4, commit: tip('dev') }),
            expect.objectContaining({ action: 'end-emergency-rollback', fromNumber: 1, toNumber: null, commit: tip('dev') }),
        ]);
        expect((await as(editor)('POST', `/flows/${crypto.randomUUID()}/emergency-rollback/match-git`)).status).toBe(404);
        expect((await fix(editor)).status).toBe(409);
    });

    for (const [mode, prefix] of [
        ['pull-request', 'rollback-'],
        ['protected', 'hotfix/rollback-'],
    ] as const) {
        test(`in ${mode}, an editor's fix is the branch ${prefix}<slug>-<short id>-v<N>, cut from the tip with one commit and pushed`, async () => {
            const { id, short, label, tip, fix, merge, deployments, runs } = await workspace(mode);
            const editor = await insertMember(db, id, { name: 'Eva', role: 'editor' });
            const before = tip('dev');

            const fixed = await fix(editor);
            expect(fixed.status).toBe(200);
            const branch = `${prefix}orders-${short}-v1`;
            expect(fixed.body.fix).toEqual({ branch, target: 'dev', reused: false, provider: null, url: null });
            expect(tip(`${branch}~1`)).toBe(before);
            expect(label(branch)).toBe('One');
            expect(tip('dev')).toBe(before);
            expect(fixed.body.emergencyRollback).toMatchObject({ number: 1, gitNumber: 3 });

            await merge(branch);
            expect((await deployments()).emergencyRollback).toBeUndefined();
            expect(await runs()).toBe(4);
            expect((await deployments()).history[0]).toMatchObject({ action: 'deploy', fromNumber: 1, toNumber: 4 });
        });
    }

    test("with the adapter on, the work branch's merge request is opened through it", async () => {
        const { short, fix, project } = await workspace('pull-request', { adapter: true });

        const fixed = await fix();
        expect(fixed.status).toBe(200);
        const branch = `rollback-orders-${short}-v1`;
        const [mr] = project().mergeRequests;
        expect(mr).toMatchObject({ source_branch: branch, target_branch: 'dev', force_remove_source_branch: true });
        expect(fixed.body.fix).toMatchObject({ branch, provider: 'gitlab', url: mr!.web_url, mergeRequest: { number: mr!.iid } });

        expect((await fix()).body.fix).toMatchObject({ reused: true, mergeRequest: { number: mr!.iid } });
        expect(project().mergeRequests).toHaveLength(1);
    });

    test("the name's slug is the core's, and the short id alone names a flow whose slug is empty", async () => {
        const { call, short, ordersPath, pushOrders, fix, label } = await workspace('pull-request');
        const renamed = ordersPath.replace('Orders.flow.yaml', '日本.flow.yaml');
        pushOrders('dev', f => f, renamed);
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');

        const fixed = await fix();
        expect(fixed.status).toBe(200);
        expect(fixed.body.fix.branch).toBe(`rollback-${short}-v1`);
        expect(label(`rollback-${short}-v1`, renamed)).toBe('One');
    });

    test('an existing branch of that name is reused when its flow is what runs, and refused otherwise, saying why', async () => {
        const { short, tip, fix, pushOrders, relabelled } = await workspace('pull-request');
        const branch = `rollback-orders-${short}-v1`;
        expect((await fix()).status).toBe(200);
        // a colleague's commit on the shared branch that leaves Orders' content as it runs
        const moved = pushOrders(branch, f => ({
            ...f,
            flow: { ...f.flow, nodes: f.flow.nodes.map(n => ({ ...n, position: { x: n.position.x + 40, y: n.position.y } })) },
        }));

        const reused = await fix();
        expect(reused.status).toBe(200);
        expect(reused.body.fix).toMatchObject({ branch, reused: true });
        expect(tip(branch)).toBe(moved);

        pushOrders(branch, f => ({ ...f, flow: relabelled(f.flow, 'Other') }));
        const refused = await fix();
        expect([refused.status, refused.body.error.message]).toEqual([
            409,
            `The branch ${branch} exists, and its Orders is not the version that runs (v1): delete the branch, or merge it as it is.`,
        ]);
    });
});
