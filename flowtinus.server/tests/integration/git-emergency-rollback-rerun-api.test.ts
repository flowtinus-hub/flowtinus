import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Version = { id: string; number: number };

describe('"Run again" during and after an emergency rollback: a click does not rerun the bad version', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    // Orders and Lookup, each deployed twice with git on: v2 is git's and runs
    async function workspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const call = async (method: string, path: string) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const send = async (method: string, path: string, body: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const projectId = (await send('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await send('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await send('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await send('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await send('POST', '/git/on', { createBranch: true })).status).toBe(200);

        const deploy = async (flowId: string, label: string): Promise<Version> => {
            const { flow, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
            const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            expect((await send('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
            const deployed = await call('POST', `/flows/${flowId}/deploy`);
            expect(deployed.status).toBe(200);
            return deployed.body.versions[0];
        };
        const deployTwice = async (name: string): Promise<{ flowId: string; v1: Version; v2: Version }> => {
            const flowId = (await send('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
            return { flowId, v1: await deploy(flowId, 'One'), v2: await deploy(flowId, 'Two') };
        };
        const orders = await deployTwice('Orders');
        const lookup = await deployTwice('Lookup');

        // a failed run of Orders as it ran: at a version (null: the draft) calling flows at theirs
        const failed = async (version: Version | null, called: { flowId: string; name: string; version: Version | null }[] = []) => {
            const runId = crypto.randomUUID();
            await db.query(
                `INSERT INTO runs (id, workspace_id, flow_id, project_id, mode, flow_version_id, draft_hash, status, trigger, parameters, input,
           definition, scripts, called_flows, flow_name, error)
         VALUES ($1, $2, $3, $4, 'execution', $5, $6, 'failed', 'manual', '{}', 'null', '{"name":"Orders"}', '{}', $7::text::jsonb, 'Orders', 'boom')`,
                [
                    runId,
                    id,
                    orders.flowId,
                    projectId,
                    version?.id ?? null,
                    version ? null : 'h',
                    JSON.stringify(called.map(c => ({ id: c.flowId, name: c.name, ...(c.version ? { versionId: c.version.id } : {}) }))),
                ],
            );
            return runId;
        };
        const rollBack = async (flowId: string, version: Version) =>
            expect((await call('POST', `/flows/${flowId}/versions/${version.id}/emergency-rollback`)).status).toBe(200);
        const end = async (flowId: string) => expect((await call('DELETE', `/flows/${flowId}/emergency-rollback`)).status).toBe(200);
        return { call, orders, lookup, failed, rollBack, end, deploy };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-emergency-rollback-rerun-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-rollback-rerun', '{default}', 1, 'test')`);
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('refused during a rollback: a run of another version than the one that runs; the rolled-back one runs again', async () => {
        const { call, orders, failed, rollBack } = await workspace();
        const bad = await failed(orders.v2);
        const good = await failed(orders.v1);
        await rollBack(orders.flowId, orders.v1);

        const refused = await call('POST', `/runs/${bad}/rerun`);
        expect([refused.status, refused.body.error.message]).toEqual([
            409,
            'Orders runs v1 in an emergency rollback: this run is of v2, it would run that version again.',
        ]);
        expect((await call('POST', `/runs/${good}/rerun`)).status).toBe(202);
    });

    test('refused during a rollback of a flow it called, at another version than the one that runs', async () => {
        const { call, orders, lookup, failed, rollBack } = await workspace();
        const bad = await failed(orders.v2, [{ flowId: lookup.flowId, name: 'Lookup', version: lookup.v2 }]);
        const good = await failed(orders.v2, [{ flowId: lookup.flowId, name: 'Lookup', version: lookup.v1 }]);
        await rollBack(lookup.flowId, lookup.v1);

        const refused = await call('POST', `/runs/${bad}/rerun`);
        expect([refused.status, refused.body.error.message]).toEqual([
            409,
            'Lookup runs v1 in an emergency rollback: this run called v2, it would run that version again.',
        ]);
        expect((await call('POST', `/runs/${good}/rerun`)).status).toBe(202);
    });

    test('a draft run is exempt: it has no version', async () => {
        const { call, orders, lookup, failed, rollBack } = await workspace();
        const draft = await failed(null, [{ flowId: lookup.flowId, name: 'Lookup', version: null }]);
        await rollBack(orders.flowId, orders.v1);
        await rollBack(lookup.flowId, lookup.v1);

        expect((await call('POST', `/runs/${draft}/rerun`)).status).toBe(202);
    });

    test('after the rollback ends, the check before "Run again" names the versions a rollback left, except the one deployed now', async () => {
        const { call, orders, lookup, failed, rollBack, end, deploy } = await workspace();
        const both = await failed(orders.v2, [{ flowId: lookup.flowId, name: 'Lookup', version: lookup.v2 }]);
        const rolledBack = await failed(orders.v1);
        expect((await call('GET', `/runs/${both}/rerun`)).body).toEqual({ leftByEmergencyRollback: [] });

        await rollBack(orders.flowId, orders.v1);
        await rollBack(lookup.flowId, lookup.v1);
        await end(orders.flowId);
        await end(lookup.flowId);
        // ended by hand, git's v2 runs again: nothing to ask
        expect((await call('GET', `/runs/${both}/rerun`)).body).toEqual({ leftByEmergencyRollback: [] });

        await deploy(orders.flowId, 'Three');
        await deploy(lookup.flowId, 'Three');
        expect((await call('GET', `/runs/${both}/rerun`)).body).toEqual({
            leftByEmergencyRollback: [
                { flowId: orders.flowId, name: 'Orders', version: 2 },
                { flowId: lookup.flowId, name: 'Lookup', version: 2 },
            ],
        });
        // v1 is the version a rollback went to, not one it left
        expect((await call('GET', `/runs/${rolledBack}/rerun`)).body).toEqual({ leftByEmergencyRollback: [] });
        // only asked: the run goes when confirmed
        expect((await call('POST', `/runs/${both}/rerun`)).status).toBe(202);
    });
});
