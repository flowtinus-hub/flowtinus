import { COMPONENT_TYPE } from '#components/component-types';
import { connectionIssues, connectionSettings } from '../../connections/connection-access';
import { runConnection } from '../run-connection';
import { toError } from '#errors/normalize-error';
import { mergeFields } from '#envelope/envelope-data';
import type { ComponentLogic } from '#types/component-logic.type';
import { serverTimed } from '../server-timed';
import { evaluateMongo, mongoExpression } from '../mongo-expression';
import { MONGO_TARGET_SETTINGS, mongoTarget, mongoTargetField, mongoTargetIssues, targetName, targetsText } from '../mongo-target';

export const DEFAULT_MONGODB_TIMEOUT_S = 300;

export const DEFAULT_PIPELINE = `[
  {
    $match: {}
  },
  {
    $limit: 100
  }
]`;

export function mongoPipelineConfig(config: Record<string, unknown>) {
    const timeout = Math.round(Number(config.timeoutS ?? DEFAULT_MONGODB_TIMEOUT_S));
    return {
        connection: typeof config.connection === 'string' ? config.connection : '',
        database: mongoTargetField(config.database),
        collection: mongoTargetField(config.collection),
        pipeline: typeof config.pipeline === 'string' ? config.pipeline : DEFAULT_PIPELINE,
        outputFormat: config.outputFormat === 'extended-json' ? 'extended-json' : 'plain',
        timeoutS: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_MONGODB_TIMEOUT_S,
    };
}

const WRITING_STAGES = ['$out', '$merge'];

export function mongoPipelineTextIssue(text: string): string | null {
    const found = text.match(/["']?\$(out|merge)["']?\s*:/);
    return found ? `cannot use $${found[1]} (it is read-only)` : null;
}

export function mongoPipelineIssue(pipeline: unknown): string | null {
    if (!Array.isArray(pipeline)) {
        return 'is not a list of stages ([ {...}, {...} ])';
    }
    for (const [i, stage] of pipeline.entries()) {
        if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) {
            return `stage ${i + 1} is not an object`;
        }
        const writing = Object.keys(stage).find(key => WRITING_STAGES.includes(key));
        if (writing) {
            return `cannot use ${writing} (it is read-only)`;
        }
    }
    return null;
}

export const pipelineExpression = mongoExpression;

export const mongodbPipeline: ComponentLogic = {
    type: COMPONENT_TYPE.mongoDbPipeline,
    label: 'MongoDB Pipeline',
    category: 'database',
    description:
        'Runs an aggregation pipeline (written as in Compass or mongosh, an expression on the incoming envelope: `{$match: {cpf: $cpf}}`) on a collection (database and collection fixed or expressions on the envelope) once per incoming envelope and yields one envelope per document, the fields written into DATA. Read only: $out and $merge are refused. Output is plain JSON by default; canonical Extended JSON preserves BSON types for a MongoDB Upsert configured with the same format, and rejects documents that cannot be represented losslessly.',
    example: {
        connection: '<connection profile id>',
        collection: { value: 'orders', expression: false },
        pipeline: "[\n  { $match: { status: 'open' } },\n  { $limit: 100 },\n]",
        timeoutS: 60,
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    settings: [
        ...connectionSettings('mongodb'),
        ...MONGO_TARGET_SETTINGS,
        { key: 'pipeline', label: 'Pipeline', kind: 'code', language: 'javascript', required: true, default: DEFAULT_PIPELINE },
        {
            key: 'outputFormat',
            label: 'Output format',
            kind: 'select',
            default: 'plain',
            options: [
                { value: 'plain', label: 'Plain JSON' },
                { value: 'extended-json', label: 'Canonical Extended JSON (preserve BSON types)' },
            ],
        },
        { key: 'timeoutS', label: 'Timeout (seconds)', kind: 'number', default: DEFAULT_MONGODB_TIMEOUT_S, min: 1 },
    ],

    validate(config) {
        const { database, collection, pipeline } = mongoPipelineConfig(config);
        const issues: string[] = [...connectionIssues('mongodb', config)];
        issues.push(...mongoTargetIssues(config, database, collection));
        if (!pipeline.trim()) {
            issues.push('has no pipeline.');
        }
        if (config.outputFormat !== undefined && config.outputFormat !== 'plain' && config.outputFormat !== 'extended-json') {
            issues.push('has an invalid output format.');
        }
        const issue = mongoPipelineTextIssue(pipeline);
        if (issue) {
            issues.push(`${issue}.`);
        }
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const { database, collection, pipeline, outputFormat, timeoutS } = mongoPipelineConfig(config);
        const connection = runConnection('mongodb', config, ctx);
        let queries = 0;
        let documents = 0;
        const targets = new Set<string>();
        for await (const doc of inputs['in-0'] ?? []) {
            queries += 1;
            const t0 = Date.now();
            let thisQuery = 0;
            let server = 0;
            try {
                const target = mongoTarget(config, database, collection, doc, ctx);
                targets.add(targetName(target));
                const stages = evaluateMongo(pipeline, 'pipeline', value => ctx.fieldValue({ value, expression: true }, doc));
                const issue = mongoPipelineIssue(stages);
                if (issue) {
                    throw new Error(`The pipeline ${issue}.`);
                }
                const cursor = ctx.aggregateDocuments('mongodb', {
                    connection,
                    ...target,
                    pipeline: stages as Record<string, unknown>[],
                    ...(outputFormat === 'extended-json' ? { outputFormat: 'extended-json' as const } : {}),
                    timeoutMs: timeoutS * 1000,
                });
                for await (const found of ctx.waitEach(
                    serverTimed(cursor, ms => {
                        server += ms;
                    }),
                )) {
                    thisQuery += 1;
                    yield { port: 'out-0', doc: mergeFields(doc, found, ctx.node.override) };
                }
                ctx.log(
                    'debug',
                    `Pipeline ${queries}: ${thisQuery} document(s) in ${Date.now() - t0} ms (server ${Math.round(server)} ms).`,
                );
            } catch (e) {
                // documents already yielded move on; the envelope that triggered the pipeline goes to the error policy
                if (thisQuery) {
                    ctx.log('warning', `Pipeline ${queries} stopped after ${thisQuery} document(s).`);
                }
                yield { error: toError(e), doc };
            }
            documents += thisQuery;
        }
        ctx.log('debug', `${documents} document(s) read from ${targetsText(targets)} in ${queries} pipeline(s).`);
    },
};
