import type { Scenario } from '#perf/scenario';
import { DATA_VERSION, expectedRows, OLD_ROWS, pages, type Row } from './data';

/*
 * Replacing a page of a transformer in Redshift with the components there are (no component of its own): the
 * page's keys and rows go to staging tables with a token (Redshift Insert, no size limit), a Wait sees them all
 * written, and one Redshift Execute swaps them into the target in one transaction (LOCK, DELETE ... USING the keys,
 * INSERT ... SELECT the rows, the staging of the token deleted). A page without rows changes nothing; a failure cleans
 * the token's staging and fails the run. After each run `verify` compares the target with what the pages say.
 *
 * The database is a Postgres standing in for Redshift (the same protocol and drivers): the numbers are the engine's
 * and the drivers', not Redshift's, and Redshift's own limits (VARCHAR bytes, serializable isolation) are not there.
 */

const TABLES = 'perf.replace_item, perf.replace_item__stage_keys, perf.replace_item__stage_rows';

const same = (a: Row, b: Row) => a.snapshot_id === b.snapshot_id && a.item_no === b.item_no && a.name === b.name && a.payload === b.payload;

const scenario: Scenario = {
    id: 'redshift-batch-replace',
    description:
        'Pages of up to 500 snapshots → Flow Invoker per page: Redshift Insert of keys and rows into staging (token), Wait, one Redshift Execute that swaps them into the target in a transaction. Checks the target after each run.',
    services: ['postgres'],
    size: 10_000,
    quickSize: 1_500,
    seed: 1,
    timeoutMs: 300_000,
    dataVersion: DATA_VERSION,
    throughputNode: 'Start',
    rulers: [
        { metric: 'durationMs', direction: 'lower-is-better' },
        { metric: 'cpuMs', direction: 'lower-is-better' },
        { metric: 'memoryPeakBytes', direction: 'lower-is-better' },
        { metric: 'recordBytes', direction: 'lower-is-better' },
        { metric: 'progressBytes', direction: 'lower-is-better' },
        { metric: 'component.Flow Invoker.waitingMs', direction: 'lower-is-better' },
    ],
    load: async ctx => {
        await ctx.postgres!.query(`
            CREATE SCHEMA IF NOT EXISTS perf;
            DROP TABLE IF EXISTS ${TABLES};
            CREATE TABLE perf.replace_item (snapshot_id int NOT NULL, item_no int NOT NULL, name varchar(200), payload varchar(2000));
            CREATE TABLE perf.replace_item__stage_keys (token varchar(64) NOT NULL, snapshot_id int NOT NULL, created_at timestamp DEFAULT now());
            CREATE TABLE perf.replace_item__stage_rows (
                token varchar(64) NOT NULL, snapshot_id int NOT NULL, item_no int NOT NULL, name varchar(200), payload varchar(2000),
                created_at timestamp DEFAULT now()
            );`);
    },
    reset: async ctx => {
        await ctx.postgres!.query(
            `TRUNCATE ${TABLES};
            INSERT INTO perf.replace_item (snapshot_id, item_no, name, payload)
            SELECT s, n, 'old ' || s || '.' || n, 'old' FROM generate_series(1, CAST(@size AS int)) s, generate_series(1, CAST(@old AS int)) n;`,
            { size: ctx.size, old: OLD_ROWS },
        );
    },
    input: pages,
    verify: async ctx => {
        const db = ctx.postgres!;
        const wrong: string[] = [];
        const rows = (await db.query(
            'SELECT snapshot_id, item_no, name, payload FROM perf.replace_item ORDER BY snapshot_id, item_no',
        )) as Row[];
        const expected = expectedRows(ctx.size, ctx.seed);
        if (rows.length !== expected.length) {
            wrong.push(`the target has ${rows.length} rows, ${expected.length} expected`);
        }

        const differ = expected.flatMap((row, i) => (rows[i] && same(rows[i]!, row) ? [] : [i]));
        if (differ.length > 0) {
            const i = differ[0]!;
            wrong.push(
                `${differ.length} row(s) differ, the first at snapshot ${expected[i]!.snapshot_id} item ${expected[i]!.item_no}: ${JSON.stringify(rows[i] ?? null)} instead of ${JSON.stringify(expected[i])}`,
            );
        }

        const [left] = await db.query(
            'SELECT (SELECT COUNT(*) FROM perf.replace_item__stage_keys) AS keys, (SELECT COUNT(*) FROM perf.replace_item__stage_rows) AS rows',
        );
        if (Number(left?.keys) > 0 || Number(left?.rows) > 0) {
            wrong.push(`the staging was left with ${left?.keys} key(s) and ${left?.rows} row(s)`);
        }

        return wrong;
    },
};

export default scenario;
