import { Channel } from '../channel';

/**
 * Runs `run` for each item as it arrives, at most `limit` at once (the rest wait their turn, in arrival order), and
 * yields what all of them yield, interleaved as it comes. An error thrown by a run, or by `items`, is thrown here once
 * the runs already started have stopped. When the caller stops reading (it returns or throws), each run is told to
 * stop at its next result: what ends one sooner is the caller's to cancel (the run's Stop, its timeout).
 */
export async function* concurrently<T, R>(items: AsyncIterable<T>, limit: number, run: (item: T) => AsyncIterable<R>): AsyncGenerator<R> {
    const queue = new Channel<R>();
    let failure: { error: unknown } | undefined;
    let stopped = false;
    let running = 0;
    let wakeFeeder: (() => void) | undefined;
    const fail = (error: unknown) => {
        failure ??= { error };
        queue.abort();
    };
    const pour = async (item: T) => {
        try {
            for await (const result of run(item)) {
                if (stopped || failure) {
                    return;
                }
                await queue.send(result);
            }
        } finally {
            running -= 1;
            wakeFeeder?.();
        }
    };
    const feed = async () => {
        const pours: Promise<void>[] = [];
        for await (const item of items) {
            while (running >= limit) {
                await new Promise<void>(resolve => (wakeFeeder = resolve));
            }
            if (stopped || failure) {
                break;
            }
            running += 1;
            pours.push(pour(item).catch(fail));
        }
        await Promise.all(pours);
    };
    const feeding = feed()
        .catch(fail)
        .finally(() => queue.close());
    try {
        yield* queue;
        await feeding;
    } finally {
        stopped = true;
        queue.abort();
    }
    if (failure) {
        throw failure.error;
    }
}
