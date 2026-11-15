export type QueueFlowRequest = {
    flowId: string;
    parameters: Record<string, string>;
    input?: unknown;
    chain: string[];
    rootName: string;
    nodeId: string;
    nodeLabel: string;
};

export type QueueFlow = (request: QueueFlowRequest) => Promise<{ id: string }>;
