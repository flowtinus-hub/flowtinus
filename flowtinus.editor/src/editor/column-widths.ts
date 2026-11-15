/*
 * The columns of a component's list settings (a Mapper's fields, the Start's parameters, a Router's cases...) can be
 * widened and narrowed by dragging the line between two headers, as in the PoC. Each column is a share (fr) of the
 * row; a drag moves share from one to its neighbour, never below MIN_SHARE. What a person set is kept in this browser
 * (localStorage) per flow, component and list, like its window's place and size; a double click on the line goes back
 * to the default.
 */

/** a column never gets narrower than this share (a fifth of a "1fr" column) */
export const MIN_SHARE = 0.2;

/** the default share of a setting's column, by its kind (null: as wide as its content, not resizable: a checkbox) */
export function defaultShare(kind: string | undefined): number | null {
    switch (kind) {
        case 'boolean':
            return null;
        case 'text':
            return 2;
        case 'select':
            return 1.5;
        case 'number':
            return 1;
        default:
            return 3;
    }
}

/**
 * The shares after dragging the line after column `index` by `dx` pixels, `pixelsPerShare` being how wide one share is
 * now: the column grows (or shrinks) and the next resizable one gives (or takes) the same, both kept above MIN_SHARE.
 */
export function resize(shares: (number | null)[], index: number, dx: number, pixelsPerShare: number): (number | null)[] {
    const left = shares[index];
    const nextIndex = shares.findIndex((s, i) => i > index && s !== null);
    const right = nextIndex < 0 ? null : shares[nextIndex];
    if (left === null || left === undefined || right === null || right === undefined || pixelsPerShare <= 0) {
        return shares;
    }

    const pair = left + right;
    const moved = Math.min(Math.max(left + dx / pixelsPerShare, MIN_SHARE), pair - MIN_SHARE);
    return shares.map((s, i) => (i === index ? round(moved) : i === nextIndex ? round(pair - moved) : s));
}

const round = (n: number) => Math.round(n * 1000) / 1000;

const storageKey = (list: string) => `flowtinus.columns:${list}`;

/** the shares a person set for this list (of this component of this flow), when they still fit its columns; null: the defaults */
export function readShares(list: string, defaults: (number | null)[]): (number | null)[] | null {
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey(list)) ?? 'null') as unknown;
        const fits =
            Array.isArray(stored) &&
            stored.length === defaults.length &&
            stored.every((s, i) => (defaults[i] === null ? s === null : typeof s === 'number' && s >= MIN_SHARE));
        return fits ? (stored as (number | null)[]) : null;
    } catch {
        return null;
    }
}

/** keeps them (null: back to the defaults) */
export function rememberShares(list: string, shares: (number | null)[] | null) {
    try {
        if (shares) {
            localStorage.setItem(storageKey(list), JSON.stringify(shares));
        } else {
            localStorage.removeItem(storageKey(list));
        }
    } catch {
        // no storage: the widths last while the window is open
    }
}

/** the grid's columns: a share as minmax(0, Nfr), a fixed one as auto */
export const shareColumn = (share: number | null) => (share === null ? 'auto' : `minmax(0, ${share}fr)`);
