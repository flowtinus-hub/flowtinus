import { expect, test } from 'bun:test';
import { variableOfName } from '#features/mcp/tools/set-variable';

/* set_variable: a name that exists (ignoring case, as the names' rule says) is updated; another one is created. */

test('the variable a name is: the same name ignoring case and spaces around it, or none (a new one)', () => {
    const variables = [
        { id: 'a', name: 'dw_tenant_prefix' },
        { id: 'b', name: 'DW_Source_Database' },
    ];
    expect(variableOfName(variables, 'dw_tenant_prefix')?.id).toBe('a');
    expect(variableOfName(variables, ' DW_TENANT_PREFIX ')?.id).toBe('a');
    expect(variableOfName(variables, 'dw_source_database')?.id).toBe('b');
    expect(variableOfName(variables, 'dw_lake_database')).toBeUndefined();
    expect(variableOfName([], 'x')).toBeUndefined();
});
