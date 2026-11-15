import { COMPONENT_TYPE } from '#components/component-types';
import { connectionIssues, connectionSettings } from '../../connections/connection-access';
import { runConnection } from '../run-connection';
import { withKey } from '#envelope/envelope-data';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';
import { evaluateMongo } from '../mongo-expression';
import { MONGO_TARGET_SETTINGS, mongoTarget, mongoTargetField, mongoTargetIssues, targetName, targetsText } from '../mongo-target';

export const DEFAULT_DELETE_FILTER = `{
  field: $field
}`;

export function mongoDeleteConfig(config: Record<string, unknown>) {
    return {
        connection: typeof config.connection === 'string' ? config.connection : '',
        database: mongoTargetField(config.database),
        collection: mongoTargetField(config.collection),
        filter: typeof config.filter === 'string' ? config.filter : DEFAULT_DELETE_FILTER,
        allowAll: config.allowAll === true,
    };
}

export const emptyFilterText = (text: string) => /^\(?\s*\{\s*\}\s*\)?$/.test(text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim());

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const mongodbDelete: ComponentLogic = {
    type: COMPONENT_TYPE.mongoDbDelete,
    label: 'MongoDB Delete',
    category: 'database',
    description:
        'For each envelope, deletes every document of the collection (database and collection fixed or expressions on the envelope) that matches the filter (an expression on the envelope, as in mongosh) and the envelope goes on with {deleted} in its output key (default `mongodb`). An empty filter is refused unless Delete all is on. A test run only counts what would be deleted.',
    example: { connection: '<connection profile id>', collection: { value: 'sessions', expression: false }, filter: '{ customerId: $id }' },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    defaultOutputKey: 'mongodb',
    sideEffects: true,
    settings: [
        ...connectionSettings('mongodb'),
        ...MONGO_TARGET_SETTINGS,
        { key: 'filter', label: 'Filter', kind: 'code', language: 'javascript', required: true, default: DEFAULT_DELETE_FILTER },
        { key: 'allowAll', label: 'Delete all (an empty filter deletes the whole collection)', kind: 'boolean' },
    ],

    validate(config) {
        const { database, collection, filter, allowAll } = mongoDeleteConfig(config);
        const issues: string[] = [...connectionIssues('mongodb', config)];
        issues.push(...mongoTargetIssues(config, database, collection));
        if (!filter.trim()) {
            issues.push('has no filter.');
        } else if (emptyFilterText(filter) && !allowAll) {
            issues.push('has an empty filter, which deletes the whole collection: turn on "Delete all" to allow it.');
        }
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const { database, collection, filter, allowAll } = mongoDeleteConfig(config);
        const connection = runConnection('mongodb', config, ctx);
        const key = ctx.node.outputKey || 'mongodb';
        const targets = new Set<string>();
        let calls = 0;
        let deleted = 0;
        let tested = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            calls += 1;
            const t0 = performance.now();
            let target: ReturnType<typeof mongoTarget> | undefined;
            try {
                target = mongoTarget(config, database, collection, doc, ctx);
                targets.add(targetName(target));
                const match = evaluateMongo(filter, 'filter', value => ctx.fieldValue({ value, expression: true }, doc));
                if (!isObject(match)) {
                    throw new Error('The filter is not an object ({ field: value }).');
                }
                if (Object.keys(match).length === 0 && !allowAll) {
                    throw new Error('The filter is empty, which would delete the whole collection: turn on "Delete all" to allow it.');
                }
                const answer = await ctx.deleteDocuments('mongodb', { connection, ...target, filter: match });
                if ('notSent' in answer) {
                    tested += 1;
                    yield { port: 'out-0', doc: withKey(doc, key, answer, ctx.node.override) };
                    continue;
                }
                const n = answer.deleted;
                deleted += n;
                ctx.wrote(targetName(target), { deleted: n, affected: n, batches: 1 });
                ctx.log(
                    'debug',
                    `Delete ${calls}: ${n} document(s) from ${targetName(target)} in ${Math.round(performance.now() - t0)} ms.`,
                );
                yield { port: 'out-0', doc: withKey(doc, key, { deleted: n }, ctx.node.override) };
            } catch (e) {
                if (target) {
                    ctx.wrote(targetName(target), { failed: 1 });
                }
                yield { error: toError(e), doc };
            }
        }
        if (tested) {
            ctx.log('debug', `${tested} delete(s) counted on ${targetsText(targets)}, none sent.`);
        } else {
            ctx.log('debug', `${deleted} document(s) deleted from ${targetsText(targets)} in ${calls} delete(s).`);
        }
    },
};
