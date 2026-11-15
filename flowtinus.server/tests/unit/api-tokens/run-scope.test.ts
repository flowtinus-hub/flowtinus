import { expect, test } from 'bun:test';
import { inRunScope, readRunScope, runForRealCheck, RunScopeInput, type ScopeFolder } from '#features/api-tokens/run-scope';

/*
 * A token's run scope: what run_for_real may run through it. In the scope, it runs without the user's words; outside
 * it, never; a token without one needs the user's words every time.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const folders: ScopeFolder[] = [
    { id: id(1), parentId: null },
    { id: id(2), parentId: id(1) },
    { id: id(3), parentId: id(2) },
    { id: id(4), parentId: null },
];
const inLoad = { id: id(10), folderId: id(3), name: 'Load Page' };
const inOther = { id: id(11), folderId: id(4), name: 'Other' };
const atRoot = { id: id(12), folderId: null, name: 'Root' };

test('a folder takes its subfolders; a flow named is in, wherever it is', () => {
    const scope = { folders: [id(2)], flows: [atRoot.id] };
    expect(inRunScope(scope, inLoad, folders)).toBe(true);
    expect(inRunScope(scope, { id: id(13), folderId: id(2) }, folders)).toBe(true);
    expect(inRunScope(scope, atRoot, folders)).toBe(true);
    expect(inRunScope(scope, inOther, folders)).toBe(false);
    // the folder above is not in it
    expect(inRunScope(scope, { id: id(14), folderId: id(1) }, folders)).toBe(false);
    // a loop in the folders (never in a real tree) ends
    expect(inRunScope(scope, { id: id(15), folderId: id(5) }, [{ id: id(5), parentId: id(5) }])).toBe(false);
});

test('(a) a token with a run scope, a flow in it: runs without userApproval (one given is only logged)', () => {
    const scope = { folders: [id(2)], flows: [] };
    expect(runForRealCheck(scope, inLoad, folders, undefined)).toEqual({ ok: true, byScope: true });
    expect(runForRealCheck(scope, inLoad, folders, 'go ahead and run it')).toEqual({ ok: true, byScope: true });
});

test('(b) a token with a run scope, a flow outside it: refused, the user words or not', () => {
    const scope = { folders: [id(2)], flows: [atRoot.id] };
    for (const approval of [undefined, 'run Other for real']) {
        expect(runForRealCheck(scope, inOther, folders, approval)).toEqual({
            ok: false,
            code: 'forbidden',
            message: `This token may run for real only the folders ${id(2)} (and their subfolders) and the flows ${atRoot.id}: the flow "Other" (${inOther.id}) is outside its run scope. Use test_run, or ask the user to run it in the editor.`,
        });
    }
});

test('(c) a token without a run scope (every token made before): only with the user words, as before', () => {
    expect(runForRealCheck(null, inOther, folders, 'run Other for real')).toEqual({ ok: true, byScope: false });
    for (const approval of [undefined, '   ']) {
        expect(runForRealCheck(null, inOther, folders, approval)).toMatchObject({ ok: false, code: 'validation' });
    }
    expect(runForRealCheck(null, inOther, folders, undefined)).toMatchObject({
        message: expect.stringContaining('userApproval is required'),
    });
});

test('a stored scope: none is any flow; one that cannot be read lets nothing run; a new one names at least one folder or flow', () => {
    expect(readRunScope(null)).toBeNull();
    expect(readRunScope({ folders: [id(2)] })).toEqual({ folders: [id(2)], flows: [] });
    expect(readRunScope({ folders: ['not an id'] })).toEqual({ folders: [], flows: [] });
    expect(runForRealCheck(readRunScope('garbage'), inLoad, folders, 'go ahead and run it')).toMatchObject({
        ok: false,
        code: 'forbidden',
    });
    expect(RunScopeInput.safeParse({ folders: [], flows: [] }).success).toBe(false);
});
