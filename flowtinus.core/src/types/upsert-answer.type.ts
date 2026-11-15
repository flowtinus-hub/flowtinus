import type { UpsertResult } from '#types/upsert-result.type';

export type UpsertAnswer = { results: UpsertResult[]; modified: number };
