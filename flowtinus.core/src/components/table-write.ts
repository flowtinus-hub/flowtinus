import { connectionIssues, connectionSettings } from '../connections/connection-access';
import { runConnection } from './run-connection';
import { toError } from '#errors/normalize-error';
import { withKey } from '#envelope/envelope-data';
import type { ComponentLogic } from '#types/component-logic.type';
import type { DatabaseKind } from '#types/database-kind.type';
import type { Envelope } from '#types/envelope.type';
import type { ExpressionField } from '#types/expression-field.type';
import type { RowWriteMode } from '#types/row-write.type';
import type { SettingField } from '#types/setting-field.type';
import { nameField } from './sql-identifiers';

/*
 * The components that write rows into a database table (Redshift Insert, Upsert and Delete, SQL Server Insert, Update
 * and Delete): each envelope
 * becomes a row, its columns a value or an expression on the envelope each. The rows go in batches, each batch in one
 * transaction: all of it, or none (a batch that fails sends each of its envelopes to the error policy).
 *
 * - insert: adds the rows;
 * - upsert: finds the row by its Match on columns, updates it or inserts it; in a batch the last of the envelopes with
 *   the same match values wins (the earlier ones go on as `superseded`);
 * - update: finds the rows by the Match on columns (and, optionally, Expected values: more WHERE conditions with values
 *   of their own, for a compare-and-set) and sets the other columns; none found is `notFound`, or an error with If no
 *   row matches on Error.
 * - delete: deletes the rows whose columns all equal the envelope's values (every column is a condition, so there is no
 *   Match on: the Columns are it); a value that is null or undefined is refused (an error for that envelope), so a
 *   missing key never deletes more than meant; none found is `notFound`, or an error with If no row matches on Error.
 *
 * The table is a fixed name or an expression on each envelope (a tenant's schema: `$tenant + '.briefs'`), its result
 * checked like a fixed one (an invalid name is an error of that envelope). The envelopes go in batches of one table: a
 * batch is sent when the next envelope's table is another (envelopes sorted by table make full batches), each batch
 * in one transaction of its own. The last log line and the record's `writes` (ctx.wrote) say what happened per table.
 *
 * Each envelope goes on with `{action}` in its output key (and `{rows}`, how many rows it changed, for an update or a delete). In a
 * test run nothing is written (the engine's gate for `sideEffects`): the log shows what would be sent, and the
 * envelopes go on with `{notSent: true}`.
 */

export type TableColumn = ExpressionField & { column: string };

export const DEFAULT_WRITE_BATCH_SIZE = 500;
export const MAX_WRITE_BATCH_SIZE = 5000;
export const DEFAULT_WRITE_TIMEOUT_S = 300;

/** a table or column name, written into the SQL as it is: letters, digits, _ and $ (no quotes, so nothing to escape) */
const NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function tableNameIssue(table: string): string | null {
    const parts = table.trim().split('.');
    if (!table.trim()) {
        return 'has no table';
    }
    return parts.length > 2 || !parts.every(p => NAME.test(p))
        ? `has the table "${table}", which is not a valid name (schema.table: letters, digits, _ and $)`
        : null;
}

export function tableWriteConfig(config: Record<string, unknown>) {
    const number = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
        const n = Math.round(Number(value ?? fallback));
        return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
    };
    return {
        tableField: nameField(config.table),
        table: nameField(config.table).value.trim(),
        columns: Array.isArray(config.columns) ? (config.columns as TableColumn[]) : [],
        match: Array.isArray(config.match) ? (config.match as unknown[]).map(m => String(m ?? '').trim()) : [],
        conditions: Array.isArray(config.conditions) ? (config.conditions as TableColumn[]) : [],
        ifNotFound: config.ifNotFound === 'error' ? ('error' as const) : ('continue' as const),
        batchSize: number(config.batchSize, DEFAULT_WRITE_BATCH_SIZE, MAX_WRITE_BATCH_SIZE),
        timeoutS: number(config.timeoutS, DEFAULT_WRITE_TIMEOUT_S),
    };
}

function columnValue(value: unknown): unknown {
    if (value === undefined) {
        return null;
    }
    if (value instanceof Date || value === null || typeof value !== 'object') {
        return value;
    }
    return JSON.stringify(value);
}

function settings(kind: DatabaseKind, mode: RowWriteMode): SettingField[] {
    return [
        ...connectionSettings(kind),
        {
            key: 'table',
            label: 'Table',
            kind: 'value',
            required: true,
            default: { value: '', expression: false },
            description:
                'schema.table or table; with fx, an expression on the envelope (e.g. $tenant + ".customers"), its result checked the same way. A batch is one table: an envelope whose table is another closes the batch (envelopes sorted by table, e.g. a Sort before it, make full batches instead of small ones), and each batch is atomic on its own (all or none of that batch, never of the run). The last log line says what happened per table.',
            placeholder: kind === 'sqlserver' ? 'dbo.Customer' : 'sales.customers',
        },
        {
            key: 'columns',
            label: mode === 'update' ? 'Columns (the Match on ones and those it sets)' : mode === 'delete' ? 'Match on' : 'Columns',
            kind: 'list',
            itemLabel: 'column',
            required: true,
            ...(mode === 'delete'
                ? {
                      description:
                          'The rows deleted are those whose columns all equal these values (WHERE column = value AND ...). A value that is null or undefined is an error for that envelope: nothing is deleted.',
                  }
                : {}),
            item: [
                { key: 'column', label: 'Column', kind: 'text', required: true, placeholder: 'email' },
                {
                    key: 'value',
                    label: 'Value',
                    kind: 'value',
                    spread: true,
                    default: { value: '', expression: true },
                    placeholder: '$email',
                },
            ],
        },
        ...(mode === 'insert' || mode === 'delete'
            ? []
            : [
                  {
                      key: 'match',
                      label: 'Match on',
                      kind: 'list',
                      itemLabel: 'column',
                      flat: true,
                      required: true,
                      description:
                          mode === 'upsert'
                              ? 'The columns that find the row to update (among the Columns); no match: the row is inserted.'
                              : 'The columns that find the rows to update (among the Columns, their values the WHERE); the other Columns are set.',
                      item: [{ key: 'column', label: 'Column', kind: 'text', required: true, placeholder: 'id' }],
                  } satisfies SettingField,
              ]),
        ...(kind === 'sqlserver' && mode === 'update'
            ? [
                  {
                      key: 'conditions',
                      label: 'Expected values (optional)',
                      kind: 'list',
                      itemLabel: 'column',
                      description:
                          'More WHERE conditions, each column = its own value (null matches null), apart from the values set: compare-and-set, e.g. set Version = $version + 1 only where Version = $version.',
                      item: [
                          { key: 'column', label: 'Column', kind: 'text', required: true },
                          {
                              key: 'value',
                              label: 'Expected value',
                              kind: 'value',
                              spread: true,
                              default: { value: '', expression: true },
                          },
                      ],
                  } satisfies SettingField,
              ]
            : []),
        ...((kind === 'sqlserver' && mode === 'update') || mode === 'delete'
            ? [
                  {
                      key: 'ifNotFound',
                      label: 'If no row matches',
                      kind: 'select',
                      default: 'continue',
                      description:
                          mode === 'delete'
                              ? 'Continue: the envelope goes on with {action: "notFound"}. Error: it goes to the On error policy.'
                              : 'Continue: the envelope goes on with {action: "notFound"}. Error: it goes to the On error policy (e.g. a compare-and-set that lost to another run).',
                      options: [
                          { value: 'continue', label: 'Continue (notFound)' },
                          { value: 'error', label: 'Error' },
                      ],
                  } satisfies SettingField,
              ]
            : []),
        {
            key: 'batchSize',
            label: 'Batch size',
            kind: 'number',
            default: DEFAULT_WRITE_BATCH_SIZE,
            min: 1,
            max: MAX_WRITE_BATCH_SIZE,
            description: 'The most rows per batch (one transaction); an envelope of another table closes the batch before that.',
        },
        { key: 'timeoutS', label: 'Timeout (seconds)', kind: 'number', default: DEFAULT_WRITE_TIMEOUT_S, min: 1 },
    ];
}

function validate(kind: DatabaseKind, mode: RowWriteMode, config: Record<string, unknown>): string[] {
    const { table, tableField, columns, match, conditions } = tableWriteConfig(config);
    const issues: string[] = [...connectionIssues(kind, config)];
    const tableIssue = tableField.expression ? (table ? null : 'has no table expression') : tableNameIssue(table);
    if (tableIssue) {
        issues.push(`${tableIssue}.`);
    }
    if (columns.length === 0) {
        issues.push(mode === 'delete' ? 'has no Match on column (what finds the rows to delete).' : 'has no columns.');
    }
    const names = new Set<string>();
    columns.forEach((c, i) => {
        const name = (c.column ?? '').trim();
        if (!name) {
            issues.push(`column ${i + 1} has no name.`);
        } else if (!NAME.test(name)) {
            issues.push(`column "${name}" is not a valid name (letters, digits, _ and $).`);
        } else if (names.has(name.toLowerCase())) {
            issues.push(`has the column "${name}" more than once.`);
        }
        names.add(name.toLowerCase());
        if (c.expression && !(c.value ?? '').trim()) {
            issues.push(`column "${name || i + 1}" is an expression, but empty.`);
        }
    });
    if (mode === 'upsert' || mode === 'update') {
        if (match.length === 0) {
            issues.push(`has no Match on column (what finds the row${mode === 'update' ? 's' : ''} to update).`);
        }
        if (kind === 'sqlserver' && mode === 'update') {
            if (config.conditions !== undefined && !Array.isArray(config.conditions)) {
                issues.push('expected values must be a list.');
            }
            const seen = new Set<string>();
            conditions.forEach((condition, i) => {
                const name = (condition.column ?? '').trim();
                if (!NAME.test(name)) {
                    issues.push(`expected column ${i + 1} is not a valid name.`);
                } else if (seen.has(name.toLowerCase())) {
                    issues.push(`has the expected column "${name}" more than once.`);
                }
                seen.add(name.toLowerCase());
                if (condition.expression && !(condition.value ?? '').trim()) {
                    issues.push(`expected column "${name}" is an expression, but empty.`);
                }
            });
        }
        const seen = new Set<string>();
        for (const m of match) {
            if (!m) {
                issues.push('has an empty Match on column.');
            } else if (!names.has(m.toLowerCase())) {
                issues.push(`matches on "${m}", which is not one of its columns.`);
            } else if (seen.has(m.toLowerCase())) {
                issues.push(`matches on "${m}" more than once.`);
            }
            seen.add(m.toLowerCase());
        }
        if (match.length > 0 && columns.length > 0 && match.length >= columns.length) {
            issues.push(`matches on every column: there is nothing to update${mode === 'upsert' ? ' (use an Insert)' : ''}.`);
        }
    }
    return issues;
}

export type TableCounts = {
    inserted: number;
    updated: number;
    superseded: number;
    deleted: number;
    notFound: number;
    failed: number;
    /** a test run: rows made, none sent */
    prepared: number;
};

const noCounts = (): TableCounts => ({ inserted: 0, updated: 0, superseded: 0, deleted: 0, notFound: 0, failed: 0, prepared: 0 });

export function describeTableCounts(mode: RowWriteMode, c: TableCounts): string {
    const failed = c.failed ? `, ${c.failed} failed` : '';
    if (c.prepared) {
        return `${c.prepared} row(s) prepared${failed}`;
    }
    const done =
        mode === 'insert'
            ? `${c.inserted} inserted`
            : mode === 'upsert'
              ? `${c.inserted} inserted, ${c.updated} updated, ${c.superseded} superseded`
              : mode === 'delete'
                ? `${c.deleted} deleted, ${c.notFound} not found`
                : `${c.updated} updated, ${c.notFound} not found`;
    return `${done}${failed}`;
}

export function tableWriteSummary(mode: RowWriteMode, perTable: Map<string, TableCounts>, noTable: number, fallback: string): string {
    const tables = perTable.size || noTable ? perTable : new Map([[fallback, noCounts()]]);
    const lines = [...tables].map(([table, counts]) => `${table}: ${describeTableCounts(mode, counts)}`);
    if (noTable) {
        lines.push(`${noTable} failed before its table was known (the table expression)`);
    }
    const prepared = [...perTable.values()].some(c => c.prepared > 0);
    return `${lines.join('; ')}${prepared ? '; none sent' : ''}.`;
}

function execute(kind: DatabaseKind, mode: RowWriteMode, fallbackKey: string): ComponentLogic['execute'] {
    return async function* (inputs, config, ctx) {
        const { table: fixedTable, tableField, columns, match, conditions, ifNotFound, batchSize, timeoutS } = tableWriteConfig(config);
        const connection = runConnection(kind, config, ctx);
        const key = ctx.node.outputKey || fallbackKey;
        const names = columns.map(c => c.column.trim());
        let batch: { doc: Envelope; row: unknown[]; expected: unknown[] }[] = [];
        let table = fixedTable;
        const tableOf = (doc: Envelope): string => {
            if (!tableField.expression) {
                return fixedTable;
            }
            const value = ctx.fieldValue(tableField, doc);
            const name = typeof value === 'string' ? value.trim() : '';
            const issue =
                typeof value === 'string' ? tableNameIssue(name) : `has the table ${value === null ? 'null' : typeof value}, not text`;
            if (issue) {
                throw new Error(`The table expression ${issue.replace(/^has /, 'gives ')}.`);
            }
            return name;
        };
        const perTable = new Map<string, TableCounts>();
        const countsOf = (name: string) => {
            let counts = perTable.get(name);
            if (!counts) {
                counts = noCounts();
                perTable.set(name, counts);
            }
            return counts;
        };
        let noTable = 0;
        let batches = 0;
        const failedOf = (name: string, n = 1) => {
            countsOf(name).failed += n;
            ctx.wrote(name, { failed: n });
        };

        async function* flush() {
            const current = batch;
            batch = [];
            ctx.holding(0);
            if (!current.length) {
                return;
            }
            const t0 = performance.now();
            let answer;
            try {
                answer = await ctx.writeRows(kind, {
                    connection,
                    table,
                    columns: names,
                    rows: current.map(b => b.row),
                    mode,
                    ...(mode === 'upsert' || mode === 'update' ? { match } : {}),
                    ...(kind === 'sqlserver' && mode === 'update' && conditions.length
                        ? { conditions: { columns: conditions.map(c => c.column.trim()), rows: current.map(b => b.expected) } }
                        : {}),
                    timeoutMs: timeoutS * 1000,
                });
            } catch (e) {
                failedOf(table, current.length);
                for (const { doc } of current) {
                    yield { error: toError(e), doc };
                }
                return;
            }
            if (answer === null) {
                countsOf(table).prepared += current.length;
                for (const { doc } of current) {
                    yield { port: 'out-0', doc: withKey(doc, key, { notSent: true }, ctx.node.override) };
                }
                return;
            }
            batches += 1;
            const here = noCounts();
            let affected = 0;
            for (const [i, { doc }] of current.entries()) {
                const action = answer.results[i] ?? 'inserted';
                here[action] += 1;
                const rows = answer.rows?.[i];
                affected += rows ?? (action === 'inserted' || action === 'updated' || action === 'deleted' ? 1 : 0);
                if (action === 'notFound' && (mode === 'update' || mode === 'delete') && ifNotFound === 'error') {
                    here.failed += 1;
                    yield {
                        error: new Error(`No row of ${table} matched: nothing was ${mode === 'delete' ? 'deleted' : 'updated'}.`),
                        doc,
                    };
                    continue;
                }
                yield { port: 'out-0', doc: withKey(doc, key, rows === undefined ? { action } : { action, rows }, ctx.node.override) };
            }
            const counts = countsOf(table);
            for (const name of Object.keys(here) as (keyof TableCounts)[]) {
                counts[name] += here[name];
            }
            ctx.wrote(table, {
                inserted: here.inserted,
                updated: here.updated,
                deleted: here.deleted,
                affected,
                batches: 1,
                failed: here.failed,
            });
            ctx.log(
                'debug',
                `Batch ${batches} (${table}): ${current.length} row(s) in ${Math.round(performance.now() - t0)} ms (${describeTableCounts(mode, here)}).`,
            );
        }

        for await (const doc of inputs['in-0'] ?? []) {
            let target: string;
            try {
                target = tableOf(doc);
            } catch (e) {
                noTable += 1;
                yield { error: toError(e), doc };
                continue;
            }
            // another table closes the batch: a batch is one table, in one transaction
            if (target !== table) {
                yield* flush();
                table = target;
            }
            countsOf(target);
            try {
                const expected =
                    kind === 'sqlserver' && mode === 'update'
                        ? conditions.map(c => {
                              const value = ctx.fieldValue(c, doc);
                              if (value === undefined) {
                                  throw new Error(`Expected value for "${c.column}" is undefined.`);
                              }
                              return columnValue(value);
                          })
                        : [];
                const row = columns.map(c => {
                    const value = ctx.fieldValue(c, doc);
                    if (mode === 'delete' && (value === undefined || value === null)) {
                        throw new Error(
                            `Match on value for "${c.column.trim()}" is ${value === null ? 'null' : 'undefined'}: nothing was deleted.`,
                        );
                    }
                    return columnValue(value);
                });
                batch.push({ doc, row, expected });
                ctx.holding(batch.length, doc);
            } catch (e) {
                failedOf(target);
                yield { error: toError(e), doc };
                continue;
            }
            if (batch.length >= batchSize) {
                yield* flush();
            }
        }
        yield* flush();
        ctx.log('debug', tableWriteSummary(mode, perTable, noTable, fixedTable));
    };
}

export function tableWriteComponent(options: {
    type: string;
    label: string;
    description: string;
    example: Record<string, unknown>;
    kind: DatabaseKind;
    mode: RowWriteMode;
    outputKey: string;
}): ComponentLogic {
    const { kind, mode } = options;
    return {
        type: options.type,
        label: options.label,
        category: 'database',
        description: options.description,
        example: options.example,
        inputs: 1,
        outputs: 1,
        usesOverride: true,
        defaultOutputKey: options.outputKey,
        sideEffects: true,
        settings: settings(kind, mode),
        validate: config => validate(kind, mode, config),
        execute: execute(kind, mode, options.outputKey),
    };
}
