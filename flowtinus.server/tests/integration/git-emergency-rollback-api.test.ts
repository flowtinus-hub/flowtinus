import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowFromYaml, repoFlowToYaml, type FlowFile, type RepoTriggers } from '@flowtinus/core';
import { ANA, insertMember, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Mode = 'direct' | 'pull-request' | 'protected';

type Version = { id: string; number: number };

describe('the emergency rollback: an environment runs an older version of one flow, without git, until a commit changes it', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    // Orders deployed three times (labels One, Two, Three): v3 is git's and runs, v1 and v2 ran here before
    async function workspace(mode: Mode = 'direct') {
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
        const relabel = async (flowId: string, label: string) => {
            const { flow, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
            const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            expect((await call('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
        };
        const deployAs = async (label: string): Promise<Version> => {
            await relabel(orders, label);
            const deployed = await call('POST', `/flows/${orders}/deploy`);
            expect(deployed.status).toBe(200);
            return deployed.body.versions[0];
        };
        const v1 = await deployAs('One');
        const v2 = await deployAs('Two');
        const v3 = await deployAs('Three');

        const handle = workspaceHandleOf(id);
        const ordersPath = `${handle}/projects/Sales/flows/Orders.flow.yaml`;
        const show = (ref: string, file: string) =>
            Bun.spawnSync(['git', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const filesOf = (ref: string): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', ref)
                    .split('\n')
                    .filter(Boolean)
                    .map(file => [file, show(ref, file)]),
            );
        const setMode = async (next: Mode) => {
            const topology = git(repo, 'show', 'flowtinus/config:topology.yaml');
            commitFiles(repo, 'flowtinus/config', { 'topology.yaml': `${topology.replace(/mode: [a-z-]+/, `mode: ${next}`)}\n` }, next);
            expect((await call('POST', '/git/reconcile')).status).toBe(200);
            expect((await call('GET', '/git/status')).body.mode).toBe(next);
        };
        // a commit pushed straight to dev, then reconciled: edit gets the flow's file as git has it
        const pushOrders = async (
            edit: (file: {
                flow: FlowFile;
                triggers: RepoTriggers & { deployed?: boolean };
            }) => { flow: FlowFile; triggers: RepoTriggers & { deployed?: boolean } } | null,
            path = ordersPath,
        ) => {
            const files = filesOf('dev');
            const read = repoFlowFromYaml(files[ordersPath]!, 'Orders');
            if (!read.ok) {
                throw new Error(read.errors.join(' '));
            }
            const edited = edit({ flow: read.value.flow, triggers: read.value });
            delete files[ordersPath];
            const next = edited ? { ...files, [path]: repoFlowToYaml(edited.flow, edited.triggers) } : files;
            commitFiles(repo, 'dev', next, 'From git');
            return (await call('POST', '/git/reconcile')).body;
        };
        const relabelled = (flow: FlowFile, label: string): FlowFile => ({
            ...flow,
            nodes: flow.nodes.map(n => (n.type === 'start' ? { ...n, label } : n)),
        });
        const deployments = async () => (await call('GET', `/flows/${orders}/deployments`)).body;
        const runs = async () => {
            const view = await deployments();
            return view.versions.find((v: Version) => v.id === view.deployed?.versionId)?.number ?? null;
        };
        if (mode !== 'direct') {
            await setMode(mode);
        }
        return { id, as, call, projectId, orders, v1, v2, v3, repo, ordersPath, show, pushOrders, relabelled, deployments, runs, relabel };
    }

    const rollBack = (call: (method: string, path: string) => Promise<{ status: number; body: any }>, flowId: string, version: Version) =>
        call('POST', `/flows/${flowId}/versions/${version.id}/emergency-rollback`);

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-emergency-rollback-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('in direct, an editor rolls back to a version that ran here, without a commit; a viewer cannot', async () => {
        const { id, as, orders, v1, v3, repo, runs } = await workspace('direct');
        const tip = git(repo, 'rev-parse', 'dev');
        const editor = await insertMember(db, id, { name: 'Eva', role: 'editor' });
        const viewer = await insertMember(db, id, { name: 'Vic', role: 'viewer' });

        expect((await rollBack(as(viewer), orders, v1)).status).toBe(403);
        const rolled = await rollBack(as(editor), orders, v1);
        expect(rolled.status).toBe(200);
        expect(rolled.body.emergencyRollback).toMatchObject({ number: 1, gitNumber: 3, by: editor, byName: 'Eva' });
        expect(rolled.body.history[0]).toMatchObject({ action: 'emergency-rollback', fromNumber: 3, toNumber: 1, by: editor });
        expect(await runs()).toBe(1);
        expect(git(repo, 'rev-parse', 'dev')).toBe(tip);
        expect(v3.number).toBe(3);
    });

    for (const mode of ['direct', 'pull-request', 'protected'] as const) {
        test(`in ${mode}, the rollback and its end never need git: they work with the remote down`, async () => {
            const { id, as, orders, v2, repo, runs } = await workspace(mode);
            const editor = await insertMember(db, id, { name: 'Eva', role: 'editor' });
            await rename(repo, `${repo}.away`);
            try {
                const user = mode === 'direct' ? editor : ANA;
                expect((await rollBack(as(user), orders, v2)).status).toBe(200);
                expect(await runs()).toBe(2);
                expect((await as(user)('DELETE', `/flows/${orders}/emergency-rollback`)).status).toBe(200);
                expect(await runs()).toBe(3);
            } finally {
                await rename(`${repo}.away`, repo);
            }
        });
    }

    for (const mode of ['pull-request', 'protected'] as const) {
        test(`in ${mode}, only an admin rolls back or ends it: the rollback skips the review`, async () => {
            const { id, as, call, orders, v1 } = await workspace(mode);
            const editor = await insertMember(db, id, { name: 'Eva', role: 'editor' });

            const refused = await rollBack(as(editor), orders, v1);
            expect([refused.status, refused.body.error.message]).toEqual([403, 'Only an admin of this workspace can do this.']);
            expect((await rollBack(call, orders, v1)).status).toBe(200);
            expect((await as(editor)('DELETE', `/flows/${orders}/emergency-rollback`)).status).toBe(403);
            expect((await call('DELETE', `/flows/${orders}/emergency-rollback`)).status).toBe(200);
        });
    }

    test('refused: a version that never ran here, the one running, and with git off', async () => {
        const { call, orders, v3, pushOrders, relabelled, deployments } = await workspace();
        // v4 comes undeployed from git, then v5 deploys: v4 never ran
        expect((await pushOrders(f => ({ flow: relabelled(f.flow, 'Four'), triggers: { ...f.triggers, deployed: false } }))).outcome).toBe(
            'applied',
        );
        expect((await pushOrders(f => ({ flow: relabelled(f.flow, 'Five'), triggers: { ...f.triggers, deployed: true } }))).outcome).toBe(
            'applied',
        );
        const versions = (await deployments()).versions as Version[];
        const v4 = versions.find(v => v.number === 4)!;
        const v5 = versions.find(v => v.number === 5)!;

        const never = await rollBack(call, orders, v4);
        expect([never.status, never.body.error.message]).toEqual([
            400,
            'v4 never ran here: an emergency rollback goes back to a version that ran here.',
        ]);
        const running = await rollBack(call, orders, v5);
        expect([running.status, running.body.error.message]).toEqual([400, 'v5 is the version that runs.']);
        expect((await call('DELETE', `/flows/${orders}/emergency-rollback`)).status).toBe(409);

        await call('DELETE', '/git');
        expect((await rollBack(call, orders, v3)).status).toBe(409);
    });

    test("rolling back again keeps git's version; a version with git's content ends the rollback", async () => {
        const { call, orders, v1, v2, v3, relabel, deployments } = await workspace();
        expect((await rollBack(call, orders, v2)).status).toBe(200);
        const again = await rollBack(call, orders, v1);
        expect(again.body.emergencyRollback).toMatchObject({ number: 1, gitNumber: 3 });

        // v4 has v3's content: it ran here, as a deploy of git's after a rollback to v1 would have
        expect((await call('DELETE', `/flows/${orders}/emergency-rollback`)).status).toBe(200);
        await relabel(orders, 'Two');
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        await relabel(orders, 'Three');
        const v5 = (await call('POST', `/flows/${orders}/deploy`)).body.versions[0] as Version;
        expect(v5.number).toBe(5);
        expect((await rollBack(call, orders, v2)).body.emergencyRollback).toMatchObject({ number: 2, gitNumber: 5 });

        const ended = await rollBack(call, orders, v3);
        expect(ended.status).toBe(200);
        expect(ended.body.emergencyRollback).toBeUndefined();
        expect(ended.body.deployed.versionId).toBe(v5.id);
        expect(ended.body.history.slice(0, 2)).toEqual([
            expect.objectContaining({ action: 'end-emergency-rollback', fromNumber: 2, toNumber: 5 }),
            expect.objectContaining({ action: 'emergency-rollback', fromNumber: 5, toNumber: 2 }),
        ]);
        expect((await deployments()).emergencyRollback).toBeUndefined();
    });

    test("ending by hand goes back to git's version, recorded with the version it left", async () => {
        const { as, id, orders, v1, v3, runs } = await workspace();
        const editor = await insertMember(db, id, { name: 'Eva', role: 'editor' });
        await rollBack(as(editor), orders, v1);

        const ended = await as(editor)('DELETE', `/flows/${orders}/emergency-rollback`);
        expect(ended.status).toBe(200);
        expect(ended.body.deployed.versionId).toBe(v3.id);
        expect(ended.body.history[0]).toMatchObject({ action: 'end-emergency-rollback', fromNumber: 1, toNumber: 3, by: editor });
        expect(await runs()).toBe(3);
    });

    test('the reconcile ends the rollback on a content change, written as ended by that commit', async () => {
        const { call, orders, v1, repo, pushOrders, relabelled, deployments, runs } = await workspace('protected');
        await rollBack(call, orders, v1);

        expect((await pushOrders(f => ({ ...f, flow: relabelled(f.flow, 'Fixed') }))).outcome).toBe('applied');
        const sha = git(repo, 'rev-parse', 'dev');
        const view = await deployments();
        expect(view.emergencyRollback).toBeUndefined();
        expect(await runs()).toBe(4);
        expect(view.history.slice(0, 2)).toEqual([
            expect.objectContaining({ action: 'deploy', fromNumber: 1, toNumber: 4, commit: sha }),
            expect.objectContaining({ action: 'end-emergency-rollback', fromNumber: 1, toNumber: null, commit: sha }),
        ]);
    });

    test('the reconcile ends the rollback when git undeploys, archives or removes the flow', async () => {
        for (const end of ['undeployed', 'removed'] as const) {
            const { call, orders, v1, pushOrders, deployments } = await workspace();
            await rollBack(call, orders, v1);
            const reconciled = await pushOrders(f => (end === 'removed' ? null : { ...f, triggers: { ...f.triggers, deployed: false } }));
            expect(reconciled.outcome).toBe('applied');
            const view = await deployments();
            expect(view.emergencyRollback).toBeUndefined();
            expect(view.deployed).toBeNull();
            expect(view.history[1]).toMatchObject({ action: 'end-emergency-rollback', fromNumber: 1 });
        }

        const { call, orders, v1, deployments } = await workspace();
        await rollBack(call, orders, v1);
        expect((await call('POST', `/flows/${orders}/archive`)).status).toBe(200);
        const changes = (await call('GET', '/git/changes')).body.changes as { path: string }[];
        expect((await call('POST', '/git/commit', { paths: changes.map(c => c.path), message: 'Archive Orders' })).status).toBe(200);
        const view = await deployments();
        expect(view.emergencyRollback).toBeUndefined();
        expect(view.deployed).toBeNull();
    });

    test('the reconcile keeps the rollback on a name, layout or trigger change, a refused commit and an untouched flow', async () => {
        const { call, orders, v1, repo, ordersPath, pushOrders, deployments, runs } = await workspace('pull-request');
        await rollBack(call, orders, v1);

        const moved = (f: { flow: FlowFile; triggers: RepoTriggers }) => ({
            ...f,
            flow: { ...f.flow, nodes: f.flow.nodes.map(n => ({ ...n, position: { x: n.position.x + 40, y: n.position.y + 10 } })) },
        });
        expect((await pushOrders(moved)).outcome).toBe('applied');
        const schedule = { id: crypto.randomUUID(), cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed' as const, parameters: {} };
        expect((await pushOrders(f => ({ ...f, triggers: { ...f.triggers, schedules: [schedule] } }))).outcome).toBe('applied');
        expect((await pushOrders(f => f, ordersPath.replace('Orders.flow.yaml', 'Sales orders.flow.yaml'))).outcome).toBe('applied');

        const files = Object.fromEntries(
            git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                .split('\n')
                .map(file => [file, Bun.spawnSync(['git', 'show', `dev:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString()]),
        );
        const bad = `${ordersPath.split('/')[0]}/connections/Bad.yaml`;
        commitFiles(repo, 'dev', { ...files, [bad]: `id: ${crypto.randomUUID()}\ntype: oracle\n` }, 'Refused');
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('refused');
        delete files[bad];
        // a commit that leaves Orders untouched
        commitFiles(repo, 'dev', { ...files, [`${ordersPath.split('/')[0]}/projects/Sales/scripts/util.ts`]: 'export const x = 1;\n' });
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');

        expect((await deployments()).emergencyRollback).toMatchObject({ number: 1, gitNumber: 3 });
        expect(await runs()).toBe(1);
    });

    test('Revert to the version that runs, in direct, commits it: the rollback ends with that content under a new number', async () => {
        const { call, orders, v1, deployments, runs, show, ordersPath } = await workspace();
        await rollBack(call, orders, v1);

        const fixed = await call('POST', `/flows/${orders}/versions/${v1.id}/deploy`);
        expect(fixed.status).toBe(200);
        expect(show('dev', ordersPath)).toContain('label: One');
        const view = await deployments();
        expect(view.emergencyRollback).toBeUndefined();
        expect(await runs()).toBe(4);
        expect(view.history[0]).toMatchObject({ action: 'deploy', fromNumber: 1, toNumber: 4 });
    });

    test("with a rollback, git's version stays the draft's base: the working copy shows no change", async () => {
        const { call, orders, v1, relabel } = await workspace();
        await relabel(orders, 'Draft');
        await rollBack(call, orders, v1);
        expect((await call('POST', `/flows/${orders}/draft/discard`)).status).toBe(200);
        expect((await call('GET', '/git/changes')).body.changes).toEqual([]);
        expect((await call('GET', `/flows/${orders}/draft`)).body.flow.nodes.find((n: { type: string }) => n.type === 'start').label).toBe(
            'Three',
        );
    });

    test('turning git off ends the rollback: the flow stays at the rolled-back version, an ordinary deployment', async () => {
        const { call, orders, v1, deployments, runs } = await workspace();
        await rollBack(call, orders, v1);

        expect((await call('DELETE', '/git')).status).toBe(200);
        const view = await deployments();
        expect(view.emergencyRollback).toBeUndefined();
        expect(await runs()).toBe(1);
        expect(view.history[0]).toMatchObject({ action: 'end-emergency-rollback', fromNumber: 1, toNumber: null });
    });

    test('a project is not moved to another workspace while one of its flows is in an emergency rollback', async () => {
        const { call, projectId, orders, v1 } = await workspace();
        const target = crypto.randomUUID();
        await insertWorkspace(db, target, 'other');
        await rollBack(call, orders, v1);

        const refused = await call('POST', `/projects/${projectId}/move`, { toWorkspace: workspaceHandleOf(target) });
        expect([refused.status, refused.body.error.message]).toEqual([409, 'End the emergency rollback of Orders first.']);

        await call('DELETE', `/flows/${orders}/emergency-rollback`);
        expect((await call('POST', `/projects/${projectId}/move`, { toWorkspace: workspaceHandleOf(target) })).status).not.toBe(409);
    });
});
