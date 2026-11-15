import { COMPONENT_TYPE } from '#components/component-types';
import { mergeFields } from '#envelope/envelope-data';
import { nameIssue } from '#validation/key-name';
import type { ComponentLogic } from '#types/component-logic.type';
import type { ParameterType } from '#types/parameter.type';

export type DataGridColumn = { name: string; type: ParameterType };

export function dataGridConfig(config: Record<string, unknown>) {
    const columns = Array.isArray(config.columns) ? (config.columns as DataGridColumn[]) : [];
    const rows = Array.isArray(config.rows) ? (config.rows as string[][]) : [];
    return { columns, rows };
}

const TRUE_VALUES = ['true', 'yes', 'y', '1'];
const FALSE_VALUES = ['false', 'no', 'n', '0'];

export function cellValue(text: string | undefined, type: ParameterType): unknown {
    const t = (text ?? '').trim();
    if (t === '') {
        return null;
    }
    if (type === 'number') {
        // accepts a decimal comma (pasted from a spreadsheet in a comma locale); thousands separators are not accepted
        const n = Number(t.replace(',', '.'));
        return Number.isFinite(n) ? n : undefined;
    }
    if (type === 'boolean') {
        const v = t.toLowerCase();
        return TRUE_VALUES.includes(v) ? true : FALSE_VALUES.includes(v) ? false : undefined;
    }
    return text;
}

export const datagrid: ComponentLogic = {
    type: COMPONENT_TYPE.datagrid,
    label: 'Data Grid',
    category: 'transformation',
    description:
        "A table typed into the component: for each incoming envelope (usually the Start's only one) yields one envelope per row, the columns written into DATA (Override: only the columns). Cells are text converted by the column type (text, number, boolean); an empty cell is null. Good for mappings (into a Lookup's lookup input) and test data.",
    example: {
        columns: [
            { name: 'code', type: 'text' },
            { name: 'rate', type: 'number' },
        ],
        rows: [
            ['BR', '0.17'],
            ['US', '0.07'],
        ],
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    settings: [
        {
            key: 'columns',
            label: 'Data',
            kind: 'grid',
            required: true,
            options: [
                { value: 'text', label: 'Text' },
                { value: 'number', label: 'Number' },
                {
                    value: 'boolean',
                    label: 'Boolean',
                },
            ],
        },
    ],

    validate(config) {
        const { columns, rows } = dataGridConfig(config);
        if (columns.length === 0) {
            return ['has no columns.'];
        }
        const issues: string[] = [];
        const seen = new Set<string>();
        columns.forEach((c, i) => {
            const issue = nameIssue(c.name);
            if (issue) {
                issues.push(`column ${i + 1} ${issue}.`);
            } else if (seen.has(c.name)) {
                issues.push(`has the column "${c.name}" more than once.`);
            }
            seen.add(c.name);
        });

        if (rows.length === 0) {
            issues.push('has no rows.');
        }

        rows.forEach((row, i) =>
            columns.forEach((c, j) => {
                if (cellValue(row[j], c.type) !== undefined) {
                    return;
                }
                issues.push(
                    `row ${i + 1}, column "${c.name || j + 1}": "${row[j]}" is not a ${c.type === 'number' ? 'number' : 'boolean'}.`,
                );
            }),
        );

        return issues;
    },

    async *execute(inputs, config, ctx) {
        const { columns, rows } = dataGridConfig(config);
        const records = rows.map(row => Object.fromEntries(columns.map((c, j) => [c.name, cellValue(row[j], c.type) ?? null])));
        let received = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            received += 1;
            for (const record of records) {
                yield { port: 'out-0', doc: mergeFields(doc, record, ctx.node.override) };
            }
        }
        ctx.log('debug', `${records.length} row(s) yielded for ${received} input envelope(s).`);
    },
};
