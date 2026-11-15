import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { insertWorkspace } from '../../helpers/workspaces';
import { asc, eq } from 'drizzle-orm';
import { openDatabase, type Database } from '#shared/database/database';
import { WorkspaceRepository } from '#shared/database/repository';
import { projects as projectsTable } from '#features/projects/project';

setDefaultTimeout(30_000);

describe('workspace repository', () => {
    let db: Database;
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    const projects = (workspaceId: string) => new WorkspaceRepository(db, projectsTable, workspaceId);

    beforeAll(async () => {
        db = await openDatabase('memory://');
        for (const workspaceId of [workspaceA, workspaceB]) {
            await insertWorkspace(db, workspaceId, `org ${workspaceId}`);
        }
    });

    afterAll(async () => {
        await db.close();
    });

    test('inserts in the workspace and reads the entity back', async () => {
        const id = crypto.randomUUID();
        const inserted = await projects(workspaceA).insert({ id, name: 'Sales', description: '' });

        expect(inserted).toMatchObject({ id, workspaceId: workspaceA, name: 'Sales', deletedAt: null, deletedBy: null });
        expect(inserted.createdAt).toBeInstanceOf(Date);
        expect(await projects(workspaceA).findById(id)).toEqual(inserted);
    });

    test('another workspace sees nothing, even filtering by the other workspaceId', async () => {
        const { id } = await projects(workspaceA).insert({ id: crypto.randomUUID(), name: 'Hidden', description: '' });

        expect(await projects(workspaceB).findById(id)).toBeNull();
        expect(await projects(workspaceB).findOne(eq(projectsTable.workspaceId, workspaceA))).toBeNull();
        expect(await projects(workspaceB).update(id, { name: 'Taken' })).toBeNull();
        expect(await projects(workspaceB).softDelete(id, 'bia')).toBe(false);
    });

    test('insert cannot write into another workspace', async () => {
        const values = { id: crypto.randomUUID(), workspaceId: workspaceA, name: 'Mine', description: '' };
        const inserted = await projects(workspaceB).insert(values);

        expect(inserted.workspaceId).toBe(workspaceB);
    });

    test('filters, orders and limits', async () => {
        const repo = projects(workspaceB);
        await repo.insert({ id: crypto.randomUUID(), name: 'Beta', description: 'x' });
        await repo.insert({ id: crypto.randomUUID(), name: 'Alpha', description: 'x' });

        expect(await repo.exists(eq(projectsTable.name, 'Beta'))).toBe(true);
        const found = await repo.findMany(eq(projectsTable.description, 'x'), { orderBy: asc(projectsTable.name), limit: 1 });
        expect(found.map(p => p.name)).toEqual(['Alpha']);
    });

    test('updates only the given fields', async () => {
        const { id } = await projects(workspaceA).insert({ id: crypto.randomUUID(), name: 'Old', description: 'kept' });

        expect(await projects(workspaceA).update(id, { name: 'New' })).toMatchObject({ name: 'New', description: 'kept' });
    });

    test('soft delete hides the row and keeps it', async () => {
        const { id } = await projects(workspaceA).insert({ id: crypto.randomUUID(), name: 'Gone', description: '' });

        expect(await projects(workspaceA).softDelete(id, 'ana')).toBe(true);
        expect(await projects(workspaceA).findById(id)).toBeNull();
        expect(await projects(workspaceA).softDelete(id, 'ana')).toBe(false);
        const [row] = await db.query<{ deleted_by: string }>('SELECT deleted_by FROM projects WHERE id = $1', [id]);
        expect(row?.deleted_by).toBe('ana');
    });

    test('works inside a transaction, and a rollback undoes it', async () => {
        const id = crypto.randomUUID();
        await expect(
            db.transaction(async tx => {
                await new WorkspaceRepository(tx, projectsTable, workspaceA).insert({ id, name: 'Rolled back', description: '' });
                throw new Error('rollback');
            }),
        ).rejects.toThrow('rollback');

        expect(await projects(workspaceA).findById(id)).toBeNull();
    });
});
