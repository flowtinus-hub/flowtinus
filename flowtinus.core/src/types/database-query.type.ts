export type DatabaseQuery = {
    connection: string;
    sql: string;
    parameters: Record<string, unknown>;
    timeoutMs: number;
    signal: AbortSignal;
};
