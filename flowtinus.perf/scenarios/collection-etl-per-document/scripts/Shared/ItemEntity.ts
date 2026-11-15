import { bool, id, int32, isoDate } from '@myproject/scripts/Shared/ExtendedJson';

/** one source document (a Data Lake snapshot, Extended JSON) as a warehouse row */
export function mapItemEntity(input: Record<string, unknown>, contextId: string): Record<string, unknown> {
    if (!input.OriginalId || !contextId) {
        throw new Error('OriginalId and etlContextId are required');
    }
    const state = input.State as { _id?: unknown } | null | undefined;
    return {
        id: id(input.OriginalId),
        title: input.Title == null ? null : String(input.Title),
        code: input.Code ?? null,
        client_id: int32(input.ClientId, 'ClientId'),
        location_id: int32(input.LocationId, 'LocationId'),
        is_draft: bool(input.IsDraft, 'IsDraft'),
        state_id: id(state?._id),
        parent_id: id(input.ParentId),
        created_on: isoDate(input.CreatedOn, 'CreatedOn', { required: true }),
        modified_on: isoDate(input.ModifiedOn, 'ModifiedOn'),
        deleted_on: isoDate(input.DeletedOn, 'DeletedOn'),
        is_deleted: bool(input.IsDeleted, 'IsDeleted'),
        tag_count: Array.isArray(input.Tags) ? input.Tags.length : 0,
        notes: input.Notes == null ? null : String(input.Notes),
        ingestion_timestamp: isoDate(input.ExtractedOn, 'ExtractedOn'),
        etl_timestamp: new Date().toISOString(),
        etl_context_id: contextId,
    };
}
