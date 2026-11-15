import { and, eq, isNotNull, isNull, type InferInsertModel, type InferSelectModel, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgInsertValue, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Database } from './database';

/**
 * a table with id and workspace_id; with deleted_at/deleted_by it is soft deleted (archived); with removed_at, a row removed
 * after that is left out of every query, the deleted ones included
 */
export type WorkspaceTable = PgTable & {
    id: AnyPgColumn;
    workspaceId: AnyPgColumn;
    deletedAt?: AnyPgColumn;
    deletedBy?: AnyPgColumn;
    removedAt?: AnyPgColumn;
};

export type FindOptions = {
    orderBy?: SQL | AnyPgColumn | (SQL | AnyPgColumn)[];
    limit?: number;
};

type Rows = 'live' | 'deleted' | 'all';

/**
 * The rows of ONE workspace: the workspaceId comes in the constructor, every query filters by it and every insert writes
 * it, so a repository built for org A cannot see or change org B's rows. Deleted rows are left out.
 */
export class WorkspaceRepository<TTable extends WorkspaceTable> {
    constructor(
        protected readonly db: Database,
        protected readonly table: TTable,
        protected readonly workspaceId: string,
    ) {}

    async insert(values: Omit<InferInsertModel<TTable>, 'workspaceId'>): Promise<InferSelectModel<TTable>> {
        const rows = await this.db.orm
            .insert(this.table)
            .values({ ...values, workspaceId: this.workspaceId } as PgInsertValue<TTable>)
            .returning();

        return (rows as InferSelectModel<TTable>[])[0]!;
    }

    async findById(id: string): Promise<InferSelectModel<TTable> | null> {
        const [row] = await this.findMany(eq(this.table.id, id), { limit: 1 });
        return row ?? null;
    }

    async findOne(where: SQL): Promise<InferSelectModel<TTable> | null> {
        const [row] = await this.findMany(where, { limit: 1 });
        return row ?? null;
    }

    async findMany(where?: SQL, options: FindOptions = {}): Promise<InferSelectModel<TTable>[]> {
        return this.select('live', where, options);
    }

    async findDeleted(where?: SQL, options: FindOptions = {}): Promise<InferSelectModel<TTable>[]> {
        return this.select('deleted', where, options);
    }

    async findAll(where?: SQL, options: FindOptions = {}): Promise<InferSelectModel<TTable>[]> {
        return this.select('all', where, options);
    }

    private async select(rows: Rows, where: SQL | undefined, options: FindOptions): Promise<InferSelectModel<TTable>[]> {
        if (rows === 'deleted' && !this.table.deletedAt) {
            return [];
        }

        const query = this.db.orm
            .select()
            .from(this.table as PgTable)
            .where(this.scope(where, rows))
            .$dynamic();
        if (options.orderBy) {
            query.orderBy(...[options.orderBy].flat());
        }

        if (options.limit !== undefined) {
            query.limit(options.limit);
        }

        return (await query) as InferSelectModel<TTable>[];
    }

    async exists(where: SQL): Promise<boolean> {
        const rows = await this.db.orm
            .select({ id: this.table.id })
            .from(this.table as PgTable)
            .where(this.scope(where))
            .limit(1);
        return rows.length > 0;
    }

    async update(
        id: string,
        values: Partial<Omit<InferInsertModel<TTable>, 'id' | 'workspaceId'>>,
    ): Promise<InferSelectModel<TTable> | null> {
        const rows = await this.db.orm
            .update(this.table)
            .set(values as PgUpdateSetSource<TTable>)
            .where(this.scope(eq(this.table.id, id)))
            .returning();

        return (rows as InferSelectModel<TTable>[])[0] ?? null;
    }

    async softDelete(id: string, by: string): Promise<boolean> {
        if (!this.table.deletedAt || !this.table.deletedBy) {
            throw new Error('This table has no soft delete.');
        }

        const rows = await this.db.orm
            .update(this.table)
            .set({ deletedAt: new Date(), deletedBy: by } as PgUpdateSetSource<TTable>)
            .where(this.scope(eq(this.table.id, id)))
            .returning({ id: this.table.id });

        return rows.length > 0;
    }

    async remove(id: string): Promise<boolean> {
        const rows = await this.db.orm
            .delete(this.table)
            .where(this.scope(eq(this.table.id, id), 'all'))
            .returning({ id: this.table.id });

        return rows.length > 0;
    }

    async restore(id: string): Promise<InferSelectModel<TTable> | null> {
        if (!this.table.deletedAt || !this.table.deletedBy) {
            throw new Error('This table has no soft delete.');
        }

        const rows = await this.db.orm
            .update(this.table)
            .set({ deletedAt: null, deletedBy: null } as PgUpdateSetSource<TTable>)
            .where(this.scope(eq(this.table.id, id), 'deleted'))
            .returning();

        return (rows as InferSelectModel<TTable>[])[0] ?? null;
    }

    protected scope(where?: SQL, rows: Rows = 'live'): SQL {
        const deletedAt = this.table.deletedAt;
        const removedAt = this.table.removedAt;
        return and(
            eq(this.table.workspaceId, this.workspaceId),
            removedAt ? isNull(removedAt) : undefined,
            deletedAt && rows !== 'all' ? (rows === 'live' ? isNull(deletedAt) : isNotNull(deletedAt)) : undefined,
            where,
        )!;
    }
}
