import type { DocumentQuery } from '#types/document-query.type';

export type AggregateDocuments = (query: DocumentQuery) => AsyncIterable<Record<string, unknown>>;
