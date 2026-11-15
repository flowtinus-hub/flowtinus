import type { Envelope } from '#types/envelope.type';

export type ComponentOutput = { port: string; doc: Envelope } | { error: Error; doc: Envelope };
