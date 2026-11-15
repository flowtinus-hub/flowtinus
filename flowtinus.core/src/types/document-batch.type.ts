import type { DocumentUpsert } from '#types/document-upsert.type';

export type DocumentBatch = {
    connection: string;
    database: string;
    collection: string;
    upserts: DocumentUpsert[];
    /** interpret canonical Extended JSON as its original BSON types */
    valueFormat?: 'extended-json';
    /** replace the entire matched document instead of setting its supplied fields */
    writeMode?: 'replace';
    signal: AbortSignal;
};
