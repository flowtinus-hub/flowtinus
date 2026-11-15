import { COMPONENT_TYPE } from '#components/component-types';
import { connectionIssues, connectionSettings } from '../../connections/connection-access';
import { runConnection } from '../run-connection';
import { withKey } from '#envelope/envelope-data';
import { isDate } from '#envelope/dates';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';
import type { DocumentUpsert } from '#types/document-upsert.type';
import type { Envelope } from '#types/envelope.type';
import type { ExpressionField } from '#types/expression-field.type';
import { MONGO_TARGET_SETTINGS, mongoTarget, mongoTargetField, mongoTargetIssues, targetName, targetsText, type MongoTarget } from '../mongo-target';

export type MongoFilterKey = ExpressionField & { field: string };
export type MongoDocumentSource = 'data' | 'expression';

export const DEFAULT_MONGODB_BATCH_SIZE = 500;
export const MAX_MONGODB_BATCH_SIZE = 10_000;

export function mongoUpsertConfig(config: Record<string, unknown>) {
    const size = Math.round(Number(config.batchSize ?? DEFAULT_MONGODB_BATCH_SIZE));
    const document = config.document as ExpressionField | undefined;
    return {
        connection: typeof config.connection === 'string' ? config.connection : '',
        database: mongoTargetField(config.database),
        collection: mongoTargetField(config.collection),
        filter: Array.isArray(config.filter) ? (config.filter as MongoFilterKey[]) : [],
        source: (config.source === 'expression' ? 'expression' : 'data') as MongoDocumentSource,
        document: { value: typeof document?.value === 'string' ? document.value : '', expression: true },
        valueFormat: config.valueFormat === 'extended-json' ? 'extended-json' : 'plain',
        writeMode: config.writeMode === 'replace' ? 'replace' : 'update',
        batchSize: Number.isFinite(size) && size >= 1 ? Math.min(size, MAX_MONGODB_BATCH_SIZE) : DEFAULT_MONGODB_BATCH_SIZE,
    };
}

/** a target as a key (a NUL cannot be in either name) */
const targetId = (t: MongoTarget) => `${t.database}\0${t.collection}`;

const describe = (c: { inserted: number; modified: number; unchanged: number }) =>
    `${c.inserted} inserted, ${c.modified} modified, ${c.unchanged} unchanged`;

/**
 * The value with its dates as Date of this realm, at any depth: the driver writes them as BSON dates. A Date made in
 * an expression (node:vm, another realm) would not be recognized as one. Text stays text, whatever it looks like.
 */
function withDates(value: unknown): unknown {
    if (isDate(value)) {
        return new Date(value.getTime());
    }
    if (Array.isArray(value)) {
        return value.map(withDates);
    }
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withDates(v)]));
    }
    return value;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const validField = (field: string) => /^[^$.\0][^\0]*$/.test(field) && !field.split('.').some(part => part === '');

export const mongodbUpsert: ComponentLogic = {
    type: COMPONENT_TYPE.mongoDbUpsert,
    label: 'MongoDB Upsert',
    category: 'database',
    description:
        'Writes each envelope into a collection (database and collection fixed or expressions on the envelope; batches kept per collection): updates ($set) or replaces the document matching the filter, or inserts it. The document is the whole DATA or an expression; `_id` is taken from the filter when inserting. Writes in batches; each envelope goes on with {matched, upsertedId} in its output key (default `mongodb`). A test run writes nothing. Select canonical Extended JSON when the filter and document contain BSON values in that format; reserved Extended JSON forms are interpreted as BSON values.',
    example: {
        connection: '<connection profile id>',
        collection: { value: 'customers', expression: false },
        filter: [{ field: 'email', value: '$email', expression: true }],
        source: 'data',
        batchSize: 100,
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    defaultOutputKey: 'mongodb',
    sideEffects: true,
    settings: [
        ...connectionSettings('mongodb'),
        ...MONGO_TARGET_SETTINGS,
        {
            key: 'filter',
            label: 'Match on',
            kind: 'list',
            itemLabel: 'field',
            required: true,
            item: [
                { key: 'field', label: 'Field', kind: 'text', required: true, placeholder: 'email' },
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
        {
            key: 'source',
            label: 'Document',
            kind: 'select',
            default: 'data',
            options: [
                { value: 'data', label: 'The whole DATA' },
                { value: 'expression', label: 'An expression' },
            ],
        },
        {
            key: 'document',
            label: 'Expression',
            kind: 'value',
            default: { value: '', expression: true },
            when: { key: 'source', values: ['expression'] },
        },
        {
            key: 'valueFormat',
            label: 'Value format',
            kind: 'select',
            default: 'plain',
            options: [
                { value: 'plain', label: 'Plain JSON' },
                { value: 'extended-json', label: 'Canonical Extended JSON (preserve BSON types)' },
            ],
        },
        {
            key: 'writeMode',
            label: 'When a document matches',
            kind: 'select',
            default: 'update',
            options: [
                { value: 'update', label: 'Update supplied fields ($set)' },
                { value: 'replace', label: 'Replace the document' },
            ],
        },
        { key: 'batchSize', label: 'Batch size', kind: 'number', default: DEFAULT_MONGODB_BATCH_SIZE, min: 1, max: MAX_MONGODB_BATCH_SIZE },
    ],

    validate(config) {
        const { database, collection, filter, source, document } = mongoUpsertConfig(config);
        const issues: string[] = [...connectionIssues('mongodb', config)];
        if (config.valueFormat !== undefined && config.valueFormat !== 'plain' && config.valueFormat !== 'extended-json') {
            issues.push('has an invalid value format.');
        }
        if (config.writeMode !== undefined && config.writeMode !== 'update' && config.writeMode !== 'replace') {
            issues.push('has an invalid write mode.');
        }
        issues.push(...mongoTargetIssues(config, database, collection));
        if (filter.length === 0) {
            issues.push('has no filter field (what finds the document to update).');
        }
        const fields = new Set<string>();
        filter.forEach((f, i) => {
            const field = (f.field ?? '').trim();
            if (!field) {
                issues.push(`filter field ${i + 1} has no name.`);
            } else if (!validField(field)) {
                issues.push(`filter field "${field}" is not a valid MongoDB field.`);
            } else if (fields.has(field)) {
                issues.push(`has the filter field "${field}" more than once.`);
            }
            fields.add(field);
        });
        if (source === 'expression' && !document.value.trim()) {
            issues.push('has no document expression.');
        }
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const { database, collection, filter, source, document, valueFormat, writeMode, batchSize } = mongoUpsertConfig(config);
        const connection = runConnection('mongodb', config, ctx);
        const key = ctx.node.outputKey || 'mongodb';
        type Held = { doc: Envelope; upsert: DocumentUpsert };
        const pending = new Map<string, { target: MongoTarget; held: Held[] }>();
        let holding = 0;
        const targets = new Set<string>();
        const dynamic = database.expression || collection.expression;
        let written = 0;
        let failed = 0;
        let sent = 0;
        let prepared = 0;
        let batches = 0;
        const totals = { inserted: 0, modified: 0, unchanged: 0 };

        const upsertOf = (doc: Envelope): DocumentUpsert => {
            const match: Record<string, unknown> = {};
            for (const f of filter) {
                const value = ctx.fieldValue(f, doc);
                if (value === undefined) {
                    throw new Error(`The filter field "${f.field}" has no value.`);
                }
                match[f.field.trim()] = withDates(value);
            }
            const fields = source === 'expression' ? ctx.fieldValue(document, doc) : doc.DATA;
            if (!isObject(fields)) {
                throw new Error('The document is not an object.');
            }
            const set = withDates(fields) as Record<string, unknown>;
            delete set._id;
            return { filter: match, document: set };
        };

        async function* flush(id: string) {
            const entry = pending.get(id);
            pending.delete(id);
            if (!entry || !entry.held.length) {
                return;
            }
            const { target, held: current } = entry;
            holding -= current.length;
            ctx.holding(holding);
            let answer;
            const t0 = performance.now();
            try {
                answer = await ctx.upsertDocuments('mongodb', {
                    connection,
                    ...target,
                    upserts: current.map(b => b.upsert),
                    ...(valueFormat === 'extended-json' ? { valueFormat: 'extended-json' as const } : {}),
                    ...(writeMode === 'replace' ? { writeMode: 'replace' as const } : {}),
                });
            } catch (e) {
                failed += current.length;
                ctx.wrote(targetName(target), { failed: current.length });
                for (const { doc } of current) {
                    yield { error: toError(e), doc };
                }
                return;
            }
            if (answer === null) {
                prepared += current.length;
                for (const { doc } of current) {
                    yield { port: 'out-0', doc: withKey(doc, key, { notSent: true }, ctx.node.override) };
                }
                return;
            }
            const results = answer.results;
            sent += current.length;
            batches += 1;
            // a bulk write says how many changed only in total: matched minus modified are the unchanged ones (they
            // already had these values, e.g. the same envelope twice)
            const counts = { inserted: 0, modified: answer.modified, unchanged: 0, failed: 0 };
            let matched = 0;
            for (const r of results) {
                if ('error' in r) {
                    counts.failed += 1;
                } else if (r.upsertedId !== null) {
                    counts.inserted += 1;
                } else if (r.matched > 0) {
                    matched += 1;
                }
            }
            counts.unchanged = Math.max(0, matched - answer.modified);
            ctx.wrote(targetName(target), {
                inserted: counts.inserted,
                updated: counts.modified,
                affected: counts.inserted + counts.modified,
                batches: 1,
                failed: counts.failed,
            });
            totals.inserted += counts.inserted;
            totals.modified += counts.modified;
            totals.unchanged += counts.unchanged;
            ctx.log(
                'debug',
                `Batch ${batches}: ${current.length} upsert(s)${dynamic ? ` into ${targetName(target)}` : ''} in ${Math.round(performance.now() - t0)} ms (${describe(counts)}${counts.failed ? `, ${counts.failed} failed` : ''}).`,
            );
            for (const [i, { doc }] of current.entries()) {
                const result = results[i];
                if (!result || 'error' in result) {
                    failed += 1;
                    yield { error: new Error(result?.error ?? 'MongoDB did not answer for this document.'), doc };
                    continue;
                }
                written += 1;
                yield { port: 'out-0', doc: withKey(doc, key, result, ctx.node.override) };
            }
        }

        async function* flushAll() {
            for (const k of [...pending.keys()]) {
                yield* flush(k);
            }
        }

        for await (const doc of inputs['in-0'] ?? []) {
            let entry;
            let target: MongoTarget | undefined;
            try {
                target = mongoTarget(config, database, collection, doc, ctx);
                const upsert = upsertOf(doc);
                targets.add(targetName(target));
                entry = pending.get(targetId(target)) ?? { target, held: [] };
                pending.set(targetId(target), entry);
                entry.held.push({ doc, upsert });
                holding += 1;
                ctx.holding(holding, doc);
            } catch (e) {
                failed += 1;
                if (target) {
                    ctx.wrote(targetName(target), { failed: 1 });
                }
                yield { error: toError(e), doc };
                continue;
            }
            if (entry.held.length >= batchSize) {
                yield* flush(targetId(entry.target));
            } else if (holding >= batchSize) {
                // envelopes spread over several targets: no more than a batch held in all
                yield* flushAll();
            }
        }
        yield* flushAll();
        if (prepared) {
            ctx.log('debug', `${prepared} upsert(s) prepared for ${targetsText(targets)}, none sent${failed ? `, ${failed} failed` : ''}.`);
        } else {
            ctx.log(
                'debug',
                `${written} document(s) upserted into ${targetsText(targets)}: ${describe(totals)}${failed ? `, ${failed} failed` : ''} (${sent} sent).`,
            );
        }
    },
};
