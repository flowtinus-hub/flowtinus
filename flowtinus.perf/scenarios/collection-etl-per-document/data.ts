import { ObjectId } from 'mongodb';
import { mulberry32 } from '#fake-api/random';

/*
 * The source collection of a collection ETL: documents as an application keeps them (ObjectIds, dates, nested ids, a
 * list, a long text), most of them created, changed or deleted inside the run's window and the others outside it (the
 * extract leaves those out). The row each one becomes is what the scenario's script (scripts/Shared/ItemEntity.ts)
 * maps, written here a second time on purpose: the run's target is checked against it.
 */

export const DATA_VERSION = 2;
export const WINDOW_START = '2025-01-01T00:00:00.000Z';
export const WINDOW_END = '2026-01-01T00:00:00.000Z';
export const CONTEXT = 'perf-etl';
export const REFERENCE_FIELDS = ['CreatedOn', 'ModifiedOn', 'DeletedOn'] as const;

export type SourceDocument = {
    _id: ObjectId;
    /** 1, 2, 3...: a run of a smaller size reads the first ones (the data is loaded once, at the largest size) */
    Seq: number;
    Title: string;
    Code: string;
    ClientId: number;
    LocationId: number;
    IsDraft: boolean;
    State: { _id: ObjectId; Name: string } | null;
    ParentId: ObjectId | null;
    CreatedOn: Date;
    ModifiedOn: Date | null;
    DeletedOn: Date | null;
    IsDeleted: boolean;
    Tags: string[];
    Notes: string;
};

export type ItemRow = {
    id: string;
    title: string;
    code: string;
    client_id: number;
    location_id: number;
    is_draft: boolean;
    state_id: string | null;
    parent_id: string | null;
    created_on: string;
    modified_on: string | null;
    deleted_on: string | null;
    is_deleted: boolean;
    tag_count: number;
    notes: string;
    etl_context_id: string;
};

const objectId = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const DAY = 86_400_000;
const at = (base: string, days: number) => new Date(Date.parse(base) + Math.floor(days) * DAY);
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'campaign', 'review', 'asset', 'draft', 'final', 'ção', '"q"', "it's"];

export function documents(size: number, seed: number): SourceDocument[] {
    const random = mulberry32(seed);
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    return Array.from({ length: size }, (_, i) => {
        // about 15 % outside the window: created the year before and not changed in it
        const outside = random() < 0.15;
        const created = outside ? at('2024-01-01T00:00:00Z', random() * 360) : at('2024-06-01T00:00:00Z', random() * 500);
        const modified = outside ? null : random() < 0.6 ? at(WINDOW_START, random() * 360) : null;
        const deleted = !outside && random() < 0.1 ? at(WINDOW_START, random() * 360) : null;
        return {
            _id: objectId(0x6500_0000_0000 + i),
            Seq: i + 1,
            Title: Array.from({ length: 3 + Math.floor(random() * 6) }, () => pick(WORDS)).join(' '),
            Code: `IT-${i + 1}`,
            ClientId: 1 + Math.floor(random() * 400),
            LocationId: 1 + Math.floor(random() * 30),
            IsDraft: random() < 0.2,
            State: random() < 0.9 ? { _id: objectId(0x7700 + Math.floor(random() * 12)), Name: pick(WORDS) } : null,
            ParentId: random() < 0.7 ? objectId(0x8800_0000 + Math.floor(random() * 5000)) : null,
            CreatedOn: created,
            ModifiedOn: modified,
            DeletedOn: deleted,
            IsDeleted: deleted !== null,
            Tags: Array.from({ length: Math.floor(random() * 8) }, () => pick(WORDS)),
            Notes: Array.from({ length: 30 + Math.floor(random() * 90) }, () => pick(WORDS)).join(' '),
        };
    });
}

export function inWindow(d: SourceDocument): boolean {
    const start = Date.parse(WINDOW_START);
    const end = Date.parse(WINDOW_END);
    return REFERENCE_FIELDS.some(field => {
        const value = d[field];
        return value !== null && value.getTime() >= start && value.getTime() < end;
    });
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function rowOf(d: SourceDocument): ItemRow {
    return {
        id: d._id.toHexString(),
        title: d.Title,
        code: d.Code,
        client_id: d.ClientId,
        location_id: d.LocationId,
        is_draft: d.IsDraft,
        state_id: d.State ? d.State._id.toHexString() : null,
        parent_id: d.ParentId ? d.ParentId.toHexString() : null,
        created_on: iso(d.CreatedOn)!,
        modified_on: iso(d.ModifiedOn),
        deleted_on: iso(d.DeletedOn),
        is_deleted: d.IsDeleted,
        tag_count: d.Tags.length,
        notes: d.Notes,
        etl_context_id: CONTEXT,
    };
}

export function expectedRows(size: number, seed: number): ItemRow[] {
    return documents(size, seed)
        .filter(inWindow)
        .map(rowOf)
        .sort((a, b) => a.id.localeCompare(b.id));
}
