import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import { loadDraft } from '#features/flows/flow-draft';
import { loadTree } from '#features/folders/project-tree';
import { calledFlows } from '#features/runs/start-run/called-flows';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

type Deployments = {
    versions: { id: string; number: number; definition: { name: string; nodes: { id: string; position: { x: number } }[] } }[];
    deployed: { versionId: string } | null;
    history: { action: string; fromNumber: number | null; toNumber: number | null; by: string }[];
};

describe('deploys in its own environment', () => {
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
    const newFlow = async (name: string) => (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
    /** the draft with its Start moved to x, and named after it unless `onlyMoved` (moving alone is not a change) */
    const moveStart = async (id: string, x: number, onlyMoved = false) => {
        const { flow, revision } = (await call('GET', `/flows/${id}/draft`)).body as {
            revision: number;
            flow: { nodes: { id: string; type: string; position: { x: number; y: number } }[] };
        };
        const nodes = flow.nodes.map(n =>
            n.type === 'start' ? { ...n, position: { x, y: 0 }, ...(onlyMoved ? {} : { label: `Start ${x}` }) } : n,
        );
        expect((await call('PUT', `/flows/${id}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
    };
    const deployments = async (id: string) => (await call('GET', `/flows/${id}/deployments`)).body as unknown as Deployments;

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
        app = createApp(db, 'DEV');
        projectId = (await call('POST', '/projects', { name: 'Deploys' })).body.id as string;
    });

    afterAll(async () => {
        await db.close();
    });

    test('deploy, nothing to deploy, a change is v2, roll back, deploy the newer again, undeploy', async () => {
        const id = await newFlow('Orders');
        expect(await deployments(id)).toEqual({ versions: [], deployed: null, history: [], warnings: [] } as never);

        const first = await call('POST', `/flows/${id}/deploy`);
        expect(first.status).toBe(200);
        const v1 = (first.body as unknown as Deployments).versions[0]!;
        expect(v1).toMatchObject({ number: 1, definition: { name: 'Orders' } });
        expect((first.body as unknown as Deployments).deployed).toMatchObject({ versionId: v1.id });

        const same = await call('POST', `/flows/${id}/deploy`);
        expect(same.status).toBe(400);
        expect((same.body.error as { message: string }).message).toBe('Nothing to deploy: the draft is v1.');

        // a rename is the row's: still nothing to deploy
        await call('PATCH', `/flows/${id}`, { name: 'Orders renamed' });
        expect((await call('POST', `/flows/${id}/deploy`)).status).toBe(400);

        // only on the canvas (where the components are): still nothing to deploy
        await moveStart(id, 20, true);
        expect((await call('POST', `/flows/${id}/deploy`)).status).toBe(400);

        await moveStart(id, 40);
        const second = (await call('POST', `/flows/${id}/deploy`)).body as unknown as Deployments;
        expect(second.versions.map(v => v.number)).toEqual([2, 1]);
        const v2 = second.versions[0]!;

        const back = await call('POST', `/flows/${id}/versions/${v1.id}/deploy`);
        expect((back.body as unknown as Deployments).deployed).toMatchObject({ versionId: v1.id });
        expect((await call('POST', `/flows/${id}/versions/${v1.id}/deploy`)).status).toBe(400);
        await call('POST', `/flows/${id}/versions/${v2.id}/deploy`);

        const projects = (await call('GET', '/projects')).body as { items: { id: string; summary: Record<string, number> }[] };
        expect(projects.items.find(p => p.id === projectId)!.summary).toEqual({
            flows: 1,
            deployed: 1,
            scripts: 0,
        });

        const listed = (await call('GET', `/projects/${projectId}/contents`)).body as {
            flows: { id: string; deployedVersion: number | null }[];
        };
        expect(listed.flows.find(f => f.id === id)!.deployedVersion).toBe(2);

        const off = (await call('POST', `/flows/${id}/undeploy`)).body as unknown as Deployments;
        expect(off.deployed).toBeNull();
        expect(off.versions).toHaveLength(2);
        expect(off.history.map(h => [h.action, h.fromNumber, h.toNumber, h.by])).toEqual([
            ['undeploy', 2, null, ANA],
            ['deploy', 1, 2, ANA],
            ['rollback', 2, 1, ANA],
            ['deploy', 1, 2, ANA],
            ['deploy', null, 1, ANA],
        ]);
        expect((await call('POST', `/flows/${id}/undeploy`)).status).toBe(400);
        const after = (await call('GET', `/projects/${projectId}/contents`)).body as {
            flows: { id: string; deployedVersion: number | null }[];
        };
        expect(after.flows.find(f => f.id === id)!.deployedVersion).toBeNull();
        expect((await deployments(id)).versions.find(v => v.number === 1)!.definition.nodes.find(n => n.id === 'start')!.position.x).toBe(
            v1.definition.nodes.find(n => n.id === 'start')!.position.x,
        );
    });

    test("restore draft: the version's flow at the next revision, under the flow's name now", async () => {
        const id = await newFlow('Restore me');
        const v1 = ((await call('POST', `/flows/${id}/deploy`)).body as unknown as Deployments).versions[0]!;
        await moveStart(id, 99);
        await call('PATCH', `/flows/${id}`, { name: 'Restored' });

        const restored = await call('POST', `/flows/${id}/versions/${v1.id}/restore-draft`);
        expect(restored.body).toEqual({ revision: 2 });
        const draft = (await call('GET', `/flows/${id}/draft`)).body as {
            revision: number;
            flow: { name: string; nodes: { id: string; position: { x: number } }[] };
        };
        expect(draft.revision).toBe(2);
        expect(draft.flow.name).toBe('Restored');
        expect(draft.flow.nodes.find(n => n.id === 'start')!.position.x).toBe(v1.definition.nodes.find(n => n.id === 'start')!.position.x);
        expect((await call('POST', `/flows/${id}/versions/${crypto.randomUUID()}/restore-draft`)).status).toBe(404);
    });

    test("another flow's version, an archived flow, another workspace: refused", async () => {
        const a = await newFlow('A');
        const b = await newFlow('B');
        const va = ((await call('POST', `/flows/${a}/deploy`)).body as unknown as Deployments).versions[0]!;
        expect((await call('POST', `/flows/${b}/versions/${va.id}/deploy`)).status).toBe(404);

        await call('POST', `/flows/${a}/archive`);
        expect((await call('POST', `/flows/${a}/deploy`)).status).toBe(404);
        expect((await call('POST', `/flows/${a}/undeploy`)).status).toBe(404);
        expect((await deployments(a)).versions).toHaveLength(1);

        const otherWorkspace = crypto.randomUUID();
        await insertWorkspace(db, otherWorkspace, 'other');
        const other = await app.request(wsPath(otherWorkspace, `/flows/${b}/deployments`), { headers });
        expect(other.status).toBe(404);
    });

    test('archiving a deployed flow, its folder or its project undeploys it (in its history); restoring does not deploy it', async () => {
        const one = await newFlow('Archived alone');
        await call('POST', `/flows/${one}/deploy`);
        await call('POST', `/flows/${one}/archive`);
        const off = await deployments(one);
        expect(off.deployed).toBeNull();
        expect(off.history[0]).toMatchObject({ action: 'undeploy', fromNumber: 1, toNumber: null });
        await call('POST', `/flows/${one}/restore`);
        expect((await deployments(one)).deployed).toBeNull();

        const folder = (await call('POST', `/projects/${projectId}/folders`, { name: 'Archived folder' })).body.id as string;
        const inFolder = (await call('POST', `/projects/${projectId}/flows`, { name: 'In folder', folderId: folder })).body.id as string;
        await call('POST', `/flows/${inFolder}/deploy`);
        await call('POST', `/folders/${folder}/archive`);
        expect((await deployments(inFolder)).deployed).toBeNull();

        const project = (await call('POST', '/projects', { name: 'Archived project' })).body.id as string;
        const inProject = (await call('POST', `/projects/${project}/flows`, { name: 'In project' })).body.id as string;
        await call('POST', `/flows/${inProject}/deploy`);
        expect((await call('POST', `/projects/${project}/archive`)).status).toBe(200);
        expect((await deployments(inProject)).deployed).toBeNull();
    });

    test("a Flow Invoker: an editor's run calls the draft; a trigger's run the deployed version, never the draft (not deployed: cannot be called)", async () => {
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-deploys', '{default}', 1, 'test')`);
        const child = await newFlow('Child');
        const parent = await newFlow('Parent');
        const { flow, revision } = (await call('GET', `/flows/${parent}/draft`)).body as {
            revision: number;
            flow: { nodes: { id: string; type: string }[]; edges: unknown[] };
        };
        const nodes = [...flow.nodes, { id: 'call', type: 'flow', position: { x: 160, y: 0 }, config: { flowId: child } }];
        const edges = [
            { source: 'start', sourcePort: 'out-0', target: 'call', targetPort: 'in-0' },
            { source: 'call', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ];
        const start = flow.nodes.find(n => n.type === 'start')!.id;
        const end = flow.nodes.find(n => n.type === 'end')!.id;
        const wired = edges.map(e => ({
            ...e,
            source: e.source === 'start' ? start : e.source,
            target: e.target === 'end' ? end : e.target,
        }));
        expect((await call('PUT', `/flows/${parent}/draft`, { revision, flow: { ...flow, nodes, edges: wired } })).status).toBe(200);

        // an editor's run (Run for real here): the called flow's draft, deployed or not
        const id = (await call('POST', `/flows/${parent}/runs`, { mode: 'execution' })).body.id as string;
        const [run] = await db.query<{ called_flows: { id: string; unavailable?: string; versionId?: string }[] }>(
            'SELECT called_flows FROM runs WHERE id = $1',
            [id],
        );
        expect(run!.called_flows.find(c => c.id === child)).toMatchObject({ id: child, name: 'Child' });
        expect(run!.called_flows.find(c => c.id === child)!.unavailable).toBeUndefined();

        // a trigger's run (schedule, webhook, API): the called flow's deployed version, never its draft
        const ctx = { db, workspaceId, userId: 'ana', role: 'admin' as const };
        const calledOf = async () => {
            const row = (await loadTree(db, workspaceId, projectId)).flows.find(f => f.id === parent)!;
            const tree = await loadTree(db, workspaceId, projectId);
            return (await calledFlows(ctx, tree, (await loadDraft(db, workspaceId, row)).flow, 'deployed')).find(c => c.id === child)!;
        };

        expect(await calledOf()).toMatchObject({ unavailable: 'it is not deployed.' });
        // deploying the parent now warns (and does not stop the deploy)
        expect(((await call('GET', `/flows/${parent}/deployments`)).body as { warnings: string[] }).warnings).toEqual([
            'It calls "Child", which is not deployed: those calls will fail.',
        ]);

        const v1 = ((await call('POST', `/flows/${child}/deploy`)).body as unknown as Deployments).versions[0]!;
        // the draft changes after the deploy: the call still takes v1
        await moveStart(child, 500);
        expect(((await call('GET', `/flows/${parent}/deployments`)).body as { warnings: string[] }).warnings).toEqual([]);
        const called = await calledOf();
        expect(called.unavailable).toBeUndefined();
        expect(called.versionId).toBe(v1.id);
        expect(JSON.stringify(called.flow)).not.toContain('500');

        await call('POST', `/flows/${child}/undeploy`);
        expect(await calledOf()).toMatchObject({ unavailable: 'it is not deployed.' });
    });
});
