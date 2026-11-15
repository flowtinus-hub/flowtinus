import { expect, test } from 'bun:test';
import { Stopwatch } from '../../src/engine/stopwatch';

const spin = (ms: number) => {
    const until = performance.now() + ms;
    while (performance.now() < until) {
        /* working */
    }
};

test("a component's waiting counts only while its own code is not running: a request in flight while it works is active time", () => {
    const active = new Stopwatch(true);
    const waiting = new Stopwatch();
    active.pairWaiting(waiting);
    const t0 = performance.now();

    active.resume();
    waiting.resume(); // the request goes out; the component goes on preparing the next one
    spin(20);
    active.stop(); // now it only waits
    spin(20);
    waiting.stop();
    active.resume();
    spin(5);
    active.stop();

    const elapsed = performance.now() - t0;
    expect(active.total).toBeGreaterThanOrEqual(25);
    expect(waiting.total).toBeGreaterThanOrEqual(20);
    expect(waiting.total).toBeLessThan(active.total);
    expect(active.total + waiting.total).toBeLessThanOrEqual(elapsed);
});

test('another component taking the thread stops the active stopwatch: the pending wait counts again', () => {
    const active = new Stopwatch(true);
    const waiting = new Stopwatch();
    active.pairWaiting(waiting);
    const other = new Stopwatch(true);

    active.resume();
    waiting.resume();
    expect(waiting.running).toBe(false);
    other.resume(); // another component's code runs: this one's request is still in flight
    expect(active.running).toBe(false);
    expect(waiting.running).toBe(true);
    other.stop();
    waiting.stop();
    expect(waiting.running).toBe(false);
});

test('a waiting stopwatch without a pair counts as before', () => {
    const waiting = new Stopwatch();
    waiting.resume();
    spin(5);
    waiting.stop();
    expect(waiting.total).toBeGreaterThanOrEqual(5);
});
