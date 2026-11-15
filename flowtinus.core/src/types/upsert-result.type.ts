export type UpsertResult = { matched: number; upsertedId: string | null; modified?: number } | { error: string };
