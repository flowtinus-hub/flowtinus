import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import { callWebhook } from '#features/webhooks/call-webhook';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

type Created = { webhook: { id: string; path: string; tokenHint: string; last: unknown }; token: string };

describe('webhooks', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let projectId: string;
    const workspaceId = crypto.randomUUID();
    const headers = { 'x-user-id': ANA, 'content-type': 'application/json' };
    const call = async (method: string, path: string, body?: unknown) => {
        const response = await app.request(wsPath(workspaceId, path), {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    /** a call from another system: no X-Workspace-Id, the token */
    const hook = async (method: string, id: string, token: string | null, query = '', body?: string) => {
        const response = await app.request(`/wh/${id}${query}`, {
            method,
            headers: token ? { authorization: `Bearer ${token}` } : {},
            body,
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    /** a deployed flow: its Start with a parameter, taking an input or not */
    const deployedFlow = async (name: string, acceptsInput: boolean) => {
        const id = (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
        const draft = (await call('GET', `/flows/${id}/draft`)).body as {
            revision: number;
            flow: { nodes: { type: string; config: Record<string, unknown> }[] };
        };
        const nodes = draft.flow.nodes.map(n =>
            n.type === 'start' ? { ...n, config: { parameters: [{ name: 'since', type: 'number', default: '1' }], acceptsInput } } : n,
        );
        expect((await call('PUT', `/flows/${id}/draft`, { revision: draft.revision, flow: { ...draft.flow, nodes } })).status).toBe(200);
        expect((await call('POST', `/flows/${id}/deploy`)).status).toBe(200);
        return id;
    };
    const runOf = async (id: string) =>
        (
            await db.query<{
                trigger: string;
                webhook_id: string;
                flow_version_id: string | null;
                input: unknown;
                parameters: unknown;
                status: string;
            }>('SELECT trigger, webhook_id, flow_version_id, input, parameters, status FROM runs WHERE id = $1', [id])
        )[0]!;

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-webhooks', '{default}', 1, 'test')`);
        app = createApp(db, 'DEV');
        projectId = (await call('POST', '/projects', { name: 'Webhooks' })).body.id as string;
    });

    afterAll(async () => {
        await db.close();
    });

    test('only a deployed flow; the token is answered once (only its first characters after)', async () => {
        const plain = (await call('POST', `/projects/${projectId}/flows`, { name: 'Not deployed' })).body.id as string;
        expect((await call('POST', `/flows/${plain}/webhooks`, { name: 'Shop' })).status).toBe(400);

        const flowId = await deployedFlow('Orders', true);
        const created = await call('POST', `/flows/${flowId}/webhooks`, { name: 'Shop' });
        expect(created.status).toBe(201);
        const { webhook, token } = created.body as unknown as Created;
        expect(token).toMatch(/^dfwh_[A-Za-z0-9_-]{43}$/);
        expect(webhook.tokenHint).toBe(token.slice(0, 9));
        expect(webhook.path).toBe(`wh/${webhook.id}`);
        const listed = JSON.stringify((await call('GET', `/flows/${flowId}/webhooks`)).body);
        expect(listed).not.toContain(token);
        const [stored] = await db.query<{ token_hash: string }>('SELECT token_hash FROM flow_webhooks WHERE id = $1', [webhook.id]);
        expect(stored!.token_hash).not.toContain(token);
    });

    test('POST: its token, its JSON body the input, its query string the parameters; a run of the deployed version', async () => {
        const flowId = await deployedFlow('Takes orders', true);
        const { webhook, token } = (await call('POST', `/flows/${flowId}/webhooks`, { name: 'Shop' })).body as unknown as Created;

        expect((await hook('POST', webhook.id, null)).status).toBe(401);
        expect((await hook('POST', webhook.id, 'dfwh_wrong')).status).toBe(401);
        expect((await hook('POST', crypto.randomUUID(), token)).status).toBe(404);
        // its address: /wh/{id}, nothing of the workspace or the project (renaming the project changes nothing)
        await call('PATCH', `/projects/${projectId}`, { name: 'Webhooks Renamed' });
        const listed = ((await call('GET', `/flows/${flowId}/webhooks`)).body.items as { path: string }[])[0]!;
        expect(listed.path).toBe(`wh/${webhook.id}`);
        const byPath = await app.request(`/${listed.path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '[]' });
        expect(byPath.status).toBe(202);
        expect((await hook('POST', webhook.id, token, '', '[]')).status).toBe(202);
        expect((await hook('POST', webhook.id, token, '', '{nope')).status).toBe(400);
        // it takes an input: GET is refused
        expect((await hook('GET', webhook.id, token)).status).toBe(405);

        const answered = await hook('POST', webhook.id, token, '?since=7', JSON.stringify([{ id: 1 }, { id: 2 }]));
        expect(answered).toMatchObject({ status: 202, body: { status: 'queued' } });
        const run = await runOf(answered.body.runId as string);
        expect(run).toMatchObject({
            trigger: 'webhook',
            webhook_id: webhook.id,
            input: [{ id: 1 }, { id: 2 }],
            parameters: { since: '7' },
            status: 'queued',
        });
        expect(run.flow_version_id).not.toBeNull();

        const last = ((await call('GET', `/flows/${flowId}/webhooks`)).body.items as { last: { status: number; runId: string } }[])[0]!
            .last;
        expect(last).toMatchObject({ status: 202, runId: answered.body.runId });
    });

    test('GET for a flow that takes no input; off, a new token, removed', async () => {
        const flowId = await deployedFlow('No input', false);
        const { webhook, token } = (await call('POST', `/flows/${flowId}/webhooks`, { name: 'Ping' })).body as unknown as Created;
        const got = await hook('GET', webhook.id, token, '?since=3');
        expect(got.status).toBe(202);
        expect(await runOf(got.body.runId as string)).toMatchObject({ parameters: { since: '3' }, input: null });
        // an input to a flow that takes none: refused, no run
        expect((await hook('POST', webhook.id, token, '', '[1]')).status).toBe(400);

        const renewed = (await call('POST', `/webhooks/${webhook.id}/token`)).body as unknown as Created;
        expect((await hook('GET', webhook.id, token)).status).toBe(401);
        expect((await hook('GET', webhook.id, renewed.token)).status).toBe(202);

        await call('PUT', `/webhooks/${webhook.id}`, { name: 'Ping', enabled: false });
        expect((await hook('GET', webhook.id, renewed.token)).status).toBe(404);
        await call('PUT', `/webhooks/${webhook.id}`, { name: 'Ping', enabled: true });
        await call('POST', `/flows/${flowId}/undeploy`);
        expect((await hook('GET', webhook.id, renewed.token)).status).toBe(409);
        expect((await call('DELETE', `/webhooks/${webhook.id}`)).status).toBe(200);
        expect((await hook('GET', webhook.id, renewed.token)).status).toBe(404);
    });

    test('wait: what reached the End once the run ends; past the limit, 202 with the run id', async () => {
        const flowId = await deployedFlow('Answers', true);
        const { webhook, token } = (await call('POST', `/flows/${flowId}/webhooks`, { name: 'Ask', response: 'wait' }))
            .body as unknown as Created;

        const asked = callWebhook(
            db,
            { id: webhook.id, method: 'POST', authorization: `Bearer ${token}`, query: {}, body: '[{"q":1}]' },
            5_000,
        );
        // a supervisor runs it: ended with what reached the End
        let runId: string | undefined;
        while (!runId) {
            runId = (await db.query<{ id: string }>('SELECT id FROM runs WHERE webhook_id = $1', [webhook.id]))[0]?.id;
            await Bun.sleep(20);
        }

        const record = { components: [{ type: 'end', inputSample: [{ answer: 42 }] }] };
        await db.query(`UPDATE runs SET status = 'completed', record = $2::text::jsonb WHERE id = $1`, [runId, JSON.stringify(record)]);
        expect(await asked).toEqual({ status: 200, body: { runId, status: 'completed', output: [{ answer: 42 }] } });

        const slow = await callWebhook(
            db,
            { id: webhook.id, method: 'POST', authorization: `Bearer ${token}`, query: {}, body: '[]' },
            300,
        );
        expect(slow).toMatchObject({ status: 202, body: { status: 'queued' } });
    });

    test('wait: an output larger than the End keeps is an error that says so, never part of it as if it were all', async () => {
        const flowId = await deployedFlow('Big answer', true);
        const { webhook, token } = (await call('POST', `/flows/${flowId}/webhooks`, { name: 'Big', response: 'wait' }))
            .body as unknown as Created;

        const asked = callWebhook(
            db,
            { id: webhook.id, method: 'POST', authorization: `Bearer ${token}`, query: {}, body: '[{"q":1}]' },
            5_000,
        );
        let runId: string | undefined;
        while (!runId) {
            runId = (await db.query<{ id: string }>('SELECT id FROM runs WHERE webhook_id = $1', [webhook.id]))[0]?.id;
            await Bun.sleep(20);
        }

        const record = { components: [{ type: 'end', inputSample: [{ part: 1 }], samplesNotKept: { input: 3, output: 0 } }] };
        await db.query(`UPDATE runs SET status = 'completed', record = $2::text::jsonb WHERE id = $1`, [runId, JSON.stringify(record)]);
        expect(await asked).toEqual({
            status: 500,
            body: {
                runId,
                status: 'completed',
                error: 'The run completed, but what reached the End is larger than the 10 MB a webhook answers with (3 envelope(s) left out): read the run, or make the flow answer with less.',
            },
        });
    });
});
