import type { Scenario } from '#perf/scenario';
import { DATA_VERSION, expected, FIELDS, OLD_ROWS, pages, type ListRow } from './data';

/*
 * A page router as a warehouse feed runs it: each page of up to 500 snapshots (megabytes in one envelope) goes to a
 * TypeScript that keeps each snapshot's latest version and plans the transformer calls with the project's scripts (one
 * per snapshot and list), a Split, a Flow Invoker that picks the transformer by its path (On error: divert) and a Wait
 * that holds the page until every call ended, then a check. Each call replaces one snapshot's list with one Redshift
 * Execute (DELETE, then an INSERT that splits the packed rows in SQL). What it measures: a large envelope that several
 * components see and the Wait holds (their samples, the record, the progress), thousands of called runs, and one SQL
 * round trip each. After each run the lists' tables are checked against the pages.
 *
 * Redshift is a Postgres here (the same protocol and drivers): the numbers are the engine's and the drivers'.
 */

const TABLES = FIELDS.map(f => `perf.page_${f.toLowerCase()}`);

const scenario: Scenario = {
    id: 'page-router-fanout',
    description:
        'Pages of up to 500 snapshots (MB each) → TypeScript plan with project scripts → Split → Flow Invoker by path per snapshot and list (divert) → Wait holding the page → check; each call: TypeScript → Redshift Execute (DELETE + INSERT splitting the rows in SQL). Checks the tables after each run.',
    services: ['postgres'],
    size: 1_500,
    quickSize: 400,
    seed: 1,
    timeoutMs: 600_000,
    dataVersion: DATA_VERSION,
    throughputNode: 'Plan page transformer calls',
    rulers: [
        { metric: 'durationMs', direction: 'lower-is-better' },
        { metric: 'cpuMs', direction: 'lower-is-better' },
        { metric: 'memoryPeakBytes', direction: 'lower-is-better' },
        { metric: 'recordBytes', direction: 'lower-is-better' },
        { metric: 'progressBytes', direction: 'lower-is-better' },
        { metric: 'progressMaxBytes', direction: 'lower-is-better' },
        { metric: 'component.Invoke page transformer.waitingMs', direction: 'lower-is-better' },
    ],
    load: async ctx => {
        await ctx.postgres!.query(`
            CREATE SCHEMA IF NOT EXISTS perf;
            ${TABLES.map(
                t => `DROP TABLE IF EXISTS ${t};
            CREATE TABLE ${t} (id varchar(64), project_id varchar(64) NOT NULL, value int, ingestion_timestamp timestamp, etl_timestamp timestamp, etl_context_id varchar(64));
            CREATE INDEX ON ${t} (project_id);`,
            ).join('\n')}`);
    },
    reset: async ctx => {
        // every snapshot with its old rows: a list with values replaces them, an empty one leaves them
        for (const t of TABLES) {
            await ctx.postgres!.query(
                `TRUNCATE ${t};
                INSERT INTO ${t} (id, project_id, value) SELECT 'old-' || s || '-' || n, 'snap-' || s, -n
                  FROM generate_series(1, CAST(@size AS int)) s, generate_series(1, CAST(@old AS int)) n;`,
                { size: ctx.size, old: OLD_ROWS },
            );
        }
    },
    input: pages,
    verify: async ctx => {
        const wrong: string[] = [];
        const want = expected(ctx.size, ctx.seed);
        for (const field of FIELDS) {
            const table = `perf.page_${field.toLowerCase()}`;
            const rows = (await ctx.postgres!.query(
                `SELECT project_id, value FROM ${table} ORDER BY project_id COLLATE "C", value`,
            )) as ListRow[];
            if (rows.length !== want[field].length) {
                wrong.push(`${table} has ${rows.length} rows, ${want[field].length} expected`);
            }

            const i = want[field].findIndex((row, n) => rows[n]?.project_id !== row.project_id || rows[n]?.value !== row.value);
            if (i >= 0) {
                wrong.push(
                    `${table} differs from row ${i + 1}: ${JSON.stringify(rows[i] ?? null)} instead of ${JSON.stringify(want[field][i])}`,
                );
            }
        }

        return wrong;
    },
};

export default scenario;
