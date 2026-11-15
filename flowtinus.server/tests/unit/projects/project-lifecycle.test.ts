import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { insertWorkspace } from '../../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { ArchiveFlowHandler } from '#features/flows/archive-flow/archive-flow-handler';
import { CreateFlowHandler } from '#features/flows/create-flow/create-flow-handler';
import { RestoreFlowHandler } from '#features/flows/restore-flow/restore-flow-handler';
import { CreateFolderHandler } from '#features/folders/create-folder/create-folder-handler';
import { RestoreFolderHandler } from '#features/folders/restore-folder/restore-folder-handler';
import { loadTree } from '#features/folders/project-tree';
import { ArchiveProjectHandler } from '#features/projects/archive-project/archive-project-handler';
import { ListProjectsHandler } from '#features/projects/list-projects/list-projects-handler';
import { ProjectRepository } from '#features/projects/project-repository';
import { RestoreProjectHandler } from '#features/projects/restore-project/restore-project-handler';
import { UpdateProjectHandler } from '#features/projects/update-project/update-project-handler';

setDefaultTimeout(30_000);

describe('update, archive and restore projects', () => {
    let db: Database;
    let ctx: UseCaseContext;
    let otherWorkspaceCtx: UseCaseContext;
    const update = new UpdateProjectHandler();
    const archive = new ArchiveProjectHandler();
    const restore = new RestoreProjectHandler();
    const list = new ListProjectsHandler();

    const newProject = async (name: string, workspaceCtx = ctx) =>
        (await new ProjectRepository(db, workspaceCtx.workspaceId).insert({ id: crypto.randomUUID(), name, description: '' })).id;

    const names = async (status: 'active' | 'archived') => {
        const result = await list.handle({ status }, ctx);
        if (!result.ok) {
            throw new Error('expected success');
        }

        return result.value.items.map(p => p.name);
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        ctx = { workspaceId: crypto.randomUUID(), userId: 'ana', role: 'admin', db };
        otherWorkspaceCtx = { workspaceId: crypto.randomUUID(), userId: 'bia', role: 'admin', db };
        for (const workspaceId of [ctx.workspaceId, otherWorkspaceCtx.workspaceId]) {
            await insertWorkspace(db, workspaceId, `org ${workspaceId}`);
        }
    });

    afterAll(async () => {
        await db.close();
    });

    test('update changes only the given fields', async () => {
        const id = await newProject('Draft');

        const result = await update.handle({ id, name: '  Sales  ', icon: 'cart' }, ctx);

        expect(result).toMatchObject({
            ok: true,
            value: { id, name: 'Sales', description: '', icon: 'cart', color: 'blue', archivedAt: null },
        });
    });

    test("update keeps its own name (any case) but not another project's", async () => {
        const id = await newProject('Finance');
        await newProject('Taken');

        expect((await update.handle({ id, name: 'FINANCE' }, ctx)).ok).toBe(true);
        expect(await update.handle({ id, name: 'taken' }, ctx)).toMatchObject({
            ok: false,
            error: { code: 'conflict', fields: { name: 'Already in use' } },
        });
    });

    test('update validates the fields and needs at least one', async () => {
        const id = await newProject('Valid');

        expect(await update.handle({ id, name: ' ', color: 'Blue!' }, ctx)).toMatchObject({
            ok: false,
            error: { code: 'validation', fields: { name: 'Required', color: 'Invalid' } },
        });
        expect(await update.handle({ id }, ctx)).toMatchObject({ ok: false, error: { code: 'validation' } });
        expect(await update.handle({ id: 'not-a-uuid', name: 'X' }, ctx)).toMatchObject({
            ok: false,
            error: { fields: { id: 'Invalid' } },
        });
    });

    test('archive moves the project to the archived list, once', async () => {
        const id = await newProject('Old stuff');

        expect(await archive.handle({ id }, ctx)).toEqual({ ok: true, value: { id } });
        expect(await names('active')).not.toContain('Old stuff');
        expect(await names('archived')).toContain('Old stuff');
        expect(await archive.handle({ id }, ctx)).toMatchObject({ ok: false, error: { code: 'not-found' } });

        const [row] = await db.query<{ deleted_by: string }>('SELECT deleted_by FROM projects WHERE id = $1', [id]);
        expect(row?.deleted_by).toBe('ana');
    });

    test('an archived project cannot be edited', async () => {
        const id = await newProject('Frozen');
        await archive.handle({ id }, ctx);

        expect(await update.handle({ id, name: 'Thawed' }, ctx)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    });

    test('restore brings it back, unless an active project took its name', async () => {
        const id = await newProject('Comeback');
        await archive.handle({ id }, ctx);

        const restored = await restore.handle({ id }, ctx);
        expect(restored).toMatchObject({ ok: true, value: { id, name: 'Comeback', archivedAt: null } });
        expect(await restore.handle({ id }, ctx)).toMatchObject({ ok: false, error: { code: 'not-found' } });

        await archive.handle({ id }, ctx);
        await newProject('Comeback');
        expect(await restore.handle({ id }, ctx)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    });

    test('archive takes its active folders and flows with it (same time); restore brings back only those', async () => {
        const id = await newProject('With contents');
        const created = async <T>(result: Promise<{ ok: boolean; value?: T }>) => (await result).value as T;
        const folder = (
            await created<{ id: string }>(new CreateFolderHandler().handle({ projectId: id, parentId: null, name: 'Imports' }, ctx))
        ).id;
        const inFolder = (
            await created<{ id: string }>(new CreateFlowHandler().handle({ projectId: id, folderId: folder, name: 'Load' }, ctx))
        ).id;
        const atRoot = (await created<{ id: string }>(new CreateFlowHandler().handle({ projectId: id, folderId: null, name: 'Main' }, ctx)))
            .id;
        const before = (await created<{ id: string }>(new CreateFlowHandler().handle({ projectId: id, folderId: null, name: 'Old' }, ctx)))
            .id;
        await new ArchiveFlowHandler().handle({ id: before }, ctx);
        const archivedBefore = (await loadTree(db, ctx.workspaceId, id)).flows.find(f => f.id === before)!.archivedAt;
        await Bun.sleep(5); // a distinct archive time

        expect((await archive.handle({ id }, ctx)).ok).toBe(true);
        const [project] = await db.query<{ deleted_at: Date }>('SELECT deleted_at FROM projects WHERE id = $1', [id]);
        const archived = await loadTree(db, ctx.workspaceId, id);
        const at = (itemId: string) => [...archived.folders, ...archived.flows].find(i => i.id === itemId)!;
        for (const itemId of [folder, inFolder, atRoot]) {
            expect(at(itemId).archivedAt?.getTime()).toBe(new Date(project!.deleted_at).getTime());
            expect(at(itemId).deletedBy).toBe('ana');
        }
        expect(at(before).archivedAt).toEqual(archivedBefore);

        // what is in an archived project comes back with it, not on its own
        expect(await new RestoreFlowHandler().handle({ id: atRoot }, ctx)).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await new RestoreFolderHandler().handle({ id: folder }, ctx)).toMatchObject({ ok: false, error: { code: 'conflict' } });

        expect((await restore.handle({ id }, ctx)).ok).toBe(true);
        const restored = await loadTree(db, ctx.workspaceId, id);
        const now = (itemId: string) => [...restored.folders, ...restored.flows].find(i => i.id === itemId)!;
        for (const itemId of [folder, inFolder, atRoot]) {
            expect(now(itemId).archivedAt).toBeNull();
        }
        expect(now(before).archivedAt).toEqual(archivedBefore);
    });

    test('archived list: last archived first, with archivedAt', async () => {
        const first = await newProject('First archived');
        const second = await newProject('Second archived');
        await archive.handle({ id: first }, ctx);
        await Bun.sleep(5); // distinct archive times
        await archive.handle({ id: second }, ctx);

        const result = await list.handle({ status: 'archived' }, ctx);
        if (!result.ok) {
            throw new Error('expected success');
        }

        const archived = result.value.items.filter(p => p.name.endsWith('archived'));
        expect(archived.map(p => p.name)).toEqual(['Second archived', 'First archived']);
        expect(archived[0]!.archivedAt).toBeInstanceOf(Date);
    });

    test('list refuses an unknown status', async () => {
        expect(await list.handle({ status: 'deleted' }, ctx)).toMatchObject({ ok: false, error: { code: 'validation' } });
    });

    test('another workspace can neither change, archive nor restore', async () => {
        const id = await newProject('Private');

        expect(await update.handle({ id, name: 'Mine' }, otherWorkspaceCtx)).toMatchObject({ ok: false, error: { code: 'not-found' } });
        expect(await archive.handle({ id }, otherWorkspaceCtx)).toMatchObject({ ok: false, error: { code: 'not-found' } });
        await archive.handle({ id }, ctx);
        expect(await restore.handle({ id }, otherWorkspaceCtx)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    });
});
