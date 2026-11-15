import { z } from 'zod';
import { desc } from 'drizzle-orm';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { projects } from '../project';
import { toProjectView, type ProjectView } from '../project-fields';
import { ProjectRepository } from '../project-repository';

export const ListProjectsQuery = z.object({
    status: z.enum(['active', 'archived'], 'Use active or archived').default('active'),
});

export type ProjectSummary = { flows: number; deployed: number; scripts: number };

export type ListProjectsResponse = { items: (ProjectView & { summary: ProjectSummary })[] };

const EMPTY: ProjectSummary = { flows: 0, deployed: 0, scripts: 0 };

async function summaries(ctx: UseCaseContext, ids: string[]): Promise<Map<string, ProjectSummary>> {
    if (ids.length === 0) {
        return new Map();
    }

    const rows = await ctx.db.query<{ id: string } & Record<keyof ProjectSummary, number | string>>(
        `SELECT p.id,
       (SELECT count(*) FROM flows f WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS flows,
       (SELECT count(*) FROM deployments d JOIN flows f ON f.id = d.flow_id WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS deployed,
       (SELECT count(*) FROM scripts s WHERE s.project_id = p.id) AS scripts
     FROM projects p WHERE p.workspace_id = $1 AND p.id = ANY($2::uuid[])`,
        [ctx.workspaceId, ids],
    );
    return new Map(
        rows.map(({ id, ...counts }) => [
            id,
            Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])) as ProjectSummary,
        ]),
    );
}

export class ListProjectsHandler implements UseCaseHandler<ListProjectsResponse> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ListProjectsResponse>> {
        const parsed = validate(ListProjectsQuery, input ?? {});
        if (!parsed.ok) {
            return parsed;
        }

        const repository = new ProjectRepository(ctx.db, ctx.workspaceId);
        const rows =
            parsed.value.status === 'active'
                ? await repository.findMany(undefined, { orderBy: desc(projects.createdAt) })
                : await repository.findDeleted(undefined, { orderBy: desc(projects.deletedAt) });

        const counts = await summaries(
            ctx,
            rows.map(r => r.id),
        );
        return success({ items: rows.map(row => ({ ...toProjectView(row), summary: counts.get(row.id) ?? EMPTY })) });
    }
}
