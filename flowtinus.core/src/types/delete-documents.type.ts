import type { DocumentDelete } from '#types/document-delete.type';

export type DeleteDocuments = (request: DocumentDelete) => Promise<number>;
