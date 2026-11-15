export type SqlExecute = {
    connection: string;
    sql: string;
    parameters: Record<string, unknown>;
    atEnd: 'commit' | 'rollback';
    timeoutMs: number;
    signal: AbortSignal;
};

export type SqlExecuteAnswer = {
    rowsAffected: number;
    rows: Record<string, unknown>[];
    transaction: 'committed' | 'rolledBack' | 'sql';
};

export type ExecuteSql = (execute: SqlExecute) => Promise<SqlExecuteAnswer>;
