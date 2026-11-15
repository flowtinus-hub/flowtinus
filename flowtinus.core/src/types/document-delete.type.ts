export type DocumentDelete = {
    connection: string;
    database: string;
    collection: string;
    filter: Record<string, unknown>;
    countOnly?: boolean;
    signal: AbortSignal;
};
