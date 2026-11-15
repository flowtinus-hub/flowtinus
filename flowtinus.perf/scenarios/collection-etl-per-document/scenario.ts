import type { Scenario } from '#perf/scenario';
import { DATA_VERSION, documents, expectedRows, REFERENCE_FIELDS, type ItemRow, type SourceDocument } from './data';

/*
 * A collection ETL as a warehouse feed runs it, a document at a time: a MongoDB Pipeline takes the collection's
 * documents changed in a window (as canonical Extended JSON), a TypeScript prepares each one's snapshot, a MongoDB
 * Upsert saves the snapshots to a data lake (batches of 100), and a Flow Invoker that picks the flow by its path calls
 * the collection's transformer once per document: a TypeScript that maps it with the project's scripts
 * (scripts/Shared) and a Redshift Upsert of 17 `$row.x` columns into a table named by an expression. What it measures:
 * a called run per document (its record, its progress), each component's per-envelope work (expressions, script
 * calls), and the writes' round trips. After each run the target and the lake are checked against the source.
 *
 * Redshift is a Postgres here (the same protocol and drivers): the numbers are the engine's and the drivers'.
 */

const TARGET = 'perf.etl_items';
const LAKE = 'etl_items_lake';
const BATCH = 5_000;

/** a target row as text, to compare with what the documents say (timestamps without a zone read as written) */
const SELECT = `SELECT id, title, code, client_id, location_id, is_draft, state_id, parent_id,
    to_char(created_on, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_on,
    to_char(modified_on, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS modified_on,
    to_char(deleted_on, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deleted_on,
    is_deleted, tag_count, notes, etl_context_id
  FROM ${TARGET} ORDER BY id`;

const scenario: Scenario = {
    id: 'collection-etl-per-document',
    description:
        'MongoDB Pipeline (a window, Extended JSON) → TypeScript snapshot → MongoDB Upsert (lake, batches of 100) → Flow Invoker by path, one call per document → transformer: TypeScript with project scripts → Redshift Upsert (17 columns). Checks the target and the lake after each run.',
    services: ['mongodb', 'postgres'],
    size: 2_000,
    quickSize: 300,
    seed: 1,
    timeoutMs: 600_000,
    dataVersion: DATA_VERSION,
    throughputNode: 'Extract collection in window',
    rulers: [
        { metric: 'durationMs', direction: 'lower-is-better' },
        { metric: 'cpuMs', direction: 'lower-is-better' },
        { metric: 'memoryPeakBytes', direction: 'lower-is-better' },
        { metric: 'recordBytes', direction: 'lower-is-better' },
        { metric: 'progressBytes', direction: 'lower-is-better' },
        { metric: "component.Invoke the collection's transformer.waitingMs", direction: 'lower-is-better' },
        { metric: 'component.Save snapshot to the lake.waitingMs', direction: 'lower-is-better' },
    ],
    load: async ctx => {
        const collection = ctx.mongo!.collection<SourceDocument>('etl_items');
        await collection.drop().catch(() => undefined);
        const all = documents(ctx.size, ctx.seed);
        for (let i = 0; i < all.length; i += BATCH) {
            await collection.insertMany(all.slice(i, i + BATCH), { ordered: false });
        }
        for (const field of ['Seq', ...REFERENCE_FIELDS]) {
            await collection.createIndex({ [field]: 1 }, undefined, undefined);
        }

        await ctx.postgres!.query(`
            CREATE SCHEMA IF NOT EXISTS perf;
            DROP TABLE IF EXISTS ${TARGET};
            CREATE TABLE ${TARGET} (
                id varchar(64) NOT NULL, title varchar(400), code varchar(64), client_id int, location_id int,
                is_draft boolean, state_id varchar(64), parent_id varchar(64), created_on timestamp, modified_on timestamp,
                deleted_on timestamp, is_deleted boolean, tag_count int, notes varchar(4000), ingestion_timestamp timestamp,
                etl_timestamp timestamp, etl_context_id varchar(64)
            );`);
    },
    reset: async ctx => {
        await ctx.postgres!.query(`TRUNCATE ${TARGET}`);
        await ctx
            .mongo!.collection(LAKE)
            .drop()
            .catch(() => undefined);
    },
    input: () => [{ collectionName: 'etl_items', mappingPath: 'perf: item transformer', referenceFields: [...REFERENCE_FIELDS] }],
    verify: async ctx => {
        const wrong: string[] = [];
        const expected = expectedRows(ctx.size, ctx.seed);
        const rows = (await ctx.postgres!.query(SELECT)) as ItemRow[];
        if (rows.length !== expected.length) {
            wrong.push(`the target has ${rows.length} rows, ${expected.length} expected`);
        }

        const differ = expected.filter((row, i) => JSON.stringify(rows[i] ?? null) !== JSON.stringify(row));
        if (differ.length > 0) {
            const i = expected.indexOf(differ[0]!);
            wrong.push(
                `${differ.length} row(s) differ, the first ${JSON.stringify(rows[i] ?? null)} instead of ${JSON.stringify(expected[i])}`,
            );
        }

        const lake = await ctx.mongo!.collection(LAKE).countDocuments();
        if (lake !== expected.length) {
            wrong.push(`the lake has ${lake} snapshots, ${expected.length} expected`);
        }

        return wrong;
    },
};

export default scenario;
