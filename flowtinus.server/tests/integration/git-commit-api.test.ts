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

type Version = { number: number; commit: string | null; commitMessage?: string; createdByName?: string; createdBy: string | null };
type Event = {
    action: string;
    fromNumber: number | null;
    toNumber: number | null;
    commit: string | null;
    by: string | null;
    byName?: string;
};

describe("with git on, a deploy is a Commit to the environment's branch", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace(options: { git?: boolean } = {}) {
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
        if (options.git !== false) {
            await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
            await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
            expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
            expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        }

        const newFlow = async (name: string) => (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
        const relabel = async (flowId: string, label: string) => {
            const { flow, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
            const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            expect((await call('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
        };
        const flowPath = (name: string) => `${slugOf(id)}/projects/Sales/flows/${name}.flow.yaml`;
        const show = (path: string) => Bun.spawnSync(['git', 'show', `dev:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const onBranch = (): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                    .split('\n')
                    .map(path => [path, show(path)]),
            );
        const tip = () => git(repo, 'rev-parse', 'dev');
        const lastCommit = () => git(repo, 'log', '-1', '--format=%an|%cn|%s', 'dev');
        return { call, repo, projectId, newFlow, relabel, flowPath, show, onBranch, tip, lastCommit };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-commit-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a Commit writes the draft to the branch with its message; the reconcile deploys it as a version of that commit', async () => {
        const { call, newFlow, relabel, flowPath, show, tip, lastCommit } = await newWorkspace();
        const orders = await newFlow('Orders');
        expect((await call('GET', `/flows/${orders}/deployments`)).body.git).toEqual({ branch: 'dev', mode: 'direct' });

        const first = await call('POST', `/flows/${orders}/deploy`);
        expect(first.status).toBe(200);
        expect(lastCommit()).toBe('Ana|Flowtinus|Update Orders');
        expect(first.body.commit).toBe(tip());

        await relabel(orders, 'Begin');
        const second = await call('POST', `/flows/${orders}/deploy`, { message: 'Name the start' });
        expect(second.status).toBe(200);
        expect(lastCommit()).toBe('Ana|Flowtinus|Name the start');
        expect(show(flowPath('Orders'))).toContain('label: Begin');
        expect(second.body.commit).toBe(tip());

        const versions = second.body.versions as Version[];
        expect(versions.map(v => [v.number, v.commit, v.commitMessage, v.createdByName])).toEqual([
            [2, tip(), 'Name the start', 'Ana'],
            [1, first.body.commit, 'Update Orders', 'Ana'],
        ]);
        expect(second.body.deployed.versionId).toBe(second.body.versions[0].id);
        expect((second.body.history as Event[])[0]).toMatchObject({ action: 'deploy', fromNumber: 1, toNumber: 2, commit: tip(), by: ANA });

        const again = await call('POST', `/flows/${orders}/deploy`);
        expect(again.status).toBe(400);
        expect(again.body.error.message).toBe('Nothing to commit: the draft is v2.');
    });

    test('an undeploy is a commit of deployed: false; deploying an older version is a commit of its content', async () => {
        const { call, newFlow, relabel, flowPath, show, tip, lastCommit } = await newWorkspace();
        const orders = await newFlow('Orders');
        const v1 = (await call('POST', `/flows/${orders}/deploy`)).body.versions[0];
        const v1File = show(flowPath('Orders'));
        await relabel(orders, 'Begin');
        await call('POST', `/flows/${orders}/deploy`);

        const undeployed = await call('POST', `/flows/${orders}/undeploy`);
        expect(undeployed.status).toBe(200);
        expect(lastCommit()).toBe('Ana|Flowtinus|Undeploy Orders');
        expect(show(flowPath('Orders'))).toContain('deployed: false');
        expect(undeployed.body.deployed).toBeNull();
        expect((undeployed.body.history as Event[])[0]).toMatchObject({ action: 'undeploy', fromNumber: 2, commit: tip() });

        const reverted = await call('POST', `/flows/${orders}/versions/${v1.id}/deploy`);
        expect(reverted.status).toBe(200);
        expect(lastCommit()).toBe('Ana|Flowtinus|Revert Orders to v1');
        expect(show(flowPath('Orders'))).toBe(v1File);
        expect((reverted.body.versions as Version[])[0]).toMatchObject({ number: 3, commit: tip(), commitMessage: 'Revert Orders to v1' });
        expect(reverted.body.deployed.versionId).toBe(reverted.body.versions[0].id);
    });

    test('a Commit the tree refuses changes nothing and answers the errors per file', async () => {
        const { call, newFlow, flowPath, tip } = await newWorkspace();
        const orders = await newFlow('Orders');
        const { flow, revision } = (await call('GET', `/flows/${orders}/draft`)).body;
        const nodes = [
            ...flow.nodes,
            {
                id: 'ts',
                type: 'typescript',
                label: 'Prices',
                position: { x: 160, y: 0 },
                config: { code: "import { value } from '@myproject/scripts/lib/nowhere';" },
            },
        ];
        await call('PUT', `/flows/${orders}/draft`, { revision, flow: { ...flow, nodes } });
        const before = tip();

        const refused = await call('POST', `/flows/${orders}/deploy`);
        expect(refused.status).toBe(400);
        expect(refused.body.error.message).toBe('The commit on dev would not be valid: nothing was changed.');
        expect(Object.keys(refused.body.error.fields)).toEqual([flowPath('Orders')]);
        expect(tip()).toBe(before);
        expect((await call('GET', `/flows/${orders}/deployments`)).body.versions).toEqual([]);
    });

    test('a new flow has no file until its first Commit: renaming or moving it before is not a commit', async () => {
        const { call, projectId, newFlow, flowPath, onBranch, tip } = await newWorkspace();
        const before = tip();
        const orders = await newFlow('Orders');
        const folder = (await call('POST', `/projects/${projectId}/folders`, { name: 'Imports' })).body.id as string;
        const afterFolder = tip();
        expect(afterFolder).not.toBe(before);

        expect((await call('PATCH', `/flows/${orders}`, { name: 'Sales orders' })).status).toBe(200);
        expect((await call('POST', `/flows/${orders}/move`, { folderId: folder })).status).toBe(200);
        expect(tip()).toBe(afterFolder);
        expect(Object.keys(onBranch()).filter(path => path.endsWith('.flow.yaml'))).toEqual([]);

        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        expect(Object.keys(onBranch()).filter(path => path.includes('/flows/'))).toEqual([`${flowPath('Imports/Sales orders')}`]);
    });

    test('a commit made outside the app shows as its author, tied to an app user when the email matches', async () => {
        const { call, repo, newFlow, flowPath, onBranch } = await newWorkspace();
        const orders = await newFlow('Orders');
        await call('POST', `/flows/${orders}/deploy`);

        const files = onBranch();
        const path = flowPath('Orders');
        const outside = commitFiles(
            repo,
            'dev',
            { ...files, [path]: files[path]!.replace('    type: start\n', '    type: start\n    label: Outside\n') },
            'From a laptop',
        );
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
        let view = (await call('GET', `/flows/${orders}/deployments`)).body;
        expect(view.versions[0]).toMatchObject({
            number: 2,
            commit: outside,
            commitMessage: 'From a laptop',
            createdBy: null,
            createdByName: 'Someone',
        });
        expect(view.history[0]).toMatchObject({ action: 'deploy', toNumber: 2, commit: outside, by: null, byName: 'Someone' });

        const known = crypto.randomUUID();
        await db.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Known Someone', 'SOMEONE@example.com')`, [known]);
        const back = commitFiles(repo, 'dev', files, 'Back from a laptop');
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
        view = (await call('GET', `/flows/${orders}/deployments`)).body;
        expect(view.history[0]).toMatchObject({ action: 'deploy', toNumber: 3, commit: back, by: known, byName: 'Known Someone' });
        await db.query('DELETE FROM users WHERE id = $1', [known]);
    });

    test('with git off, a deploy is a deploy again: no commit, no branch', async () => {
        const { call, newFlow, tip } = await newWorkspace({ git: false });
        const orders = await newFlow('Orders');
        const before = tip();
        const deployed = await call('POST', `/flows/${orders}/deploy`, { message: 'ignored' });
        expect(deployed.status).toBe(200);
        expect(deployed.body.git).toBeUndefined();
        expect(deployed.body.commit).toBeUndefined();
        expect(deployed.body.versions[0]).toMatchObject({ number: 1, commit: null });
        expect(tip()).toBe(before);
    });
});
