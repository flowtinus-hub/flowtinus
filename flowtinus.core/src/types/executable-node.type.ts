import type { EnvelopeData } from '#types/envelope-data.type';

export type ExecutableNode = {
    id: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
    outputKey?: string;
    override?: boolean;
    disabled?: boolean;
    pinned?: Record<string, EnvelopeData[]>;
    loop?: string;
};
