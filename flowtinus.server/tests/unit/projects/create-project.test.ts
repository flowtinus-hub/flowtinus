import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { insertWorkspace } from '../../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { CreateProjectHandler } from '#features/projects/create-project/create-project-handler';
import { ProjectRepository } from '#features/projects/project-repository';

setDefaultTimeout(30_000);

describe('create project', () => {
    let db: Database;
    let ctx: UseCaseContext;
    let otherWorkspaceCtx: UseCaseContext;
    const handler = new CreateProjectHandler();

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

    test("creates the project in the caller's workspace", async () => {
        const result = await handler.handle({ name: '  Sales  ', description: 'Daily sales flows' }, ctx);

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const project = await new ProjectRepository(db, ctx.workspaceId).findById(result.value.id);
        expect(project).toMatchObject({ workspaceId: ctx.workspaceId, name: 'Sales', description: 'Daily sales flows', deletedAt: null });
    });

    test('description is optional', async () => {
        const result = await handler.handle({ name: 'Finance' }, ctx);

        expect(result.ok).toBe(true);
    });

    test('rejects invalid fields', async () => {
        const result = await handler.handle({ name: '   ', description: 'x'.repeat(501) }, ctx);

        expect(result).toEqual({
            ok: false,
            error: {
                code: 'validation',
                message: 'The request has invalid fields.',
                fields: { name: 'Required', description: 'At most 500 characters' },
            },
        });
    });

    test('rejects a body that is not an object', async () => {
        const result = await handler.handle(undefined, ctx);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe('validation');
        }
    });

    test('rejects a name already used in the workspace, ignoring case', async () => {
        const result = await handler.handle({ name: 'SALES' }, ctx);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe('conflict');
            expect(result.error.fields).toEqual({ name: 'Handle taken by "Sales"' });
        }
    });

    test('another workspace can use the same name', async () => {
        const result = await handler.handle({ name: 'Sales' }, otherWorkspaceCtx);

        expect(result.ok).toBe(true);
    });

    test('a project of one workspace is not visible to another', async () => {
        const result = await handler.handle({ name: 'Private' }, ctx);
        if (!result.ok) {
            throw new Error('expected success');
        }

        expect(await new ProjectRepository(db, otherWorkspaceCtx.workspaceId).findById(result.value.id)).toBeNull();
    });
});
