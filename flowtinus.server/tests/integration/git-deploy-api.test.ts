import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, BIA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe("a flow's deploy is a commit on the environment's branch", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    /** a workspace with a project, git on for a new repository whose topology has DEV on the branch dev */
    async function newWorkspace(options: { branch?: boolean; git?: boolean } = {}) {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const call = async (method: string, path: string, body?: unknown, user = ANA) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        if (options.git !== false) {
            await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
            await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
            expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        }
        if (options.branch !== false) {
            createBranch(repo, 'dev');
        }
        if (options.git !== false) {
            expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        }

        const newFlow = async (name: string, folderId?: string) =>
            (await call('POST', `/projects/${projectId}/flows`, { name, ...(folderId ? { folderId } : {}) })).body.id as string;
        const flowPath = (...path: string[]) => `${slugOf(id)}/projects/Sales/flows/${path.join('/')}.flow.yaml`;
        const firstExport = `First export of ${slugOf(id)}`;
        return { id, call, repo, projectId, newFlow, flowPath, firstExport };
    }

    const show = (repo: string, path: string) => git(repo, 'show', `dev:${path}`);
    const commits = (repo: string) => git(repo, 'log', '--format=%an <%ae>|%s', 'dev').split('\n');

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-deploy-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("a deploy writes the flow's file at the path its names give, by the user who deployed", async () => {
        const { call, repo, projectId, newFlow, flowPath, firstExport } = await newWorkspace();
        const folder = (await call('POST', `/projects/${projectId}/folders`, { name: 'Imports' })).body.id as string;
        const flowId = await newFlow('Orders', folder);

        expect((await call('POST', `/flows/${flowId}/deploy`)).status).toBe(200);

        const file = show(repo, flowPath('Imports', 'Orders'));
        expect(file).toStartWith(`version: 1\nid: ${flowId}\nnodes:\n`);
        expect(file).not.toContain('name:');
        expect(file).not.toContain('deployed:');
        expect(commits(repo)).toEqual([
            `Ana <${ANA}@example.com>|Deploy Orders v1`,
            `Ana <${ANA}@example.com>|Create folder Imports`,
            `Ana <${ANA}@example.com>|${firstExport}`,
            'Someone <someone@example.com>|start',
        ]);
    });

    test('an undeploy writes the file with deployed: false; deploying it again makes no new version', async () => {
        const { call, repo, newFlow, flowPath, firstExport } = await newWorkspace();
        const flowId = await newFlow('Orders');
        await call('POST', `/flows/${flowId}/deploy`);
        const deployedFile = show(repo, flowPath('Orders'));

        expect((await call('POST', `/flows/${flowId}/undeploy`, undefined, BIA)).status).toBe(200);
        expect(show(repo, flowPath('Orders'))).toBe(deployedFile.replace(`id: ${flowId}\n`, `id: ${flowId}\ndeployed: false\n`));

        const again = await call('POST', `/flows/${flowId}/deploy`);
        expect(again.status).toBe(200);
        expect(again.body.versions.map((v: { number: number }) => v.number)).toEqual([1]);
        expect(again.body.history.map((h: { action: string; toNumber: number | null }) => [h.action, h.toNumber])).toEqual([
            ['deploy', 1],
            ['undeploy', null],
            ['deploy', 1],
        ]);
        expect(show(repo, flowPath('Orders'))).toBe(deployedFile);
        expect(commits(repo)).toEqual([
            `Ana <${ANA}@example.com>|Deploy Orders v1`,
            `Bia <${BIA}@example.com>|Undeploy Orders`,
            `Ana <${ANA}@example.com>|Deploy Orders v1`,
            `Ana <${ANA}@example.com>|${firstExport}`,
            'Someone <someone@example.com>|start',
        ]);
    });

    test('a deploy that changes nothing makes no commit; a rollback writes the version it deploys', async () => {
        const { call, repo, newFlow, flowPath, firstExport } = await newWorkspace();
        const flowId = await newFlow('Orders');
        const v1 = (await call('POST', `/flows/${flowId}/deploy`)).body.versions[0];
        expect((await call('POST', `/flows/${flowId}/deploy`)).status).toBe(400);
        expect(commits(repo)).toHaveLength(3);

        const { flow, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
        const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: 'Begin' } : n));
        await call('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes } });
        await call('POST', `/flows/${flowId}/deploy`);
        expect(show(repo, flowPath('Orders'))).toContain('label: Begin');

        expect((await call('POST', `/flows/${flowId}/versions/${v1.id}/deploy`)).status).toBe(200);
        expect(show(repo, flowPath('Orders'))).not.toContain('label: Begin');
        expect(commits(repo).map(c => c.split('|')[1])).toEqual([
            'Roll back Orders to v1',
            'Deploy Orders v2',
            'Deploy Orders v1',
            firstExport,
            'start',
        ]);
    });

    test('a rollback to a version whose file is the same as the deployed one makes no commit', async () => {
        const { call, repo, newFlow, firstExport } = await newWorkspace();
        const flowId = await newFlow('Orders');
        const relabel = async (label: string) => {
            const { flow, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
            const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            await call('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes } });
            return (await call('POST', `/flows/${flowId}/deploy`)).body.versions[0];
        };
        const v1 = await relabel('Begin');
        await relabel('Go');
        await relabel('Begin');

        expect((await call('POST', `/flows/${flowId}/versions/${v1.id}/deploy`)).status).toBe(200);
        expect(commits(repo).map(c => c.split('|')[1])).toEqual([
            'Deploy Orders v3',
            'Deploy Orders v2',
            'Deploy Orders v1',
            firstExport,
            'start',
        ]);
        expect((await call('GET', '/git/status')).body.status.pending).toBe(0);
    });

    test('a push refused leaves the deploy standing and git behind, with why; the next commit pushes what is pending', async () => {
        const { call, repo, newFlow, flowPath, firstExport } = await newWorkspace();
        const orders = await newFlow('Orders');
        const invoices = await newFlow('Invoices');
        expect((await call('GET', '/git/status')).body).toEqual({ status: { pending: 0, reason: null, since: null } });

        const hook = join(repo, 'hooks', 'pre-receive');
        await Bun.write(hook, '#!/bin/sh\necho "the branch dev is protected" >&2\nexit 1\n');
        await chmod(hook, 0o755);

        const deployed = await call('POST', `/flows/${orders}/deploy`);
        expect(deployed.status).toBe(200);
        expect(deployed.body.deployed).not.toBeNull();
        const behind = (await call('GET', '/git/status')).body.status;
        expect(behind).toMatchObject({ pending: 1, since: expect.any(String) });
        expect(behind.reason).toContain('the branch dev is protected');
        expect(commits(repo)).toHaveLength(2);

        await rm(hook);
        expect((await call('POST', `/flows/${invoices}/deploy`)).status).toBe(200);
        expect((await call('GET', '/git/status')).body.status).toEqual({ pending: 0, reason: null, since: null });
        expect(commits(repo).map(c => c.split('|')[1])).toEqual(['Deploy Invoices v1', 'Deploy Orders v1', firstExport, 'start']);
        expect(show(repo, flowPath('Orders'))).toContain(`id: ${orders}`);
    });

    test('a branch deleted once git is on is not created again: git stays behind until it is, or git is turned off', async () => {
        const { call, repo, newFlow } = await newWorkspace();
        git(repo, 'update-ref', '-d', 'refs/heads/dev');
        const orders = await newFlow('Orders');

        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        expect((await call('GET', '/git/status')).body.status).toMatchObject({ pending: 1, reason: 'The branch dev does not exist yet.' });
        expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/flowtinus/config');

        const config = (await call('GET', '/git')).body.config;
        await call('DELETE', '/git');
        expect((await call('PUT', '/git', config)).body.on).toBe(false);
        expect((await call('GET', '/git/status')).body.status).toBeNull();
    });

    test('drafts never reach git, and a workspace without git configured gets no commits', async () => {
        const { call, repo, newFlow, firstExport } = await newWorkspace();
        const orders = await newFlow('Orders');
        const { flow, revision } = (await call('GET', `/flows/${orders}/draft`)).body;
        expect((await call('PUT', `/flows/${orders}/draft`, { revision, flow })).status).toBe(200);
        expect(commits(repo)).toEqual([`Ana <${ANA}@example.com>|${firstExport}`, 'Someone <someone@example.com>|start']);

        const off = await newWorkspace({ git: false });
        const flowId = await off.newFlow('Orders');
        expect((await off.call('POST', `/flows/${flowId}/deploy`)).status).toBe(200);
        expect(commits(off.repo)).toEqual(['Someone <someone@example.com>|start']);
        expect((await off.call('GET', '/git/status')).body).toEqual({ status: null });
    });
});
