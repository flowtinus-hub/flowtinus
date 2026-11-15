import { mulberry32 } from '#fake-api/random';

export const DATA_VERSION = 1;

/** how many input envelopes: each runs a loop of its own, so `size` iterations in all are split among them */
export const LOOPS = 100;

export type LoopState = { id: number; iterations: number; page: number; total: number; filters: Record<string, string> };

/**
 * The loop state of each input envelope: how many iterations it runs (the stop condition reads it), a page counter and a
 * total that every iteration moves on (Continue with), and some filters it only carries along, so each iteration's copy
 * of the state is a few hundred bytes, as a paging loop's (a cursor, a window, its filters) would be.
 */
export function loopStates(size: number, seed: number): LoopState[] {
    const random = mulberry32(seed);
    const iterations = Math.max(1, Math.ceil(size / LOOPS));
    return Array.from({ length: LOOPS }, (_, i) => ({
        id: i + 1,
        iterations,
        page: 0,
        total: 0,
        filters: Object.fromEntries(Array.from({ length: 10 }, (_, f) => [`field${f}`, `value ${Math.floor(random() * 1_000_000)}`])),
    }));
}
