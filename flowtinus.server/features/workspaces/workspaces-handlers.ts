import { z } from 'zod';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { requireRole } from '#shared/use-cases/require-role';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { users } from '#features/users/user';
import { membershipsOf, type Membership } from './memberships';
import { WORKSPACE_SLUG, workspaces, type Workspace } from './workspace';
import { WORKSPACE_ROLES, workspaceMembers, type WorkspaceRole } from './workspace-member';
import { projects } from '#features/projects/project';

const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

export type WorkspaceView = {
    id: string;
    slug: string;
    name: string;
    description: string;
    icon: string;
    color: string;
    createdAt: Date;
    archivedAt: Date | null;
    role: WorkspaceRole;
};

export type WorkspaceSummary = { projects: number; connections: number; secrets: number; variables: number; members: number };

const toView = (row: Workspace, role: WorkspaceRole): WorkspaceView => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color,
    createdAt: row.createdAt,
    archivedAt: row.deletedAt,
    role,
});

const Fields = {
    name: z.string().trim().min(1, 'Required').max(NAME_MAX, `At most ${NAME_MAX} characters`),
    description: z.string().trim().max(DESCRIPTION_MAX, `At most ${DESCRIPTION_MAX} characters`),
    icon: z.string().trim().min(1).max(40),
    color: z.string().trim().min(1).max(40),
};

async function findWorkspace(ctx: UseCaseContext): Promise<Workspace | null> {
    const [row] = await ctx.db.orm.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
    return row ?? null;
}

/** the user's id may be any text (a dev login), not always a uuid: compared as text, so Postgres never rejects it */
const userIs = (userId: string) => sql`${users.id}::text = ${userId}`;

export type MeView = { id: string; name: string; email: string; handle: string; isAdmin: boolean; workspaces: Membership[] };

export class GetMeHandler implements UseCaseHandler<MeView> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<MeView>> {
        const [user] = await ctx.db.orm.select().from(users).where(userIs(ctx.userId));
        if (!user) {
            return fail('not-found', 'Unknown user.');
        }

        return success({
            id: user.id,
            name: user.name,
            email: user.email,
            handle: user.handle,
            isAdmin: user.isAdmin,
            workspaces: await membershipsOf(ctx.db, ctx.userId),
        });
    }
}

export const ListWorkspacesQuery = z.object({
    status: z.enum(['active', 'archived'], 'Use active or archived').default('active'),
});

export class ListWorkspacesHandler implements UseCaseHandler<{ items: (WorkspaceView & { summary: WorkspaceSummary })[] }> {
    async handle(
        input: unknown,
        ctx: UseCaseContext,
    ): Promise<UseCaseResult<{ items: (WorkspaceView & { summary: WorkspaceSummary })[] }>> {
        const parsed = validate(ListWorkspacesQuery, input ?? {});
        if (!parsed.ok) {
            return parsed;
        }

        const rows = await ctx.db.query<{
            id: string;
            slug: string;
            name: string;
            description: string;
            icon: string;
            color: string;
            created_at: Date;
            deleted_at: Date | null;
            role: WorkspaceRole;
            projects: number | string;
            connections: number | string;
            secrets: number | string;
            variables: number | string;
            members: number | string;
        }>(
            `SELECT w.id, w.slug, w.name, w.description, w.icon, w.color, w.created_at, w.deleted_at, m.role,
              (SELECT count(*) FROM projects p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) AS projects,
              (SELECT count(*) FROM connections c WHERE c.workspace_id = w.id AND c.deleted_at IS NULL) AS connections,
              (SELECT count(*) FROM secrets s WHERE s.workspace_id = w.id) AS secrets,
              (SELECT count(*) FROM variables v WHERE v.workspace_id = w.id) AS variables,
              (SELECT count(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS members
         FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id::text = $1 AND (w.deleted_at IS NULL) = $2
        ORDER BY lower(w.name), w.slug`,
            [ctx.userId, parsed.value.status === 'active'],
        );
        return success({
            items: rows.map(r => ({
                id: r.id,
                slug: r.slug,
                name: r.name,
                description: r.description,
                icon: r.icon,
                color: r.color,
                createdAt: new Date(r.created_at),
                archivedAt: r.deleted_at ? new Date(r.deleted_at) : null,
                role: r.role,
                summary: {
                    projects: Number(r.projects),
                    connections: Number(r.connections),
                    secrets: Number(r.secrets),
                    variables: Number(r.variables),
                    members: Number(r.members),
                },
            })),
        });
    }
}

export const CreateWorkspaceCommand = z.object({
    slug: z.string().trim().regex(WORKSPACE_SLUG, 'Lowercase letters, digits and hyphens (1 to 40), not starting or ending with a hyphen'),
    name: Fields.name,
    description: Fields.description.default(''),
    icon: Fields.icon.default('layers'),
    color: Fields.color.default('blue'),
});

export class CreateWorkspaceHandler implements UseCaseHandler<{ id: string; slug: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string; slug: string }>> {
        const [user] = await ctx.db.orm.select({ isAdmin: users.isAdmin }).from(users).where(userIs(ctx.userId));
        if (!user?.isAdmin) {
            return fail('forbidden', 'Only an admin of the environment can create workspaces.');
        }

        const parsed = validate(CreateWorkspaceCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { slug, ...fields } = parsed.value;
        if ((await ctx.db.orm.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1)).length > 0) {
            return fail('conflict', `A workspace with the ID "${slug}" already exists.`, { slug: 'Already in use' });
        }

        const id = crypto.randomUUID();
        await ctx.db.transaction(async tx => {
            await tx.orm.insert(workspaces).values({ id, slug, ...fields });
            await tx.orm.insert(workspaceMembers).values({ workspaceId: id, userId: ctx.userId, role: 'admin' });
        });
        return success({ id, slug });
    }
}

export class GetWorkspaceHandler implements UseCaseHandler<WorkspaceView> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<WorkspaceView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }

        const row = await findWorkspace(ctx);
        return row ? success(toView(row, ctx.role!)) : fail('not-found', 'Workspace not found.');
    }
}

export const UpdateWorkspaceCommand = z.object({
    name: Fields.name.optional(),
    description: Fields.description.optional(),
    icon: Fields.icon.optional(),
    color: Fields.color.optional(),
    /** the slug never changes: sent only to say so */
    slug: z.string().optional(),
});

export class UpdateWorkspaceHandler implements UseCaseHandler<WorkspaceView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<WorkspaceView>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const parsed = validate(UpdateWorkspaceCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { slug, ...fields } = parsed.value;
        const current = await findWorkspace(ctx);
        if (!current || current.deletedAt) {
            return fail('not-found', 'Workspace not found.');
        }

        if (slug !== undefined && slug !== current.slug) {
            return fail('validation', "A workspace's ID cannot change.", { slug: 'Cannot change' });
        }

        const changes = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (Object.keys(changes).length === 0) {
            return success(toView(current, ctx.role!));
        }

        const [row] = await ctx.db.orm.update(workspaces).set(changes).where(eq(workspaces.id, ctx.workspaceId)).returning();
        return success(toView(row!, ctx.role!));
    }
}

/** Archives the workspace (admins): only when all its projects are archived. Its schedules and webhooks stop firing. */
export class ArchiveWorkspaceHandler implements UseCaseHandler<{ id: string }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const n = await ctx.db.orm.$count(projects, and(eq(projects.workspaceId, ctx.workspaceId), isNull(projects.deletedAt)));
        if (n > 0) {
            return fail('conflict', `Archive its projects first: ${n} ${n === 1 ? 'project is' : 'projects are'} still active.`);
        }

        const rows = await ctx.db.orm
            .update(workspaces)
            .set({ deletedAt: sql`now()`, deletedBy: ctx.userId })
            .where(and(eq(workspaces.id, ctx.workspaceId), isNull(workspaces.deletedAt)))
            .returning({ id: workspaces.id });
        return rows.length > 0 ? success({ id: ctx.workspaceId }) : fail('not-found', 'Workspace not found.');
    }
}

export class RestoreWorkspaceHandler implements UseCaseHandler<{ id: string }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const rows = await ctx.db.orm
            .update(workspaces)
            .set({ deletedAt: null, deletedBy: null })
            .where(and(eq(workspaces.id, ctx.workspaceId), isNotNull(workspaces.deletedAt)))
            .returning({ id: workspaces.id });
        return rows.length > 0 ? success({ id: ctx.workspaceId }) : fail('not-found', 'No archived workspace to restore.');
    }
}

export type MemberView = { userId: string; name: string; email: string; role: WorkspaceRole; createdAt: Date };

async function members(ctx: UseCaseContext): Promise<MemberView[]> {
    return ctx.db.orm
        .select({
            userId: workspaceMembers.userId,
            name: users.name,
            email: users.email,
            role: workspaceMembers.role,
            createdAt: workspaceMembers.createdAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, ctx.workspaceId))
        .orderBy(sql`lower(${users.name})`, asc(users.email));
}

export class ListMembersHandler implements UseCaseHandler<{ items: MemberView[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: MemberView[] }>> {
        return requireRole(ctx, 'viewer') ?? success({ items: await members(ctx) });
    }
}

const Role = z.enum(WORKSPACE_ROLES, 'Use admin, editor or viewer');

export const AddMemberCommand = z.object({ email: z.string().trim().min(1, 'Required'), role: Role });

export class AddMemberHandler implements UseCaseHandler<MemberView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<MemberView>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const parsed = validate(AddMemberCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [user] = await ctx.db.orm
            .select({ id: users.id })
            .from(users)
            .where(sql`lower(${users.email}) = lower(${parsed.value.email})`);
        if (!user) {
            return fail('not-found', 'No user with this email.', { email: 'No user with this email' });
        }

        const added = await ctx.db.orm
            .insert(workspaceMembers)
            .values({ workspaceId: ctx.workspaceId, userId: user.id, role: parsed.value.role })
            .onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.userId] })
            .returning({ userId: workspaceMembers.userId });
        if (added.length === 0) {
            return fail('conflict', 'This user is already a member.', { email: 'Already a member' });
        }

        return success((await members(ctx)).find(m => m.userId === user.id)!);
    }
}

async function anotherAdmin(ctx: UseCaseContext, userId: string): Promise<boolean> {
    const rows = await ctx.db.orm
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
            and(
                eq(workspaceMembers.workspaceId, ctx.workspaceId),
                eq(workspaceMembers.role, 'admin'),
                ne(sql`${workspaceMembers.userId}::text`, userId),
            ),
        )
        .limit(1);
    return rows.length > 0;
}

export const UpdateMemberCommand = z.object({ userId: z.uuid('Invalid'), role: Role });

export class UpdateMemberHandler implements UseCaseHandler<MemberView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<MemberView>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const parsed = validate(UpdateMemberCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { userId, role } = parsed.value;
        if (role !== 'admin' && !(await anotherAdmin(ctx, userId))) {
            return fail('conflict', 'A workspace needs at least one admin.');
        }

        const rows = await ctx.db.orm
            .update(workspaceMembers)
            .set({ role })
            .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)))
            .returning({ userId: workspaceMembers.userId });
        if (rows.length === 0) {
            return fail('not-found', 'Member not found.');
        }

        return success((await members(ctx)).find(m => m.userId === userId)!);
    }
}

export const RemoveMemberCommand = z.object({ userId: z.uuid('Invalid') });

export class RemoveMemberHandler implements UseCaseHandler<{ userId: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ userId: string }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const parsed = validate(RemoveMemberCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { userId } = parsed.value;
        if (!(await anotherAdmin(ctx, userId))) {
            return fail('conflict', 'A workspace needs at least one admin.');
        }

        const rows = await ctx.db.orm
            .delete(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)))
            .returning({ userId: workspaceMembers.userId });
        return rows.length > 0 ? success({ userId }) : fail('not-found', 'Member not found.');
    }
}
