import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allResults, buildReport } from '#perf/report-site';

/*
 * The report as a static site, for GitHub Pages: the page (index.html, app.js, style.css) and every machine's result
 * lines joined into one results.jsonl, the same file `bun run perf --serve` answers. Run by the workflow on the results
 * branch (pages/perf-results-pages.yml), with Bun and no install:
 *
 *   bun flowtinus.perf/src/build-site.ts <folder of .jsonl> <output folder>
 */

const [from, to] = Bun.argv.slice(2);
if (!from || !to) {
    console.error('usage: bun flowtinus.perf/src/build-site.ts <folder of .jsonl> <output folder>');
    process.exit(2);
}

const out = resolve(to);
mkdirSync(out, { recursive: true });
await buildReport(out);
const results = allResults(resolve(from));
writeFileSync(join(out, 'results.jsonl'), results ? `${results}\n` : '');
console.log(`The report is in ${out} (${results ? results.split('\n').length : 0} result line(s)).`);
