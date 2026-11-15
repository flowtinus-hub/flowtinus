import { formatMetric } from '#perf/format';
import { changeOf, compareComponents, compareMetrics, commitUrl, counted, defaultSelection, executionsOf, failedRuns, machines, median, NOISE_LIMIT, noise, parseResults, seriesOf, shortCommit, sizesOf, summaries, type Change, type ReportLine, type ScenarioSummary } from './model';

/*
 * The report page: reads the results (results/*.jsonl, served by `bun run perf --serve`, or picked from disk when the
 * page is opened as a file) and shows an overview of every scenario (a strip of totals, the slower ones called out),
 * then a scenario's latest numbers, history, where its time goes and its executions, and the executions you pick
 * compared side by side. Everything the view depends on is in the URL's hash (#/s/<id>?size=&sel=), so back, reload
 * and a shared link show the same thing.
 */

const app = document.getElementById('app')!;
let all: ReportLine[] = [];
let source = '';
let host = '';

const esc = (text: unknown) =>
    String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const value = (metric: string, v: number | undefined) => (v === undefined ? '<span class="muted">–</span>' : esc(formatMetric(metric, v)));

const delta = (change: Change | undefined) => (change ? `<span class="delta ${change.kind}">${esc(change.text)}</span>` : '');

/** the short sha, a link to the commit on GitHub when the line has one */
const commit = (line: ReportLine) => {
    const url = commitUrl(line);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(shortCommit(line))}</a>` : esc(shortCommit(line));
};

const directionText = (d: string) => (d === 'lower-is-better' ? 'lower is better' : 'higher is better');

type Route = { view: 'overview' } | { view: 'scenario'; id: string; size?: number; selected?: string[] };

function currentRoute(): Route {
    const [path = '', query = ''] = location.hash.slice(1).split('?');
    const found = path.match(/^\/s\/(.+)$/);
    if (!found) {
        return { view: 'overview' };
    }

    const params = new URLSearchParams(query);
    const size = Number(params.get('size'));
    const sel = params.get('sel');
    return {
        view: 'scenario',
        id: decodeURIComponent(found[1]!),
        ...(size ? { size } : {}),
        ...(sel !== null ? { selected: sel.split(',').filter(Boolean) } : {}),
    };
}

function scenarioLink(id: string, size?: number, selected?: string[]) {
    const params = new URLSearchParams();
    if (size) {
        params.set('size', String(size));
    }

    if (selected) {
        params.set('sel', selected.join(','));
    }

    const query = params.toString();
    return `#/s/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}

const badges = (line: ReportLine) =>
    [
        line.partial ? '<span class="badge warn">partial</span>' : '',
        failedRuns(line) ? `<span class="badge worse">${failedRuns(line)} failed</span>` : '',
        (noise(line) ?? 0) > NOISE_LIMIT
            ? `<span class="badge warn" title="the engine's time varied more than ${NOISE_LIMIT * 100} % of its median between runs">noisy</span>`
            : '',
        line.scenario.quick ? '<span class="badge">quick</span>' : '',
        line.git.dirty ? '<span class="badge" title="uncommitted changes">dirty</span>' : '',
    ].join(' ');

/** a tile of the strip at the top of a view: a label, a big value and a line under it; tone colours the value */
const stat = (label: string, valueHtml: string, subHtml = '', tone = '') =>
    `<div class="stat ${tone}"><div class="stat-label">${esc(label)}</div><div class="stat-value">${valueHtml}</div><div class="stat-sub">${subHtml}</div></div>`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** the overview's totals, and the scenarios slower than their previous execution, the worst first */
function overviewStats(rows: ScenarioSummary[], lines: ReportLine[]): string {
    const faster = rows.filter(r => r.change?.kind === 'better').length;
    const slower = rows.filter(r => r.change?.kind === 'worse').length;
    const noisy = rows.filter(r => (noise(r.latest) ?? 0) > NOISE_LIMIT).length;
    const last = lines.filter(l => !l.partial).at(-1);
    const worst = rows.filter(r => r.change?.kind === 'worse').sort((a, b) => b.change!.ratio - a.change!.ratio);
    const alert = worst.length
        ? `<section class="callout worse" role="status">
  <strong>${plural(worst.length, 'scenario is', 'scenarios are')} slower than the previous execution</strong>
  <ul class="chips">${worst.map(r => `<li><a href="${scenarioLink(r.id)}">${esc(r.id)}</a> ${delta(r.change)}</li>`).join('')}</ul>
</section>`
        : '';
    return `<div class="stats">
${stat('scenarios', rows.length.toLocaleString('en-US'), `${plural(lines.length, 'execution', 'executions')} on this machine`)}
${stat('faster', String(faster), 'vs previous execution', faster ? 'better' : '')}
${stat('slower', String(slower), 'vs previous execution', slower ? 'worse' : '')}
${stat('noisy', String(noisy), `varied more than ${NOISE_LIMIT * 100} % between runs`, noisy ? 'warn' : '')}
${stat('last execution', last ? `<span class="stat-text">${esc(when(last.at))}</span>` : '–', last ? `${commit(last)} · ${esc(last.scenario.id)}` : '')}
</div>
${alert}`;
}

/** the first metrics of a scenario's latest complete execution, against the one before it */
function scenarioStats(executions: ReportLine[]): string {
    const complete = executions.filter(l => !l.partial);
    const latest = complete.at(-1);
    const previous = complete.at(-2);
    if (!latest) {
        return '';
    }

    const metrics = latest.rulers.filter(r => !r.metric.startsWith('component.')).slice(0, 4);
    return `<div class="stats">
${metrics
    .map(r => {
        const change = changeOf(r.median, previous?.rulers.find(p => p.metric === r.metric)?.median, r.direction);
        const spread =
            r.min !== undefined && r.max !== undefined && r.min !== r.max
                ? `range ${esc(formatMetric(r.metric, r.min))} – ${esc(formatMetric(r.metric, r.max))}`
                : directionText(r.direction);
        const tone = change?.kind === 'worse' ? 'worse' : change?.kind === 'better' ? 'better' : '';
        return stat(r.metric, esc(formatMetric(r.metric, r.median)), `${delta(change)} ${spread}`.trim(), tone);
    })
    .join('')}
${stat('runs', `${counted(latest).length}/${latest.samples.length}`, `${esc(when(latest.at))} · ${commit(latest)}`)}
</div>`;
}

/** one execution's components as bars of active and waiting time, the busiest first */
function breakdown(line: ReportLine): string {
    const rows = compareComponents([line]);
    if (!rows.length) {
        return '';
    }

    const total = (r: (typeof rows)[number]) => (r.active[0] ?? 0) + (r.waiting[0] ?? 0);
    const max = Math.max(...rows.map(total), 1);
    const pct = (v: number | undefined) => `${(((v ?? 0) / max) * 100).toFixed(2)}%`;
    const body = rows
        .map(
            r => `<div class="bd-row">
  <div class="bd-label">${esc(r.label)} <span class="muted small">${esc(r.type)}</span></div>
  <div class="bd-track" title="active ${esc(formatMetric('activeMs', r.active[0]))} · waiting ${esc(formatMetric('waitingMs', r.waiting[0]))}"><span class="bd-active" style="width:${pct(r.active[0])}"></span><span class="bd-wait" style="width:${pct(r.waiting[0])}"></span></div>
  <div class="bd-value num">${value('activeMs', r.active[0])}${r.waiting[0] ? ` <span class="muted small">+ ${esc(formatMetric('waitingMs', r.waiting[0]))} waiting</span>` : ''}</div>
</div>`,
        )
        .join('');
    return `<h2>Where the time goes <span class="muted small">${esc(when(line.at))} · ${commit(line)} · median per run</span></h2>
<div class="card breakdown">
  <div class="legend small muted"><span><i class="swatch active"></i>active (working)</span><span><i class="swatch wait"></i>waiting (database, API, called flow)</span></div>
  ${body}
</div>`;
}

function chart(
    metric: string,
    executions: ReportLine[],
    options: { width: number; height: number; selected?: string[]; select?: (at: string) => string },
): string {
    const points = seriesOf(executions, metric);
    if (!points.length) {
        return '<span class="muted small">no data</span>';
    }

    const { width, height } = options;
    const pad = 8;
    const values = points.map(p => p.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const x = (i: number) => (points.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (points.length - 1));
    const y = (v: number) => (high === low ? height / 2 : height - pad - ((v - low) * (height - 2 * pad)) / (high - low));
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const dots = points
        .map((p, i) => {
            const chosen = options.selected?.includes(p.at);
            const circle = `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${chosen ? 5 : 3}" class="${chosen ? 'chosen' : ''}"><title>${esc(`${when(p.at)} · ${p.commit} · ${formatMetric(metric, p.value)}`)}</title></circle>`;
            return options.select ? `<a href="${options.select(p.at)}">${circle}</a>` : circle;
        })
        .join('');
    return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(metric)} history"><path d="${path}"/>${dots}</svg>`;
}

function header(crumbs: string): string {
    const hosts = machines(all);
    const machine = all.find(l => l.machine.hostname === host)?.machine;
    const picker =
        hosts.length > 1
            ? `<select id="machine" aria-label="machine">${hosts.map(h => `<option ${h === host ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`
            : `<strong>${esc(host)}</strong>`;
    return `<header>
  <h1><a href="#/">Flowtinus perf</a>${crumbs}</h1>
  <p class="muted small">${picker} · ${machine ? `${esc(machine.cpuModel)} ×${machine.cores} · ${(machine.totalMemBytes / 1024 ** 3).toFixed(0)} GB · ${esc(machine.platform)}` : ''} · ${esc(source)}</p>
</header>`;
}

function overview(lines: ReportLine[]): string {
    const rows = summaries(lines);
    if (!rows.length) {
        return `${header('')}<p>No results for this machine yet: run <code>bun run perf</code>.</p>`;
    }

    const body = rows
        .map(s => {
            const history = executionsOf(lines, s.id, s.latest.scenario.size);
            return `<tr>
  <td><span class="dot ${s.change?.kind ?? 'none'}" aria-hidden="true"></span><a href="${scenarioLink(s.id)}"><strong>${esc(s.id)}</strong></a><div class="muted small desc">${esc(s.description ?? '')}</div></td>
  <td class="num">${s.latest.scenario.size.toLocaleString('en-US')}</td>
  <td class="num strong">${value('durationMs', s.time)}</td>
  <td class="num">${delta(s.change) || '<span class="muted">–</span>'}</td>
  <td>${chart('durationMs', history, { width: 140, height: 32 })}</td>
  <td class="num">${s.executions}</td>
  <td class="small">${esc(when(s.latest.at))}<div class="muted">${commit(s.latest)}</div></td>
  <td>${badges(s.latest)}</td>
</tr>`;
        })
        .join('\n');
    return `${header('')}
${overviewStats(rows, lines)}
<p class="muted small">The latest execution of each scenario on this machine. Change: its engine time against the previous execution at the same size (green: faster; red: slower; grey: less than 2 %). Open a scenario to compare its executions.</p>
<table>
<thead><tr><th>scenario</th><th class="num">size</th><th class="num">engine time</th><th class="num">change</th><th>history</th><th class="num">executions</th><th>last run</th><th></th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function comparison(id: string, size: number, chosen: ReportLine[]): string {
    if (!chosen.length) {
        return '<p class="muted">Pick executions in the table or on a chart to compare them.</p>';
    }

    const heads = chosen
        .map(
            (line, i) =>
                `<th class="num exec">${i === 0 && chosen.length > 1 ? '<span class="muted small">baseline</span><br>' : ''}${esc(when(line.at))}<br><span class="muted small">${commit(line)}</span> ${badges(line)}</th>`,
        )
        .join('');
    const metrics = compareMetrics(chosen)
        .map(
            row => `<tr>
  <td><code>${esc(row.metric)}</code><div class="muted small">${directionText(row.direction)}</div></td>
  ${row.values.map((v, i) => `<td class="num">${value(row.metric, v)} ${delta(row.changes[i])}</td>`).join('')}
</tr>`,
        )
        .join('\n');
    const components = compareComponents(chosen)
        .map(
            row => `<tr>
  <td>${esc(row.label)} <span class="muted small">${esc(row.type)}</span></td>
  ${row.active
      .map((active, i) => {
          const waiting = row.waiting[i];
          const change = i === 0 ? undefined : changeOf(active, row.active[0], 'lower-is-better');
          return `<td class="num">${value('activeMs', active)} ${delta(change)}${waiting ? `<div class="muted small">waiting ${esc(formatMetric('waitingMs', waiting))}</div>` : ''}</td>`;
      })
      .join('')}
</tr>`,
        )
        .join('\n');
    const runs = chosen
        .map(line => {
            const everyRun = [...(line.warmup ? [line.warmup] : []), ...line.samples];
            const slowest = Math.max(...everyRun.map(s => s.record.durationMs), 1);
            const list = everyRun
                .map(
                    s => `<tr class="${s.warmup ? 'muted' : ''}">
  <td>${s.warmup ? 'warm-up' : `run ${s.iteration}`}</td>
  <td><span class="pill ${s.record.status === 'failed' ? 'worse' : 'ok'}">${esc(s.record.status)}</span></td>
  <td class="num"><span class="meter" aria-hidden="true"><i class="${s.warmup ? 'warmup' : ''}" style="width:${((s.record.durationMs / slowest) * 100).toFixed(1)}%"></i></span>${esc(formatMetric('durationMs', s.record.durationMs))}</td>
  <td class="num">${esc(formatMetric('cpuMs', s.cpu.cpuMs))}</td>
  <td class="num">${esc(formatMetric('memoryDeltaBytes', s.memory.peakRssBytes - s.memory.startRssBytes))}</td>
  <td class="num">${s.memory.samples}</td>
  <td class="small">${esc(s.record.error ?? '')}</td>
</tr>`,
                )
                .join('\n');
            const api = counted(line)
                .map(s => s.fakeApi)
                .filter(f => f !== undefined);
            const apiLine = api.length
                ? `<p class="muted small">fake API, median per run: ${median(api.map(a => a.requests))} requests, ${median(api.map(a => a.failures))} failures, p95 ${esc(formatMetric('p95Ms', median(api.map(a => a.p95Ms))))}</p>`
                : '';
            return `<details><summary>${esc(when(line.at))} · ${commit(line)} · ${counted(line).length} counted run(s)</summary>
${apiLine}
<table class="compact"><thead><tr><th>run</th><th>status</th><th class="num">engine time</th><th class="num">CPU</th><th class="num">memory (peak − start)</th><th class="num">memory samples</th><th>error</th></tr></thead><tbody>
${list}
</tbody></table>
<p class="muted small">Bun ${esc(line.machine.bunVersion)}${line.machine.dockerVersion ? ` · Docker ${esc(line.machine.dockerVersion)}` : ''} · seed ${line.scenario.seed} · services: ${esc(line.scenario.services.join(', ') || 'none')}</p>
</details>`;
        })
        .join('\n');
    return `<h2>Comparing ${chosen.length} execution${chosen.length > 1 ? 's' : ''} <span class="muted small">size ${size.toLocaleString('en-US')}${chosen.length > 1 ? ' · changes are against the oldest (baseline)' : ''} · <a href="${scenarioLink(id, size, [])}">clear</a></span></h2>
<div class="scroll"><table>
<thead><tr><th>metric</th>${heads}</tr></thead>
<tbody>
${metrics}
</tbody>
</table></div>
<h3>Components <span class="muted small">median active time per run (waiting below)</span></h3>
<div class="scroll"><table>
<thead><tr><th>component</th>${heads}</tr></thead>
<tbody>
${components}
</tbody>
</table></div>
<h3>Runs</h3>
${runs}`;
}

function scenario(lines: ReportLine[], route: Extract<Route, { view: 'scenario' }>): string {
    const sizes = sizesOf(lines, route.id);
    if (!sizes.length) {
        return `${header(` › ${esc(route.id)}`)}<p>No results for <code>${esc(route.id)}</code> on this machine.</p>`;
    }

    const size = route.size && sizes.includes(route.size) ? route.size : sizes[0]!;
    const executions = executionsOf(lines, route.id, size);
    const known = new Set(executions.map(l => l.at));
    const selected = (route.selected ?? defaultSelection(executions)).filter(at => known.has(at));
    const chosen = executions.filter(l => selected.includes(l.at));
    const toggle = (at: string) => scenarioLink(route.id, size, selected.includes(at) ? selected.filter(s => s !== at) : [...selected, at]);
    const latest = executions.at(-1)!;
    const description = [...executions].reverse().find(l => l.scenario.description)?.scenario.description ?? '';
    const metrics = latest.rulers.map(r => r.metric);

    const tabs =
        sizes.length > 1
            ? `<nav class="tabs">${sizes.map(s => `<a href="${scenarioLink(route.id, s)}" class="${s === size ? 'active' : ''}">size ${s.toLocaleString('en-US')}</a>`).join('')}</nav>`
            : '';
    const charts = metrics
        .map(metric => {
            const direction = latest.rulers.find(r => r.metric === metric)!.direction;
            const points = seriesOf(executions, metric);
            const values = points.map(p => p.value);
            const range = values.length
                ? `${esc(formatMetric(metric, Math.min(...values)))} – ${esc(formatMetric(metric, Math.max(...values)))}`
                : '';
            const last = points.at(-1)?.value;
            const change = changeOf(last, points.at(-2)?.value, direction);
            return `<div class="card"><div class="card-head"><code>${esc(metric)}</code><span class="muted small">${directionText(direction)}</span></div><div class="card-value">${value(metric, last)} ${delta(change)}</div>${chart(metric, executions, { width: 320, height: 96, selected, select: toggle })}<div class="card-foot muted small"><span>range</span><span>${range}</span></div></div>`;
        })
        .join('');
    const rows = [...executions]
        .reverse()
        .map((line, i, newestFirst) => {
            const before = newestFirst.slice(i + 1).find(l => !l.partial);
            const on = selected.includes(line.at);
            return `<tr class="${on ? 'chosen' : ''}">
  <td><a class="check" href="${toggle(line.at)}" aria-label="${on ? 'unselect' : 'select'}">${on ? '☑' : '☐'}</a></td>
  <td class="small">${esc(when(line.at))}<div class="muted">${commit(line)}</div></td>
  <td>${badges(line)}</td>
  <td class="num">${counted(line).length}/${line.samples.length}</td>
  ${metrics
      .map(metric => {
          const direction = line.rulers.find(r => r.metric === metric)?.direction ?? 'lower-is-better';
          const v = line.rulers.find(r => r.metric === metric)?.median;
          return `<td class="num">${value(metric, v)}<div>${delta(changeOf(v, before?.rulers.find(r => r.metric === metric)?.median, direction))}</div></td>`;
      })
      .join('')}
</tr>`;
        })
        .join('\n');

    return `${header(` › ${esc(route.id)}`)}
<p class="lede">${esc(description)}</p>
${tabs}
${scenarioStats(executions)}
<h2>History <span class="muted small">${executions.length} execution(s) at size ${size.toLocaleString('en-US')} · click a point to add or remove it from the comparison</span></h2>
<div class="cards">${charts}</div>
${breakdown(chosen.at(-1) ?? executions.filter(l => !l.partial).at(-1) ?? latest)}
<h2>Executions <span class="muted small">newest first · the change under each value is against the execution below it</span></h2>
<div class="scroll"><table>
<thead><tr><th></th><th>when</th><th></th><th class="num">runs</th>${metrics.map(m => `<th class="num"><code>${esc(m)}</code></th>`).join('')}</tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
${comparison(route.id, size, chosen)}`;
}

function render() {
    const lines = all.filter(l => l.machine.hostname === host);
    const route = currentRoute();
    app.innerHTML = route.view === 'scenario' ? scenario(lines, route) : overview(lines);
    document.getElementById('machine')?.addEventListener('change', event => {
        host = (event.target as HTMLSelectElement).value;
        render();
    });
    window.scrollTo({ top: route.view === 'scenario' && route.selected ? window.scrollY : 0 });
}

function load(text: string, from: string) {
    all = parseResults(text);
    source = `${all.length} execution(s) from ${from}`;
    host = all.at(-1)?.machine.hostname ?? '';
    render();
}

function picker(reason: string) {
    app.innerHTML = `<header><h1>Flowtinus perf</h1></header>
<div class="drop" id="drop">
  <p><strong>Pick the results to show</strong></p>
  <p class="muted">${esc(reason)} Choose or drop <code>flowtinus.perf/results/*.jsonl</code>, or run <code>bun run perf --serve --open</code> to have them loaded for you.</p>
  <input type="file" id="files" accept=".jsonl,application/x-ndjson,text/plain" multiple>
</div>`;
    const read = async (files: FileList | null | undefined) => {
        const list = [...(files ?? [])];
        if (list.length) {
            load((await Promise.all(list.map(f => f.text()))).join('\n'), list.map(f => f.name).join(', '));
        }
    };
    const drop = document.getElementById('drop')!;
    document.getElementById('files')!.addEventListener('change', event => void read((event.target as HTMLInputElement).files));
    drop.addEventListener('dragover', event => {
        event.preventDefault();
        drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', event => {
        event.preventDefault();
        drop.classList.remove('over');
        void read(event.dataTransfer?.files);
    });
}

async function fetchResults(): Promise<string | undefined> {
    try {
        const response = await fetch('results.jsonl', { cache: 'no-store' });
        return response.ok ? await response.text() : undefined;
    } catch {
        return undefined;
    }
}

async function boot() {
    window.addEventListener('hashchange', () => all.length && render());
    if (location.protocol === 'file:') {
        picker('This page was opened as a file, so it cannot read the results by itself.');
        return;
    }

    const text = await fetchResults();
    if (text === undefined) {
        picker('The results could not be loaded from the server.');
        return;
    }

    load(text, 'results/*.jsonl');
}

void boot();
