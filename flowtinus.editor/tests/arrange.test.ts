import { describe, expect, test } from 'bun:test';
import type { Edge } from '@xyflow/react';
import { arrange } from '../src/editor/arrange';
import { ARROW_CARD_WIDTH, CARD_HEIGHT, CARD_WIDTH, PORT_GAP } from '@flowtinus/core';

// as in arrange.ts: the room kept between the boxes of two groups
const GROUP_GAP = 32;

const card = (id: string, type: string, x: number, y: number, config: Record<string, unknown> = {}) => ({
    id,
    type: 'component',
    position: { x, y },
    data: { type, config },
});

const edge = (source: string, target: string, sourceHandle = 'out-0', targetHandle = 'in-0'): Edge => ({
    id: `${source}-${sourceHandle}-${target}-${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
});

const at = (nodes: { id: string; position: { x: number; y: number } }[]) =>
    Object.fromEntries(nodes.map(n => [n.id, [n.position.x, n.position.y]]));

describe('arrange (left to right, glued)', () => {
    test('a line of cards: one card width apart, same row, from the top left of where they were (on the grid)', () => {
        const nodes = [card('c', 'log', 900, 500), card('a', 'mapper', 100, 40), card('b', 'sort', 400, 300)];
        const placed = arrange(nodes, [edge('a', 'b'), edge('b', 'c')]);
        // (100, 40) to the nearest grid point: (96, 48)
        expect(at(placed)).toEqual({ a: [96, 48], b: [96 + CARD_WIDTH, 48], c: [96 + 2 * CARD_WIDTH, 48] });
    });

    test('glued cards: the next one a card width to the right, same row (output beside input)', () => {
        const placed = arrange([card('a', 'mapper', 0, 0), card('b', 'sort', 500, 500)], [edge('a', 'b')]);
        expect(at(placed)).toEqual({ a: [0, 0], b: [CARD_WIDTH, 0] });
    });

    test("a branch goes a row down, where the second output is (Filter's false)", () => {
        const placed = arrange(
            [card('f', 'filter', 0, 0), card('t', 'log', 0, 0), card('x', 'sort', 0, 0)],
            [edge('f', 't'), edge('f', 'x', 'out-1')],
        );
        // Filter's outputs have names (true, false): the next column leaves room for them (64 px: 5 letters and the room)
        expect(at(placed)).toEqual({ f: [0, 0], t: [CARD_WIDTH + 64, 0], x: [CARD_WIDTH + 64, PORT_GAP] });
    });

    test('not glued after an output with several edges: room for its 2x, 3x; the other branches stacked above the main one', () => {
        const placed = arrange(
            [card('s', 'mapper', 0, 0), card('a', 'sort', 0, 0), card('b', 'log', 0, 0), card('c', 'limit', 0, 0)],
            [edge('s', 'a'), edge('s', 'b'), edge('s', 'c')],
        );
        // the main branch (the first of the longest) level with s; the others above it, in their order (what goes below a
        // card is its error port's)
        expect(at(placed)).toMatchObject({
            s: [0, 2 * PORT_GAP],
            a: [CARD_WIDTH + 48, 2 * PORT_GAP],
            b: [CARD_WIDTH + 48, 0],
            c: [CARD_WIDTH + 48, PORT_GAP],
        });
    });

    test('room for the longest name of the card (Distinct: duplicates), also after the unnamed-looking first output', () => {
        const placed = arrange([card('d', 'distinct', 0, 0), card('e', 'log', 0, 0)], [edge('d', 'e')]);
        // "duplicates": 10 letters → 10 × 6.5 + 24 = 89 → 96 (whole grid steps)
        expect(at(placed)).toMatchObject({ e: [CARD_WIDTH + 96, 0] });
    });

    test("a Lookup lines up with its first input; the second source's card on the next row", () => {
        const nodes = [card('a', 'mapper', 0, 0), card('b', 'sort', 0, 100), card('u', 'lookup', 0, 0)];
        const placed = arrange(nodes, [edge('a', 'u'), edge('b', 'u', 'out-0', 'in-1')]);
        // room before the Lookup for its inputs' names (input, lookup)
        expect(at(placed)).toEqual({ a: [0, 0], b: [0, PORT_GAP], u: [CARD_WIDTH + 64, 0] });
    });

    test('a group is resized around the cards that were inside it, with room for its title', () => {
        const group = { id: 'g', type: 'group', position: { x: -100, y: -100 }, width: 900, height: 700, data: {} };
        const placed = arrange([group, card('a', 'mapper', 0, 0), card('b', 'sort', 400, 300)], [edge('a', 'b')]);
        // cards at (0, 0) and (160, 0); the box: 32 left, 48 above, 32 right of the second card, 32 below
        expect(placed[0]).toMatchObject({ position: { x: -32, y: -48 }, width: 2 * CARD_WIDTH + 64, height: CARD_HEIGHT + 48 + 32 });
    });

    test('groups never overlap: a group fed by another one moves right of it; groups of separate flows go down', () => {
        const boxOf = (n: { position: { x: number; y: number }; width?: number; height?: number }) => ({
            ...n.position,
            w: n.width!,
            h: n.height!,
        });
        const apart = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        const groupA = { id: 'ga', type: 'group', position: { x: -50, y: -50 }, width: 400, height: 200, data: {} };
        const groupB = { id: 'gb', type: 'group', position: { x: 450, y: -50 }, width: 400, height: 200, data: {} };

        // a → b inside group A, b → c → d inside group B
        const chained = arrange(
            [groupA, groupB, card('a', 'mapper', 0, 0), card('b', 'sort', 170, 0), card('c', 'log', 500, 0), card('d', 'limit', 670, 0)],
            [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
        );
        expect(apart(boxOf(chained[0]!), boxOf(chained[1]!))).toBe(true);
        // A's box ends at 2 × 160 + 32 = 352; B (c, d glued after b: c at 320) starts at 320 - 32 = 288, which is 96 short of
        // A's end + GROUP_GAP = 352 + 32 = 384: 96 to the right. A move right with a group is in grid steps (16), not whole columns
        expect(at(chained)).toMatchObject({ a: [0, 0], b: [CARD_WIDTH, 0], c: [2 * CARD_WIDTH + 96, 0], d: [3 * CARD_WIDTH + 96, 0] });

        // two flows, each in its group, nothing between them
        const separate = arrange([groupA, groupB, card('a', 'mapper', 0, 0), card('c', 'log', 500, 0)], []);
        expect(apart(boxOf(separate[0]!), boxOf(separate[1]!))).toBe(true);
    });

    test('groups inside a group do not overlap either, and stay inside it', () => {
        type Sized = { id: string; position: { x: number; y: number }; width?: number; height?: number };
        const boxOf = (n: Sized) => ({ ...n.position, w: n.width!, h: n.height! });
        const apart = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        const within = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
            a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

        const green = { id: 'green', type: 'group', position: { x: -100, y: -100 }, width: 1000, height: 1000, data: {} };
        const blue = { id: 'blue', type: 'group', position: { x: -40, y: -40 }, width: 260, height: 120, data: {} };
        const yellow = { id: 'yellow', type: 'group', position: { x: -40, y: 100 }, width: 260, height: 120, data: {} };
        const placed = arrange(
            [green, blue, yellow, card('a', 'typescript', 0, 0), card('b', 'sqlserver', 0, 140), card('u', 'lookup', 400, 0)],
            [edge('a', 'u'), edge('b', 'u', 'out-0', 'in-1')],
        ) as Sized[];
        const box = (id: string) => boxOf(placed.find(n => n.id === id)!);

        expect(apart(box('blue'), box('yellow'))).toBe(true);
        expect(within(box('blue'), box('green'))).toBe(true);
        expect(within(box('yellow'), box('green'))).toBe(true);
    });

    test('a loose card going out of a group and back in does not open a gap in the group: it moves above the box', () => {
        // as in the screenshot: start → aggregate → http → router → end inside the group; start → grid (outside) → router
        const group = { id: 'g', type: 'group', position: { x: -50, y: -50 }, width: 900, height: 200, data: {} };
        const placed = arrange(
            [
                group,
                card('s', 'start', 0, 0),
                card('ag', 'aggregate', 170, 0),
                card('h', 'http-request', 340, 0),
                card('r', 'router', 600, 0),
                card('e', 'end', 800, 0),
                card('dg', 'datagrid', 300, 400),
            ],
            [edge('s', 'ag'), edge('s', 'dg'), edge('ag', 'h'), edge('h', 'r'), edge('dg', 'r'), edge('r', 'e')],
        ) as { id: string; position: { x: number; y: number }; width?: number; height?: number }[];
        const x = (id: string) => placed.find(n => n.id === id)!.position.x;
        const box = placed.find(n => n.id === 'g')!;
        const grid = placed.find(n => n.id === 'dg')!;

        // the Router right after the HTTP Request (no empty column between them); the End after the Router's else (its name)
        expect(x('r') - x('h')).toBe(CARD_WIDTH);
        expect(x('e') - x('r')).toBe(CARD_WIDTH + 64);
        // the Aggregate after the Start's 2x (the Start is narrower)
        expect(x('ag') - x('s')).toBe(ARROW_CARD_WIDTH + 48);
        // the Data Grid out of the group's box, above it (moving up is preferred to down)
        expect(grid.position.y + CARD_HEIGHT).toBeLessThanOrEqual(box.position.y);
    });

    test('a loose card between cards of a group never ends on top of another card: the group stays whole', () => {
        type Placed = { id: string; position: { x: number; y: number } };
        const flow = (groupWidth: number) =>
            arrange(
                [
                    { id: 'g', type: 'group', position: { x: -50, y: -50 }, width: groupWidth, height: 200, data: {} },
                    card('s', 'start', 0, 0),
                    card('ag', 'aggregate', 170, 0),
                    card('h', 'http-request', 340, 0),
                    card('r', 'router', 600, 300),
                    card('e', 'end', 900, 0),
                    card('dg', 'datagrid', 300, 400),
                ],
                [edge('s', 'ag'), edge('s', 'dg'), edge('ag', 'h'), edge('h', 'r'), edge('dg', 'r'), edge('r', 'e')],
            ) as Placed[];
        const apart = (placed: Placed[]) => {
            const cards = placed.filter(n => n.id !== 'g');
            return cards.every((a, i) =>
                cards
                    .slice(i + 1)
                    .every(b => Math.abs(a.position.x - b.position.x) >= CARD_WIDTH || Math.abs(a.position.y - b.position.y) >= PORT_GAP),
            );
        };

        // the Router out of the group, the End out too: the Router goes past the box and the End moves along after it
        const bothOut = flow(1100);
        const x = (placed: Placed[], id: string) => placed.find(n => n.id === id)!.position.x;
        expect(apart(bothOut)).toBe(true);
        expect(x(bothOut, 'e')).toBeGreaterThan(x(bothOut, 'r'));

        // the Router out, the End in the group: the Router goes above the box, nothing on top of the End
        const endIn = flow(1300);
        expect(apart(endIn)).toBe(true);
    });

    test('moving a group away never leaves two loose cards on top of each other (the Lookup and the Mapper)', () => {
        type Placed = { id: string; position: { x: number; y: number } };
        // as in the screenshot: Start → Mapper (loose), Start → Mapper → Sort → Router → End in a group, Start → both
        // inputs of a Lookup (loose); the Mapper and the Lookup go to the End. Whatever order the edges were drawn in.
        const nodes = [
            card('s', 'start', 40, 248),
            card('m1', 'mapper', 410, 40),
            { id: 'g', type: 'group', position: { x: 380, y: 200 }, width: 770, height: 140, data: {} },
            card('m2', 'mapper', 410, 248),
            card('so', 'sort', 570, 248),
            card('r', 'router', 730, 248),
            card('e', 'end', 955, 248),
            card('l', 'lookup', 665, 487),
        ];
        const rest = [edge('m2', 'so'), edge('so', 'r'), edge('r', 'e'), edge('m1', 'e'), edge('l', 'e')];
        const fromStart = [edge('s', 'm1'), edge('s', 'm2'), edge('s', 'l'), edge('s', 'l', 'out-0', 'in-1')];
        const orders = [
            fromStart,
            [fromStart[2]!, fromStart[3]!, fromStart[0]!, fromStart[1]!],
            [fromStart[1]!, fromStart[2]!, fromStart[0]!, fromStart[3]!],
            [fromStart[1]!, fromStart[0]!, fromStart[2]!, fromStart[3]!],
        ];

        for (const order of orders) {
            const placed = arrange(nodes, [...order, ...rest]) as Placed[];
            const at = (id: string) => placed.find(n => n.id === id)!.position;
            // the Lookup takes two rows (its strip): nothing may sit in either
            const lookup = at('l');
            for (const other of ['s', 'm1', 'm2', 'so', 'r', 'e']) {
                const p = at(other);
                const sameColumn = Math.abs(p.x - lookup.x) < CARD_WIDTH;
                const inRows = p.y > lookup.y - PORT_GAP && p.y < lookup.y + 2 * PORT_GAP;
                expect(`${other}: ${sameColumn && inRows}`).toBe(`${other}: false`);
            }
        }
    });

    test('what handles the errors (Divert) goes below the path that works, one column after', () => {
        const placed = arrange(
            [card('m', 'mapper', 0, 0, { onError: 'divert' }), card('ok', 'sort', 0, 0), card('fix', 'log', 0, 0)],
            [edge('m', 'ok'), edge('m', 'fix', 'error')],
        );
        expect(at(placed)).toEqual({ m: [0, 0], ok: [CARD_WIDTH, 0], fix: [CARD_WIDTH, PORT_GAP] });
    });

    test('separate flows one below the other; groups and loose cards are kept', () => {
        const group = { id: 'g', type: 'group', position: { x: 7, y: 7 }, data: {} };
        const placed = arrange([card('a', 'mapper', 0, 0), card('b', 'sort', 0, 50), group], []);
        expect(at(placed)).toEqual({ a: [0, 0], b: [0, PORT_GAP], g: [7, 7] });
    });

    test('a Lookup fed by a branch of the Start: its ports level with what feeds them; the branch above the main path, error targets below their card', () => {
        // as in a real flow: Start → HTTP → Split → Filter → Log → End, and Start → Mapper → (2x) two grids → Lookup → End
        const group = { id: 'g', type: 'group', position: { x: -320, y: -4032 }, width: 816, height: 384, data: {} };
        const nodes = [
            group,
            card('start', 'start', -496, -3584),
            card('end', 'end', 464, -3584),
            card('http', 'http-request', -288, -3584),
            card('split', 'split', -80, -3584),
            card('filter', 'filter', 80, -3584),
            card('log', 'log', 304, -3584),
            card('gridA', 'datagrid', -80, -3984),
            card('gridB', 'datagrid', -80, -3904),
            card('lookup', 'lookup', 176, -3984),
            card('mapper', 'mapper', -288, -3984),
            card('discard', 'discard', 304, -3744),
        ];
        const edges = [
            edge('start', 'http'),
            edge('split', 'filter'),
            edge('filter', 'log'),
            edge('log', 'end'),
            edge('gridA', 'lookup'),
            edge('gridB', 'lookup', 'out-0', 'in-1'),
            edge('mapper', 'gridA'),
            edge('mapper', 'gridB'),
            edge('start', 'mapper'),
            edge('lookup', 'end'),
            edge('http', 'split'),
            edge('lookup', 'discard', 'error', 'in-0'),
        ];
        for (const order of [edges, [...edges].reverse()]) {
            const placed = at(arrange(nodes, order));
            const [lx, ly] = placed.lookup!;
            // the Lookup's input (its top port) level with the grid feeding it, its lookup port (a row down) with the other one
            expect(ly).toBe(placed.gridA![1]);
            expect(placed.gridB![1]).toBe(ly + PORT_GAP);
            // room before the Lookup for its inputs' names
            expect(lx - placed.gridA![0]).toBeGreaterThanOrEqual(CARD_WIDTH + 64);
            // no two cards on the same spot
            const spots = Object.values(placed).map(([x, y]) => `${x},${y}`);
            expect(new Set(spots).size).toBe(spots.length);
            // the main path (Start → HTTP → … → End) on one row; the Mapper branch above it; what Lookup's error port feeds
            // right below the Lookup (under its two-row strip), so no red edge crosses the branch
            expect(placed.http![1]).toBe(placed.start![1]);
            expect(placed.split![1]).toBe(placed.start![1]);
            expect(placed.mapper![1]).toBeLessThan(placed.start![1]);
            expect(placed.discard![1]).toBe(ly + 2 * PORT_GAP);
            expect(placed.discard![1]).toBeLessThan(placed.start![1]);
        }
    });

    test('the room one card needs does not push the cards of another row in its column (they stay glued)', () => {
        // like the editor's test flow: start → (2x) mapper (top branch, with a Lookup's named inputs) and start → http → ts → split
        const nodes = [
            card('start', 'start', 0, 0),
            card('map', 'mapper', 0, 0),
            card('a', 'datagrid', 0, 0),
            card('b', 'datagrid', 0, 0),
            card('lookup', 'lookup', 0, 0),
            card('http', 'http-request', 0, 0),
            card('ts', 'typescript', 0, 0),
            card('split', 'split', 0, 0),
        ];
        const edges = [
            edge('start', 'http'),
            edge('start', 'map'),
            edge('map', 'a'),
            edge('map', 'b'),
            edge('a', 'lookup'),
            edge('b', 'lookup', 'out-0', 'in-1'),
            edge('http', 'ts'),
            edge('ts', 'split'),
        ];
        const placed = at(arrange(nodes, edges));
        const x = (id: string) => placed[id]![0];
        // the main row: http, ts, split one card width apart, whatever the Mapper's 2x or the Lookup's input names need
        expect(x('ts') - x('http')).toBe(CARD_WIDTH);
        expect(x('split') - x('ts')).toBe(CARD_WIDTH);
        // the top branch keeps its room: after the Mapper's 2x, and before the Lookup's input names
        expect(x('a') - x('map')).toBeGreaterThan(CARD_WIDTH);
        expect(x('lookup') - x('a')).toBeGreaterThan(CARD_WIDTH);
    });

    // a line of Mappers m0 → m1 → …; a Discard hung from one of them is a shorter branch, raised above the line
    const line = (length: number) => Array.from({ length }, (_, i) => `m${i}`);
    const lineEdges = (ids: string[]) => ids.slice(1).map((id, i) => edge(ids[i]!, id));

    test('raised branches far apart (no column in common) are both right above the main path, not one above the other', () => {
        const ids = line(8);
        const nodes = [...ids.map(id => card(id, 'mapper', 0, 0)), card('x1', 'discard', 0, 0), card('x2', 'discard', 0, 0)];
        // a fan-out at the first card and another at the sixth: the first branch never gets to the second one's columns
        const placed = at(arrange(nodes, [...lineEdges(ids), edge('m0', 'x1'), edge('m5', 'x2')]));
        const main = placed.m0![1]!;
        expect(ids.every(id => placed[id]![1] === main)).toBe(true);
        expect(placed.x1![1]).toBe(main - PORT_GAP);
        expect(placed.x2![1]).toBe(main - PORT_GAP);
        // each in the column after its feeder
        expect(placed.x1![0]).toBe(placed.m1![0]);
        expect(placed.x2![0]).toBe(placed.m6![0]);
    });

    test('raised branches that share a column still stack: the one made later goes above the earlier one', () => {
        const ids = line(6);
        const nodes = [
            ...ids.map(id => card(id, 'mapper', 0, 0)),
            card('b1', 'mapper', 0, 0),
            card('b2', 'mapper', 0, 0),
            card('b3', 'discard', 0, 0),
            card('x', 'discard', 0, 0),
        ];
        // m2's branch (x) is made first, it is met going down the main path; m0's branch has b3 in x's column: it goes above x
        const placed = at(arrange(nodes, [...lineEdges(ids), edge('m0', 'b1'), edge('b1', 'b2'), edge('b2', 'b3'), edge('m2', 'x')]));
        const main = placed.m0![1]!;
        expect(placed.x![1]).toBe(main - PORT_GAP);
        expect([placed.b1![1], placed.b2![1], placed.b3![1]]).toEqual([main - 2 * PORT_GAP, main - 2 * PORT_GAP, main - 2 * PORT_GAP]);
    });

    test('a raised branch stays above a shortcut edge that runs along a row across its columns', () => {
        const nodes = [
            card('c', 'mapper', 0, 0),
            card('p1', 'mapper', 0, 0),
            card('p2', 'mapper', 0, 0),
            card('t', 'lookup', 0, 0),
            card('x', 'discard', 0, 0),
            card('e', 'end', 0, 0),
        ];
        // c → t runs along c's row over p1 and p2 (the longer way goes below it); x hangs from p1, in p2's column
        const edges = [
            edge('c', 't'),
            edge('c', 'p1'),
            edge('p1', 'p2'),
            edge('p2', 't', 'out-0', 'in-1'),
            edge('p1', 'x'),
            edge('t', 'e'),
        ];
        const placed = at(arrange(nodes, edges));
        expect(placed.p1![1]).toBe(placed.c![1]! + PORT_GAP);
        expect(placed.p2![1]).toBe(placed.p1![1]);
        expect(placed.x![1]).toBe(placed.c![1]! - PORT_GAP);
        expect(placed.x![0]).toBe(placed.p2![0]);
    });

    test('a block with nothing settled in its columns goes right above what feeds it; a long edge to a block settled before pushes the next one up', () => {
        // a flow p0 → … → p11, and another one: m0 → m1 → m2 → m3 with two branches of m0, y and x. p10 feeds x as well, so x
        // is in column 11, past the end of m's main path: nothing of that flow is settled there (and m0 → x is a long edge)
        const flow = Array.from({ length: 12 }, (_, i) => `p${i}`);
        const rest = ['m0', 'm1', 'm2', 'm3'];
        const nodes = (xY: number) => [
            ...flow.map(id => card(id, 'mapper', 0, 0)),
            ...rest.map(id => card(id, 'mapper', 0, 1000)),
            card('y', 'discard', 0, 1100),
            card('x', 'discard', 0, xY),
        ];
        const edges = [...lineEdges(flow), ...lineEdges(rest), edge('m0', 'y'), edge('m0', 'x'), edge('p10', 'x')];

        // x made after y (blocks are made from the last branch on the screen to the first): above its feeder, level with y,
        // not above y as well (there is no settled card of the flow in its columns, and y is not in them)
        const after = at(arrange(nodes(1050), edges));
        expect(after.x![0]).toBeGreaterThan(after.p10![0]! + CARD_WIDTH - 1);
        expect(after.x![1]).toBe(after.m0![1]! - PORT_GAP);
        expect(after.y![1]).toBe(after.m0![1]! - PORT_GAP);

        // x made before y: m0 → x runs one row above the main path across y's column, so y goes above that edge
        const before = at(arrange(nodes(1150), edges));
        expect(before.x![1]).toBe(before.m0![1]! - PORT_GAP);
        expect(before.y![1]).toBe(before.m0![1]! - 2 * PORT_GAP);
    });

    describe('a row apart from a card of another group', () => {
        const group = (id: string, x: number, y: number, width: number, height: number) => ({
            id,
            type: 'group',
            position: { x, y },
            width,
            height,
            data: {},
        });
        // m0 → m1 → m2 with a branch x of m0: how many rows above the main path x ends, the groups around the cards' starting places
        const rowsAbove = (groups: ReturnType<typeof group>[]) => {
            const nodes = [
                ...groups,
                card('m0', 'mapper', 0, 0),
                card('m1', 'mapper', 170, 0),
                card('m2', 'mapper', 340, 0),
                card('x', 'discard', 170, 300),
            ];
            const placed = at(arrange(nodes, [edge('m0', 'm1'), edge('m1', 'm2'), edge('m0', 'x')]));
            return (placed.m1![1]! - placed.x![1]!) / PORT_GAP;
        };
        const around = group('g', -50, -50, 900, 500);

        test('both loose, or both in the same group: no empty row between them', () => {
            expect(rowsAbove([])).toBe(1);
            expect(rowsAbove([around])).toBe(1);
            // the same smallest group of two nested
            expect(rowsAbove([group('outer', -100, -100, 1000, 700), group('inner', -50, -50, 900, 500)])).toBe(1);
        });

        test('in a group of its own (inside the main path group, or beside it): an empty row between them', () => {
            expect(rowsAbove([around, group('h', 100, 250, 300, 150)])).toBe(2);
            expect(rowsAbove([group('g', -50, -50, 600, 150), group('h', 100, 250, 300, 150)])).toBe(2);
        });

        test('the main path in a group and the branch loose, or the other way round: an empty row between them', () => {
            expect(rowsAbove([group('g', -50, -50, 600, 150)])).toBe(2);
            expect(rowsAbove([group('h', 100, 250, 300, 150)])).toBe(2);
        });
    });

    describe('groups pulled apart: a move right just past the other box, a move up by whole rows', () => {
        type Sized = { id: string; position: { x: number; y: number }; width?: number; height?: number };
        const group = (id: string, x: number, y: number, width = 400, height = 200) => ({
            id,
            type: 'group',
            position: { x, y },
            width,
            height,
            data: {},
        });
        const boxEnd = (n: Sized) => n.position.x + n.width!;
        const find = (placed: Sized[], id: string) => placed.find(n => n.id === id)!;

        test('groups in a line end exactly GROUP_GAP apart, and what comes after moves with the one pulled', () => {
            // a → b in A, c → d in B, e → f in C, f → l loose: each group starts a card past the one before it
            const placed = arrange(
                [
                    group('A', -50, -50),
                    group('B', 290, -50),
                    group('C', 600, -50),
                    card('a', 'mapper', 0, 0),
                    card('b', 'sort', 170, 0),
                    card('c', 'log', 320, 0),
                    card('d', 'limit', 480, 0),
                    card('e', 'mapper', 640, 0),
                    card('f', 'sort', 800, 0),
                    card('l', 'log', 1100, 0),
                ],
                [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e'), edge('e', 'f'), edge('f', 'l')],
            ) as Sized[];
            const [a, b, c] = ['A', 'B', 'C'].map(id => find(placed, id));

            expect(a!.position.x).toBe(-32);
            expect(boxEnd(a!) + GROUP_GAP).toBe(b!.position.x);
            expect(boxEnd(b!) + GROUP_GAP).toBe(c!.position.x);
            // glued as before inside each group (the columns: a b | c d | e f, then l)
            // A ends at 352 (320 + 32); B is 96 short of 384, so c is at 320 + 96; C then needs 96 more: e is 2 × 96 further;
            // l (loose, fed by f) ends GROUP_GAP past C's box: 1184 + 32
            expect(at(placed)).toMatchObject({
                a: [0, 0],
                b: [CARD_WIDTH, 0],
                c: [2 * CARD_WIDTH + 96, 0],
                d: [3 * CARD_WIDTH + 96, 0],
                e: [4 * CARD_WIDTH + 192, 0],
                f: [5 * CARD_WIDTH + 192, 0],
                l: [1216, 0],
            });
            expect(b!.position.x).toBe(384);
            expect(c!.position.x).toBe(800);
        });

        test('a move right is in grid steps, no bigger than needed: 32 px when only that was missing', () => {
            // the Filter's true port has a name: the card after it is 64 px further, so B is 96 - 64 = 32 short of A's end + GROUP_GAP (the groups are tall: the Filter takes two rows)
            const placed = arrange(
                [
                    group('A', -50, -50, 400, 300),
                    group('B', 340, -50, 400, 300),
                    card('a', 'mapper', 5, 3),
                    card('b', 'filter', 170, 3),
                    card('c', 'log', 384, 3),
                    card('d', 'limit', 544, 3),
                ],
                [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
            ) as Sized[];
            const left = 0;
            const [ga, gb] = [find(placed, 'A'), find(placed, 'B')];

            // c glued after the Filter and its room (160 + 160 + 64 = 384), then 32 to the right: 416
            expect(at(placed)).toMatchObject({ a: [0, 0], b: [CARD_WIDTH, 0], c: [416, 0], d: [416 + CARD_WIDTH, 0] });
            expect(gb.position.x - boxEnd(ga)).toBe(GROUP_GAP);
            for (const n of [gb, find(placed, 'c'), find(placed, 'd')]) {
                expect((n.position.x - left) % 16).toBe(0);
            }
            expect(find(placed, 'c').position.x - (CARD_WIDTH + CARD_WIDTH + 64)).toBeLessThan(CARD_WIDTH);
        });

        test('a card of a group moved up (out of its box, or a flow below another) differs by whole rows', () => {
            // as in the screenshot test: the Data Grid goes above the box
            const flow = arrange(
                [
                    group('g', -50, -50, 900, 200),
                    card('s', 'start', 0, 0),
                    card('ag', 'aggregate', 170, 0),
                    card('h', 'http-request', 340, 0),
                    card('r', 'router', 600, 0),
                    card('e', 'end', 800, 0),
                    card('dg', 'datagrid', 300, 400),
                ],
                [edge('s', 'ag'), edge('s', 'dg'), edge('ag', 'h'), edge('h', 'r'), edge('dg', 'r'), edge('r', 'e')],
            ) as Sized[];
            const dy = find(flow, 'dg').position.y - find(flow, 's').position.y;
            expect(dy).not.toBe(0);
            expect(Math.abs(dy) % PORT_GAP).toBe(0);

            // two flows, each in its group: the second one is a whole number of rows from the first
            const separate = arrange(
                [group('ga', -50, -50), group('gb', 450, -50), card('a', 'mapper', 0, 0), card('c', 'log', 500, 0)],
                [],
            );
            const rows = (separate[3]!.position.y - separate[2]!.position.y) / PORT_GAP;
            expect(Number.isInteger(rows)).toBe(true);
            expect(rows).not.toBe(0);
        });

        test('a loose End after the last card of a tall group goes right, on its row: GROUP_GAP past the box', () => {
            // m0 → m1 → m2 → end, with a Discard branch of m0 raised above the main path: the group is two rows tall, and
            // the End (glued after m2) starts where the group's cards end, in the lower half of the box
            const placed = arrange(
                [
                    group('g', -50, -50, 560, 300),
                    card('m0', 'mapper', 0, 100),
                    card('m1', 'mapper', 170, 100),
                    card('m2', 'mapper', 340, 100),
                    card('x', 'discard', 170, 0),
                    card('end', 'end', 600, 100),
                ],
                [edge('m0', 'm1'), edge('m1', 'm2'), edge('m2', 'end'), edge('m0', 'x')],
            ) as Sized[];
            const box = find(placed, 'g');
            const end = find(placed, 'end');

            // the Discard is a row above the main path: the box is two rows tall; the End stays on the row of m2
            expect(find(placed, 'x').position.y).toBe(find(placed, 'm0').position.y - PORT_GAP);
            expect(end.position.y).toBe(find(placed, 'm2').position.y);
            // m0's 2x takes 48 px: m1 at 208, m2 at 368, its end 528; the box ends 32 past that (560); the End 32 further, on the grid
            expect(boxEnd(box)).toBe(368 + CARD_WIDTH + 32);
            expect(end.position.x).toBe(boxEnd(box) + GROUP_GAP);
            expect(end.position.x % 16).toBe(0);
        });

        test('two loose cards that a group pulled over each other are a whole card width apart, not glued', () => {
            type Placed = { id: string; position: { x: number; y: number } };
            const nodes = [
                card('s', 'start', 40, 248),
                card('m1', 'mapper', 410, 40),
                { id: 'g', type: 'group', position: { x: 380, y: 200 }, width: 770, height: 140, data: {} },
                card('m2', 'mapper', 410, 248),
                card('so', 'sort', 570, 248),
                card('r', 'router', 730, 248),
                card('e', 'end', 955, 248),
                card('l', 'lookup', 665, 487),
            ];
            const edges = [
                edge('s', 'm1'),
                edge('s', 'm2'),
                edge('s', 'l'),
                edge('s', 'l', 'out-0', 'in-1'),
                edge('m2', 'so'),
                edge('so', 'r'),
                edge('r', 'e'),
                edge('m1', 'e'),
                edge('l', 'e'),
            ];
            const placed = arrange(nodes, edges) as Placed[];
            const cards = placed.filter(n => n.id !== 'g');
            // cards of the same row: never closer than a card width (the Lookup takes two rows, the Start is narrower)
            for (const [i, p] of cards.entries()) {
                for (const q of cards.slice(i + 1)) {
                    const sameRows = Math.abs(p.position.y - q.position.y) < PORT_GAP;
                    const gap = Math.abs(p.position.x - q.position.x);
                    expect(`${p.id} ${q.id}: ${!sameRows || gap >= ARROW_CARD_WIDTH}`).toBe(`${p.id} ${q.id}: true`);
                }
            }
        });
    });
});
