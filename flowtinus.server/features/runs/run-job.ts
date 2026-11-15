import { eq } from 'drizzle-orm';
import { applyRunFrom, flowRunner, type RunFromPlan, startConfig, START, toExecutableFlow, type ConnectionProfileData, type ExecutableFlow, type FlowFile, type OAuthTokenSource, type QueueFlow, type RunMode, type RunProgress, type RunRecord, type SendHttp } from '@flowtinus/core';
import { ConnectionRepository } from '#features/connections/connection-store';
import { projects } from '#features/projects/project';
import { workspaces } from '#features/workspaces/workspace';
import { scriptBlobs } from '#features/scripts/script-store';
import { workspaceSecrets } from '#features/secrets/secret-store';
import { VariableRepository } from '#features/variables/variable-repository';
import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import { createEvaluate } from '#shared/runner/evaluate';
import { prepareScript } from '#shared/runner/prepare-script';
import { querySqlServer } from '#shared/runner/sqlserver-driver';
import { queryRedshift } from '#shared/runner/redshift-driver';
import { writeRedshift } from '#shared/runner/redshift-write-driver';
import { executeRedshift } from '#shared/runner/redshift-execute-driver';
import { writeSqlServer } from '#shared/runner/sqlserver-write-driver';
import { executeSqlServer } from '#shared/runner/sqlserver-execute-driver';
import { aggregateMongoDb, deleteMongoDb, upsertMongoDb } from '#shared/runner/mongodb-driver';
import { sendHttp } from '#shared/runner/send-http';
import type { Run } from './run';
import type { CallChain } from './run-queue';
import type { CalledFlow } from './start-run/called-flows';

/** the code of scripts by hash, kept in the supervisor (a hash is one code forever): the latest few MB */
const blobCache = new Map<string, string>();
const BLOB_CACHE_BYTES = 64 * 1024 * 1024;
let blobCacheBytes = 0;

const remember = (hash: string, content: string) => {
    blobCache.set(hash, content);
    blobCacheBytes += content.length;
    for (const [old, value] of blobCache) {
        if (blobCacheBytes <= BLOB_CACHE_BYTES) {
            break;
        }
        blobCache.delete(old);
        blobCacheBytes -= value.length;
    }
};

async function scriptsOfRun(db: Database, workspaceId: string, hashes: Record<string, string>) {
    const missing = Object.values(hashes).filter(hash => !blobCache.has(hash));
    for (const [hash, content] of await scriptBlobs(db, workspaceId, [...new Set(missing)])) {
        remember(hash, content);
    }
    const scripts: Record<string, string> = {};
    for (const [path, hash] of Object.entries(hashes)) {
        const content = blobCache.get(hash);
        if (content === undefined) {
            throw new Error(`The script ${path} of this run is gone.`);
        }
        blobCache.delete(hash);
        blobCache.set(hash, content);
        scripts[path] = content;
    }
    return { scripts, scriptHashes: hashes };
}

export const RUN_TIMEOUT_MS = 10 * 60_000;

/**
 * Everything a worker needs to run one flow, and nothing else: it never reads the database. The supervisor prepares
 * it (secrets decrypted there) and hands it to the worker, which keeps it in memory for that run only. Plain data:
 * it crosses to the worker process as JSON.
 */
export type RunJob = {
    id: string;
    mode: RunMode;
    flow: ExecutableFlow;
    parameters: Record<string, string>;
    input?: unknown;
    secrets: Record<string, string>;
    variables: Record<string, string>;
    connections: Record<string, ConnectionProfileData>;
    runFrom?: RunFromPlan;
    flows?: Record<string, ExecutableFlow>;
    chain?: string[];
    rootName?: string;
    maxFireAndForgetRuns?: number;
    scripts?: Record<string, string>;
    scriptHashes?: Record<string, string>;
    workspaceName: string;
    projectName: string;
    flowName: string;
};

export function failedRecord(
    run: { id: string; mode: RunMode; workspaceName?: string; projectName: string; flowName: string; startedAt?: Date },
    error: string,
): RunRecord {
    const started = run.startedAt ?? new Date();
    return {
        run: {
            id: run.id,
            mode: run.mode,
            workspace: run.workspaceName ?? '',
            project: run.projectName,
            flow: run.flowName,
            startedAt: started.toISOString(),
        },
        parameters: {},
        status: 'failed',
        end: new Date().toISOString(),
        durationMs: Date.now() - started.getTime(),
        error,
        components: [],
    };
}

export function stoppedRecord(progress: RunProgress | null, run: Parameters<typeof failedRecord>[0], error: string): RunRecord {
    if (!progress) {
        return failedRecord(run, error);
    }

    return { ...progress, status: 'failed', end: new Date().toISOString(), error };
}

export async function prepareJob(db: Database, keyring: Keyring | undefined, run: Run): Promise<RunJob> {
    const file = run.definition as FlowFile | null;
    if (!file || !run.projectId) {
        throw new Error('The run has no flow to run.');
    }

    const [project] = await db.orm.select({ name: projects.name }).from(projects).where(eq(projects.id, run.projectId));
    const [workspace] = await db.orm.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, run.workspaceId));
    const [secretRows, connectionRows, variableRows] = await Promise.all([
        workspaceSecrets(db, run.workspaceId),
        new ConnectionRepository(db, run.workspaceId).all(),
        new VariableRepository(db, run.workspaceId).all(),
    ]);

    const secrets: Record<string, string> = {};
    if (secretRows.length > 0 && !keyring) {
        throw new Error('The server has no keyring: the workspace secrets cannot be read.');
    }

    for (const secret of secretRows) {
        secrets[secret.name] = await keyring!.decrypt(secret, secret.id, secret.name);
    }

    const { acceptsInput, testInput } = startConfig(file.nodes.find(n => n.type === START)?.config ?? {});
    const input = run.input ?? (acceptsInput && testInput.trim() ? JSON.parse(testInput) : undefined);
    const projectName = project?.name ?? '';
    const workspaceName = workspace?.name ?? '';
    const whole = { ...toExecutableFlow(file, projectName, workspaceName), id: run.flowId };
    const from = run.runFrom as RunFromPlan | null;
    // the called flows, as they were when queued: one that cannot be called still names itself (each call is an error)
    const flows = Object.fromEntries(
        ((run.calledFlows as CalledFlow[] | null) ?? []).map((c): [string, ExecutableFlow] => [
            c.id,
            {
                ...(c.flow
                    ? toExecutableFlow(c.flow, projectName, workspaceName)
                    : { workspace: workspaceName, project: projectName, flow: c.name, parameters: [], nodes: [], edges: [] }),
                id: c.id,
                ...(c.path ? { path: c.path } : {}),
                ...(c.inputType ? { inputType: c.inputType } : {}),
                ...(c.unavailable ? { unavailable: c.unavailable } : {}),
            },
        ]),
    );
    const chain = run.callChain as CallChain | null;
    return {
        id: run.id,
        mode: run.mode,
        flow: from ? applyRunFrom(whole, from) : whole,
        ...(from ? { runFrom: from } : {}),
        ...(Object.keys(flows).length ? { flows } : {}),
        ...(chain ? { chain: chain.flows, rootName: chain.rootName } : {}),
        ...(await scriptsOfRun(db, run.workspaceId, (run.scripts as Record<string, string> | null) ?? {})),
        parameters: (run.parameters as Record<string, string> | null) ?? {},
        input,
        secrets,
        variables: Object.fromEntries(variableRows.map(v => [v.name, v.value])),
        connections: Object.fromEntries(connectionRows.map(c => [c.id, { name: c.name, type: c.type, config: c.config }])),
        workspaceName,
        projectName,
        flowName: file.name,
    };
}

export async function runJob(
    job: RunJob,
    options: {
        http?: SendHttp;
        onProgress?: (progress: RunProgress) => void;
        signal?: AbortSignal;
        oauthTokens?: OAuthTokenSource;
        queueFlow?: QueueFlow;
    } = {},
): Promise<RunRecord> {
    try {
        return await flowRunner(job.flow, {
            mode: job.mode,
            id: job.id,
            parameterValues: job.parameters,
            // one expression context for the whole run (and the flows it calls), never shared with another run
            evaluate: createEvaluate(),
            http: options.http ?? sendHttp,
            // the databases' drivers (SQL Server Query, Redshift Query; MongoDB Pipeline, Upsert, Delete): in a test run, what writes does
            // not reach them (the engine's gate), a Delete only counts
            databases: { sqlserver: querySqlServer, redshift: queryRedshift },
            databaseWrites: { redshift: writeRedshift, sqlserver: writeSqlServer },
            databaseExecutes: { redshift: executeRedshift, sqlserver: executeSqlServer },
            documentQueries: { mongodb: aggregateMongoDb },
            documentStores: { mongodb: upsertMongoDb },
            documentDeletes: { mongodb: deleteMongoDb },
            secrets: job.secrets,
            variables: job.variables,
            connections: job.connections,
            input: job.input,
            timeoutMs: RUN_TIMEOUT_MS,
            onProgress: options.onProgress,
            runFrom: job.runFrom,
            flows: job.flows,
            ...(job.chain ? { chain: job.chain, rootName: job.rootName } : {}),
            ...(job.maxFireAndForgetRuns !== undefined ? { maxFireAndForgetRuns: job.maxFireAndForgetRuns } : {}),
            ...(options.queueFlow ? { queueFlow: options.queueFlow } : {}),
            prepareScript: (code, globals) => prepareScript(code, globals, job.scripts ?? {}, job.scriptHashes ?? {}),
            signal: options.signal,
            ...(options.oauthTokens ? { oauthTokens: options.oauthTokens } : {}),
        });
    } catch (e) {
        // the engine masks what it writes; an error thrown past it is masked here
        const message = Object.values(job.secrets)
            .filter(value => value.length > 0)
            .reduce((text, value) => text.split(value).join('***'), e instanceof Error ? e.message : String(e));
        return failedRecord({ ...job }, message);
    }
}
