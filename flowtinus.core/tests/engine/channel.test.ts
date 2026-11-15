import { expect, test } from 'bun:test';
import { Channel } from '../../src/channel';
import { mergeSources } from '../../src/engine/merge-sources';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function* numbers(from: number, count: number) {
    for (let i = 0; i < count; i++) {
        yield from + i;
    }
}

test('Channel: several writers waiting for space are all released (none is forgotten)', async () => {
    const channel = new Channel<number>(1);
    await channel.send(0);
    // the queue is full: both wait for space
    const a = channel.send(1);
    const b = channel.send(2);
    await tick();

    const got: number[] = [];
    const reading = (async () => {
        for await (const n of channel) {
            got.push(n);
        }
    })();
    await Promise.all([a, b]);
    channel.close();
    await reading;
    expect(got.sort()).toEqual([0, 1, 2]);
});

test('Channel: abort releases every writer waiting for space', async () => {
    const channel = new Channel<number>(1);
    await channel.send(0);
    const writers = [channel.send(1), channel.send(2), channel.send(3)];
    await tick();
    channel.abort();
    await Promise.all(writers);
});

test('mergeSources: two fast sources into a slow reader deliver every envelope and end', async () => {
    const got: number[] = [];
    for await (const n of mergeSources([numbers(0, 500), numbers(1000, 500)] as never)) {
        got.push(n as unknown as number);
        if (got.length % 7 === 0) {
            await tick();
        }
    }
    expect(got.length).toBe(1000);
});
