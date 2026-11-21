import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { connectionString, resolveConnection, START, type ExecutableFlow } from '@flowtinus/core';
import { runJob, type RunJob } from '@flowtinus/server/run-job';
import { aggregateMongoDb, closeMongoClients } from '@flowtinus/server/runner/mongodb-driver';
import { prepareScript } from '@flowtinus/server/runner/prepare-script';
import { closeRedshiftPools, queryRedshift } from '@flowtinus/server/runner/redshift-driver';
import { sendHttp } from '@flowtinus/server/runner/send-http';
import { closeSqlServerPools, querySqlServer } from '@flowtinus/server/runner/sqlserver-driver';
import { executableFlows, loadFlowFiles, PERF_CONNECTIONS, PERF_SECRETS, PERF_WORKSPACE, scenarioScripts } from '#perf/flows';
import { compactRecord } from '#perf/compact';
import type { Sample, Scenario } from '#perf/scenario';
import { scenarioById } from '#perf/scenarios';
import { FAKE_API_URL } from '#perf/stack';

/*
 * One measured run, in a fresh Bun process (the orchestrator starts one per run, so no run inherits another's heap):
 * reads the scenario's flows, builds the RunJob the server's worker would get, warms the drivers and scripts up, then
 * runs it through the server's own runJob (the same drivers the worker uses) while a sampler thread watches the
 * process's memory. Writes one JSON line (the Sample) to stdout. Exit code 0 when the run ended (even failed), 2 when
 * this process itself broke.
 */

const signal = () => new AbortController().signal;

async function drain(rows: AsyncIterable<unknown>) {
    for await (const row of rows) {
        void row;
    }
}

/** the first use of each driver in a process pays its import and its connection; the engine's clock must not */
async function warmUp(scenario: Scenario, flows: Record<string, ExecutableFlow>, scripts: ReturnType<typeof scenarioScripts>) {
    if (scenario.services.includes('mssql')) {
        const connection = connectionString(resolveConnection('sqlserver', { profile: 'perf-sqlserver' }, PERF_CONNECTIONS, PERF_SECRETS));
        await drain(
            querySqlServer({
                connection,
                sql: 'SELECT 1 AS ok',
                parameters: {},
                timeoutMs: 30_000,
                signal: signal(),
            }),
        );
    }

    if (scenario.services.includes('mongodb')) {
        const connection = connectionString(resolveConnection('mongodb', { profile: 'perf-mongodb' }, PERF_CONNECTIONS, PERF_SECRETS));
        await drain(
            aggregateMongoDb({
                connection,
                database: 'perf',
                collection: '_perf_meta',
                pipeline: [{ $limit: 1 }],
                timeoutMs: 30_000,
                signal: signal(),
            }),
        );
    }

    if (scenario.services.includes('postgres')) {
        const connection = connectionString(resolveConnection('redshift', { profile: 'perf-redshift' }, PERF_CONNECTIONS, PERF_SECRETS));
        await drain(queryRedshift({ connection, sql: 'SELECT 1 AS ok', parameters: {}, timeoutMs: 30_000, signal: signal() }));
    }

    if (scenario.services.includes('fake-api')) {
        await sendHttp({ method: 'GET', url: `${FAKE_API_URL}/health`, headers: {}, timeoutMs: 5_000, signal: signal() });
    }

    const globals = {
        run: {
            id: 'warm-up',
            mode: 'execution' as const,
            workspace: 'perf',
            project: 'perf',
            flow: 'warm-up',
            startedAt: new Date().toISOString(),
        },
        parameters: {},
        secrets: {},
        variables: {},
        log: () => undefined,
        wait: <T>(promise: Promise<T>) => promise,
    };

    for (const node of Object.values(flows).flatMap(f => f.nodes)) {
        if (node.type === 'typescript' && typeof node.config.code === 'string') {
            // with the scenario's scripts and their hashes: the bundle is kept, as a worker keeps it between runs
            await prepareScript(node.config.code, globals, {
                scripts: scripts.scripts,
                hashes: scripts.scriptHashes,
                workspace: PERF_WORKSPACE,
            });
        }
    }
}

function startSampler(): Promise<{ stop(): Promise<{ peakRssBytes: number; samples: number }> }> {
    const worker = new Worker(join(import.meta.dir, 'memory-sampler.ts'));
    return new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.once('message', () =>
            resolve({
                stop: () =>
                    new Promise(done => {
                        worker.once('message', (result: { peakRssBytes: number; samples: number }) => {
                            void worker.terminate();
                            done(result);
                        });
                        worker.postMessage({ type: 'stop' });
                    }),
            }),
        );
    });
}

async function main() {
    const [id = '', sizeText = '', seedText = '', iterationText = '0'] = process.argv.slice(2);
    const scenario = scenarioById(id);
    if (!scenario) {
        throw new Error(`Unknown scenario "${id}".`);
    }

    const size = Number(sizeText);
    const seed = Number(seedText);
    const { main: flow, flows } = executableFlows(loadFlowFiles(id), id);
    const scripts = scenarioScripts(id);
    const acceptsInput = flow.nodes.find(n => n.type === START)?.config.acceptsInput === true;
    const job: RunJob = {
        id: crypto.randomUUID(),
        mode: 'execution',
        flow,
        flows,
        parameters: { size: String(size) },
        ...(acceptsInput && scenario.input ? { input: scenario.input(size, seed) } : {}),
        secrets: PERF_SECRETS,
        variables: {},
        connections: PERF_CONNECTIONS,
        ...scripts,
        workspaceName: 'perf',
        workspaceHandle: PERF_WORKSPACE,
        projectName: 'perf',
        flowName: flow.flow,
    };

    await warmUp(scenario, flows, scripts);

    Bun.gc(true);
    const start = process.memoryUsage();
    const sampler = await startSampler();
    const cpu0 = process.cpuUsage();
    // each progress as JSON, as the worker sends it to its supervisor (that work is the run's, as it is in a worker)
    const progress = { count: 0, bytes: 0, max: 0 };
    const record = await runJob(job, {
        signal: signal(),
        onProgress: value => {
            const bytes = JSON.stringify(value).length;
            progress.count += 1;
            progress.bytes += bytes;
            progress.max = Math.max(progress.max, bytes);
        },
    });
    const cpu = process.cpuUsage(cpu0);
    const { peakRssBytes, samples } = await sampler.stop();
    const end = process.memoryUsage();
    await Promise.all([closeSqlServerPools(), closeMongoClients(), closeRedshiftPools()]);

    const sample: Omit<Sample, 'warmup'> = {
        iteration: Number(iterationText),
        record: compactRecord(record),
        memory: {
            startRssBytes: start.rss,
            peakRssBytes: Math.max(peakRssBytes, end.rss),
            endRssBytes: end.rss,
            heapStartBytes: start.heapUsed,
            heapEndBytes: end.heapUsed,
            samples,
        },
        cpu: { cpuMs: (cpu.user + cpu.system) / 1000, userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
        sizes: {
            recordBytes: JSON.stringify(record).length,
            progressCount: progress.count,
            progressBytes: progress.bytes,
            progressMaxBytes: progress.max,
        },
    };
    await Bun.write(Bun.stdout, `${JSON.stringify(sample)}\n`);
}

try {
    await main();
    process.exit(0);
} catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(2);
}
