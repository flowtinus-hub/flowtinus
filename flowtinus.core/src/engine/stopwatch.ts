/**
 * Time of a component, started and stopped by the engine. An active stopwatch (`exclusive`) is the component's own work:
 * it starts when its code runs again (the engine asked for the next result, an envelope arrived) and stops when it is
 * waiting (input, next component, ctx.wait). There is a single thread, so only one component's code runs at a time:
 * starting an active stopwatch stops the one that was running, in any run of the process, and the components' active
 * times add up to no more than the time that passed. Without that, the time other components ran in between (between
 * a `yield` and the engine taking the result) counted for every component that had its stopwatch on, more for those in
 * the middle of a flow. A waiting stopwatch (waits on databases, APIs, called flows) is not exclusive: waits overlap.
 *
 * A component's waiting, paired with its active stopwatch (`pairWaiting`), counts only while the component's own code
 * is not running: an HTTP Request prepares its next request while one is in flight, and that time is active, not
 * waiting too. So a component's active + waiting never pass its open time.
 */
export class Stopwatch {
    private static current?: Stopwatch;
    total = 0;
    firstAt?: number;
    private since?: number;
    /** waiting: something outside is pending (it counts whenever its component's code is not running) */
    private wanted = false;
    /** active: its component's waiting; waiting: its component's active stopwatch */
    private pair?: Stopwatch;

    constructor(private readonly exclusive = false) {}

    /** pairs a component's active stopwatch (this) with its waiting */
    pairWaiting(waiting: Stopwatch) {
        this.pair = waiting;
        waiting.pair = this;
    }

    get running() {
        return this.since !== undefined;
    }

    resume() {
        if (this.exclusive) {
            if (Stopwatch.current !== this) {
                Stopwatch.current?.stop();
                Stopwatch.current = this;
            }
            this.start();
            this.pair?.pause();
            return;
        }

        this.wanted = true;
        if (!this.pair?.running) {
            this.start();
        }
    }

    stop() {
        if (this.exclusive) {
            if (Stopwatch.current === this) {
                Stopwatch.current = undefined;
            }
            this.pause();
            if (this.pair?.wanted) {
                this.pair.start();
            }
            return;
        }

        this.wanted = false;
        this.pause();
    }

    private start() {
        this.since ??= performance.now();
        this.firstAt ??= this.since;
    }

    private pause() {
        if (this.since === undefined) {
            return;
        }

        this.total += performance.now() - this.since;
        this.since = undefined;
    }
}

export async function* timed<T>(source: AsyncIterable<T>, stopwatch: Stopwatch): AsyncIterable<T> {
    const it = source[Symbol.asyncIterator]();
    try {
        while (true) {
            stopwatch.stop();

            const r = await it.next();
            if (r.done) {
                return;
            }

            stopwatch.resume();

            yield r.value;
        }
    } finally {
        await it.return?.();
    }
}

export async function* timedRequests<T>(source: AsyncIterable<T>, stopwatch: Stopwatch): AsyncIterable<T> {
    const it = source[Symbol.asyncIterator]();
    try {
        while (true) {
            stopwatch.resume();
            const r = await it.next();
            stopwatch.stop();

            if (r.done) {
                return;
            }

            yield r.value;
        }
    } finally {
        await it.return?.();
    }
}
