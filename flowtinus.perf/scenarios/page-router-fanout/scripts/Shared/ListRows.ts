import { int32, isoDate } from '@w/perf/scenario/scripts/Shared/ExtendedJson';

/**
 * A snapshot's list as the rows that replace it, packed for one SQL statement: `id:value,id:value,` (the SQL splits
 * it). An empty list: null, nothing to replace.
 */
export function mapListRows(snapshot: Record<string, unknown>, field: string, contextId: string): Record<string, unknown> | null {
    const values = snapshot[field];
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }
    if (typeof snapshot.OriginalId !== 'string' || !snapshot.OriginalId || !contextId) {
        throw new Error('OriginalId and etlContextId are required');
    }
    const rows = values.map(value => {
        if (value == null) {
            throw new Error(`Invalid ${field} item`);
        }
        return `${crypto.randomUUID()}:${int32(value, field)}`;
    });
    return {
        project_id: snapshot.OriginalId,
        rows: rows.join(',') + ',',
        ingestion_timestamp: isoDate(snapshot.ExtractedOn, 'ExtractedOn'),
        etl_timestamp: new Date().toISOString(),
        etl_context_id: contextId,
    };
}
