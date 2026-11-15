/*
 * Generates the animated diagrams of docs/runtime, in the look of the website's "Watch a run move" block (dark canvas,
 * Flowtinus Gold, envelopes, the component category colors of docs/visual/colors.md). They are SMIL SVGs: they play
 * on GitHub (in the README and in the file view) and in any browser, with no script.
 *
 * Run from the repo root after changing it: bun docs/runtime/diagrams/generate.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = import.meta.dir;

/** the website's tokens (website/src/styles.css, from docs/visual/colors.md, dark theme) */
const C = {
    frame: '#171717',
    canvas: '#23272b',
    grid: '#43484e',
    card: '#171717',
    code: '#0a0a0a',
    line: 'rgba(255,255,255,0.10)',
    line2: 'rgba(255,255,255,0.18)',
    wire: '#5a6068',
    text: '#fafafa',
    muted: '#a1a1a1',
    dim: '#6b7178',
    gold: '#f2a93b',
    goldSoft: 'rgba(242,169,59,0.14)',
    onGold: '#111111',
    fixed: '#edd5a3',
    ok: '#5bc99e',
    okSoft: 'rgba(91,201,158,0.14)',
    err: '#ff6467',
    errSoft: 'rgba(255,100,103,0.14)',
    // component categories
    database: '#f2af48',
    api: '#5bc99e',
    code_: '#ba93fb',
    codeSoft: 'rgba(186,147,251,0.14)',
    transformation: '#36baeb',
    transformationSoft: 'rgba(54,186,235,0.12)',
    flow: '#d3d8de',
};

/**
 * What each color means, the same in every diagram: a run (or the job it becomes) is a gold envelope; NOTIFY is violet;
 * progress and the queued state are blue; heartbeats, done and completed are green; a failure is red.
 */
const S = {
    run: C.gold,
    notify: C.code_,
    notifySoft: C.codeSoft,
    queued: C.transformation,
    queuedSoft: C.transformationSoft,
    running: C.gold,
    runningSoft: C.goldSoft,
    ok: C.ok,
    okSoft: C.okSoft,
    err: C.err,
    errSoft: C.errSoft,
    postgres: C.transformation,
    supervisor: C.api,
};

const SANS = "Inter, ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

type P = [number, number];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = (n: number) => Number(n.toFixed(4)).toString();

const HEAD = 44;
const FOOT = 48;

/**
 * How a diagram's story (written in seconds, 0 to its length) plays: slowed down by `speed`, held at the end for `hold`
 * seconds, and, for one step's own diagram, only the `window` of that step.
 */
type Clock = { speed: number; hold: number; window?: [number, number] };

class Diagram {
    private parts: string[] = [];
    private foot: string[] = [];
    readonly height: number;
    readonly from: number;
    readonly to: number;
    /** the SVG's loop, in seconds */
    readonly dur: number;
    constructor(
        readonly width: number,
        /** the canvas' height, between the header and the captions */
        readonly body: number,
        /** the story's length, in seconds */
        readonly loop: number,
        readonly title: string,
        readonly meta: string,
        readonly clock: Clock,
    ) {
        this.height = HEAD + body + FOOT;
        [this.from, this.to] = clock.window ?? [0, loop];
        this.dur = Number(((this.to - this.from) * clock.speed + clock.hold).toFixed(2));
    }

    /** whether something from t0 to t1 shows in this diagram's window */
    shows(t0: number, t1: number) {
        return t1 > this.from && t0 < this.to;
    }

    add(svg: string) {
        this.parts.push(svg);
    }

    /** a moment of the story as a fraction of the SVG's loop */
    at(t: number) {
        const clamped = Math.min(this.to, Math.max(this.from, t));
        return ((clamped - this.from) * this.clock.speed) / this.dur;
    }

    text(
        x: number,
        y: number,
        s: string,
        o: { size?: number; weight?: number; fill?: string; anchor?: string; mono?: boolean; halo?: boolean } = {},
    ) {
        const halo = o.halo ? ` stroke="${C.canvas}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"` : '';
        return `<text x="${x}" y="${y}" xml:space="preserve" font-family="${o.mono ? MONO : SANS}" font-size="${o.size ?? 13}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? C.text}" text-anchor="${o.anchor ?? 'start'}"${halo}>${esc(s)}</text>`;
    }

    box(
        x: number,
        y: number,
        w: number,
        h: number,
        o: { fill?: string; stroke?: string; r?: number; dash?: boolean; width?: number; extra?: string } = {},
    ) {
        return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 10}" fill="${o.fill ?? C.card}" stroke="${o.stroke ?? C.line2}" stroke-width="${o.width ?? 1.2}"${o.dash ? ' stroke-dasharray="5 4"' : ''}>${o.extra ?? ''}</rect>`;
    }

    /** a card with a category dot, a title and a mono subtitle, as the website's components */
    node(
        x: number,
        y: number,
        w: number,
        h: number,
        title: string,
        sub: string,
        o: { dot?: string; stroke?: string; fixed?: boolean } = {},
    ) {
        const fill = o.fixed ? C.fixed : C.card;
        const fg = o.fixed ? C.onGold : C.text;
        const mid = y + h / 2;
        const dot = o.dot ? `<circle cx="${x + 16}" cy="${mid - 8}" r="4.5" fill="${o.fixed ? C.onGold : o.dot}"/>` : '';
        const tx = o.dot ? x + 28 : x + 14;
        return `${this.box(x, y, w, h, { fill, stroke: o.fixed ? 'none' : (o.stroke ?? C.line2) })}${dot}${this.text(tx, mid - 3, title, { weight: 600, fill: fg })}${this.text(tx, mid + 14, sub, { size: 10.5, mono: true, fill: o.fixed ? '#5c4a22' : C.muted })}`;
    }

    line(points: P[], o: { stroke?: string; dash?: boolean; arrow?: boolean; width?: number } = {}) {
        const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
        return `<path d="${d}" fill="none" stroke="${o.stroke ?? C.wire}" stroke-width="${o.width ?? 2}" stroke-linejoin="round"${o.dash ? ' stroke-dasharray="5 5"' : ''}${o.arrow ? ' marker-end="url(#arrow)"' : ''}/>`;
    }

    visible(t0: number, t1: number) {
        const a = t0 <= this.from ? 0 : this.at(t0);
        const b = t1 >= this.to ? 1 : this.at(t1);
        if (b >= 1) {
            return `<animate attributeName="opacity" dur="${this.dur}s" repeatCount="indefinite" calcMode="discrete" values="${a === 0 ? '1' : '0;1'}" keyTimes="${a === 0 ? '0' : `0;${f(a)}`}"/>`;
        }
        const values = a === 0 ? '1;0' : '0;1;0';
        const times = a === 0 ? `0;${f(b)}` : `0;${f(a)};${f(b)}`;
        return `<animate attributeName="opacity" dur="${this.dur}s" repeatCount="indefinite" calcMode="discrete" values="${values}" keyTimes="${times}"/>`;
    }

    /** an attribute that changes at moments: [from, value] pairs, the first one at 0 */
    steps(attribute: string, changes: [number, string][]) {
        // the value when the window opens, then the changes inside it
        const first = [...changes].reverse().find(c => c[0] <= this.from) ?? changes[0]!;
        const inside = changes.filter(c => c[0] > this.from && c[0] < this.to);
        const all: [number, string][] = [[this.from, first[1]], ...inside];
        const values = all.map(c => c[1]).join(';');
        const times = all.map(c => f(this.at(c[0]))).join(';');
        return `<animate attributeName="${attribute}" dur="${this.dur}s" repeatCount="indefinite" calcMode="discrete" values="${values}" keyTimes="${times}"/>`;
    }

    during(t0: number, t1: number, svg: string) {
        if (!this.shows(t0, t1)) {
            return '';
        }
        return `<g opacity="0">${this.visible(t0, t1)}${svg}</g>`;
    }

    /** text that changes over time: [from, text] pairs, each shown until the next one */
    ticker(x: number, y: number, frames: [number, string][], o: Parameters<Diagram['text']>[3] = {}) {
        return frames.map(([t0, s], i) => this.during(t0, frames[i + 1]?.[0] ?? this.loop, this.text(x, y, s, o))).join('');
    }

    /**
     * Something that travels: drawn around (0,0), it goes through the points at the given moments (the same point twice:
     * it waits there), seen only while it travels.
     */
    mover(points: P[], times: number[], svg: string) {
        if (!this.shows(times[0]!, times[times.length - 1]! + 0.05)) {
            return '';
        }
        const lengths = [0];
        for (let i = 1; i < points.length; i++) {
            const [ax, ay] = points[i - 1]!;
            const [bx, by] = points[i]!;
            lengths.push(lengths[i - 1]! + Math.hypot(bx - ax, by - ay));
        }
        const total = lengths[lengths.length - 1] || 1;
        let keyPoints = lengths.map(l => l / total);
        let keyTimes = times.map(t => this.at(t));
        if (keyTimes[0]! > 0) {
            keyPoints = [0, ...keyPoints];
            keyTimes = [0, ...keyTimes];
        }
        if (keyTimes[keyTimes.length - 1]! < 1) {
            keyPoints = [...keyPoints, 1];
            keyTimes = [...keyTimes, 1];
        }
        const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
        return `<g opacity="0">${this.visible(times[0]!, times[times.length - 1]! + 0.05)}<animateMotion dur="${this.dur}s" repeatCount="indefinite" calcMode="linear" path="${d}" keyPoints="${keyPoints.map(f).join(';')}" keyTimes="${keyTimes.map(f).join(';')}"/>${svg}</g>`;
    }

    /** the website's envelope, in a color, with an optional label above (or below) it */
    envelope(color: string, label?: string, o: { below?: boolean; anchor?: string; dx?: number; scale?: number } = {}) {
        const s = o.scale ?? 1;
        const icon = `<g transform="scale(${s})"><rect x="-8" y="-5.5" width="16" height="11" rx="1.6" fill="${color}" stroke="#111" stroke-width="1"/><path d="M-8 -5 L0 1 L8 -5" fill="none" stroke="#111" stroke-width="1.1"/></g>`;
        if (!label) {
            return icon;
        }
        return `${icon}${this.text(o.dx ?? 0, o.below ? 22 : -12, label, { size: 10.5, weight: 600, mono: true, fill: color, anchor: o.anchor ?? 'middle', halo: true })}`;
    }

    /** a small signal (NOTIFY, a heartbeat): a dot with a label */
    signal(color: string, label?: string, o: { below?: boolean; anchor?: string; dx?: number; r?: number } = {}) {
        const dot = `<circle r="${o.r ?? 5}" fill="${color}" stroke="#111" stroke-width="1.5"/>`;
        if (!label) {
            return dot;
        }
        return `${dot}${this.text(o.dx ?? 0, o.below ? 20 : -10, label, { size: 10.5, weight: 600, mono: true, fill: color, anchor: o.anchor ?? 'middle', halo: true })}`;
    }

    /** a chip, as the website's pills */
    chip(x: number, y: number, label: string, color: string, soft: string) {
        const w = label.length * 6.6 + 18;
        return `<rect x="${x}" y="${y}" width="${f(w)}" height="20" rx="10" fill="${soft}" stroke="${color}" stroke-width="1"/>${this.text(x + 9, y + 14, label, { size: 10.5, mono: true, fill: color, weight: 600 })}`;
    }

    pulse(x: number, y: number, t: number, color: string, r = 26) {
        if (!this.shows(t, t + 0.7)) {
            return '';
        }
        const a = this.at(t);
        const b = this.at(t + 0.7);
        return `<circle cx="${x}" cy="${y}" r="0" fill="none" stroke="${color}" stroke-width="2.5" opacity="0"><animate attributeName="r" dur="${this.dur}s" repeatCount="indefinite" values="0;0;${r};${r}" keyTimes="0;${f(a)};${f(b)};1"/><animate attributeName="opacity" dur="${this.dur}s" repeatCount="indefinite" values="0;0.9;0;0" keyTimes="0;${f(a)};${f(b)};1"/></circle>`;
    }

    /** the captions under the canvas, one at a time, numbered like the steps in the page */
    captions(items: [number, number, string][]) {
        const y = HEAD + this.body + 29;
        items.forEach(([t0, t1, s], i) => {
            const n = String(i + 1);
            this.foot.push(
                this.during(
                    t0,
                    t1,
                    `<rect x="18" y="${y - 14}" width="22" height="20" rx="10" fill="${C.gold}"/>${this.text(29, y + 0.5, n, { size: 11, weight: 700, fill: C.onGold, anchor: 'middle', mono: true })}${this.text(50, y, s, { size: 13 })}`,
                ),
            );
        });
        // the progress of the loop
        this.foot.push(
            `<rect x="0" y="${HEAD + this.body}" width="0" height="2" fill="${C.gold}"><animate attributeName="width" dur="${this.dur}s" repeatCount="indefinite" values="0;${this.width}" keyTimes="0;1"/></rect>`,
        );
    }

    svg() {
        const W = this.width;
        const H = this.height;
        const dot = `<circle cx="22" cy="22" r="4.5" fill="${C.gold}"><animate attributeName="opacity" dur="1s" repeatCount="indefinite" values="1;0.35;1"/></circle>`;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(this.title)}">
<title>${esc(this.title)}</title>
<defs>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${C.grid}"/></pattern>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${C.wire}"/></marker>
<clipPath id="frame"><rect x="0" y="0" width="${W}" height="${H}" rx="14"/></clipPath>
</defs>
<g clip-path="url(#frame)">
<rect x="0" y="0" width="${W}" height="${H}" fill="${C.frame}"/>
<rect x="0" y="${HEAD}" width="${W}" height="${this.body}" fill="${C.canvas}"/>
<rect x="0" y="${HEAD}" width="${W}" height="${this.body}" fill="url(#dots)"/>
<path d="M0 ${HEAD} H${W} M0 ${HEAD + this.body} H${W}" stroke="${C.line}"/>
${dot}
${this.text(36, 26.5, this.title, { size: 12.5, weight: 600, mono: true })}
${this.text(W - 18, 26.5, this.meta, { size: 12, mono: true, fill: C.muted, anchor: 'end' })}
<g transform="translate(0 ${HEAD})">
${this.parts.join('\n')}
</g>
${this.foot.join('\n')}
</g>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${C.line}"/>
</svg>
`;
    }
}

// 01. A run, end to end: editor → API server → Postgres → supervisor → worker, and back

const RUN_LIFECYCLE_STEPS: [number, number, string][] = [
    [0, 1, 'The editor asks for a run: the API checks that a live supervisor has the flow’s tag'],
    [1, 2, 'The API inserts the run: status queued, the flow’s worker_tag, a snapshot of the draft and its scripts'],
    [2, 3, 'NOTIFY runs_queued with the tag: every supervisor that LISTENs wakes up'],
    [3, 4.2, 'Only a supervisor whose WORKER_TAGS has the tag claims it: UPDATE … FOR UPDATE SKIP LOCKED'],
    [4.2, 5.2, 'It prepares the RunJob (secrets decrypted, in memory) and hands it to a free worker over IPC'],
    [5.2, 8.9, 'The worker runs the engine: progress every 250 ms; the supervisor beats every 5 s'],
    [8.9, 9.7, 'The worker answers done: the supervisor stores the record, status and usage (finishRun)'],
    [9.7, 12, 'NOTIFY run_events: the API pushes the change to the editor over SSE'],
];

function runLifecycle(clock: Clock, title = 'A run, end to end') {
    const d = new Diagram(1000, 440, 12, title, 'editor → api → postgres → supervisor → worker', clock);
    const t = d.text.bind(d);

    // the editor and the API server
    d.add(d.node(24, 175, 150, 64, 'Editor', 'flowtinus.editor', { dot: C.flow }));
    d.add(
        d.ticker(
            99,
            262,
            [
                [0, ''],
                [0.05, 'Run ▸'],
                [1.2, ''],
            ],
            { size: 11, mono: true, anchor: 'middle', fill: C.muted },
        ),
    );
    d.add(d.during(10.9, 12, t(99, 262, 'completed ✓', { size: 11, mono: true, anchor: 'middle', fill: S.ok, weight: 600 })));
    d.add(d.box(214, 175, 180, 64, { fill: C.gold, stroke: 'none' }));
    d.add(t(228, 202, 'API server', { weight: 700, fill: C.onGold }));
    d.add(t(228, 222, 'POST /w/:ws/flows/:id/runs', { size: 10, mono: true, fill: '#4a3410' }));

    // Postgres
    const PG = { x: 440, y: 50, w: 260, h: 330 };
    d.add(d.box(PG.x, PG.y, PG.w, PG.h, { fill: 'rgba(54,186,235,0.05)', stroke: S.postgres, width: 1.2 }));
    d.add(`<circle cx="${PG.x + 18}" cy="${PG.y + 22}" r="4.5" fill="${S.postgres}"/>`);
    d.add(t(PG.x + 30, PG.y + 27, 'Postgres', { weight: 700 }));
    d.add(t(PG.x + PG.w - 14, PG.y + 27, 'queue · state · bus', { size: 10.5, mono: true, fill: C.muted, anchor: 'end' }));

    d.add(d.box(PG.x + 14, PG.y + 42, PG.w - 28, 118, { fill: C.card, r: 8, stroke: C.line2 }));
    d.add(t(PG.x + 26, PG.y + 62, 'runs / test_runs', { size: 11.5, weight: 600, mono: true }));
    const rowX = PG.x + 24;
    const rowW = PG.w - 48;
    const rowY = [PG.y + 72, PG.y + 99, PG.y + 126];
    // the run's row: empty → queued (blue) → running (gold) → completed (green)
    d.add(
        `<rect x="${rowX}" y="${rowY[0]}" width="${rowW}" height="22" rx="5" stroke-width="1">${d.steps('fill', [
            [0, 'rgba(255,255,255,0.04)'],
            [2, S.queuedSoft],
            [4.2, S.runningSoft],
            [9.6, S.okSoft],
        ])}${d.steps('stroke', [
            [0, C.line],
            [2, S.queued],
            [4.2, S.running],
            [9.6, S.ok],
        ])}</rect>`,
    );
    d.add(d.during(2, 4.2, t(rowX + 10, rowY[0]! + 15, "queued · tag 'default'", { size: 10.5, mono: true, fill: S.queued, weight: 600 })));
    d.add(
        d.during(4.2, 9.6, t(rowX + 10, rowY[0]! + 15, 'running · worker_id A', { size: 10.5, mono: true, fill: S.running, weight: 600 })),
    );
    d.add(d.during(9.6, 12, t(rowX + 10, rowY[0]! + 15, 'completed · record', { size: 10.5, mono: true, fill: S.ok, weight: 600 })));
    d.add(d.during(5.4, 9.2, t(rowX + rowW - 10, rowY[0]! + 15, 'progress', { size: 10, mono: true, fill: S.queued, anchor: 'end' })));
    for (const y of rowY.slice(1)) {
        d.add(`<rect x="${rowX}" y="${y}" width="${rowW}" height="22" rx="5" fill="rgba(255,255,255,0.04)" stroke="${C.line}"/>`);
        d.add(t(rowX + 10, y + 15, 'completed', { size: 10.5, mono: true, fill: C.dim }));
    }

    d.add(d.box(PG.x + 14, PG.y + 172, PG.w - 28, 50, { fill: C.card, r: 8, stroke: C.line2 }));
    d.add(t(PG.x + 26, PG.y + 192, 'supervisors', { size: 11.5, weight: 600, mono: true }));
    d.add(t(PG.x + 26, PG.y + 210, 'id · tags · workers · last_seen', { size: 10, mono: true, fill: C.muted }));

    d.add(d.box(PG.x + 14, PG.y + 234, PG.w - 28, 80, { fill: S.notifySoft, r: 8, stroke: 'rgba(186,147,251,0.45)' }));
    d.add(t(PG.x + 26, PG.y + 254, 'LISTEN / NOTIFY', { size: 11.5, weight: 600, mono: true, fill: S.notify }));
    d.add(t(PG.x + 26, PG.y + 274, 'runs_queued   → supervisors', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(PG.x + 26, PG.y + 290, 'run_cancel    → supervisors', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(PG.x + 26, PG.y + 306, 'run_events    → API → SSE', { size: 10.5, mono: true, fill: C.muted }));

    // supervisors
    const A = { x: 756, y: 20, w: 220, h: 176 };
    d.add(d.box(A.x, A.y, A.w, A.h, { fill: C.card, stroke: S.supervisor }));
    d.add(`<circle cx="${A.x + 18}" cy="${A.y + 22}" r="4.5" fill="${S.supervisor}"/>`);
    d.add(t(A.x + 30, A.y + 27, 'Supervisor A', { weight: 700 }));
    d.add(t(A.x + 14, A.y + 48, 'WORKER_TAGS=default', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(A.x + 14, A.y + 63, 'WORKERS=2', { size: 10.5, mono: true, fill: C.muted }));
    const w1 = { x: A.x + 14, y: A.y + 78, w: 92, h: 58 };
    const w2 = { x: A.x + 114, y: A.y + 78, w: 92, h: 58 };
    d.add(
        `<rect x="${w1.x}" y="${w1.y}" width="${w1.w}" height="${w1.h}" rx="8" fill="${C.canvas}" stroke-width="1.2">${d.steps('stroke', [
            [0, C.line2],
            [5.1, S.running],
            [9.3, C.line2],
        ])}</rect>`,
    );
    d.add(t(w1.x + 46, w1.y + 23, 'worker 1', { size: 11.5, weight: 600, anchor: 'middle' }));
    d.add(
        d.ticker(
            w1.x + 46,
            w1.y + 41,
            [
                [0, 'idle'],
                [5.1, 'engine ▸ run'],
                [9.3, 'idle'],
            ],
            { size: 10, mono: true, anchor: 'middle', fill: C.muted },
        ),
    );
    d.add(
        `<rect x="${w2.x}" y="${w2.y}" width="${w2.w}" height="${w2.h}" rx="8" fill="${C.canvas}" stroke="${C.line2}" stroke-width="1.2"/>`,
    );
    d.add(t(w2.x + 46, w2.y + 23, 'worker 2', { size: 11.5, weight: 600, anchor: 'middle' }));
    d.add(t(w2.x + 46, w2.y + 41, 'idle', { size: 10, mono: true, anchor: 'middle', fill: C.muted }));
    d.add(t(A.x + 14, A.y + 160, 'claims · prepares · writes', { size: 10.5, fill: C.muted }));

    const B = { x: 756, y: 236, w: 220, h: 144 };
    d.add(d.box(B.x, B.y, B.w, B.h, { fill: C.card, stroke: S.supervisor }));
    d.add(`<circle cx="${B.x + 18}" cy="${B.y + 22}" r="4.5" fill="${S.supervisor}"/>`);
    d.add(t(B.x + 30, B.y + 27, 'Supervisor B', { weight: 700 }));
    d.add(t(B.x + 14, B.y + 48, 'WORKER_TAGS=heavy', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(B.x + 14, B.y + 63, 'WORKERS=1', { size: 10.5, mono: true, fill: C.muted }));
    d.add(
        `<rect x="${B.x + 14}" y="${B.y + 76}" width="192" height="40" rx="8" fill="${C.canvas}" stroke="${C.line2}" stroke-width="1.2"/>`,
    );
    d.add(t(B.x + 110, B.y + 101, 'worker 1 · idle', { size: 11, mono: true, anchor: 'middle', fill: C.muted }));
    d.add(
        d.during(
            2.9,
            4.6,
            t(B.x + 110, B.y + 134, "'default' is not mine: ignored", {
                size: 10.5,
                mono: true,
                fill: S.notify,
                anchor: 'middle',
                weight: 600,
            }),
        ),
    );

    // wires
    d.add(
        d.line(
            [
                [174, 207],
                [214, 207],
            ],
            { arrow: true },
        ),
    );
    d.add(
        d.line(
            [
                [394, 207],
                [440, 207],
            ],
            { arrow: true },
        ),
    );
    d.add(
        d.line(
            [
                [700, 150],
                [756, 120],
            ],
            { dash: true },
        ),
    );
    d.add(
        d.line(
            [
                [700, 300],
                [756, 320],
            ],
            { dash: true },
        ),
    );

    // 0-1 Run → API; 1-2 INSERT
    d.add(
        d.mover(
            [
                [174, 207],
                [214, 207],
            ],
            [0.2, 1],
            d.envelope(S.run, 'Run'),
        ),
    );
    d.add(
        d.mover(
            [
                [394, 207],
                [440, 207],
                [rowX + 20, rowY[0]! + 11],
            ],
            [1.1, 1.5, 2],
            d.envelope(S.run, 'INSERT'),
        ),
    );
    // 2-2.9 NOTIFY runs_queued 'default' wakes both
    d.add(d.pulse(PG.x + PG.w / 2, PG.y + 274, 2, S.notify, 44));
    d.add(
        d.mover(
            [
                [700, 150],
                [756, 120],
            ],
            [2.1, 2.8],
            d.signal(S.notify, 'NOTIFY'),
        ),
    );
    d.add(
        d.mover(
            [
                [700, 300],
                [756, 320],
            ],
            [2.1, 2.8],
            d.signal(S.notify, 'NOTIFY', { below: true }),
        ),
    );
    // 3-4.2 A claims it
    d.add(
        d.mover(
            [
                [756, 120],
                [700, 130],
                [rowX + rowW - 20, rowY[0]! + 11],
            ],
            [3, 3.4, 4.1],
            d.envelope(S.run, 'claim · SKIP LOCKED', { anchor: 'end', dx: 30 }),
        ),
    );
    // 4.3-5.1 the job to worker 1 (secrets decrypted by the supervisor)
    d.add(
        d.mover(
            [
                [rowX + rowW - 20, rowY[0]! + 11],
                [700, 130],
                [756, 120],
                [w1.x + 46, w1.y + 50],
            ],
            [4.3, 4.55, 4.75, 5.1],
            d.envelope(S.run, 'RunJob'),
        ),
    );
    // 5.4-8.8 progress every 250 ms
    for (const s of [5.4, 6.3, 7.2, 8.1]) {
        d.add(
            d.mover(
                [
                    [w1.x + 46, w1.y + 50],
                    [756, 140],
                    [700, 140],
                    [rowX + rowW - 20, rowY[0]! + 11],
                ],
                [s, s + 0.25, s + 0.4, s + 0.8],
                d.envelope(S.queued, undefined, { scale: 0.75 }),
            ),
        );
    }
    // heartbeats: the supervisor's own beat to its row
    for (const s of [5.8, 8.3]) {
        d.add(
            d.mover(
                [
                    [A.x, A.y + 150],
                    [712, 228],
                    [PG.x + PG.w - 8, PG.y + 197],
                ],
                [s, s + 0.4, s + 0.9],
                d.signal(S.ok, 'heartbeat', { r: 4, anchor: 'start', dx: 8 }),
            ),
        );
    }
    // 8.9-9.6 done
    d.add(
        d.mover(
            [
                [w1.x + 46, w1.y + 50],
                [756, 140],
                [700, 140],
                [rowX + rowW - 20, rowY[0]! + 11],
            ],
            [8.9, 9.15, 9.3, 9.6],
            d.envelope(S.ok, 'done'),
        ),
    );
    // 9.7-11 run_events → API → SSE → editor
    d.add(d.pulse(PG.x + PG.w / 2, PG.y + 306, 9.7, S.notify, 44));
    d.add(
        d.mover(
            [
                [440, 340],
                [304, 340],
                [304, 239],
            ],
            [9.8, 10.3, 10.6],
            d.signal(S.notify, 'run_events', { below: true }),
        ),
    );
    d.add(
        d.mover(
            [
                [214, 228],
                [174, 228],
            ],
            [10.65, 11],
            d.signal(S.notify, 'SSE', { below: true }),
        ),
    );
    d.add(
        d.during(
            9.7,
            12,
            d.line(
                [
                    [440, 340],
                    [304, 340],
                    [304, 239],
                ],
                { dash: true, stroke: 'rgba(186,147,251,0.45)' },
            ),
        ),
    );

    d.captions(RUN_LIFECYCLE_STEPS);
    return d;
}

// shared pieces

/** a titled container (Postgres, a supervisor): a colored border, a dot and its name */
function container(
    d: Diagram,
    x: number,
    y: number,
    w: number,
    h: number,
    name: string,
    color: string,
    o: { note?: string; soft?: string } = {},
) {
    d.add(d.box(x, y, w, h, { fill: o.soft ?? C.card, stroke: color }));
    d.add(`<circle cx="${x + 18}" cy="${y + 22}" r="4.5" fill="${color}"/>`);
    d.add(d.text(x + 30, y + 27, name, { weight: 700 }));
    if (o.note) {
        d.add(d.text(x + w - 14, y + 27, o.note, { size: 10.5, mono: true, fill: C.muted, anchor: 'end' }));
    }
}

/** a block of code on the darkest background; a line starting with // is a comment */
function code(
    d: Diagram,
    x: number,
    y: number,
    w: number,
    h: number,
    title: string,
    lines: string[],
    o: { size?: number; gap?: number } = {},
) {
    d.add(d.box(x, y, w, h, { fill: C.code, stroke: C.line2 }));
    d.add(d.text(x + 14, y + 22, title, { size: 11, mono: true, fill: C.muted }));
    d.add(`<path d="M${x} ${y + 32} H${x + w}" stroke="${C.line}"/>`);
    lines.forEach((line, i) =>
        d.add(
            d.text(x + 14, y + 52 + i * (o.gap ?? 17), line, {
                size: o.size ?? 11.5,
                mono: true,
                fill: line.trimStart().startsWith('//') ? C.muted : C.text,
            }),
        ),
    );
}

const quiet = 'rgba(255,255,255,0.04)';

// 00. Architecture: every piece, and one run going through them

const ARCHITECTURE_STEPS: [number, number, string][] = [
    [0, 2, 'The editor (React) only talks to the API server; every screen is a call under /w/:ws/…'],
    [2, 4, 'A run is a row in Postgres: queued with a snapshot of the flow; NOTIFY wakes the supervisors'],
    [4, 7, 'A supervisor claims it and a worker process runs the engine, which reads and writes the outside systems'],
    [7, 9, 'Progress and the end go back to Postgres; the API pushes them to the editor over SSE'],
    [9, 11, 'An agent works through /mcp with a personal access token: the same use cases as the editor'],
    [11, 13, 'Another system calls a webhook; the supervisors fire the schedules: both run the deployed version'],
    [13, 15, 'The API and the supervisors log JSON; the otel-collector sends it to OpenObserve'],
];

function architecture(clock: Clock, title = 'Architecture') {
    const d = new Diagram(1000, 470, 15, title, 'flowtinus.editor · flowtinus.server · flowtinus.core', clock);
    const t = d.text.bind(d);

    // who calls
    d.add(d.node(24, 30, 180, 62, 'Editor', 'flowtinus.editor', { dot: C.flow }));
    d.add(d.node(24, 140, 180, 62, 'Agent (MCP)', 'Claude, Copilot…', { dot: C.code_ }));
    d.add(d.node(24, 250, 180, 62, 'Another system', 'calls a webhook', { dot: C.api }));

    // the API server
    d.add(d.box(244, 30, 180, 282, { fill: C.gold, stroke: 'none' }));
    d.add(t(258, 56, 'API server', { weight: 700, fill: C.onGold }));
    d.add(t(258, 74, 'flowtinus.server/api', { size: 10, mono: true, fill: '#4a3410' }));
    d.add(t(258, 88, ':5190', { size: 10, mono: true, fill: '#4a3410' }));
    const routes: [number, string, string][] = [
        [104, '/w/:ws/…', 'the editor’s api'],
        [148, '/runs/:id/events', 'SSE'],
        [192, '/mcp', 'tools for agents'],
        [264, '/wh/:id', 'webhooks'],
    ];
    for (const [y, path, what] of routes) {
        d.add(`<rect x="256" y="${y}" width="156" height="36" rx="6" fill="rgba(17,17,17,0.10)"/>`);
        d.add(t(266, y + 15, path, { size: 10.5, mono: true, weight: 700, fill: C.onGold }));
        d.add(t(266, y + 29, what, { size: 10, fill: '#4a3410' }));
    }

    // Postgres
    container(d, 464, 30, 220, 282, 'Postgres', S.postgres, { soft: 'rgba(54,186,235,0.05)' });
    const tables = [
        'workspaces · projects · flows',
        'versions · deployments',
        'runs · test_runs  (the queue)',
        'supervisors',
        'schedules · webhooks',
    ];
    tables.forEach((name, i) => {
        d.add(`<rect x="476" y="${70 + i * 32}" width="196" height="26" rx="5" fill="${C.card}" stroke="${C.line2}"/>`);
        if (i !== 2) {
            d.add(t(486, 87 + i * 32, name, { size: 10.5, mono: true, fill: C.muted }));
        }
    });
    d.add(
        stateRowOf(
            d,
            476,
            134,
            196,
            [
                [0, C.line2, C.card],
                [1.8, S.queued, S.queuedSoft],
                [4.6, S.running, S.runningSoft],
                [8.4, S.ok, S.okSoft],
                [13.5, C.line2, C.card],
            ],
            26,
        ),
    );
    d.add(t(486, 151, 'runs · test_runs  (the queue)', { size: 10.5, mono: true, weight: 600 }));
    d.add(`<rect x="476" y="234" width="196" height="64" rx="5" fill="${S.notifySoft}" stroke="rgba(186,147,251,0.45)"/>`);
    d.add(t(486, 253, 'LISTEN / NOTIFY', { size: 10.5, mono: true, weight: 600, fill: S.notify }));
    d.add(t(486, 271, 'runs_queued · run_cancel', { size: 10, mono: true, fill: C.muted }));
    d.add(t(486, 287, 'run_events · schedules_changed', { size: 10, mono: true, fill: C.muted }));

    // supervisors and their workers
    container(d, 724, 20, 252, 214, 'Supervisor', S.supervisor);
    d.add(t(738, 64, 'flowtinus.server/supervisor', { size: 10, mono: true, fill: C.muted }));
    const workers = [738, 818, 898];
    workers.forEach((x, i) => {
        const busy = i === 0;
        d.add(
            `<rect x="${x}" y="78" width="70" height="100" rx="8" fill="${C.canvas}" stroke-width="1.2">${
                busy
                    ? d.steps('stroke', [
                          [0, C.line2],
                          [4.6, S.running],
                          [8.2, C.line2],
                      ])
                    : ''
            }</rect>`,
        );
        if (!busy) {
            d.add(`<rect x="${x}" y="78" width="70" height="100" rx="8" fill="none" stroke="${C.line2}" stroke-width="1.2"/>`);
        }
        d.add(t(x + 35, 98, `worker ${i + 1}`, { size: 10.5, weight: 600, anchor: 'middle' }));
        d.add(t(x + 35, 113, 'bun process', { size: 9.5, mono: true, fill: C.muted, anchor: 'middle' }));
        d.add(`<rect x="${x + 8}" y="124" width="54" height="44" rx="6" fill="${C.card}" stroke="${C.line2}"/>`);
        d.add(t(x + 35, 142, 'engine', { size: 10, weight: 600, anchor: 'middle', fill: busy ? C.gold : C.muted }));
        d.add(t(x + 35, 157, 'core', { size: 9.5, mono: true, anchor: 'middle', fill: C.muted }));
    });
    d.add(t(738, 206, 'no database access in a worker:', { size: 10, fill: C.muted }));
    d.add(t(738, 220, 'it gets the job and answers over IPC', { size: 10, fill: C.muted }));
    d.add(d.box(724, 244, 252, 34, { fill: 'none', stroke: S.supervisor, dash: true }));
    d.add(t(850, 266, 'more supervisors share the queue', { size: 10.5, anchor: 'middle', fill: C.muted }));

    // outside systems
    d.add(d.box(724, 300, 252, 150, { fill: C.card }));
    d.add(t(738, 324, 'What the flows reach', { weight: 700, size: 12.5 }));
    const outside: [string, string, number, number][] = [
        ['SQL Server', C.database, 738, 338],
        ['MongoDB', C.database, 856, 338],
        ['Redshift', C.database, 738, 374],
        ['HTTP APIs', C.api, 856, 374],
    ];
    for (const [name, color, x, y] of outside) {
        d.add(`<rect x="${x}" y="${y}" width="108" height="28" rx="6" fill="${C.canvas}" stroke="${C.line2}"/>`);
        d.add(`<circle cx="${x + 13}" cy="${y + 14}" r="4" fill="${color}"/>`);
        d.add(t(x + 24, y + 18.5, name, { size: 11, weight: 600 }));
    }
    d.add(t(738, 430, 'connections · secrets: the workspace’s', { size: 10, mono: true, fill: C.muted }));

    // observability
    d.add(d.box(244, 350, 440, 100, { fill: C.card }));
    d.add(t(258, 374, 'Observability', { weight: 700, size: 12.5 }));
    d.add(t(670, 374, 'docker compose --profile observability', { size: 10, mono: true, fill: C.muted, anchor: 'end' }));
    d.add(`<rect x="258" y="388" width="190" height="44" rx="6" fill="${C.canvas}" stroke="${C.line2}"/>`);
    d.add(t(270, 406, 'otel-collector', { size: 11, weight: 600 }));
    d.add(t(270, 422, 'logs (JSON) · metrics', { size: 10, mono: true, fill: C.muted }));
    d.add(`<rect x="480" y="388" width="190" height="44" rx="6" fill="${C.canvas}" stroke="${C.line2}"/>`);
    d.add(t(492, 406, 'OpenObserve', { size: 11, weight: 600 }));
    d.add(t(492, 422, ':5080 · search, dashboards', { size: 10, mono: true, fill: C.muted }));
    d.add(
        d.line(
            [
                [448, 410],
                [480, 410],
            ],
            { arrow: true },
        ),
    );

    // wires
    d.add(
        d.line(
            [
                [204, 61],
                [244, 61],
            ],
            { arrow: true },
        ),
    );
    d.add(
        d.line(
            [
                [204, 171],
                [244, 171],
            ],
            { arrow: true },
        ),
    );
    d.add(
        d.line(
            [
                [204, 281],
                [244, 281],
            ],
            { arrow: true },
        ),
    );
    d.add(
        d.line(
            [
                [424, 140],
                [464, 140],
            ],
            { arrow: true },
        ),
    );
    d.add(
        d.line(
            [
                [684, 140],
                [724, 120],
            ],
            { dash: true },
        ),
    );
    d.add(
        d.line(
            [
                [850, 234],
                [850, 244],
            ],
            { dash: true },
        ),
    );
    d.add(
        d.line(
            [
                [773, 178],
                [773, 300],
            ],
            { dash: true },
        ),
    );

    // 0-2 the editor's run: to the API, then a row
    d.add(
        d.mover(
            [
                [204, 61],
                [244, 61],
            ],
            [0.2, 0.9],
            d.envelope(S.run, 'Run'),
        ),
    );
    d.add(
        d.mover(
            [
                [424, 140],
                [476, 147],
            ],
            [1, 1.8],
            d.envelope(S.run, 'INSERT'),
        ),
    );
    // 2-4 NOTIFY, claim
    d.add(d.pulse(574, 264, 2.1, S.notify, 40));
    d.add(
        d.mover(
            [
                [684, 140],
                [724, 120],
            ],
            [2.2, 3],
            d.signal(S.notify, 'NOTIFY'),
        ),
    );
    d.add(
        d.mover(
            [
                [724, 120],
                [684, 140],
                [672, 147],
            ],
            [3.2, 3.6, 3.9],
            d.envelope(S.run, 'claim', { below: true }),
        ),
    );
    d.add(
        d.mover(
            [
                [672, 147],
                [684, 140],
                [724, 120],
                [773, 150],
            ],
            [4, 4.2, 4.4, 4.6],
            d.envelope(S.run, 'job'),
        ),
    );
    // 4.6-7 the engine reaches outside
    for (const [s, x, y, color] of [
        [4.9, 792, 352, C.database],
        [5.4, 910, 388, C.api],
        [5.9, 792, 388, C.database],
        [6.4, 910, 352, C.database],
    ] as [number, number, number, string][]) {
        d.add(
            d.mover(
                [
                    [773, 168],
                    [773, 300],
                    [x, y],
                ],
                [s, s + 0.35, s + 0.6],
                d.envelope(color, undefined, { scale: 0.8 }),
            ),
        );
    }
    // 7-9 progress, done, SSE
    for (const s of [7, 7.6]) {
        d.add(
            d.mover(
                [
                    [773, 150],
                    [724, 120],
                    [684, 140],
                    [672, 147],
                ],
                [s, s + 0.2, s + 0.35, s + 0.5],
                d.envelope(S.queued, undefined, { scale: 0.75 }),
            ),
        );
    }
    d.add(
        d.mover(
            [
                [773, 150],
                [724, 120],
                [684, 140],
                [672, 147],
            ],
            [8, 8.15, 8.25, 8.4],
            d.envelope(S.ok, 'done'),
        ),
    );
    d.add(
        d.mover(
            [
                [464, 150],
                [424, 150],
                [334, 150],
                [334, 108],
            ],
            [8.5, 8.65, 8.8, 8.95],
            d.signal(S.notify, 'run_events', { below: true }),
        ),
    );
    d.add(
        d.mover(
            [
                [244, 75],
                [204, 75],
            ],
            [9, 9.4],
            d.signal(S.notify, 'SSE', { below: true }),
        ),
    );
    // 9-11 an agent
    d.add(
        d.mover(
            [
                [204, 171],
                [244, 171],
            ],
            [9.4, 10],
            d.envelope(C.code_, 'tools/call'),
        ),
    );
    d.add(
        d.mover(
            [
                [424, 145],
                [476, 140],
            ],
            [10.2, 10.8],
            d.envelope(C.code_, 'same use cases', { below: true }),
        ),
    );
    // 11-13 webhook and schedule
    d.add(
        d.mover(
            [
                [204, 281],
                [244, 281],
            ],
            [11.1, 11.7],
            d.envelope(C.api, 'POST /wh/:id'),
        ),
    );
    d.add(
        d.mover(
            [
                [424, 150],
                [476, 140],
            ],
            [11.8, 12.3],
            d.envelope(S.run, 'v3', { below: true }),
        ),
    );
    d.add(
        d.mover(
            [
                [724, 110],
                [684, 200],
                [672, 212],
            ],
            [12, 12.4, 12.8],
            d.envelope(S.run, 'schedule v3', { anchor: 'end', dx: 10 }),
        ),
    );
    // 13-15 logs
    d.add(
        d.mover(
            [
                [334, 312],
                [334, 388],
            ],
            [13.1, 13.7],
            d.signal(C.flow, 'logs', { anchor: 'start', dx: 10 }),
        ),
    );
    d.add(
        d.mover(
            [
                [850, 278],
                [700, 330],
                [448, 395],
            ],
            [13.2, 13.6, 14],
            d.signal(C.flow, 'logs'),
        ),
    );
    d.add(
        d.mover(
            [
                [448, 410],
                [480, 410],
            ],
            [14.1, 14.5],
            d.signal(C.flow),
        ),
    );

    d.captions(ARCHITECTURE_STEPS);
    return d;
}

function stateRowOf(d: Diagram, x: number, y: number, w: number, states: [number, string, string][], h = 28) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" stroke-width="1.2">${d.steps(
        'fill',
        states.map(s => [s[0], s[2]]),
    )}${d.steps(
        'stroke',
        states.map(s => [s[0], s[1]]),
    )}</rect>`;
}

// 02. Claiming: FOR UPDATE SKIP LOCKED

const CLAIM_STEPS: [number, number, string][] = [
    [0, 1, 'A run was queued: NOTIFY runs_queued wakes both supervisors'],
    [1, 2.2, 'A locks R1 first: the highest priority, then the oldest'],
    [2.2, 3.6, 'B finds R1 locked: SKIP LOCKED makes it take the next one, R2, without waiting'],
    [3.6, 5, 'Each UPDATE marks its row running with its worker_id: a run goes to exactly one supervisor'],
    [5, 7.4, 'A still has a free worker: it claims again (fill loops while active < WORKERS)'],
    [7.4, 10, 'Both are full: R4 waits; the next free worker (a run ends, or the 5 s poll) claims it'],
];

function claim(clock: Clock, title = 'Claiming runs') {
    const d = new Diagram(1000, 470, 10, title, 'FOR UPDATE SKIP LOCKED', clock);
    const t = d.text.bind(d);
    const LOCK = C.fixed;
    const LOCK_SOFT = 'rgba(237,213,163,0.14)';

    container(d, 24, 110, 230, 120, 'Supervisor A', S.supervisor);
    d.add(t(38, 66 + 84, 'WORKERS=2', { size: 10.5, mono: true, fill: C.muted }));
    d.add(
        d.ticker(
            38,
            206,
            [
                [0, 'busy 0 / 2'],
                [4.6, 'busy 1 / 2'],
                [7.4, 'busy 2 / 2 · full'],
            ],
            { size: 12, weight: 600, mono: true, fill: C.text },
        ),
    );

    container(d, 746, 110, 230, 120, 'Supervisor B', S.supervisor);
    d.add(t(760, 150, 'WORKERS=1', { size: 10.5, mono: true, fill: C.muted }));
    d.add(
        d.ticker(
            760,
            206,
            [
                [0, 'busy 0 / 1'],
                [4.6, 'busy 1 / 1 · full'],
            ],
            { size: 12, weight: 600, mono: true },
        ),
    );

    // the queue
    container(d, 320, 20, 360, 300, 'Postgres', S.postgres, { note: "runs · status 'queued'", soft: 'rgba(54,186,235,0.05)' });
    d.add(t(500, 66, 'ORDER BY priority DESC, queued_at', { size: 10.5, mono: true, fill: C.muted, anchor: 'middle' }));
    const rows = ['R1', 'R2', 'R3', 'R4'];
    const y = (i: number) => 80 + i * 56;
    const fate: Record<string, [number, number, 'A' | 'B'] | null> = {
        R1: [2, 4.4, 'A'],
        R2: [3.6, 4.4, 'B'],
        R3: [6.6, 7.2, 'A'],
        R4: null,
    };
    rows.forEach((name, i) => {
        const story = fate[name];
        const states: [number, string, string][] = story
            ? [
                  [0, S.queued, S.queuedSoft],
                  [story[0], LOCK, LOCK_SOFT],
                  [story[1], S.running, S.runningSoft],
              ]
            : [[0, S.queued, S.queuedSoft]];
        d.add(stateRowOf(d, 340, y(i), 320, states, 44));
        d.add(t(356, y(i) + 27, name, { weight: 700 }));
        if (!story) {
            d.add(t(400, y(i) + 27, 'queued', { size: 11.5, mono: true, fill: S.queued, weight: 600 }));
            d.add(d.during(7.4, 10, t(644, y(i) + 27, 'waits', { size: 11.5, anchor: 'end', fill: C.muted })));
            return;
        }
        d.add(d.during(0, story[0], t(400, y(i) + 27, 'queued', { size: 11.5, mono: true, fill: S.queued, weight: 600 })));
        d.add(
            d.during(story[0], story[1], t(400, y(i) + 27, `locked by ${story[2]}`, { size: 11.5, mono: true, fill: LOCK, weight: 600 })),
        );
        d.add(
            d.during(
                story[1],
                10,
                t(400, y(i) + 27, `running · worker_id ${story[2]}`, { size: 11.5, mono: true, fill: S.running, weight: 600 }),
            ),
        );
    });

    // 0-1 both woken
    d.add(d.pulse(254, 170, 0.3, S.notify, 30));
    d.add(d.pulse(746, 170, 0.3, S.notify, 30));
    d.add(d.during(0.3, 1.6, t(139, 98, 'NOTIFY', { size: 11, weight: 700, mono: true, fill: S.notify, anchor: 'middle' })));
    d.add(d.during(0.3, 1.6, t(861, 98, 'NOTIFY', { size: 11, weight: 700, mono: true, fill: S.notify, anchor: 'middle' })));
    // 1-2 A reaches R1 first; B arrives right after, R1 is locked: skips to R2
    d.add(
        d.mover(
            [
                [254, 150],
                [340, y(0) + 22],
            ],
            [1, 2],
            d.signal(C.text, 'A', { r: 6 }),
        ),
    );
    d.add(
        d.mover(
            [
                [746, 150],
                [660, y(0) + 22],
                [660, y(0) + 22],
                [690, y(1) - 6],
                [660, y(1) + 22],
            ],
            [1.3, 2.4, 2.8, 3.2, 3.6],
            d.signal(C.text, 'B', { r: 6 }),
        ),
    );
    d.add(d.during(2.5, 3.6, t(646, y(0) + 27, 'B: locked, skip', { size: 11, weight: 700, mono: true, fill: C.text, anchor: 'end' })));
    // 4.4 claimed: the rows go to their workers
    d.add(
        d.mover(
            [
                [340, y(0) + 22],
                [254, 185],
            ],
            [4.4, 4.9],
            d.envelope(S.run),
        ),
    );
    d.add(
        d.mover(
            [
                [660, y(1) + 22],
                [746, 185],
            ],
            [4.4, 4.9],
            d.envelope(S.run),
        ),
    );
    // 5.6 A has a free worker left: claims again
    d.add(
        d.mover(
            [
                [254, 195],
                [340, y(2) + 22],
            ],
            [5.6, 6.6],
            d.signal(C.text, 'A', { r: 6 }),
        ),
    );
    d.add(
        d.mover(
            [
                [340, y(2) + 22],
                [254, 200],
            ],
            [7.2, 7.6],
            d.envelope(S.run),
        ),
    );

    // the query
    code(d, 24, 340, 952, 120, 'claimRun · flowtinus.server/features/runs/run-queue.ts', [
        "UPDATE runs SET status = 'running', started_at = now(), heartbeat_at = now(), worker_id = $2",
        "WHERE id = ( SELECT id FROM runs WHERE status = 'queued' AND worker_tag = ANY($1::text[])",
        '             ORDER BY priority DESC, queued_at  FOR UPDATE SKIP LOCKED  LIMIT 1 )',
        'RETURNING …',
    ]);

    d.captions(CLAIM_STEPS);
    return d;
}

// 03. Worker tags

const TAGS_STEPS: [number, number, string][] = [
    [0, 1.8, 'A flow’s tag (its settings) is copied to each run it queues: runs.worker_tag'],
    [1.8, 3, 'The API refuses a run whose tag no live supervisor has: it would wait forever'],
    [3, 5, 'A supervisor only claims the runs whose tag is in its WORKER_TAGS; its replicas share the queue'],
    [5, 9, 'WORKER_COLOR paints the tag on the screens; WORKERS = runs at the same time per container'],
];

function tags(clock: Clock, title = 'Worker tags') {
    const d = new Diagram(1000, 420, 9, title, 'which supervisors run a flow', clock);
    const t = d.text.bind(d);
    const SKY = C.transformation;
    const VIOLET = C.code_;
    const GRAY = C.flow;

    const flows = [
        { y: 40, name: 'Import orders', tag: 'default', color: SKY, soft: S.queuedSoft },
        { y: 150, name: 'Resize images', tag: 'heavy', color: VIOLET, soft: C.codeSoft },
        { y: 260, name: 'Train model', tag: 'gpu', color: GRAY, soft: 'rgba(211,216,222,0.10)' },
    ];
    for (const fl of flows) {
        d.add(d.box(24, fl.y, 196, 74));
        d.add(`<circle cx="40" cy="${fl.y + 22}" r="4.5" fill="${C.flow}"/>`);
        d.add(t(52, fl.y + 27, fl.name, { weight: 600 }));
        d.add(d.chip(38, fl.y + 40, `tag ${fl.tag}`, fl.color, fl.soft));
    }

    // the API's gate
    d.add(d.box(268, 30, 140, 320, { fill: C.gold, stroke: 'none' }));
    d.add(t(338, 58, 'API server', { weight: 700, anchor: 'middle', fill: C.onGold }));
    d.add(t(338, 76, 'hasLiveSupervisor', { size: 10, mono: true, fill: '#4a3410', anchor: 'middle' }));
    d.add(t(338, 90, '(tag)', { size: 10, mono: true, fill: '#4a3410', anchor: 'middle' }));

    // the queue
    container(d, 456, 30, 180, 320, 'Postgres', S.postgres, { soft: 'rgba(54,186,235,0.05)' });
    d.add(t(470, 70, 'runs.worker_tag', { size: 10.5, mono: true, fill: C.muted }));

    // supervisors
    container(d, 684, 30, 292, 140, 'Supervisor A · 2 replicas', S.supervisor);
    d.add(t(698, 72, 'WORKER_TAGS=default,reports · WORKERS=4', { size: 10, mono: true, fill: C.muted }));
    d.add(`<rect x="698" y="100" width="128" height="36" rx="6" fill="${C.canvas}" stroke="${C.line2}"/>`);
    d.add(t(762, 123, 'supervisor-1', { size: 10.5, mono: true, anchor: 'middle' }));
    d.add(`<rect x="834" y="100" width="128" height="36" rx="6" fill="${C.canvas}" stroke="${C.line2}"/>`);
    d.add(t(898, 123, 'supervisor-2', { size: 10.5, mono: true, anchor: 'middle' }));

    container(d, 684, 190, 292, 130, 'Supervisor heavy', S.supervisor);
    d.add(t(698, 232, 'WORKER_TAGS=heavy · WORKERS=2', { size: 10, mono: true, fill: C.muted }));
    d.add(t(698, 248, 'WORKER_COLOR=violet', { size: 10, mono: true, fill: VIOLET }));
    d.add(`<rect x="698" y="264" width="264" height="36" rx="6" fill="${C.codeSoft}" stroke="${VIOLET}"/>`);
    d.add(t(830, 287, 'supervisor-heavy-1', { size: 10.5, mono: true, anchor: 'middle', fill: VIOLET }));

    d.add(d.box(684, 340, 292, 40, { dash: true, fill: 'none' }));
    d.add(t(830, 365, "no supervisor has 'gpu'", { size: 11.5, anchor: 'middle', fill: C.muted }));

    // the queued rows, while they wait
    d.add(
        d.during(
            2.1,
            2.7,
            `<rect x="470" y="110" width="152" height="24" rx="5" fill="${S.queuedSoft}" stroke="${SKY}"/>${t(546, 127, 'queued · default', { size: 10.5, mono: true, fill: SKY, anchor: 'middle' })}`,
        ),
    );
    d.add(
        d.during(
            2.9,
            3.5,
            `<rect x="470" y="190" width="152" height="24" rx="5" fill="${C.codeSoft}" stroke="${VIOLET}"/>${t(546, 207, 'queued · heavy', { size: 10.5, mono: true, fill: VIOLET, anchor: 'middle' })}`,
        ),
    );
    // default: through to A (either replica)
    d.add(
        d.mover(
            [
                [220, 77],
                [268, 77],
                [408, 100],
                [456, 122],
                [530, 122],
            ],
            [0.2, 0.7, 1.4, 1.7, 2.1],
            d.envelope(SKY, 'default'),
        ),
    );
    d.add(
        d.mover(
            [
                [530, 122],
                [636, 122],
                [762, 118],
            ],
            [2.6, 3.1, 3.6],
            d.envelope(SKY),
        ),
    );
    // heavy: through to the heavy supervisor
    d.add(
        d.mover(
            [
                [220, 187],
                [268, 187],
                [408, 202],
                [456, 202],
                [546, 202],
            ],
            [1, 1.5, 2.2, 2.5, 2.9],
            d.envelope(VIOLET, 'heavy'),
        ),
    );
    d.add(
        d.mover(
            [
                [546, 202],
                [636, 230],
                [830, 282],
            ],
            [3.4, 3.9, 4.6],
            d.envelope(VIOLET),
        ),
    );
    // gpu: refused at the API
    d.add(
        d.mover(
            [
                [220, 297],
                [300, 297],
            ],
            [1.8, 2.6],
            d.envelope(GRAY, 'gpu'),
        ),
    );
    d.add(
        d.during(
            2.6,
            9,
            `<g><circle cx="338" cy="297" r="13" fill="${C.errSoft}" stroke="${C.err}" stroke-width="2"/><path d="M332 291 L344 303 M344 291 L332 303" stroke="${C.err}" stroke-width="2.5"/></g>${t(338, 330, 'refused (502)', { size: 11, weight: 700, mono: true, fill: C.onGold, anchor: 'middle' })}`,
        ),
    );

    d.captions(TAGS_STEPS);
    return d;
}

// 04. Heartbeats and reaping

const HEARTBEATS_STEPS: [number, number, string][] = [
    [0, 4, 'Every 5 s each supervisor bumps its last_seen and the heartbeat_at of the runs it has'],
    [4, 9.4, 'B dies with R7 running: its rows stop moving'],
    [9.4, 10.8, 'A’s poll runs reapGone: B unseen for 60 s → failRunsOf(B), then its row goes'],
    [10.8, 13, 'Also: reapStaleRuns fails any running run whose heartbeat_at is older than 60 s'],
];

function heartbeats(clock: Clock, title = 'Heartbeats and lost runs') {
    const d = new Diagram(1000, 420, 13, title, 'register · heartbeat · reap', clock);
    const t = d.text.bind(d);
    const crash = 4;
    const reap = 10;

    container(d, 24, 40, 236, 110, 'Supervisor A', S.supervisor);
    d.add(t(38, 86, 'every 5 s: heartbeat + register', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(38, 104, 'every 5 s: poll → reap + fill', { size: 10.5, mono: true, fill: C.muted }));

    d.add(
        `<rect x="24" y="230" width="236" height="110" rx="10" stroke-width="1.2">${d.steps('fill', [
            [0, C.card],
            [crash, C.errSoft],
        ])}${d.steps('stroke', [
            [0, S.supervisor],
            [crash, S.err],
        ])}</rect>`,
    );
    d.add(
        `<circle cx="42" cy="252" r="4.5">${d.steps('fill', [
            [0, S.supervisor],
            [crash, S.err],
        ])}</circle>`,
    );
    d.add(t(54, 257, 'Supervisor B', { weight: 700 }));
    d.add(d.during(0, crash, t(38, 280, 'running R7 on worker 1', { size: 10.5, mono: true, fill: C.muted })));
    d.add(d.during(crash, 13, t(38, 280, 'container killed (OOM, kill -9)', { size: 10.5, mono: true, fill: S.err, weight: 600 })));
    d.add(d.during(crash, 13, t(38, 298, 'no more heartbeats', { size: 10.5, mono: true, fill: S.err })));

    // Postgres
    container(d, 330, 20, 646, 330, 'Postgres', S.postgres, { soft: 'rgba(54,186,235,0.05)' });
    d.add(t(350, 76, 'supervisors', { size: 11.5, weight: 600, mono: true }));
    d.add(`<rect x="350" y="86" width="606" height="30" rx="6" fill="${C.card}" stroke="${C.line2}"/>`);
    d.add(t(362, 106, 'A · tags {default} · workers 2 · last_seen = now()', { size: 11, mono: true }));
    d.add(
        `<g>${d.steps('opacity', [
            [0, '1'],
            [reap + 0.6, '0'],
        ])}${stateRowOf(
            d,
            350,
            122,
            606,
            [
                [0, C.line2, C.card],
                [crash, S.err, S.errSoft],
            ],
            30,
        )}${d.during(0, crash, t(362, 142, 'B · tags {default} · workers 1 · last_seen = now()', { size: 11, mono: true }))}${d.during(
            crash,
            13,
            t(362, 142, 'B · tags {default} · workers 1 · last_seen getting older…', { size: 11, mono: true, fill: S.err }),
        )}</g>`,
    );
    d.add(d.during(reap + 0.6, 13, t(362, 142, 'B · row deleted: gone from the Workers page', { size: 11, mono: true, fill: C.muted })));

    d.add(t(350, 184, 'runs', { size: 11.5, weight: 600, mono: true }));
    d.add(
        stateRowOf(
            d,
            350,
            194,
            606,
            [
                [0, S.running, S.runningSoft],
                [reap + 0.6, S.err, S.errSoft],
            ],
            30,
        ),
    );
    d.add(d.during(0, reap + 0.6, t(362, 214, 'R7 · running · worker_id B · heartbeat_at', { size: 11, mono: true })));
    d.add(
        d.during(
            reap + 0.6,
            13,
            t(362, 214, "R7 · failed · 'The supervisor running it stopped.'", { size: 11, mono: true, fill: S.err, weight: 600 }),
        ),
    );

    // B's silence against the 60 s limit
    d.add(t(350, 263, 'B silent for', { size: 11.5, weight: 600 }));
    d.add(`<rect x="450" y="251" width="486" height="16" rx="8" fill="${C.card}" stroke="${C.line2}"/>`);
    const a = d.at(crash);
    const b = d.at(reap);
    d.add(
        `<rect x="450" y="251" width="0" height="16" rx="8" fill="${S.err}" opacity="0.8"><animate attributeName="width" dur="${d.dur}s" repeatCount="indefinite" values="0;0;486;486" keyTimes="0;${f(a)};${f(b)};1"/></rect>`,
    );
    d.add(t(450, 286, '0 s', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(936, 286, '60 s: lost', { size: 10.5, mono: true, fill: S.err, anchor: 'end', weight: 600 }));
    d.add(`<path d="M531 248 L531 270" stroke="${C.muted}" stroke-dasharray="2 2"/>`);
    d.add(t(537, 286, '10 s: same host, pid gone', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(350, 326, 'SUPERVISOR_LOST_AFTER_MS = STALE_AFTER_MS = 60 s · heartbeat every 5 s', { size: 10.5, mono: true, fill: C.muted }));

    // heartbeats: A always, B until it dies
    for (let s = 0.3; s < 13; s += 1.2) {
        d.add(
            d.mover(
                [
                    [260, 90],
                    [350, 101],
                ],
                [s, s + 0.5],
                d.signal(S.ok, undefined, { r: 4.5 }),
            ),
        );
    }
    for (let s = 0.9; s < crash; s += 1.2) {
        d.add(
            d.mover(
                [
                    [260, 270],
                    [350, 137],
                ],
                [s, s + 0.6],
                d.signal(S.ok, undefined, { r: 4.5 }),
            ),
        );
        d.add(
            d.mover(
                [
                    [260, 275],
                    [350, 209],
                ],
                [s, s + 0.6],
                d.signal(S.ok, undefined, { r: 4 }),
            ),
        );
    }
    d.add(
        d.during(0.3, crash, t(300, 186, 'heartbeat', { size: 10.5, weight: 700, mono: true, fill: S.ok, anchor: 'middle', halo: true })),
    );
    // the reap
    d.add(
        d.mover(
            [
                [260, 130],
                [350, 209],
            ],
            [reap - 0.6, reap + 0.5],
            d.signal(C.database, 'reapGone', { below: true }),
        ),
    );
    d.add(d.pulse(650, 209, reap + 0.5, S.err, 50));

    d.captions(HEARTBEATS_STEPS);
    return d;
}

// 06. The engine: envelopes through components (the website's "Watch a run move", as a test run)

type EngineNode = { id: string; label: string; kind: 'fixed' | 'database' | 'transformation' | 'api' | 'flow'; at: P };

const ENGINE_NODES: EngineNode[] = [
    { id: 'start', label: 'Start', kind: 'fixed', at: [70, 110] },
    { id: 'query', label: 'SQL Server Query', kind: 'database', at: [235, 110] },
    { id: 'mapper', label: 'Mapper', kind: 'transformation', at: [405, 110] },
    { id: 'router', label: 'Router', kind: 'transformation', at: [575, 110] },
    { id: 'http', label: 'HTTP Request', kind: 'api', at: [760, 55] },
    { id: 'discard', label: 'Discard', kind: 'flow', at: [760, 170] },
    { id: 'end', label: 'End', kind: 'fixed', at: [930, 55] },
];

const ENGINE_STEPS: [number, number, string][] = [
    [0, 1.2, 'The Start sends one envelope (the run’s parameters); every edge is a Channel, a bounded queue'],
    [1.2, 5, 'The query streams an envelope per row, and every component runs at once: rows flow, they don’t wait for a batch'],
    [5, 9, 'HTTP Request is slower: its input channel fills up (64) and the Router waits for room: backpressure'],
    [9, 11.5, 'Rows without a customer leave the Router by else, to a Discard: dropped on purpose, and counted'],
    [11.5, 14, 'When its inputs close a component ends and closes its outputs; the record keeps counts, samples, times'],
];

function engine(clock: Clock, title = 'Test run · draft · tag default') {
    const d = new Diagram(1000, 430, 14, title, 'flowtinus.core · engine', clock);
    const t = d.text.bind(d);
    const byId = Object.fromEntries(ENGINE_NODES.map(n => [n.id, n])) as Record<string, EngineNode>;
    const color = { fixed: C.onGold, database: C.database, transformation: C.transformation, api: C.api, flow: C.flow };

    const route = (ids: string[]) => {
        const pts: P[] = [];
        ids.forEach((id, i) => {
            const p = byId[id]!.at;
            if (i > 0) {
                const prev = pts[pts.length - 1]!;
                if (prev[1] !== p[1]) {
                    const mx = (prev[0] + p[0]) / 2 - 15;
                    pts.push([mx, prev[1]], [mx + 30, p[1]]);
                }
            }
            pts.push(p);
        });
        return pts;
    };
    const MAIN = route(['query', 'mapper', 'router', 'http', 'end']);
    const SIDE = route(['query', 'mapper', 'router', 'discard']);
    const length = (pts: P[]) => pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]), 0);
    /** the moment each point of a route is reached, at a speed */
    const timesOf = (pts: P[], start: number, speed: number) => {
        const out = [start];
        for (let i = 1; i < pts.length; i++) {
            out.push(out[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]) / speed);
        }
        return out;
    };

    // wires
    d.add(d.line(route(['start', 'query', 'mapper', 'router', 'http', 'end'])));
    d.add(d.line(SIDE.slice(-4)));

    // the envelopes: one from the Start, then 24 rows (each stands for 52), every 6th has no customer
    const ROWS = 52;
    const SPEED = length(MAIN) / 3.2;
    const passed: Record<string, number[]> = { query: [], mapper: [], router: [], http: [], discard: [], end: [] };
    d.add(d.mover([byId.start!.at, byId.query!.at], [0.3, 1.1], d.envelope(C.gold)));
    for (let k = 0; k < 24; k++) {
        const side = k % 6 === 4;
        const pts = side ? SIDE : MAIN;
        const start = 1.2 + k * 0.3;
        const times = timesOf(pts, start, SPEED);
        // the HTTP Request is slower: from 5 s on, its envelopes wait before it (the Router's channel fills)
        if (!side && start > 3.2) {
            const i = pts.findIndex(p => p === byId.http!.at);
            const wait = Math.min(1.6, (start - 3.2) * 0.35);
            for (let j = i; j < times.length; j++) {
                times[j]! += wait;
            }
        }
        const ids = side ? ['query', 'mapper', 'router', 'discard'] : ['query', 'mapper', 'router', 'http', 'end'];
        for (const id of ids) {
            passed[id]!.push(times[pts.findIndex(p => p === byId[id]!.at)]!);
        }
        d.add(d.mover(pts, times, d.envelope(side ? '#8a8f96' : C.gold)));
    }
    const finish = Math.max(...passed.end!, ...passed.discard!);

    // nodes, on top of the wires and the envelopes
    for (const n of ENGINE_NODES) {
        const half = n.kind === 'fixed' ? 40 : Math.max(66, n.label.length * 3.9 + 22);
        const [x, y] = n.at;
        const fixed = n.kind === 'fixed';
        d.add(
            `<rect x="${x - half}" y="${y - 22}" width="${half * 2}" height="44" rx="10" fill="${fixed ? C.fixed : C.card}" stroke="${fixed ? 'none' : C.line2}" stroke-width="1.2"/>`,
        );
        d.add(`<circle cx="${x - half + 14}" cy="${y}" r="4.5" fill="${color[n.kind]}"/>`);
        d.add(t(x - half + 26, y + 4.5, n.label, { size: 12.5, weight: 600, fill: fixed ? C.onGold : C.text }));
        // its count, as it grows
        const counts = n.id === 'start' ? [0.3] : passed[n.id]!;
        const frames: [number, string][] = [[0, '—']];
        counts
            .slice()
            .sort((p, q) => p - q)
            .forEach((at, i) => frames.push([at, (n.id === 'start' ? 1 : (i + 1) * ROWS).toLocaleString('en-US')]));
        d.add(d.ticker(x, y + 40, frames, { size: 11.5, mono: true, anchor: 'middle', fill: C.muted }));
    }

    // the run's status, top left of the canvas
    d.add(
        d.ticker(
            24,
            26,
            [
                [0, '● Queued'],
                [0.2, '● Running'],
                [finish + 0.1, '● Succeeded · 11.2 s'],
            ],
            { size: 11.5, mono: true, weight: 600, fill: C.gold },
        ),
    );

    // below: the envelope, the channel, a component
    code(
        d,
        24,
        240,
        300,
        176,
        'an envelope (Mapper, out)',
        [
            '{',
            '  FLOW_CURRENT_RUN: { id, mode, flow… },',
            '  PARAMETERS: { since: "2026-11-14" },',
            '  DATA: { id: 88213, customer_id: "c_1029",',
            '          amount: 14990, currency: "USD" }',
            '}',
        ],
        { size: 11 },
    );

    d.add(d.box(340, 240, 316, 176, { fill: C.card }));
    d.add(t(354, 262, 'Channel · Router → HTTP Request', { size: 11, mono: true, fill: C.muted }));
    d.add(`<path d="M340 272 H656" stroke="${C.line}"/>`);
    d.add(t(354, 296, 'a bounded queue: 64 envelopes', { size: 12 }));
    for (let i = 0; i < 16; i++) {
        const x = 354 + i * 18;
        d.add(`<rect x="${x}" y="312" width="14" height="22" rx="3" fill="none" stroke="${C.line2}"/>`);
        d.add(
            d.during(
                5 + i * 0.18,
                9.6 - i * 0.05,
                `<rect x="${x}" y="312" width="14" height="22" rx="3" fill="${C.gold}" opacity="0.85"/>`,
            ),
        );
    }
    d.add(
        d.ticker(
            354,
            360,
            [
                [0, 'room: the Router sends as it routes'],
                [7.6, 'full: the Router waits (backpressure)'],
                [9.6, 'room again'],
            ],
            { size: 11, mono: true, fill: C.muted },
        ),
    );
    d.add(t(354, 396, 'only a few envelopes in memory, whatever the input', { size: 11, fill: C.muted }));

    code(
        d,
        672,
        240,
        304,
        176,
        'a component: an async generator',
        [
            'async *execute(inputs, config, ctx) {',
            "  for await (const doc of inputs['in-0'])",
            '    yield {',
            "      port: hasCustomer ? 'out-0' : 'else',",
            '      doc,',
            '    };',
            '}',
        ],
        { size: 11 },
    );

    d.captions(ENGINE_STEPS);
    return d;
}

// 09/10. Triggers: schedules and webhooks run the deployed version

const TRIGGERS_STEPS: [number, number, string][] = [
    [0, 2.4, 'A supervisor keeps a timer on the next next_fire_at: a schedule is due'],
    [2.4, 4.6, 'One transaction: lock the schedule (SKIP LOCKED), queue a run of the deployed version, set the next time'],
    [4.6, 6.6, 'Another system calls POST /wh/:id with its token: the API compares its sha256'],
    [6.6, 8.6, 'The API queues a run of the deployed version: the body is the input, the query string the parameters'],
    [8.6, 12, 'Both are runs like any other: NOTIFY, a supervisor with the tag claims them; async answers 202 at once'],
];

function triggers(clock: Clock, title = 'Schedules and webhooks') {
    const d = new Diagram(1000, 400, 12, title, 'they run the deployed version', clock);
    const t = d.text.bind(d);

    // the schedule's clock and the caller
    d.add(d.box(24, 30, 200, 100));
    d.add(`<circle cx="42" cy="52" r="4.5" fill="${C.gold}"/>`);
    d.add(t(54, 57, 'Schedule', { weight: 700 }));
    d.add(t(38, 82, '0 */5 * * * *', { size: 11, mono: true }));
    d.add(t(38, 100, 'America/Cuiaba · relaxed', { size: 10.5, mono: true, fill: C.muted }));
    d.add(
        d.ticker(
            38,
            118,
            [
                [0, 'next: 14:05:00'],
                [2.4, 'fired 14:05:00'],
                [4.6, 'next: 14:10:00'],
            ],
            { size: 10.5, mono: true, fill: C.gold },
        ),
    );

    d.add(d.node(24, 250, 200, 62, 'Another system', 'Bearer <token>', { dot: C.api }));
    d.add(
        d.during(
            9.4,
            12,
            t(124, 336, '202 { runId, status: "queued" }', { size: 10.5, mono: true, anchor: 'middle', fill: S.ok, weight: 600 }),
        ),
    );

    // supervisor and API
    container(d, 270, 30, 190, 100, 'Supervisor', S.supervisor);
    d.add(t(284, 74, 'fireSchedules()', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(284, 90, 'timer + NOTIFY', { size: 10.5, mono: true, fill: C.muted }));
    d.add(t(284, 106, 'schedules_changed', { size: 10.5, mono: true, fill: C.muted }));
    d.add(d.box(270, 230, 190, 100, { fill: C.gold, stroke: 'none' }));
    d.add(t(284, 256, 'API server', { weight: 700, fill: C.onGold }));
    d.add(t(284, 276, 'POST /wh/:id', { size: 10.5, mono: true, fill: C.onGold, weight: 700 }));
    d.add(t(284, 292, 'token → sha256, compared', { size: 10, fill: '#4a3410' }));
    d.add(t(284, 306, 'in constant time', { size: 10, fill: '#4a3410' }));

    // Postgres
    container(d, 508, 20, 260, 360, 'Postgres', S.postgres, { soft: 'rgba(54,186,235,0.05)' });
    const row = (y: number, label: string) => {
        d.add(t(522, y, label, { size: 11, weight: 600, mono: true }));
    };
    row(68, 'deployments');
    d.add(`<rect x="522" y="76" width="232" height="24" rx="5" fill="${C.card}" stroke="${C.line2}"/>`);
    d.add(t(532, 92, 'Import orders → v3', { size: 10.5, mono: true }));
    row(124, 'flow_schedules');
    d.add(
        stateRowOf(
            d,
            522,
            132,
            232,
            [
                [0, C.line2, C.card],
                [2.4, S.running, S.runningSoft],
                [4.6, C.line2, C.card],
            ],
            24,
        ),
    );
    d.add(
        d.ticker(
            532,
            148,
            [
                [0, 'next_fire_at 14:05:00'],
                [4.6, 'next_fire_at 14:10:00'],
            ],
            { size: 10.5, mono: true },
        ),
    );
    row(180, 'flow_webhooks');
    d.add(
        stateRowOf(
            d,
            522,
            188,
            232,
            [
                [0, C.line2, C.card],
                [5.4, S.running, S.runningSoft],
                [6.6, C.line2, C.card],
            ],
            24,
        ),
    );
    d.add(t(532, 204, 'token_sha256 · last call', { size: 10.5, mono: true }));
    row(236, 'runs');
    d.add(
        stateRowOf(
            d,
            522,
            244,
            232,
            [
                [0, C.line, quiet],
                [3.6, S.queued, S.queuedSoft],
                [9.4, S.running, S.runningSoft],
            ],
            24,
        ),
    );
    d.add(d.during(3.6, 12, t(532, 260, 'v3 · trigger schedule', { size: 10.5, mono: true })));
    d.add(
        stateRowOf(
            d,
            522,
            274,
            232,
            [
                [0, C.line, quiet],
                [7.6, S.queued, S.queuedSoft],
                [9.8, S.running, S.runningSoft],
            ],
            24,
        ),
    );
    d.add(d.during(7.6, 12, t(532, 290, 'v3 · trigger webhook', { size: 10.5, mono: true })));
    d.add(t(522, 330, 'unique (schedule_id, scheduled_for):', { size: 10, mono: true, fill: C.muted }));
    d.add(t(522, 346, 'a time queues one run, whatever happens', { size: 10, mono: true, fill: C.muted }));

    // the supervisors that run them
    container(d, 812, 150, 164, 120, 'Supervisors', S.supervisor);
    d.add(t(826, 194, 'with the flow’s tag', { size: 10.5, fill: C.muted }));
    d.add(t(826, 212, 'claim as usual', { size: 10.5, fill: C.muted }));
    d.add(t(826, 240, '→ 01 · a run', { size: 10.5, mono: true, fill: C.gold }));

    // wires
    d.add(
        d.line(
            [
                [224, 80],
                [270, 80],
            ],
            { dash: true },
        ),
    );
    d.add(
        d.line(
            [
                [224, 281],
                [270, 281],
            ],
            { arrow: true },
        ),
    );
    d.add(
        d.line(
            [
                [460, 80],
                [508, 120],
            ],
            { dash: true },
        ),
    );
    d.add(
        d.line(
            [
                [460, 281],
                [508, 281],
            ],
            { arrow: true },
        ),
    );
    d.add(
        d.line(
            [
                [768, 270],
                [812, 230],
            ],
            { dash: true },
        ),
    );

    // 0-2.4 the timer
    d.add(d.pulse(124, 80, 1.6, C.gold, 40));
    d.add(
        d.mover(
            [
                [224, 80],
                [270, 80],
            ],
            [1.7, 2.3],
            d.signal(C.gold, 'due'),
        ),
    );
    // 2.4-4.6 the transaction
    d.add(
        d.mover(
            [
                [460, 80],
                [508, 120],
                [522, 144],
            ],
            [2.5, 2.9, 3.1],
            d.envelope(S.run, 'lock', { anchor: 'start', dx: 12 }),
        ),
    );
    d.add(
        d.mover(
            [
                [522, 144],
                [515, 200],
                [522, 256],
            ],
            [3.2, 3.4, 3.6],
            d.envelope(S.run, 'INSERT run', { anchor: 'start', dx: 12 }),
        ),
    );
    // 4.6-6.6 the call
    d.add(
        d.mover(
            [
                [224, 281],
                [270, 281],
            ],
            [4.8, 5.3],
            d.envelope(C.api, 'POST'),
        ),
    );
    d.add(
        d.mover(
            [
                [460, 262],
                [508, 236],
                [600, 200],
            ],
            [5.4, 5.6, 6],
            d.signal(C.gold, 'sha256 ✓'),
        ),
    );
    // 6.6-8.6 the run
    d.add(
        d.mover(
            [
                [460, 290],
                [522, 286],
            ],
            [6.8, 7.6],
            d.envelope(S.run, 'INSERT run', { below: true }),
        ),
    );
    // 8.6-12 claimed; the 202 answer
    d.add(d.pulse(640, 270, 8.7, S.notify, 40));
    d.add(
        d.mover(
            [
                [754, 256],
                [768, 270],
                [812, 230],
            ],
            [8.9, 9.1, 9.4],
            d.envelope(S.run),
        ),
    );
    d.add(
        d.mover(
            [
                [754, 286],
                [768, 270],
                [812, 230],
            ],
            [9.3, 9.5, 9.8],
            d.envelope(S.run),
        ),
    );
    d.add(
        d.mover(
            [
                [270, 300],
                [224, 300],
            ],
            [8.2, 8.8],
            d.envelope(S.ok, '202', { below: true }),
        ),
    );

    d.captions(TRIGGERS_STEPS);
    return d;
}

// 05. The worker pool: a supervisor's worker processes and what they say to each other over IPC

const POOL_STEPS: [number, number, string][] = [
    [0, 2.4, 'processPool spawns WORKERS bun processes (worker.ts); each one answers { type: ready } over IPC'],
    [2.4, 5, 'The supervisor claims a run, prepareJob decrypts its secrets, and a free worker gets { type: run, job }'],
    [5, 8, 'Every 250 ms the worker sends progress; the supervisor saves it and NOTIFYs run_events'],
    [8, 11.8, 'A worker never touches the database: OAuth 2.0 tokens and fire and forget calls go through the supervisor'],
    [11.8, 14, '{ type: done } brings the record and usage: finishRun stores them, and the worker is free again'],
    [14, 20.8, 'Stop: NOTIFY run_cancel → { type: cancel }. Not ended 5 s later? The worker is killed. Either way, it is replaced'],
    [20.8, 27, 'After 100 runs, or a run past 1 GiB, a worker is replaced between runs: what a run leaks does not pile up'],
];

type WorkerState = 'starting' | 'idle' | 'running' | 'killed' | 'ended';

/** one worker process: its card changes with its state, and tickers tell its pid, what it does and its runs */
function workerCard(
    d: Diagram,
    n: number,
    y: number,
    o: {
        states: [number, WorkerState][];
        pid: [number, string][];
        status: [number, string, string][];
        runs: [number, string][];
    },
) {
    const x = 660;
    const w = 316;
    const look: Record<WorkerState, [string, string, string]> = {
        starting: [C.dim, C.card, '5 4'],
        idle: [C.line2, C.card, 'none'],
        running: [S.running, S.runningSoft, 'none'],
        killed: [S.err, S.errSoft, 'none'],
        ended: [C.dim, quiet, '5 4'],
    };
    const states = o.states.map(([t, s]) => [t, ...look[s]] as const);
    d.add(
        `<rect x="${x}" y="${y}" width="${w}" height="120" rx="10" stroke-width="1.2">${d.steps(
            'stroke',
            states.map(s => [s[0], s[1]]),
        )}${d.steps(
            'fill',
            states.map(s => [s[0], s[2]]),
        )}${d.steps(
            'stroke-dasharray',
            states.map(s => [s[0], s[3]]),
        )}</rect>`,
    );
    d.add(
        `<circle cx="${x + 18}" cy="${y + 22}" r="4.5">${d.steps(
            'fill',
            states.map(s => [s[0], s[1] === C.line2 ? S.supervisor : s[1]]),
        )}</circle>`,
    );
    d.add(d.text(x + 30, y + 27, `Worker ${n}`, { weight: 700 }));
    d.add(d.ticker(x + w - 14, y + 27, o.pid, { size: 10.5, mono: true, fill: C.muted, anchor: 'end' }));
    o.status.forEach(([t0, s, fill], i) =>
        d.add(d.during(t0, o.status[i + 1]?.[0] ?? d.loop, d.text(x + 14, y + 58, s, { size: 11.5, mono: true, fill, weight: 600 }))),
    );
    d.add(d.ticker(x + 14, y + 84, o.runs, { size: 10.5, mono: true, fill: C.muted }));
}

function pool(clock: Clock, title = 'The worker pool') {
    const d = new Diagram(1000, 432, 27, title, 'processPool · WORKERS = 3 · IPC (JSON)', clock);
    const t = d.text.bind(d);
    // the rows of the three workers; the runs and the IPC wires line up with them
    const W1 = 76;
    const W2 = 212;
    const W3 = 348;
    const PG = 214; // Postgres' right edge
    const SL = 290; // the supervisor's left edge
    const SR = 570; // its right edge
    const WK = 660; // the workers' left edge

    // Postgres: the runs and the channels
    container(d, 24, 16, 190, 400, 'Postgres', S.postgres, { note: 'runs', soft: 'rgba(54,186,235,0.05)' });
    const row = (y: number, states: [number, string, string][], frames: [number, string, string][], from = 0) => {
        const svg = `${stateRowOf(d, 36, y - 14, 166, states)}${frames
            .map(([t0, s, fill], i) =>
                d.during(t0, frames[i + 1]?.[0] ?? d.loop, t(46, y + 4, s, { size: 10.5, mono: true, fill, weight: 600 })),
            )
            .join('')}`;
        d.add(from > 0 ? d.during(from, d.loop, svg) : svg);
    };
    row(
        W1,
        [
            [0, S.queued, S.queuedSoft],
            [3.1, S.running, S.runningSoft],
            [13, S.ok, S.okSoft],
        ],
        [
            [0, 'R1 · queued', S.queued],
            [3.1, 'R1 · running', S.running],
            [5.4, 'R1 · running · 2/6', S.running],
            [6.4, 'R1 · running · 3/6', S.running],
            [7.4, 'R1 · running · 4/6', S.running],
            [13, 'R1 · completed', S.ok],
        ],
    );
    row(112, [[0, S.queued, S.queuedSoft]], [[11, 'R2 · queued · child', S.queued]], 11);
    row(
        W2,
        [
            [0, S.queued, S.queuedSoft],
            [14.5, S.running, S.runningSoft],
            [15.4, S.err, S.runningSoft],
            [19.4, C.muted, quiet],
        ],
        [
            [14, 'R3 · queued', S.queued],
            [14.5, 'R3 · running', S.running],
            [15.4, 'R3 · cancel requested', S.err],
            [19.4, 'R3 · cancelled', C.muted],
        ],
        14,
    );
    row(
        W3,
        [
            [0, S.queued, S.queuedSoft],
            [21.3, S.running, S.runningSoft],
            [23.8, S.ok, S.okSoft],
        ],
        [
            [20.8, 'R4 · queued', S.queued],
            [21.3, 'R4 · running', S.running],
            [23.8, 'R4 · completed', S.ok],
        ],
        20.8,
    );
    d.add(t(36, 252, 'NOTIFY', { size: 10.5, mono: true, fill: C.muted, weight: 600 }));
    const CH = { run_events: 270, runs_queued: 294, run_cancel: 318 };
    for (const [name, y] of Object.entries(CH)) {
        d.add(d.chip(36, y - 10, name, S.notify, S.notifySoft));
    }

    // the supervisor
    container(d, SL, 16, SR - SL, 400, 'Supervisor', S.supervisor, { note: 'processPool' });
    d.add(d.box(306, 58, 248, 32, { fill: C.code, stroke: C.line2, r: 6 }));
    d.add(
        d.ticker(
            318,
            78.5,
            [
                [0, 'spawn bun worker.ts × 3'],
                [2.4, 'claimRun (SKIP LOCKED)'],
                [3.1, 'prepareJob: secrets decrypted'],
                [4.5, 'R1 → worker 1'],
                [5, 'saveProgress + NOTIFY run_events'],
                [8.7, 'oauthTokenFromMemory: once'],
                [10.5, 'queueCalledRun + NOTIFY runs_queued'],
                [11.8, 'waiting for worker 1'],
                [12.5, 'finishRun + NOTIFY run_events'],
                [14, 'claimRun: R3 → worker 2'],
                [16, 'R3 is mine: cancel it'],
                [16.5, '{ type: cancel } · 5 s to end'],
                [18.9, 'still running: kill worker 2'],
                [19.8, 'spawn a new worker 2'],
                [20.8, 'claimRun: R4 → worker 3'],
                [23.3, 'finishRun + NOTIFY run_events'],
                [24.2, 'worker 3 at 100 runs: retire'],
                [24.8, 'spawn a new worker 3'],
                [25.9, '3 workers ready'],
            ],
            { size: 10.5, mono: true, fill: C.gold, weight: 600 },
        ),
    );
    code(d, 306, 104, 248, 134, 'PoolOptions', [
        'size: 3 // WORKERS',
        'maxRunsPerWorker: 100',
        'maxRssBytes: 1 GiB',
        'cancelGraceMs: 5 s',
        'hardTimeoutMs: 11 min',
    ]);
    d.add(d.box(306, 252, 248, 82, { fill: C.card, stroke: C.line2, r: 8 }));
    d.add(t(320, 272, 'OAuth 2.0 tokens · in memory', { size: 11, mono: true, fill: C.muted }));
    d.add(d.during(0, 9.2, t(320, 300, 'none yet', { size: 10.5, mono: true, fill: C.dim })));
    d.add(d.during(9.2, d.loop, d.chip(320, 288, 'crm-api · cached', C.fixed, 'rgba(237,213,163,0.12)')));
    d.add(t(320, 324, 'one per connection, for all workers', { size: 10, mono: true, fill: C.muted }));
    d.add(t(306, 368, 'A worker never touches the database:', { size: 10.5, fill: C.muted }));
    d.add(t(306, 386, 'it asks the supervisor, over IPC.', { size: 10.5, fill: C.muted }));

    // the wires: SQL between Postgres and the supervisor, IPC between the supervisor and its workers
    for (const y of [W1, W2, W3]) {
        d.add(
            d.line(
                [
                    [PG, y],
                    [SL, y],
                ],
                { stroke: C.line2, dash: true },
            ),
        );
        d.add(
            d.line(
                [
                    [SR, y],
                    [WK, y],
                ],
                { stroke: C.wire },
            ),
        );
    }
    d.add(t((PG + SL) / 2, 150, 'SQL', { size: 10, mono: true, fill: C.dim, anchor: 'middle' }));
    d.add(t((SR + WK) / 2, 150, 'IPC', { size: 10, mono: true, fill: C.dim, anchor: 'middle' }));

    // the workers
    workerCard(d, 1, 16, {
        states: [
            [0, 'starting'],
            [1.5, 'idle'],
            [4.5, 'running'],
            [12.5, 'idle'],
        ],
        pid: [[0, 'pid 4211']],
        status: [
            [0, 'starting…', C.dim],
            [1.5, 'ready · idle', S.ok],
            [4.5, 'running R1 · runJob', S.running],
            [8.2, 'running R1 · needs a token', S.running],
            [10, 'running R1 · calls a flow', S.running],
            [11.7, 'running R1 · runJob', S.running],
            [12.5, 'idle · takes the next run', C.muted],
        ],
        runs: [
            [0, 'runs 0 / 100 · rss 60 MB'],
            [4.5, 'runs 1 / 100 · rss 140 MB'],
        ],
    });
    workerCard(d, 2, 152, {
        states: [
            [0, 'starting'],
            [1.8, 'idle'],
            [15, 'running'],
            [18.9, 'killed'],
            [19.8, 'starting'],
            [20.5, 'idle'],
        ],
        pid: [
            [0, 'pid 4212'],
            [19.8, 'pid 4318'],
        ],
        status: [
            [0, 'starting…', C.dim],
            [1.8, 'ready · idle', S.ok],
            [15, 'running R3 · runJob', S.running],
            [16.5, 'R3 · stuck in an HTTP call', S.running],
            [18.9, 'killed: not ended in 5 s', S.err],
            [19.8, 'starting… (a new process)', C.dim],
            [20.5, 'ready · idle', S.ok],
        ],
        runs: [
            [0, 'runs 0 / 100 · rss 60 MB'],
            [15, 'runs 1 / 100 · rss 150 MB'],
            [19.8, 'runs 0 / 100 · rss 60 MB'],
        ],
    });
    workerCard(d, 3, 288, {
        states: [
            [0, 'starting'],
            [2.1, 'idle'],
            [21.8, 'running'],
            [24.2, 'ended'],
            [24.8, 'starting'],
            [25.9, 'idle'],
        ],
        pid: [
            [0, 'pid 4213'],
            [24.8, 'pid 4402'],
        ],
        status: [
            [0, 'starting…', C.dim],
            [2.1, 'ready · idle', S.ok],
            [20.8, 'idle · later: 99 runs done', C.muted],
            [21.8, 'running R4 · its 100th run', S.running],
            [23.3, 'done: 100 runs, replace it', C.muted],
            [24.2, 'ended between runs', C.dim],
            [24.8, 'starting… (a new process)', C.dim],
            [25.9, 'ready · idle', S.ok],
        ],
        runs: [
            [0, 'runs 0 / 100 · rss 60 MB'],
            [20.8, 'runs 99 / 100 · rss 380 MB'],
            [21.8, 'runs 100 / 100 · rss 400 MB'],
            [24.8, 'runs 0 / 100 · rss 60 MB'],
        ],
    });

    // worker 2's 5 s to end after the cancel
    const ga = d.at(16.5);
    const gb = d.at(18.9);
    d.add(
        d.during(
            16.5,
            19.8,
            `<rect x="674" y="${152 + 96}" width="288" height="8" rx="4" fill="${C.card}" stroke="${C.line2}"/><rect x="674" y="${152 + 96}" width="0" height="8" rx="4" fill="${S.err}" opacity="0.8"><animate attributeName="width" dur="${d.dur}s" repeatCount="indefinite" values="0;0;288;288" keyTimes="0;${f(ga)};${f(gb)};1"/></rect>${t(962, 152 + 84, 'cancelGraceMs', { size: 10, mono: true, fill: S.err, anchor: 'end' })}`,
        ),
    );

    // what travels
    const ipcIn = (y: number, t0: number, svg: string) =>
        d.mover(
            [
                [WK, y],
                [SR, y],
            ],
            [t0, t0 + 0.5],
            svg,
        );
    const ipcOut = (y: number, t0: number, svg: string) =>
        d.mover(
            [
                [SR, y],
                [WK, y],
            ],
            [t0, t0 + 0.5],
            svg,
        );
    const sqlIn = (y: number, t0: number, svg: string) =>
        d.mover(
            [
                [PG, y],
                [SL, y],
            ],
            [t0, t0 + 0.45],
            svg,
        );
    const sqlOut = (y: number, t0: number, svg: string) =>
        d.mover(
            [
                [SL, y],
                [PG, y],
            ],
            [t0, t0 + 0.45],
            svg,
        );

    // 1. ready
    [W1, W2, W3].forEach((y, i) => d.add(ipcIn(y, 1 + i * 0.3, d.signal(S.ok, i === 0 ? 'ready' : undefined))));
    // 2. claim, prepare, hand over
    d.add(sqlIn(W1, 2.6, d.envelope(S.run, 'claim')));
    d.add(d.pulse(78, CH.run_events, 3.1, S.notify, 30));
    d.add(ipcOut(W1, 4, d.envelope(S.run, '{ type: run, job }', { below: true })));
    // 3. progress, every 250 ms (slowed down here)
    for (let s = 5.1; s < 7.9; s += 0.5) {
        d.add(ipcIn(W1, s, d.signal(S.queued, s < 5.2 ? 'progress' : undefined, { r: 4.5 })));
        d.add(sqlOut(W1, s + 0.5, d.signal(S.queued, undefined, { r: 4.5 })));
        d.add(d.pulse(78, CH.run_events, s + 0.95, S.notify, 22));
    }
    // 4. a token, then a fire and forget call
    d.add(ipcIn(W1, 8.2, d.signal(C.fixed, '{ type: token }')));
    d.add(d.pulse(430, 300, 9.2, C.fixed, 40));
    d.add(ipcOut(W1, 9.4, d.signal(C.fixed, 'token', { below: true })));
    d.add(ipcIn(W1, 10, d.envelope(S.run, '{ type: queue }')));
    d.add(
        d.mover(
            [
                [SL, W1 + 10],
                [PG, 112],
            ],
            [10.55, 11],
            d.envelope(S.run),
        ),
    );
    d.add(d.pulse(81, CH.runs_queued, 11, S.notify, 30));
    d.add(ipcOut(W1, 11.2, d.signal(S.queued, '{ type: queued, id }', { below: true })));
    // 5. done
    d.add(ipcIn(W1, 12, d.envelope(S.ok, '{ type: done }')));
    d.add(sqlOut(W1, 12.55, d.envelope(S.ok, 'finishRun', { below: true })));
    d.add(d.pulse(78, CH.run_events, 13, S.notify, 30));
    // 6. Stop
    d.add(sqlIn(W2, 14.05, d.envelope(S.run, 'claim')));
    d.add(ipcOut(W2, 14.5, d.envelope(S.run, '{ type: run, job }', { below: true })));
    d.add(d.pulse(78, CH.run_cancel, 15.4, S.notify, 30));
    d.add(
        d.mover(
            [
                [PG - 12, CH.run_cancel],
                [SL, W2 + 14],
            ],
            [15.5, 16],
            d.signal(S.err, 'run_cancel', { below: true }),
        ),
    );
    d.add(ipcOut(W2, 16, d.signal(S.err, '{ type: cancel }')));
    d.add(d.pulse(678, 174, 18.9, S.err, 30));
    d.add(sqlOut(W2, 18.95, d.envelope(C.muted, 'finishRun', { below: true })));
    d.add(ipcIn(W2, 20, d.signal(S.ok, 'ready')));
    // 7. the 100th run, then a new worker
    d.add(sqlIn(W3, 20.85, d.envelope(S.run, 'claim')));
    d.add(ipcOut(W3, 21.3, d.envelope(S.run, '{ type: run, job }', { below: true })));
    d.add(ipcIn(W3, 22.8, d.envelope(S.ok, '{ type: done }')));
    d.add(sqlOut(W3, 23.35, d.envelope(S.ok, 'finishRun', { below: true })));
    d.add(ipcIn(W3, 25.4, d.signal(S.ok, 'ready')));

    d.captions(POOL_STEPS);
    return d;
}

// every diagram: the whole story slowed down, and each step on its own (for the <details> of each step in its page)

const FULL: Clock = { speed: 2.5, hold: 2 };
const step = (window: [number, number]): Clock => ({ speed: 2.5, hold: 1.5, window });

const STORIES: { name: string; steps: [number, number, string][]; draw: (clock: Clock, title?: string) => Diagram; title: string }[] = [
    { name: '00-architecture', steps: ARCHITECTURE_STEPS, draw: architecture, title: 'Architecture' },
    { name: '01-run-lifecycle', steps: RUN_LIFECYCLE_STEPS, draw: runLifecycle, title: 'A run, end to end' },
    { name: '02-claim-skip-locked', steps: CLAIM_STEPS, draw: claim, title: 'Claiming runs' },
    { name: '03-worker-tags', steps: TAGS_STEPS, draw: tags, title: 'Worker tags' },
    { name: '04-heartbeats', steps: HEARTBEATS_STEPS, draw: heartbeats, title: 'Heartbeats and lost runs' },
    { name: '05-worker-pool', steps: POOL_STEPS, draw: pool, title: 'The worker pool' },
    { name: '06-engine', steps: ENGINE_STEPS, draw: engine, title: 'Test run · draft · tag default' },
    { name: '09-triggers', steps: TRIGGERS_STEPS, draw: triggers, title: 'Schedules and webhooks' },
];

for (const story of STORIES) {
    mkdirSync(join(OUT, story.name), { recursive: true });
    const files: [string, Diagram][] = [
        [`${story.name}.svg`, story.draw(FULL)],
        ...story.steps.map(([t0, t1], i): [string, Diagram] => [
            `${story.name}/step-${i + 1}.svg`,
            story.draw(step([t0, t1]), `${story.title} · step ${i + 1} of ${story.steps.length}`),
        ]),
    ];
    for (const [file, diagram] of files) {
        writeFileSync(join(OUT, file), diagram.svg());
        console.log(`docs/runtime/diagrams/${file}`);
    }
}
