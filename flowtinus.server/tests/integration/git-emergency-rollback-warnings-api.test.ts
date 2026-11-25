import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowFromYaml, repoFlowToYaml, type FlowFile } from '@flowtinus/core';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

const TOPOLOGY = `environments:
  - env: DEV
    label: Development
    branch: dev
    promotesTo: [QA]
    mode: direct
  - env: QA
    label: Quality
    branch: qa
    promotesTo: []
    mode: pull-request
`;

type Version = { id: string; number: number };

const ENDS = 'This ends the emergency rollback of Sales/Orders on DEV.';

describe('the warnings around an emergency rollback: before a change ends it by accident, and before a promotion carries git’s version', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    // Orders deployed three times (labels One, Two, Three): v3 is git's
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
        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY }, 'DEV and QA');
        expect((await call('POST', '/git/reconcile')).status).toBe(200);

        const relabel = async (flowId: string, label: string) => {
            const { flow, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
            const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            expect((await call('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
        };
        const create = async (name: string) => (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
        const deployAs = async (flowId: string, label: string): Promise<Version> => {
            await relabel(flowId, label);
            const deployed = await call('POST', `/flows/${flowId}/deploy`);
            expect(deployed.status).toBe(200);
            return deployed.body.versions[0];
        };
        const orders = await create('Orders');
        const v1 = await deployAs(orders, 'One');
        await deployAs(orders, 'Two');
        await deployAs(orders, 'Three');

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
        const relabelIn = (branch: string, name: string, label: string) => {
            const files = filesOf(branch);
            const path = at(`flows/${name}.flow.yaml`);
            const read = repoFlowFromYaml(files[path]!, name);
            if (!read.ok) {
                throw new Error(read.errors.join(' '));
            }
            const flow: FlowFile = {
                ...read.value.flow,
                nodes: read.value.flow.nodes.map(n => (n.type === 'start' ? { ...n, label } : n)),
            };
            commitFiles(repo, branch, { ...files, [path]: repoFlowToYaml(flow, read.value) }, `${name}: ${label}`);
        };
        const rollBack = async (flowId: string, version: Version) =>
            expect((await call('POST', `/flows/${flowId}/versions/${version.id}/emergency-rollback`)).status).toBe(200);
        return { id, call, repo, orders, v1, create, deployAs, relabel, at, branchAt, tip, relabelIn, rollBack };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-emergency-rollback-warnings-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("a commit's change warns when it ends the rollback by accident: not when it is what runs, nor for a flow not rolled back", async () => {
        const { call, orders, v1, create, deployAs, relabel, at, rollBack } = await workspace();
        const other = await create('Invoices');
        await deployAs(other, 'Begin');
        await rollBack(orders, v1);
        const warningOf = async (path: string) =>
            ((await call('GET', '/git/changes')).body.changes as { path: string; endsEmergencyRollback?: string }[]).find(
                c => c.path === path,
            )?.endsEmergencyRollback;

        await relabel(orders, 'Four');
        await relabel(other, 'Other');
        expect(await warningOf(at('flows/Orders.flow.yaml'))).toBe(ENDS);
        expect(await warningOf(at('flows/Invoices.flow.yaml'))).toBeUndefined();

        // the fix: what runs, committed
        await relabel(orders, 'One');
        const changes = (await call('GET', '/git/changes')).body.changes as { path: string; endsEmergencyRollback?: string }[];
        expect(changes.find(c => c.path === at('flows/Orders.flow.yaml'))).toBeDefined();
        expect(await warningOf(at('flows/Orders.flow.yaml'))).toBeUndefined();
    });

    test("the canvas's Deploy and Revert to vN warn when they end the rollback by accident: not git's version, nor what runs", async () => {
        const { call, orders, v1, relabel, rollBack } = await workspace();
        await rollBack(orders, v1);
        const ends = 'This ends the emergency rollback of Orders on DEV.';
        const view = async () => (await call('GET', `/flows/${orders}/deployments`)).body;

        const { versions, warnings } = await view();
        expect(versions.map((v: { number: number; endsEmergencyRollback?: string }) => [v.number, v.endsEmergencyRollback])).toEqual([
            [3, undefined],
            [2, ends],
            [1, undefined],
        ]);
        expect(warnings).toEqual([]);

        await relabel(orders, 'Four');
        expect((await view()).warnings).toEqual([ends]);
        await relabel(orders, 'One');
        expect((await view()).warnings).toEqual([]);
    });

    test('a pull request into this environment warns when it ends the rollback by accident, not when it carries what runs', async () => {
        const { call, orders, v1, relabel, rollBack } = await workspace();
        await rollBack(orders, v1);
        const handle = (await call('GET', '/me')).body.handle as string;

        expect((await call('POST', '/git/branches', { name: `users/${handle}/edit` })).status).toBe(201);
        await relabel(orders, 'Four');
        expect((await commitAll(call, 'Edit')).status).toBe(200);
        const edit = await call('POST', '/git/pull-request');
        expect(edit.status).toBe(200);
        expect(edit.body.endsEmergencyRollback).toBe(ENDS);

        expect((await call('POST', '/git/branches', { name: `users/${handle}/fix` })).status).toBe(201);
        await relabel(orders, 'One');
        expect((await commitAll(call, 'Fix')).status).toBe(200);
        const fix = await call('POST', '/git/pull-request');
        expect(fix.status).toBe(200);
        expect(fix.body.endsEmergencyRollback).toBeUndefined();
    });

    test("a backport's checks warn when it ends the rollback by accident, not when it carries what runs", async () => {
        const { call, orders, v1, branchAt, relabelIn, rollBack } = await workspace();
        await rollBack(orders, v1);
        const kinds = async () =>
            (
                (await call('GET', '/git/backports/preflight?target=QA')).body.warnings as {
                    kind: string;
                    message: string;
                    items: string[];
                }[]
            ).filter(w => w.kind === 'ends-emergency-rollback');

        branchAt('qa', 'dev');
        relabelIn('qa', 'Orders', 'Four');
        expect(await kinds()).toEqual([{ kind: 'ends-emergency-rollback', message: ENDS, items: ['Sales/Orders'] }]);

        relabelIn('qa', 'Orders', 'One');
        expect(await kinds()).toEqual([]);
    });

    test('a promotion out of this environment warns for a flow in a rollback it changes or adds, not for one it leaves unchanged', async () => {
        const { call, orders, create, deployAs, branchAt, tip, rollBack } = await workspace();
        const stable = await create('Stable');
        const s1 = await deployAs(stable, 'Begin');
        await deployAs(stable, 'Again');
        expect((await call('POST', '/git/reconcile')).status).toBe(200);
        branchAt('qa', 'dev');

        const v3 = (await call('GET', `/flows/${orders}/deployments`)).body.versions[0] as Version;
        await deployAs(orders, 'Four');
        const fresh = await create('Fresh');
        const f1 = await deployAs(fresh, 'Begin');
        await deployAs(fresh, 'Again');
        await rollBack(orders, v3);
        await rollBack(fresh, f1);
        await rollBack(stable, s1);

        const preflight = (await call('GET', `/git/promotions/preflight?target=QA&sha=${tip('dev')}`)).body;
        expect(preflight.warnings.filter((w: { kind: string }) => w.kind === 'emergency-rollback')).toEqual([
            {
                kind: 'emergency-rollback',
                message:
                    "In an emergency rollback on DEV: this promotion carries git's version of these flows, not the ones that run here.",
                items: ['Sales/Fresh', 'Sales/Orders'],
            },
        ]);
    });

    test('a promotion of one flow in a rollback names it', async () => {
        const { call, orders, v1, branchAt, tip, deployAs, rollBack } = await workspace();
        branchAt('qa', 'dev');
        await deployAs(orders, 'Four');
        await rollBack(orders, v1);

        const preflight = (await call('GET', `/git/promotions/preflight?target=QA&sha=${tip('dev')}`)).body;
        expect(preflight.warnings.filter((w: { kind: string }) => w.kind === 'emergency-rollback')).toEqual([
            {
                kind: 'emergency-rollback',
                message:
                    "Sales/Orders is in an emergency rollback on DEV: this promotion carries git's version of it, not the one that runs here.",
                items: ['Sales/Orders'],
            },
        ]);
    });
});
