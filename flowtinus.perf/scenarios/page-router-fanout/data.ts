import { mulberry32 } from '#fake-api/random';

/*
 * The pages a collection ETL hands its router: up to 500 snapshots each (canonical Extended JSON), every snapshot with
 * two lists (often empty) and a long payload, so a page is megabytes in one envelope. Some snapshots come twice in
 * their page, an older version first: the latest one counts. Before a run the target has two old rows per snapshot and
 * list; a list with values replaces them, an empty one leaves them (the transformer has nothing to write).
 */

export const DATA_VERSION = 1;
export const PAGE_SIZE = 500;
export const FIELDS = ['Entities', 'Locations'] as const;
export const OLD_ROWS = 2;
export const CONTEXT = 'perf-router';

export type Field = (typeof FIELDS)[number];
export type Snapshot = {
    OriginalId: string;
    Name: string;
    Version: number;
    CreatedOn: { $date: { $numberLong: string } };
    ExtractedOn: { $date: { $numberLong: string } };
    Entities: { $numberInt: string }[];
    Locations: { $numberInt: string }[];
    Payload: string;
};
export type Page = { collectionName: string; page: number; snapshots: Snapshot[] };

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'review', 'asset', 'campaign', 'final', 'ção', '"q"', "it's", '{x}'];
const date = (ms: number) => ({ $date: { $numberLong: String(ms) } });
const list = (random: () => number, max: number) =>
    random() < 0.3
        ? []
        : Array.from({ length: 1 + Math.floor(random() * max) }, () => ({ $numberInt: String(Math.floor(random() * 5000)) }));

/** the snapshots, in pages; `size` counts the distinct snapshots (a duplicate is one more entry in its page) */
export function pages(size: number, seed: number): Page[] {
    const random = mulberry32(seed);
    const pick = () => WORDS[Math.floor(random() * WORDS.length)]!;
    const snapshot = (n: number, version: number): Snapshot => ({
        OriginalId: `snap-${n}`,
        Name: `snapshot ${n} v${version}`,
        Version: version,
        CreatedOn: date(1_735_689_600_000 + n * 60_000),
        ExtractedOn: date(1_767_225_600_000),
        Entities: list(random, 12),
        Locations: list(random, 5),
        Payload: Array.from({ length: 300 + Math.floor(random() * 300) }, pick).join(' '),
    });

    const all: Page[] = [];
    let entries: Snapshot[] = [];
    for (let n = 1; n <= size; n++) {
        // about 5 %: an older version comes first, in the same page
        if (random() < 0.05 && entries.length < PAGE_SIZE - 1) {
            entries.push(snapshot(n, 1));
        }
        entries.push(snapshot(n, 2));
        if (entries.length >= PAGE_SIZE - 1 || n === size) {
            all.push({ collectionName: 'pages', page: all.length + 1, snapshots: entries });
            entries = [];
        }
    }

    return all;
}

export function latest(size: number, seed: number): Snapshot[] {
    return pages(size, seed).flatMap(page => [...new Map(page.snapshots.map(s => [s.OriginalId, s])).values()]);
}

export type ListRow = { project_id: string; value: number };

export function expected(size: number, seed: number): Record<Field, ListRow[]> {
    const out = { Entities: [] as ListRow[], Locations: [] as ListRow[] };
    for (const s of latest(size, seed)) {
        for (const field of FIELDS) {
            const values = s[field].map(v => Number(v.$numberInt));
            const kept = values.length > 0 ? values : Array.from({ length: OLD_ROWS }, (_, i) => -(i + 1));
            out[field].push(...kept.map(value => ({ project_id: s.OriginalId, value })));
        }
    }

    for (const field of FIELDS) {
        out[field].sort((a, b) => (a.project_id === b.project_id ? a.value - b.value : a.project_id < b.project_id ? -1 : 1));
    }

    return out;
}
