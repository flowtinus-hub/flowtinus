import { inArray } from 'drizzle-orm';
import type { Database } from '#shared/database/database';
import { users } from './user';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withUpdatedByName<T extends { updatedBy: string | null }>(
    db: Database,
    rows: T[],
): Promise<(T & { updatedByName?: string })[]> {
    const ids = [...new Set(rows.map(r => r.updatedBy).filter((id): id is string => !!id && UUID.test(id)))];
    if (ids.length === 0) {
        return rows;
    }

    const found = await db.orm.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    const names = new Map(found.map(u => [u.id, u.name]));
    return rows.map(row => {
        const name = row.updatedBy ? names.get(row.updatedBy) : undefined;
        return name ? { ...row, updatedByName: name } : row;
    });
}
