import { expect, test } from 'bun:test';
import { API_SCOPE_INFO, API_SCOPES } from '#features/api-tokens/api-tokens';
import { CreateApiTokenCommand, MAX_TOKEN_DAYS } from '#features/api-tokens/manage-tokens/api-tokens-handlers';

/* What a new token (the Access tokens page) must be: checked before anything is stored. */

const folder = '00000000-0000-4000-8000-000000000001';

const issues = (input: unknown) => {
    const parsed = CreateApiTokenCommand.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
};

test('a name and at least one scope; the scopes once each', () => {
    expect(CreateApiTokenCommand.parse({ name: ' Agent ', scopes: ['flows:read', 'flows:read', 'runs:test'] })).toEqual({
        name: 'Agent',
        scopes: ['flows:read', 'runs:test'],
    });
    expect(issues({ name: '  ', scopes: ['flows:read'] })).toEqual(['name: Required']);
    expect(issues({ name: 'Agent', scopes: [] })).toEqual(['scopes: Pick at least one scope']);
    expect(issues({ name: 'Agent', scopes: ['flows:delete'] })[0]).toStartWith('scopes.0:');
});

test('a run scope: only with runs:execute, at least one folder or flow, ids only', () => {
    expect(issues({ name: 'Agent', scopes: ['runs:execute'], runScope: { folders: [folder] } })).toEqual([]);
    expect(issues({ name: 'Agent', scopes: ['runs:test'], runScope: { folders: [folder] } })).toEqual([
        'runScope: A run scope needs the scope runs:execute.',
    ]);
    expect(issues({ name: 'Agent', scopes: ['runs:execute'], runScope: { folders: [], flows: [] } })).toEqual([
        'runScope: A run scope names at least one folder or flow.',
    ]);
    expect(issues({ name: 'Agent', scopes: ['runs:execute'], runScope: { flows: ['not an id'] } })[0]).toStartWith('runScope.flows.0:');
    // none: any flow, each run with the user's approval
    expect(issues({ name: 'Agent', scopes: ['runs:execute'], runScope: null })).toEqual([]);
});

test('how long it lasts: none (until revoked) or 1 to MAX_TOKEN_DAYS days', () => {
    expect(issues({ name: 'Agent', scopes: ['flows:read'], expiresInDays: 90 })).toEqual([]);
    expect(issues({ name: 'Agent', scopes: ['flows:read'], expiresInDays: 0 })).toHaveLength(1);
    expect(issues({ name: 'Agent', scopes: ['flows:read'], expiresInDays: MAX_TOKEN_DAYS + 1 })).toHaveLength(1);
});

test('every scope says what it allows', () => {
    for (const scope of API_SCOPES) {
        expect(API_SCOPE_INFO[scope].length, scope).toBeGreaterThan(10);
    }
});
