import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newFlowFile, repoFlowToYaml } from '@flowtinus/core';
import { ANA, BIA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Branch = {
    name: string;
    kind: string;
    owner?: string;
    ownerName?: string;
    mine: boolean;
    editable: boolean;
    merged: boolean;
    changes: number;
};

describe('every head of the remote, read as a branch', () => {
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
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);

        const handle = workspaceHandleOf(id);
        const userHandle = async (user: string) => (await as(user)('GET', '/me')).body.handle as string;
        const push = (branch: string, changes: Record<string, string | null> = {}) => {
            git(repo, 'update-ref', `refs/heads/${branch}`, git(repo, 'rev-parse', 'dev'));
            const files: Record<string, string> = {};
            for (const path of git(repo, 'ls-tree', '-r', '--name-only', 'dev').split('\n').filter(Boolean)) {
                files[path] = git(repo, 'show', `dev:${path}`) + '\n';
            }
            for (const [path, text] of Object.entries(changes)) {
                if (text === null) {
                    delete files[`${handle}/${path}`];
                } else {
                    files[`${handle}/${path}`] = text;
                }
            }
            if (Object.keys(changes).length > 0) {
                commitFiles(repo, branch, files, `on ${branch}`);
            }
        };
        const poll = async () => {
            await app.gitPoller.poll(id);
        };
        return { id, as, call, projectId, orders, repo, handle, userHandle, push, poll };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-branches-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("a poll fetches every head: the picker lists them by kind, the app's own left out, a branch dev contains marked merged", async () => {
        const { call, as, userHandle, push, poll } = await workspace();
        const ana = await userHandle(ANA);
        const bia = await userHandle(BIA);
        const only = repoFlowToYaml(newFlowFile('Only here', crypto.randomUUID()));
        push(`users/${ana}/try`, { 'projects/Sales/flows/Only here.flow.yaml': only });
        push(`users/${bia}/done`);
        push('fix/shared', { 'projects/Sales/flows/Shared.flow.yaml': repoFlowToYaml(newFlowFile('Shared', crypto.randomUUID())) });
        push('promote/dev-to-prod', { 'projects/Sales/flows/Promoted.flow.yaml': only });
        await poll();

        const answer = await call('GET', '/git/branches');
        expect(answer.status).toBe(200);
        expect(answer.body.current).toBe('dev');
        expect(answer.body.environment).toBe('dev');
        const branches = answer.body.branches as Branch[];
        expect(
            branches.map(({ name, kind, owner, ownerName, mine, editable, merged, changes }) => ({
                name,
                kind,
                owner,
                ownerName,
                mine,
                editable,
                merged,
                changes,
            })),
        ).toEqual([
            {
                name: 'dev',
                kind: 'environment',
                owner: undefined,
                ownerName: undefined,
                mine: false,
                editable: true,
                merged: false,
                changes: 0,
            },
            {
                name: `users/${ana}/try`,
                kind: 'user',
                owner: ana,
                ownerName: 'Ana',
                mine: true,
                editable: true,
                merged: false,
                changes: 0,
            },
            {
                name: `users/${bia}/done`,
                kind: 'user',
                owner: bia,
                ownerName: 'Bia',
                mine: false,
                editable: false,
                merged: true,
                changes: 0,
            },
            {
                name: 'fix/shared',
                kind: 'shared',
                owner: undefined,
                ownerName: undefined,
                mine: false,
                editable: true,
                merged: false,
                changes: 0,
            },
        ]);
        const forBia = ((await as(BIA)('GET', '/git/branches')).body.branches as Branch[]).map(b => b.name);
        expect(forBia).toEqual(['dev', `users/${bia}/done`, `users/${ana}/try`, 'fix/shared']);
    });

    test("on another user's branch the project, flow and script endpoints answer from its tip, a flow only there included; it is read only", async () => {
        const { call, as, projectId, orders, userHandle, push, poll } = await workspace();
        const ana = await userHandle(BIA);
        const onlyId = crypto.randomUUID();
        const begin = newFlowFile('Orders', orders);
        begin.nodes = begin.nodes.map(n => (n.id === 'start' ? { ...n, label: 'Begin' } : n));
        const branch = `users/${ana}/try`;
        push(branch, {
            'projects/Sales/flows/Later/Only here.flow.yaml': repoFlowToYaml(newFlowFile('Only here', onlyId)),
            'projects/Sales/flows/Orders.flow.yaml': repoFlowToYaml(begin),
            'projects/Sales/scripts/util.ts': 'export const two = 2;\n',
        });
        await poll();

        expect((await call('PUT', '/git/current-branch', { branch })).status).toBe(200);
        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch, editable: false });

        const projects = (await call('GET', '/projects')).body.items;
        expect(projects.map((p: { id: string; name: string; summary: unknown }) => [p.id, p.name, p.summary])).toEqual([
            [projectId, 'Sales', { flows: 2, deployed: 1, scripts: 1 }],
        ]);
        expect((await call('GET', `/projects/${projectId}`)).body).toMatchObject({ id: projectId, name: 'Sales', readOnly: true });

        const contents = (await call('GET', `/projects/${projectId}/contents`)).body;
        expect(contents.folders.map((f: { name: string; parentId: string | null }) => [f.name, f.parentId])).toEqual([['Later', null]]);
        const later = contents.folders[0].id;
        expect(
            contents.flows.map((f: { id: string; name: string; folderId: string | null; readOnly: boolean }) => [
                f.id,
                f.name,
                f.folderId,
                f.readOnly,
            ]),
        ).toEqual([
            [onlyId, 'Only here', later, true],
            [orders, 'Orders', null, true],
        ]);

        expect((await call('GET', `/flows/${onlyId}`)).body).toMatchObject({ id: onlyId, name: 'Only here', projectId, folderId: later });
        expect((await call('GET', `/flows/${onlyId}/draft`)).body).toMatchObject({ flow: { id: onlyId, name: 'Only here' }, revision: 0 });
        const draft = (await call('GET', `/flows/${orders}/draft`)).body;
        expect(draft.flow.nodes.find((n: { id: string }) => n.id === 'start').label).toBe('Begin');
        expect((await call('GET', `/flows/${onlyId}/pins`)).body).toEqual({ pins: {} });

        expect((await call('GET', `/projects/${projectId}/scripts`)).body.scripts.map((s: { path: string }) => s.path)).toEqual(['util']);
        expect((await call('GET', `/projects/${projectId}/scripts/content?path=util`)).body).toMatchObject({
            content: 'export const two = 2;\n',
        });

        const saved = await call('PUT', `/flows/${orders}/draft`, { revision: draft.revision, flow: draft.flow });
        expect(saved.status).toBe(409);
        expect(saved.body.error.message).toContain(branch);
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'New' })).status).toBe(409);
        expect((await call('PUT', `/projects/${projectId}/scripts/content`, { path: 'util', content: 'x', revision: 0 })).status).toBe(409);

        const bia = as(BIA);
        expect((await bia('GET', `/projects/${projectId}/contents`)).body.flows.map((f: { name: string }) => f.name)).toEqual(['Orders']);
        expect((await bia('GET', `/flows/${onlyId}`)).status).toBe(404);
        const dev = (await bia('GET', `/flows/${orders}/draft`)).body;
        expect(dev.flow.nodes.find((n: { id: string }) => n.id === 'start').label).not.toBe('Begin');

        expect((await call('PUT', '/git/current-branch', { branch: 'dev' })).status).toBe(200);
        expect((await call('GET', `/flows/${onlyId}`)).status).toBe(404);
        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch: 'dev', editable: true });
    });

    test('a test run on a work branch takes its flow, the flows it calls and the scripts from that branch', async () => {
        const { call, userHandle, push, poll } = await workspace();
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ($1, '{default}', 1, 'test')`, [crypto.randomUUID()]);
        const calleeId = crypto.randomUUID();
        const callerId = crypto.randomUUID();
        const caller = newFlowFile('Caller', callerId);
        const start = caller.nodes.find(n => n.type === 'start')!.id;
        const end = caller.nodes.find(n => n.type === 'end')!.id;
        caller.nodes.push(
            {
                id: 'ts',
                type: 'typescript',
                position: { x: 160, y: 0 },
                config: { code: "import { value } from '@myproject/scripts/util';" },
            },
            { id: 'call', type: 'flow', position: { x: 160, y: 80 }, config: { flowId: calleeId } },
        );
        caller.edges.push(
            ...['ts', 'call'].flatMap(id => [
                { source: start, sourcePort: 'out-0', target: id, targetPort: 'in-0' },
                { source: id, sourcePort: 'out-0', target: end, targetPort: 'in-0' },
            ]),
        );
        const branch = `users/${await userHandle(ANA)}/run`;
        push(branch, {
            'projects/Sales/flows/Caller.flow.yaml': repoFlowToYaml(caller),
            'projects/Sales/flows/Callee.flow.yaml': repoFlowToYaml(newFlowFile('Callee', calleeId)),
            'projects/Sales/scripts/util.ts': 'export const value = 2;\n',
        });
        await poll();
        expect((await call('PUT', '/git/current-branch', { branch })).status).toBe(200);

        const started = await call('POST', `/flows/${callerId}/runs`, { mode: 'validation' });
        expect(started.status).toBe(202);
        const [run] = await db.query<{
            flow_id: string;
            definition: { name: string };
            called_flows: { id: string; name: string; flow?: unknown }[];
            scripts: Record<string, string>;
        }>('SELECT flow_id, definition, called_flows, scripts FROM test_runs WHERE id = $1', [started.body.id]);
        expect(run!.flow_id).toBe(callerId);
        expect(run!.definition.name).toBe('Caller');
        expect(run!.called_flows.map(c => [c.id, c.name, Boolean(c.flow)])).toEqual([[calleeId, 'Callee', true]]);
        const [blob] = await db.query<{ content: string }>('SELECT content FROM script_blobs WHERE workspace_id = $1 AND hash = $2', [
            (await db.query<{ id: string }>('SELECT workspace_id AS id FROM test_runs WHERE id = $1', [started.body.id]))[0]!.id,
            run!.scripts.util,
        ]);
        expect(blob!.content).toBe('export const value = 2;\n');
        expect((await call('GET', `/flows/${callerId}/last-run`)).status).toBe(200);

        const calls = (await call('GET', `/projects/${(await call('GET', `/flows/${callerId}`)).body.projectId}/calls`)).body;
        expect(calls.flows.map((f: { name: string }) => f.name)).toEqual(['Callee', 'Caller', 'Orders']);
        expect(calls.scripts).toEqual(['util']);
        expect(calls.calls.map((c: { from: string; to: string }) => [c.from, c.to])).toEqual([[callerId, calleeId]]);
    });
});
