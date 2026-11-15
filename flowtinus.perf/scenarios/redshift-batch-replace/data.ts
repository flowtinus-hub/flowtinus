import { mulberry32 } from '#fake-api/random';

/*
 * The pages a transformer sends: up to 500 snapshots each, every snapshot with a list of rows (often empty).
 * Page 1 is heavy (up to 20 rows per snapshot: thousands of rows, several Insert batches), page 2 has no row at all
 * (nothing may be deleted), the others are mixed (about a quarter of the snapshots with an empty list). The values
 * carry every character a separator-based serialization trips on.
 */

export const DATA_VERSION = 2;
export const PAGE_SIZE = 500;
export const OLD_ROWS = 2;

export type Item = { no: number; name: string; payload: string };
export type Snapshot = { id: number; items: Item[] };
export type Page = { page: number; snapshots: Snapshot[] };
export type Row = { snapshot_id: number; item_no: number; name: string; payload: string };

const TRICKY = ['; ', ', ', '|', '\t', '\n', '"', "'", '\\', '{}', '[]', '$1', '@id', '{{schema}}', 'ção', '日本', '🚀', '--', '/*'];

const text = (random: () => number, length: number) => {
    let out = '';
    while (out.length < length) {
        out += `${Math.floor(random() * 36 ** 4).toString(36)}${TRICKY[Math.floor(random() * TRICKY.length)]}`;
    }
    return out;
};

export function pages(size: number, seed: number): Page[] {
    const random = mulberry32(seed);
    const list: Page[] = [];
    for (let first = 1, page = 1; first <= size; first += PAGE_SIZE, page++) {
        const snapshots: Snapshot[] = [];
        for (let id = first; id < Math.min(first + PAGE_SIZE, size + 1); id++) {
            const count = page === 2 || random() < 0.25 ? 0 : 1 + Math.floor(random() * (page === 1 ? 20 : 6));
            const items = Array.from({ length: count }, (_, i) => ({
                no: i + 1,
                name: `item ${id}.${i + 1} ${text(random, 12)}`.slice(0, 200),
                payload: text(random, 40 + Math.floor(random() * 400)).slice(0, 2000),
            }));
            snapshots.push({ id, items });
        }

        list.push({ page, snapshots });
    }

    return list;
}

export const oldRow = (snapshot: number, no: number): Row => ({
    snapshot_id: snapshot,
    item_no: no,
    name: `old ${snapshot}.${no}`,
    payload: 'old',
});

/** what the target holds after the run: a page with rows replaces all its snapshots (an empty list leaves none), a page without any keeps them */
export function expectedRows(size: number, seed: number): Row[] {
    return pages(size, seed).flatMap(({ snapshots }) => {
        const replaced = snapshots.some(s => s.items.length > 0);
        return snapshots.flatMap(s =>
            replaced
                ? s.items.map(i => ({ snapshot_id: s.id, item_no: i.no, name: i.name, payload: i.payload }))
                : Array.from({ length: OLD_ROWS }, (_, n) => oldRow(s.id, n + 1)),
        );
    });
}
