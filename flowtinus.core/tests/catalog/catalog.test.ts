import { expect, test } from 'bun:test';
import { COMPONENTS } from '../../src/components';
import { buildCatalog, catalogComponents, COMPONENT_CATEGORIES } from '../../src/catalog/catalog';
import { checkFlowYaml } from '#validation/flow-issues';
import { CONNECTION_TYPES } from '../../src/connections/types/connection-types';

test('every component describes itself: a label, a category and 1 to 3 lines of description', () => {
    const categories = COMPONENT_CATEGORIES.map(c => c.category);
    for (const logic of Object.values(COMPONENTS)) {
        expect(logic.label.trim(), logic.type).not.toBe('');
        expect(categories, logic.type).toContain(logic.category);
        expect(logic.description.trim().length, logic.type).toBeGreaterThan(30);
        expect(logic.description.length, logic.type).toBeLessThan(600);
    }
});

test("every component's example passes its own validate()", () => {
    for (const logic of Object.values(COMPONENTS)) {
        expect(logic.example, logic.type).toBeDefined();
        expect(logic.validate(logic.example!), logic.type).toEqual([]);
    }
});

test('every connection type says what it is for', () => {
    for (const type of CONNECTION_TYPES) {
        expect(type.description?.trim(), type.type).toBeTruthy();
    }
});

test('the catalog: components in palette order, ports, side effects, settings', () => {
    const components = catalogComponents();
    expect(components.map(c => c.type).sort()).toEqual(Object.keys(COMPONENTS).sort());
    const order = COMPONENT_CATEGORIES.map(c => c.category);
    const ranks = components.map(c => order.indexOf(c.category));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const filter = components.find(c => c.type === 'filter')!;
    expect(filter.inputs).toEqual([{ id: 'in-0' }]);
    expect(filter.outputs).toEqual([
        { id: 'out-0', label: 'true' },
        { id: 'out-1', label: 'false', optional: true },
    ]);
    expect(filter.sideEffects).toBe(false);
    expect(components.find(c => c.type === 'mongodb-upsert')!.sideEffects).toBe(true);
    expect(components.find(c => c.type === 'http-request')!.sideEffects).toBe('depends on config');
    expect(components.find(c => c.type === 'lookup')!.inputs.every(p => p.single)).toBe(true);
    expect(components.find(c => c.type === 'router')!.portsFromConfig).toContain('else');
    expect(components.find(c => c.type === 'flow')!.fixedOnError).toContain('throw');
});

test('the whole catalog is plain JSON: the MCP serves it as is', () => {
    const catalog = buildCatalog();
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
    expect(catalog.connectionTypes.find(t => t.type === 'sqlserver')!.fields.find(f => f.key === 'password')!.secret).toBe(true);
    expect(catalog.rules.length).toBeGreaterThan(5);
});

test("the flow file's annotated example is a valid flow (only its connection ids are placeholders)", () => {
    const check = checkFlowYaml(buildCatalog().flowFile.example);
    expect(check.issues).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.warnings).toEqual([]);
});

test('the patterns name only components that exist; the barrier is a Wait, or a Limit Last 1', () => {
    const { patterns } = buildCatalog();
    expect(patterns.length).toBeGreaterThanOrEqual(3);
    const text = patterns.flatMap(p => [p.name, p.when, ...p.steps]).join('\n');
    expect(text).toContain('Use a Wait.');
    expect(text).toContain('Limit with mode `bottom` (Last) and count 1');
    for (const label of ['Wait', 'Limit', 'SQL Server Update', 'Flow Invoker', 'Router']) {
        expect(catalogComponents().some(c => c.label === label)).toBe(true);
    }
    expect(COMPONENTS.limit.description).toContain('Last 1 is a barrier');
});
