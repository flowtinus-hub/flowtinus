import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { openDatabase, type Database } from '#shared/database/database';
import { DEV_USER, DEV_WORKSPACE_ID, seedDev } from '#shared/database/seed-dev';
import { insertMember, insertUser } from '../helpers/workspaces';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('workspaces and their members', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;

    const call = async (user: string, method: string, path: string, body?: unknown) => {
        const response = await app.request(path, {
            method,
            headers: { 'x-user-id': user, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const dev = (method: string, path: string, body?: unknown) => call(DEV_USER.id, method, path, body);

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await seedDev(db);
        app = createApp(db, 'DEV');
    });
    afterAll(() => db.close());

    test('/me: the user and their workspaces, with their role', async () => {
        const me = await dev('GET', '/me');
        expect(me.body).toMatchObject({ id: DEV_USER.id, isAdmin: true, workspaces: [{ slug: 'dev', name: 'Dev', role: 'admin' }] });
        expect((await call(crypto.randomUUID(), 'GET', '/me')).status).toBe(404);
    });

    test('only an admin of the environment creates a workspace, and becomes its admin; the slug is checked and unique', async () => {
        const created = await dev('POST', '/workspaces', { slug: 'mydevworkspace', name: 'My dev workspace' });
        expect(created).toMatchObject({ status: 201, body: { slug: 'mydevworkspace' } });
        expect((await dev('GET', '/w/mydevworkspace')).body).toMatchObject({ name: 'My dev workspace', role: 'admin', icon: 'layers' });

        const again = await dev('POST', '/workspaces', { slug: 'mydevworkspace', name: 'Other' });
        expect(again).toMatchObject({ status: 409, body: { error: { fields: { slug: 'Already in use' } } } });
        for (const slug of ['My-Space', '-dev', 'dev-', 'a'.repeat(41), 'with space', '']) {
            expect((await dev('POST', '/workspaces', { slug, name: 'X' })).status).toBe(400);
        }
        expect((await dev('POST', '/workspaces', { slug: 'ok', name: '' })).status).toBe(400);

        const member = await insertMember(db, DEV_WORKSPACE_ID, { name: 'Edu', role: 'editor' });
        const refused = await call(member, 'POST', '/workspaces', { slug: 'mine', name: 'Mine' });
        expect(refused).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    });

    test('the list: the workspaces of the user only, with the role and what each holds', async () => {
        await dev('POST', '/workspaces', { slug: 'listed', name: 'Listed' });
        await dev('POST', '/w/listed/projects', { name: 'P1' });
        await dev('POST', '/w/listed/variables', { name: 'region', value: 'eu' });
        const items = (await dev('GET', '/workspaces')).body.items as { slug: string; role: string; summary: Record<string, number> }[];
        expect(items.find(w => w.slug === 'listed')).toMatchObject({
            role: 'admin',
            summary: { projects: 1, connections: 0, secrets: 0, variables: 1, members: 1 },
        });

        const outsider = await insertUser(db);
        expect((await call(outsider, 'GET', '/workspaces')).body.items).toEqual([]);
        expect((await call(outsider, 'GET', '/w/listed/projects')).status).toBe(403);
        expect((await dev('GET', '/w/nothing-here/projects')).status).toBe(404);
    });

    test('update: name, description, icon and color by its admins; the slug never changes', async () => {
        await dev('POST', '/workspaces', { slug: 'editable', name: 'Editable' });
        const changed = await dev('PATCH', '/w/editable', { name: 'Edited', description: 'About', color: 'green', slug: 'editable' });
        expect(changed.body).toMatchObject({ name: 'Edited', description: 'About', color: 'green', slug: 'editable' });
        expect((await dev('PATCH', '/w/editable', { slug: 'renamed' })).body.error.fields).toEqual({ slug: 'Cannot change' });

        const viewer = await insertUser(db, 'Vi');
        await db.query(
            "INSERT INTO workspace_members (workspace_id, user_id, role) SELECT id, $1, 'viewer' FROM workspaces WHERE slug = 'editable'",
            [viewer],
        );
        expect((await call(viewer, 'GET', '/w/editable')).body.role).toBe('viewer');
        expect((await call(viewer, 'PATCH', '/w/editable', { name: 'Mine' })).status).toBe(403);
    });

    test('archive: only with every project archived; then its address answers only itself and restore', async () => {
        await dev('POST', '/workspaces', { slug: 'old', name: 'Old' });
        const project = (await dev('POST', '/w/old/projects', { name: 'Still here' })).body.id as string;
        const refused = await dev('POST', '/w/old/archive');
        expect(refused).toMatchObject({
            status: 409,
            body: { error: { message: 'Archive its projects first: 1 project is still active.' } },
        });

        await dev('POST', `/w/old/projects/${project}/archive`);
        expect((await dev('POST', '/w/old/archive')).status).toBe(200);
        expect((await dev('GET', '/w/old/projects')).status).toBe(404);
        expect((await dev('GET', '/w/old')).body.archivedAt).toBeString();
        expect(((await dev('GET', '/workspaces?status=archived')).body.items as { slug: string }[]).map(w => w.slug)).toContain('old');
        expect(((await dev('GET', '/me')).body.workspaces as { slug: string }[]).map(w => w.slug)).not.toContain('old');

        expect((await dev('POST', '/w/old/restore')).status).toBe(200);
        expect((await dev('GET', '/w/old/projects?status=archived')).status).toBe(200);
    });

    test('members: added by email with a role, changed, removed; never without an admin', async () => {
        await dev('POST', '/workspaces', { slug: 'team', name: 'Team' });
        const bia = await insertUser(db, 'Bia');
        const email = `${bia}@example.com`;

        expect((await dev('POST', '/w/team/members', { email: 'nobody@example.com', role: 'editor' })).status).toBe(404);
        expect((await dev('POST', '/w/team/members', { email, role: 'owner' })).status).toBe(400);
        expect((await dev('POST', '/w/team/members', { email: email.toUpperCase(), role: 'editor' })).body).toMatchObject({
            userId: bia,
            name: 'Bia',
            role: 'editor',
        });
        expect((await dev('POST', '/w/team/members', { email, role: 'viewer' })).status).toBe(409);
        expect(((await call(bia, 'GET', '/w/team/members')).body.items as { name: string }[]).map(m => m.name)).toEqual(['Bia', 'Dev']);
        // an editor does not manage members
        expect((await call(bia, 'PATCH', `/w/team/members/${DEV_USER.id}`, { role: 'viewer' })).status).toBe(403);

        // the last admin stays
        expect((await dev('PATCH', `/w/team/members/${DEV_USER.id}`, { role: 'editor' })).status).toBe(409);
        expect((await dev('DELETE', `/w/team/members/${DEV_USER.id}`)).status).toBe(409);
        expect((await dev('PATCH', `/w/team/members/${bia}`, { role: 'admin' })).body.role).toBe('admin');
        expect((await dev('PATCH', `/w/team/members/${DEV_USER.id}`, { role: 'editor' })).body.role).toBe('editor');
        expect((await call(bia, 'DELETE', `/w/team/members/${DEV_USER.id}`)).status).toBe(200);
        expect((await dev('GET', '/w/team')).status).toBe(403);
    });

    test('the Runs page: the runs of the user’s workspaces, or one of them; a run of another workspace is not found', async () => {
        await dev('POST', '/workspaces', { slug: 'runs-a', name: 'Runs A' });
        await dev('POST', '/workspaces', { slug: 'runs-b', name: 'Runs B' });
        const runIn = async (slug: string) => {
            const project = (await dev('POST', `/w/${slug}/projects`, { name: 'P' })).body.id as string;
            const flow = (await dev('POST', `/w/${slug}/projects/${project}/flows`, { name: `Flow ${slug}` })).body.id as string;
            // a run for real as it ended (no supervisor here)
            const id = crypto.randomUUID();
            await db.query(
                `INSERT INTO runs (id, workspace_id, project_id, flow_id, mode, draft_hash, status, trigger, worker_tag, flow_name)
         SELECT $1, w.id, $3, $4, 'execution', 'h', 'completed', 'manual', 'default', 'F' FROM workspaces w WHERE w.slug = $2`,
                [id, slug, project, flow],
            );
            return id;
        };
        const a = await runIn('runs-a');
        const b = await runIn('runs-b');

        const all = (await dev('GET', '/runs')).body.runs as { id: string; workspaceSlug: string }[];
        expect(
            all
                .filter(r => r.id === a || r.id === b)
                .map(r => r.workspaceSlug)
                .sort(),
        ).toEqual(['runs-a', 'runs-b']);
        const onlyA = (await dev('GET', '/runs?workspace=runs-a')).body.runs as { id: string }[];
        expect(onlyA.map(r => r.id)).toEqual([a]);
        expect((await dev('GET', `/runs/${b}`)).status).toBe(200);

        const member = await insertMember(db, (await db.query<{ id: string }>("SELECT id FROM workspaces WHERE slug = 'runs-a'"))[0]!.id, {
            name: 'Only A',
            role: 'viewer',
        });
        expect(((await call(member, 'GET', '/runs')).body.runs as { id: string }[]).map(r => r.id)).toEqual([a]);
        expect((await call(member, 'GET', '/runs?workspace=runs-b')).body.runs).toEqual([]);
        expect((await call(member, 'GET', `/runs/${b}`)).status).toBe(404);
        expect((await call(member, 'GET', `/runs/${a}`)).status).toBe(200);
    });
});
