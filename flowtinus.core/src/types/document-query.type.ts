export type DocumentQuery = {
    connection: string;
    database: string;
    collection: string;
    pipeline: Record<string, unknown>[];
    /** canonical Extended JSON preserves BSON types; omitted means the existing plain JSON representation */
    outputFormat?: 'extended-json';
    timeoutMs: number;
    signal: AbortSignal;
};
