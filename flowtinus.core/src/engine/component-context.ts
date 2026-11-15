import { NOT_A_PATH, readPath } from '#envelope/field-path';
import { timed, timedRequests } from '#engine/stopwatch';
import { checkedCall, invokeFlow, queueFlow } from '#engine/invoke-flow';
import { runIteration } from '#engine/loop-iteration';
import { LOOP_CONTROL_LABEL } from '#components/built-in/loop-control';
import { envelopeVariables } from '#envelope/expression-variables';
import { toError } from '#errors/normalize-error';
import { API_CONNECTION_TYPES, connectionHeaders, connectionString, findProfile, resolveConnection, type ConnectionUse } from '../connections/connection-access';
import { cachedAccessTokens, oauthFingerprint, oauthTokenFromMemory } from '../connections/oauth-token-cache';
import { retryDelayMs, sleep } from '#engine/http-retry';
import type { FlowExecution } from '#engine/flow-execution';
import type { ComponentContext } from '#types/component-context.type';
import type { ExecutableNode } from '#types/executable-node.type';

const WRITE_COUNTS = ['inserted', 'updated', 'deleted', 'affected', 'batches', 'failed'] as const;

const LOGGED_UPSERTS = 3;
const BODY_EXCERPT = 300;

const runTokens = new WeakMap<object, Set<string>>();
const tokensOf = (options: object) => {
    let tokens = runTokens.get(options);
    if (!tokens) {
        tokens = new Set();
        runTokens.set(options, tokens);
    }
    return tokens;
};

/** Values a run never shows, longest first so one that contains another is hidden whole. */
export const hiddenValues = (options: { secrets?: Record<string, string> }): string[] =>
    [...new Set([...Object.values(options.secrets ?? {}), ...tokensOf(options), ...cachedAccessTokens()])]
        .filter(v => v.length >= 4)
        .sort((a, b) => b.length - a.length);

export const maskText = (text: string, hidden: string[]) => hidden.reduce((t, secret) => t.split(secret).join('***'), text);

export function componentContext(
    execution: FlowExecution,
    node: ExecutableNode,
    log: ComponentContext['log'],
    dryRun = false,
    warn: ComponentContext['warn'] = message => log('warning', message),
): ComponentContext {
    const { run, options, parameters } = execution;
    const stopwatch = execution.stopwatchOf(node.id);
    const waiting = execution.waitingOf(node.id);
    let logged = 0;
    let inFlight = 0;
    const mask = (text: string) => maskText(text, hiddenValues(options));
    // inside a loop region: the loop index of the Loop that holds it
    const placeVariables: Record<string, unknown> = options.loop ? { $_loopIndex: options.loop.index } : {};
    const database = (type: 'sqlserver' | 'redshift' | 'mongodb', use: ConnectionUse) => {
        const resolved = resolveConnection(type, use, options.connections, options.secrets);
        return { connection: connectionString(resolved), database: resolved.config.database ?? '' };
    };
    return {
        run,
        parameters,
        node,
        log,
        warn,
        prepareScript: async code => {
            if (!options.prepareScript) {
                throw new Error('This runner does not execute scripts.');
            }
            // what the script waits for outside (its fetch, its timers): Waiting, not Active; several at once count once
            let outside = 0;
            const wait = async <T>(promise: Promise<T>): Promise<T> => {
                if (outside++ === 0) {
                    stopwatch.stop();
                    waiting.resume();
                }
                try {
                    return await promise;
                } finally {
                    if (--outside === 0) {
                        waiting.stop();
                        stopwatch.resume();
                    }
                }
            };
            const script = await options.prepareScript(code, {
                run,
                parameters,
                secrets: options.secrets ?? {},
                variables: options.variables ?? {},
                log: (m, level = 'info') => log(level, m),
                wait,
            });
            return (input: unknown) => {
                stopwatch.resume();
                return script(input);
            };
        },
        fieldValue: (field, doc, variables) => {
            if (!field.expression) {
                return field.value;
            }
            stopwatch.resume();
            const extra = variables ? { ...placeVariables, ...variables } : placeVariables;
            // an expression that only reads a value ($email, $customer.city): read straight, the same value (field-path.ts)
            const direct = readPath(field.value, doc, options.secrets, options.variables, extra);
            if (direct !== NOT_A_PATH) {
                return direct;
            }
            return options.evaluate(field.value, envelopeVariables(doc, options.secrets, options.variables, extra));
        },
        wait: async promise => {
            stopwatch.stop();
            try {
                return await promise;
            } finally {
                stopwatch.resume();
            }
        },
        waitEach: source => timed(source, stopwatch),
        // only Stop, the timeout, a thrown error and a Next (an iteration's) abort the control: a normal end never does
        endedEarly: () => execution.control.signal.aborted,
        invokeFlow: (flowId, call) => {
            const called = invokeFlow(execution, node, flowId, call);
            return { ...called, envelopes: timedRequests(called.envelopes, waiting) };
        },
        runIteration: (state, iteration) => {
            const run = runIteration(execution, node, state, iteration);
            return { ...run, envelopes: timedRequests(run.envelopes, waiting) };
        },
        reachLoop: (control, doc) => {
            if (!options.loop) {
                throw new Error(`A ${LOOP_CONTROL_LABEL[control]} works only inside a Loop.`);
            }
            options.loop.reach(control, doc);
        },
        queueFlow: async (flowId, call) => {
            stopwatch.stop();
            waiting.resume();
            try {
                return await queueFlow(execution, node, flowId, call);
            } finally {
                waiting.stop();
                stopwatch.resume();
            }
        },
        checkFlowCall: (flowId, input) => void checkedCall(execution, flowId, input),
        ...(options.maxFireAndForgetRuns !== undefined ? { maxFireAndForgetRuns: options.maxFireAndForgetRuns } : {}),
        queryDatabase: (kind, { connection: use, ...query }) => {
            const driver = options.databases?.[kind];
            if (!driver) {
                throw new Error(`This runner does not query ${kind}.`);
            }
            const { connection } = database(kind, use);
            // only the pull of the next row: while the component is held by the next one (backpressure), it is not waiting here
            return timedRequests(driver({ ...query, connection, signal: execution.control.signal }), waiting);
        },
        aggregateDocuments: (kind, { connection: use, ...query }) => {
            const driver = options.documentQueries?.[kind];
            if (!driver) {
                throw new Error(`This runner does not read from ${kind}.`);
            }
            const { connection, database: fallback } = database(kind, use);
            return timedRequests(
                driver({ ...query, database: query.database || fallback, connection, signal: execution.control.signal }),
                waiting,
            );
        },
        writeRows: async (kind, { connection: use, ...write }) => {
            const driver = options.databaseWrites?.[kind];
            if (!driver) {
                throw new Error(`This runner does not write to ${kind}.`);
            }
            const { connection } = database(kind, use);
            if (dryRun) {
                const what =
                    write.mode === 'insert'
                        ? 'insert(s)'
                        : `${write.mode}(s) (match on ${(write.mode === 'delete' ? write.columns : (write.match ?? [])).join(', ')})`;
                log('info', `Test run: ${write.rows.length} ${what} ${write.mode === 'delete' ? 'from' : 'into'} ${write.table} not sent.`);
                for (const [index, row] of write.rows.slice(0, Math.max(0, LOGGED_UPSERTS - logged)).entries()) {
                    logged += 1;
                    const expected = write.conditions
                        ? `; expected ${JSON.stringify(Object.fromEntries(write.conditions.columns.map((c, i) => [c, write.conditions!.rows[index]![i]])))}`
                        : '';
                    log(
                        'info',
                        `Would ${write.mode === 'delete' ? 'delete from' : 'write into'} ${write.table}: ${JSON.stringify(Object.fromEntries(write.columns.map((c, i) => [c, row[i]])))}${expected}`,
                    );
                }
                return null;
            }
            stopwatch.stop();
            try {
                waiting.resume();
                return await driver({ ...write, connection, signal: execution.control.signal });
            } finally {
                waiting.stop();
                stopwatch.resume();
            }
        },
        executeSql: async (kind, { connection: use, ...execute }) => {
            const driver = options.databaseExecutes?.[kind];
            if (!driver) {
                throw new Error(`This runner does not run SQL on ${kind}.`);
            }
            const { connection } = database(kind, use);
            if (dryRun) {
                if (logged < LOGGED_UPSERTS) {
                    logged += 1;
                    log('info', `Test run: SQL not run (it would ${execute.atEnd} at the end): ${execute.sql.trim()}`);
                    if (Object.keys(execute.parameters).length) {
                        log('info', `With the parameters ${JSON.stringify(execute.parameters)}`);
                    }
                }
                return null;
            }
            stopwatch.stop();
            try {
                waiting.resume();
                return await driver({ ...execute, connection, signal: execution.control.signal });
            } finally {
                waiting.stop();
                stopwatch.resume();
            }
        },
        upsertDocuments: async (kind, { connection: use, ...given }) => {
            const driver = options.documentStores?.[kind];
            if (!driver) {
                throw new Error(`This runner does not write to ${kind}.`);
            }
            const { connection, database: fallback } = database(kind, use);
            const batch = { ...given, database: given.database || fallback };
            if (dryRun) {
                const target = `${batch.database}.${batch.collection}`;
                log('info', `Test run: ${batch.upserts.length} upsert(s) into ${target} not sent.`);
                for (const upsert of batch.upserts.slice(0, Math.max(0, LOGGED_UPSERTS - logged))) {
                    logged += 1;
                    log(
                        'info',
                        `Would upsert into ${target}: filter ${JSON.stringify(upsert.filter)}, ${batch.writeMode === 'replace' ? 'replacement' : '$set'} ${JSON.stringify(upsert.document)}`,
                    );
                }
                return null;
            }
            stopwatch.stop();
            try {
                waiting.resume();
                return await driver({ ...batch, connection, signal: execution.control.signal });
            } finally {
                waiting.stop();
                stopwatch.resume();
            }
        },
        deleteDocuments: async (kind, { connection: use, ...given }) => {
            const driver = options.documentDeletes?.[kind];
            if (!driver) {
                throw new Error(`This runner does not delete from ${kind}.`);
            }
            const { connection, database: fallback } = database(kind, use);
            const request = { ...given, database: given.database || fallback };
            const target = `${request.database}.${request.collection}`;
            stopwatch.stop();
            waiting.resume();
            try {
                const n = await driver({ ...request, connection, countOnly: dryRun, signal: execution.control.signal });
                if (!dryRun) {
                    return { deleted: n };
                }
                log('info', `Test run: ${n} document(s) of ${target} match the filter ${JSON.stringify(request.filter)}; none deleted.`);
                return { notSent: true, matched: n };
            } finally {
                waiting.stop();
                stopwatch.resume();
            }
        },
        sendHttp: async ({ auth, retry, ...given }) => {
            if (!options.http) {
                throw new Error('This runner does not send HTTP requests.');
            }
            const http = options.http;
            if (!dryRun && inFlight++ === 0) {
                waiting.resume();
            }
            try {
                // an API connection: its headers first (an OAuth 2.0 token from the run's token source, see RunOptions.oauthTokens), the component's own win
                let request = given;
                let oauth: { name: string; renew: (refused?: string) => Promise<string> } | undefined;
                let token: string | undefined;
                if (auth) {
                    const resolved = resolveConnection('http-client', auth, options.connections, options.secrets, API_CONNECTION_TYPES);
                    if (resolved.type === 'rest-oauth2' && !dryRun) {
                        const fingerprint = oauthFingerprint(resolved);
                        const found = 'profile' in auth ? findProfile(options.connections, auth.profile) : undefined;
                        const key = found ? `profile:${found.id}` : `inline:${fingerprint}`;
                        const name = 'profile' in auth ? (found?.profile.name ?? auth.profile) : 'of the HTTP Request';
                        const source = options.oauthTokens ?? (r => oauthTokenFromMemory(r, http, execution.control.signal));
                        oauth = {
                            name,
                            renew: async refused => {
                                const got = await source({
                                    key,
                                    fingerprint,
                                    connection: resolved,
                                    timeoutMs: given.timeoutMs,
                                    ...(refused ? { refused } : {}),
                                });
                                tokensOf(options).add(got.accessToken);
                                if (got.askedMs !== undefined) {
                                    log('debug', `OAuth 2.0 token from ${mask(resolved.config.tokenUrl ?? '')} in ${got.askedMs} ms.`);
                                }
                                return got.accessToken;
                            },
                        };
                        token = await oauth.renew();
                    }
                    request = { ...given, headers: { ...connectionHeaders(resolved, token), ...given.headers } };
                }
                if (dryRun) {
                    const body =
                        request.body === undefined
                            ? ''
                            : `, body ${mask(request.body.slice(0, BODY_EXCERPT))}${request.body.length > BODY_EXCERPT ? '…' : ''}`;
                    log('info', `Test run: ${request.method} ${mask(request.url)} not sent${body}.`);
                    return null;
                }
                const signal = execution.control.signal;
                const once = async (sent: typeof request) => {
                    const t0 = performance.now();
                    const response = await http({ ...sent, signal });
                    log('debug', `${sent.method} ${mask(sent.url)} → ${response.status} in ${Math.round(performance.now() - t0)} ms.`);
                    return response;
                };
                const send = async (sent: typeof request) => {
                    let response = await once(sent);
                    for (let attempt = 0; retry && attempt < retry.retries && retry.statuses.includes(response.status); attempt++) {
                        const wait = retryDelayMs(attempt, response.headers['retry-after'], retry.maxWaitMs);
                        if (wait === undefined) {
                            log(
                                'warning',
                                `${sent.method} ${mask(sent.url)} → ${response.status}; its Retry-After (${response.headers['retry-after']}) is longer than the longest wait (${Math.round(retry.maxWaitMs / 1000)} s): not retried.`,
                            );
                            break;
                        }
                        log(
                            'warning',
                            `${sent.method} ${mask(sent.url)} → ${response.status}: retry ${attempt + 1} of ${retry.retries} in ${(wait / 1000).toFixed(1)} s.`,
                        );
                        await sleep(wait, signal);
                        response = await once(sent);
                    }
                    return response;
                };
                const response = await send(request);
                if (response.status !== 401 || !oauth || !token) {
                    return response;
                }
                // 401 with an OAuth 2.0 token (expired early, revoked, the process's one from before): a new token, the request once more
                log('debug', `401 with the OAuth 2.0 token of the connection "${oauth.name}": asking a new one and sending again.`);
                const renewed = await oauth.renew(token);
                const again = await send({
                    ...request,
                    headers: { ...request.headers, Authorization: `Bearer ${renewed}`, ...given.headers },
                });
                if (again.status === 401) {
                    throw new Error(
                        `${request.method} ${request.url} answered 401 (Unauthorized) again with a new OAuth 2.0 token of the connection "${oauth.name}".`,
                    );
                }
                return again;
            } catch (e) {
                throw new Error(mask(toError(e).message));
            } finally {
                if (!dryRun && --inFlight === 0) {
                    waiting.stop();
                }
            }
        },
        mask,
        holding: (envelopes, held) => {
            stopwatch.resume();
            execution.memoryOf(node.id).holding(envelopes, held);
        },
        wrote: (target, counts) => {
            if (dryRun) {
                return;
            }
            const writes = (execution.recordOf(node.id).writes ??= {});
            const total = (writes[target] ??= { inserted: 0, updated: 0, deleted: 0, affected: 0, batches: 0, failed: 0 });
            for (const key of WRITE_COUNTS) {
                total[key] += counts[key] ?? 0;
            }
        },
    };
}
