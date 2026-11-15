/** Async queue between two ports: the writer waits while the queue is full (backpressure). */
export class Channel<T> implements AsyncIterable<T> {
    private readonly items: T[] = [];

    private isClosed = false;
    private waitingForItemFn: (() => void) | null = null;
    /** every writer waiting for space (several write into one channel when a port takes several edges: mergeSources) */
    private readonly waitingForSpace: (() => void)[] = [];

    constructor(private readonly capacity = 64) {}

    private aborted = false;

    async send(item: T): Promise<void> {
        if (this.aborted) {
            return;
        }

        while (this.items.length >= this.capacity) {
            if (this.aborted) {
                return;
            }

            await new Promise<void>(resolve => this.waitingForSpace.push(resolve));
        }

        this.items.push(item);
        this.wake();
    }

    close() {
        this.isClosed = true;
        this.wake();
    }

    abort() {
        this.aborted = true;
        this.items.length = 0;

        this.close();

        for (const resolveFunction of this.waitingForSpace.splice(0)) {
            resolveFunction();
        }
    }

    private wake() {
        const resolveFunction = this.waitingForItemFn;
        this.waitingForItemFn = null;
        resolveFunction?.();
    }

    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        while (true) {
            if (this.items.length > 0) {
                const item = this.items.shift()!;
                this.waitingForSpace.shift()?.();

                yield item;

                continue;
            }

            if (this.isClosed) {
                return;
            }

            await new Promise<void>(resolve => (this.waitingForItemFn = resolve));
        }
    }
}

export async function* empty<T>(): AsyncIterable<T> {}
