import type { DocumentBatch } from '#types/document-batch.type';
import type { UpsertAnswer } from '#types/upsert-answer.type';

export type UpsertDocuments = (batch: DocumentBatch) => Promise<UpsertAnswer>;
