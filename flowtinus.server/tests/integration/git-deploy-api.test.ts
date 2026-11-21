import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, BIA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { API_SCOPES, insertApiToken, newApiToken } from '#features/api-tokens/api-tokens';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe("a flow's deploy is a commit on the environment's branch", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

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
        const flowPath = (...path: string[]) => `${workspaceHandleOf(id)}/projects/Sales/flows/${path.join('/')}.flow.yaml`;
        const firstExport = `First export of ${workspaceHandleOf(id)}`;
        return { id, handle: workspaceHandleOf(id), call, repo, projectId, newFlow, flowPath, firstExport };
    }

    const show = (repo: string, path: string) => git(repo, 'show', `dev:${path}`);
    const onBranch = (repo: string): Record<string, string> =>
        Object.fromEntries(
            git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                .split('\n')
                .map(path => [path, Bun.spawnSync(['git', 'show', `dev:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString()]),
        );
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
            `Ana <${ANA}@example.com>|Update Orders`,
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
            `Ana <${ANA}@example.com>|Update Orders`,
            `Bia <${BIA}@example.com>|Undeploy Orders`,
            `Ana <${ANA}@example.com>|Update Orders`,
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
            'Revert Orders to v1',
            'Update Orders',
            'Update Orders',
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
        expect(commits(repo).map(c => c.split('|')[1])).toEqual(['Update Orders', 'Update Orders', 'Update Orders', firstExport, 'start']);
    });

    test('a push refused fails the deploy, saying why, and nothing changes', async () => {
        const { call, repo, newFlow } = await newWorkspace();
        const orders = await newFlow('Orders');
        const hook = join(repo, 'hooks', 'pre-receive');
        await Bun.write(hook, '#!/bin/sh\necho "the branch dev is protected" >&2\nexit 1\n');
        await chmod(hook, 0o755);

        const refused = await call('POST', `/flows/${orders}/deploy`);
        expect(refused.status).toBe(502);
        expect(refused.body.error.message).toContain('the branch dev is protected');
        expect((await call('GET', `/flows/${orders}/deployments`)).body).toMatchObject({ versions: [], deployed: null });
        expect(commits(repo)).toHaveLength(2);

        await rm(hook);
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        expect(commits(repo)[0]).toEndWith('|Update Orders');
    });

    test('when the branch moved before the push, the commit is rebuilt on the new tip once, and both apply', async () => {
        const { call, repo, projectId, newFlow, flowPath, handle } = await newWorkspace();
        const orders = await newFlow('Orders');
        const projectFile = `${handle}/projects/Sales/project.yaml`;
        const moved = commitFiles(repo, 'outside', {
            ...onBranch(repo),
            [projectFile]: onBranch(repo)
                [projectFile]!.replace(/description: .*\n/, '')
                .replace(/^/, 'description: Set in git\n'),
        });
        const hook = join(repo, 'hooks', 'pre-receive');
        await Bun.write(
            hook,
            `#!/bin/sh\nif [ ! -f moved ]; then touch moved; unset GIT_QUARANTINE_PATH; git update-ref refs/heads/dev ${moved}; fi\nexit 0\n`,
        );
        await chmod(hook, 0o755);

        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        expect(commits(repo).map(c => c.split('|')[1])[0]).toBe('Update Orders');
        expect(git(repo, 'rev-parse', 'dev~1')).toBe(moved);
        expect(show(repo, flowPath('Orders'))).toContain(`id: ${orders}`);
        expect((await call('GET', '/projects')).body.items).toEqual([
            expect.objectContaining({ id: projectId, description: 'Set in git' }),
        ]);
    });

    test('a commit made in git since the last reconcile is applied before the change: its edit of the same file stays', async () => {
        const { call, repo, newFlow, flowPath } = await newWorkspace();
        const orders = await newFlow('Orders');
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        const files = onBranch(repo);
        const path = flowPath('Orders');
        commitFiles(
            repo,
            'dev',
            { ...files, [path]: files[path]!.replace(`id: ${orders}\n`, `id: ${orders}\ndeployed: false\n`) },
            'Undeploy in git',
        );

        expect((await call('PATCH', `/flows/${orders}`, { name: 'Sales orders' })).status).toBe(200);
        expect((await commitAll(call, 'Rename flow Orders to Sales orders')).status).toBe(200);
        expect(show(repo, flowPath('Sales orders'))).toContain('deployed: false');
        expect(
            commits(repo)
                .slice(0, 2)
                .map(c => c.split('|')[1]),
        ).toEqual(['Rename flow Orders to Sales orders', 'Undeploy in git']);
        expect((await call('GET', `/flows/${orders}/deployments`)).body.deployed).toBeNull();
    });

    test('when the branch moved with a change to the same file, the Commit is refused and nothing changes', async () => {
        const { call, repo, newFlow, flowPath } = await newWorkspace();
        const orders = await newFlow('Orders');
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        const files = onBranch(repo);
        const path = flowPath('Orders');
        const moved = commitFiles(repo, 'outside', {
            ...files,
            [path]: files[path]!.replace(`id: ${orders}\n`, `id: ${orders}\ndeployed: false\n`),
        });
        const hook = join(repo, 'hooks', 'pre-receive');
        await Bun.write(
            hook,
            `#!/bin/sh\nif [ ! -f moved ]; then touch moved; unset GIT_QUARANTINE_PATH; git update-ref refs/heads/dev ${moved}; fi\nexit 0\n`,
        );
        await chmod(hook, 0o755);

        expect((await call('PATCH', `/flows/${orders}`, { name: 'Sales orders' })).status).toBe(200);
        const refused = await commitAll(call, 'Rename flow Orders to Sales orders');
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe(`${path} changed in git meanwhile: nothing was changed, try again.`);
        expect(git(repo, 'rev-parse', 'dev')).toBe(moved);
        expect((await call('GET', '/git/changes')).body.changes.map((c: { from?: string }) => c.from)).toEqual([path]);
    });

    test('when git cannot be reached a Commit fails, saying why, and nothing changes; drafts and tree changes still save', async () => {
        const { id, call, repo, projectId, newFlow } = await newWorkspace();
        const orders = await newFlow('Orders');
        await rename(repo, `${repo}.away`);

        expect((await call('POST', `/projects/${projectId}/folders`, { name: 'Imports' })).status).toBe(201);
        const unreachable = await commitAll(call, 'Create folder Imports');
        expect(unreachable.status).toBe(502);
        expect(unreachable.body.error.message).toStartWith('Git could not be reached, nothing was changed:');
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(502);
        expect((await call('GET', `/flows/${orders}/deployments`)).body.deployed).toBeNull();
        const { flow, revision } = (await call('GET', `/flows/${orders}/draft`)).body;
        expect((await call('PUT', `/flows/${orders}/draft`, { revision, flow })).status).toBe(200);
        await rename(`${repo}.away`, repo);

        const clone = join(dir, 'clones', id);
        await rm(clone, { recursive: true, force: true });
        await Bun.write(join(clone, 'HEAD'), 'not a repository\n');
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(502);
        await rm(clone, { recursive: true, force: true });

        const otherKeys = createApp(db, 'DEV', new Keyring([{ version: 'u', key: new Uint8Array(32).fill(9) }]), undefined, {
            git: { clonesDir: join(dir, 'clones') },
        });
        const deployed = await otherKeys.request(wsPath(id, `/flows/${orders}/deploy`), { method: 'POST', headers: { 'x-user-id': ANA } });
        expect(deployed.status).toBe(502);
        expect(((await deployed.json()) as any).error.message).toContain('cannot be decrypted');

        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
    });

    test('a branch deleted once git is on is not created again: changes to the tree fail until it is, or git is turned off', async () => {
        const { call, repo, newFlow } = await newWorkspace();
        git(repo, 'update-ref', '-d', 'refs/heads/dev');
        const orders = await newFlow('Orders');

        const refused = await call('POST', `/flows/${orders}/deploy`);
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe('The branch dev does not exist.');
        expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/flowtinus/config');

        const config = (await call('GET', '/git')).body.config;
        await call('DELETE', '/git');
        expect((await call('PUT', '/git', config)).body.on).toBe(false);
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
    });

    test('the app never pushes an invalid tree: a Commit on top of a refused commit fails with its errors', async () => {
        const { call, repo, projectId, handle } = await newWorkspace();
        const bad = `${handle}/connections/Bad.yaml`;
        commitFiles(repo, 'dev', { ...onBranch(repo), [bad]: `id: ${crypto.randomUUID()}\ntype: oracle\n` });
        const tip = git(repo, 'rev-parse', 'dev');

        expect((await call('POST', `/projects/${projectId}/folders`, { name: 'Imports' })).status).toBe(201);
        const refused = await commitAll(call, 'Create folder Imports');
        expect(refused.status).toBe(400);
        expect(refused.body.error.fields).toEqual({ [bad]: 'Unknown connection type "oracle".' });
        expect(git(repo, 'rev-parse', 'dev')).toBe(tip);
    });

    test('a commit made by the app has the user as author and Flowtinus as committer', async () => {
        const { call, repo, newFlow } = await newWorkspace();
        const orders = await newFlow('Orders');
        expect((await call('POST', `/flows/${orders}/deploy`, undefined, BIA)).status).toBe(200);
        expect(git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'dev')).toBe(
            `Bia <${BIA}@example.com>|Flowtinus <flowtinus@localhost>`,
        );
    });

    test('an MCP tool that changes the tree takes the same path: into the working copy, git or not, until a Commit', async () => {
        const { handle, call, repo, projectId, firstExport } = await newWorkspace();
        const { token } = newApiToken();
        await insertApiToken(db, { userId: ANA, name: 'test', token, scopes: API_SCOPES });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        const createFolder = async (name: string) =>
            (await client.callTool({ name: 'create_folder', arguments: { workspace: handle, projectId, name } })) as {
                isError?: boolean;
                content: { text: string }[];
            };

        expect((await createFolder('Imports')).isError).toBeFalsy();
        expect(commits(repo)[0]).toBe(`Ana <${ANA}@example.com>|${firstExport}`);

        await rename(repo, `${repo}.away`);
        const away = await createFolder('Exports');
        await rename(`${repo}.away`, repo);
        expect(away.isError).toBeFalsy();
        expect(git(repo, 'ls-tree', '-r', '--name-only', 'dev')).not.toContain('Exports');
        expect((await commitAll(call, 'Create folders')).status).toBe(200);
        expect(git(repo, 'ls-tree', '-r', '--name-only', 'dev')).toContain(`${handle}/projects/Sales/flows/Exports/.gitkeep`);
        await client.close();
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
    });
});
