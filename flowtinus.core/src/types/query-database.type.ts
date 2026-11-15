import type { DatabaseQuery } from '#types/database-query.type';

export type QueryDatabase = (query: DatabaseQuery) => AsyncIterable<Record<string, unknown>>;
