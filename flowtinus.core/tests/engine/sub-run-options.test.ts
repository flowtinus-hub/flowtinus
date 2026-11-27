import { expect, test } from 'bun:test';
import { subRunOptions } from '../../src/engine/sub-run-options';
import type { RunOptions } from '../../src/index';
import { evaluate } from '../helpers';

const parent: RunOptions = {
    mode: 'validation',
    id: 'parent',
    evaluate,
    loop: { id: 'loop', index: 2, reach: () => {} },
};
const signal = new AbortController().signal;
const onReachEnd = async () => {};
const call = {
    id: 'child',
    parameterValues: {},
    parentId: 'parent',
    chain: ['a', 'b'],
    rootName: 'A',
    input: undefined,
    onProgress: undefined,
};

test('a call without signal does not compile', () => {
    // @ts-expect-error
    subRunOptions(parent, 'call', { ...call, onReachEnd });
});

test("a call given the parent's loop does not compile, nor does the loop get through", () => {
    // @ts-expect-error
    const options = subRunOptions(parent, 'call', { ...call, signal, onReachEnd, loop: parent.loop });
    expect(options.loop).toBeUndefined();
});

test('an iteration given an id does not compile, nor does the id get through', () => {
    const loop = { id: 'loop', index: 0, reach: () => {} };
    // @ts-expect-error
    const options = subRunOptions(parent, 'iteration', { loop, signal, onReachEnd, onProgress: undefined, id: 'other' });
    expect(options.id).toBe('parent');
});
