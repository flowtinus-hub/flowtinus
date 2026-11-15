export type HttpRequest = {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
    signal: AbortSignal;
};
