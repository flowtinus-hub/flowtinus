import { formatMetric, formatMs as ms } from '#perf/format';
import type { ResultLine } from '#perf/results';
import type { RulerResult, Sample, Scenario } from '#perf/scenario';
import { median, spread } from '#perf/stats';

/*
 * The report, as plain text on the terminal: what a scenario is about to do, then its rulers (median, spread and the
 * previous result beside them), its components' active and waiting time, the fake API's counters and each run's
 * status, and a summary at the end. Plain text only, so it can be piped or pasted.
 */

/** as the report page's "noisy": a spread of the engine time over the last NOISE_WINDOW executions above this share of its median */
const NOISE_LIMIT = 0.1;
const NOISE_WINDOW = 3;

export { formatMetric };

function table(rows: string[][], indent = '  '): string {
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]?.length ?? 0)));
    return rows
        .map(
            r =>
                indent +
                r
                    .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
                    .join('   ')
                    .trimEnd(),
        )
        .join('\n');
}

const counted = (line: ResultLine) => line.samples.filter(s => s.record.status !== 'failed');

const engineTime = (line: ResultLine) => {
    const runs = counted(line);
    return (
        line.rulers.find(r => r.metric === 'durationMs')?.median ?? (runs.length ? median(runs.map(s => s.record.durationMs)) : undefined)
    );
};

/**
 * How much the engine time varied between the last NOISE_WINDOW executions of a scenario (`history`: its complete
 * executions at one size on this machine, oldest first, whatever their commit): (max − min) ÷ median of their engine
 * times, as the report page's "noisy". None with fewer than 2 executions.
 */
export function noise(history: ResultLine[]): number | undefined {
    const times = history
        .filter(l => !l.partial)
        .slice(-NOISE_WINDOW)
        .map(engineTime)
        .filter((t): t is number => t !== undefined);
    if (times.length < 2) {
        return undefined;
    }

    const middle = median(times);
    const { min, max } = spread(times);
    return middle ? (max - min) / middle : undefined;
}

export function printPlan(
    scenario: Scenario,
    options: {
        runs: number;
        quick: boolean;
        size: number;
        warmup: boolean;
    },
    previous?: RulerResult[],
) {
    const before = previous?.find(r => r.metric === 'durationMs')?.median;
    const estimate =
        before === undefined ? 'no estimate yet' : `about ${ms(before * (options.runs + (options.warmup ? 1 : 0)))} of engine time`;
    console.log(`\n▶ ${scenario.id}: ${scenario.description}`);
    console.log(
        `  services: ${scenario.services.join(', ') || 'none'} · size ${options.size.toLocaleString('en-US')} · ${options.runs} run(s)${options.warmup ? ' + 1 warm-up' : ''}${options.quick ? ' (quick)' : ''} · ${estimate}`,
    );
}

export function printRun(sample: Sample, runs: number) {
    const what = sample.warmup ? 'warm-up' : `run ${sample.iteration}/${runs}`;
    const error = sample.record.error ? `: ${sample.record.error}` : '';
    console.log(`  ${what}: ${sample.record.status} in ${ms(sample.record.durationMs)}${error}`);
}

/** `history`: the scenario's complete executions at this size on this machine, oldest first, this one last */
export function printScenario(line: ResultLine, elapsedMs: number, history: ResultLine[] = [line]) {
    const runs = counted(line);
    const failed = line.samples.length - runs.length;
    console.log(
        `\n  ${line.scenario.id} · ${line.git.sha.slice(0, 7)}${line.git.dirty ? '-dirty' : ''} · ${line.machine.cpuModel} ×${line.machine.cores} · ${runs.length} run(s) counted${failed ? `, ${failed} failed` : ''}`,
    );
    console.log(
        table([
            ['metric', 'better', 'median', 'min', 'max', 'previous'],
            ...line.rulers.map(r =>
                r.median === undefined
                    ? [
                          r.metric,
                          r.direction === 'lower-is-better' ? 'lower' : 'higher',
                          'unavailable',
                          '',
                          '',
                          formatMetric(r.metric, r.previous),
                      ]
                    : [
                          r.metric,
                          r.direction === 'lower-is-better' ? 'lower' : 'higher',
                          formatMetric(r.metric, r.median),
                          formatMetric(r.metric, r.min),
                          formatMetric(r.metric, r.max),
                          formatMetric(r.metric, r.previous),
                      ],
            ),
        ]),
    );

    const labels = runs[0]?.record.components.map(c => c.label) ?? [];
    const componentRows = labels
        .map(label => {
            const of = (key: 'activeTimeMs' | 'waitingMs') => {
                const values = runs
                    .map(s => s.record.components.find(c => c.label === label)?.[key])
                    .filter((v): v is number => typeof v === 'number');
                return values.length ? median(values) : undefined;
            };
            return { label, active: of('activeTimeMs'), waiting: of('waitingMs') };
        })
        .filter(c => c.active !== undefined || c.waiting !== undefined)
        .sort((a, b) => (b.active ?? 0) - (a.active ?? 0));
    if (componentRows.length) {
        console.log('');
        console.log(
            table([
                ['component', 'active', 'waiting'],
                ...componentRows.map(c => [c.label, formatMetric('activeMs', c.active), formatMetric('waitingMs', c.waiting)]),
            ]),
        );
    }

    const stats = runs.map(s => s.fakeApi).filter(s => s !== undefined);
    if (stats.length) {
        const of = (key: 'requests' | 'failures' | 'p50Ms' | 'p95Ms') => median(stats.map(s => s[key]));
        console.log(
            `\n  fake API (median per run): ${of('requests')} requests, ${of('failures')} failures, p50 ${ms(of('p50Ms'))}, p95 ${ms(of('p95Ms'))}`,
        );
    }

    const memory = runs.map(s => s.memory.samples);
    if (memory.length) {
        console.log(`  memory samples per run: ${Math.min(...memory)} to ${Math.max(...memory)}`);
    }

    const spreadOfTime = noise(history);
    if (spreadOfTime !== undefined && spreadOfTime > NOISE_LIMIT) {
        const last = Math.min(history.filter(l => !l.partial).length, NOISE_WINDOW);
        console.log(
            `  noisy: the engine time varied ${Math.round(spreadOfTime * 100)} % of its median over the last ${last} executions (run again, or on a quieter machine, before reading small changes)`,
        );
    }

    console.log(`  took ${ms(elapsedMs)}; result saved in results/`);
}

export function printSummary(lines: ResultLine[], failures: string[]) {
    if (lines.length + failures.length < 2) {
        return;
    }

    console.log('\nSummary');
    console.log(
        table([
            ['scenario', 'runs', 'durationMs', 'status'],
            ...lines.map(line => {
                const runs = counted(line);
                const duration =
                    line.rulers.find(r => r.metric === 'durationMs')?.median ??
                    (runs.length ? median(runs.map(s => s.record.durationMs)) : undefined);
                return [
                    line.scenario.id,
                    String(runs.length),
                    formatMetric('durationMs', duration),
                    runs.length === line.samples.length ? 'ok' : `${line.samples.length - runs.length} failed`,
                ];
            }),
            ...failures.map(id => [id, '0', '-', 'not run']),
        ]),
    );
}
