import { COMPONENT_TYPE } from '#components/component-types';
import { tableWriteComponent } from '../table-write';

/*
 * Redshift Insert, Upsert and Delete: rows into (or out of) an Amazon Redshift table (table-write.ts). Redshift does not
 * enforce primary keys, so the Upsert finds the row by its Match on columns, and the Delete deletes every row whose
 * Match on columns all equal the envelope's values.
 */

export const redshiftInsert = tableWriteComponent({
    type: COMPONENT_TYPE.redshiftInsert,
    label: 'Redshift Insert',
    kind: 'redshift',
    mode: 'insert',
    outputKey: 'redshift',
    description:
        'Inserts one row per envelope into an Amazon Redshift table, each column a value or an expression on the envelope. Rows go in batches of one table, each in one transaction (all or none of that batch); each envelope goes on with {action: "inserted"} in its output key (default `redshift`). A test run writes nothing.',
    example: {
        connection: '<connection profile id>',
        table: 'sales.order_events',
        columns: [
            { column: 'order_id', value: '$id', expression: true },
            { column: 'status', value: '$status', expression: true },
            { column: 'source', value: 'flowtinus', expression: false },
        ],
        batchSize: 500,
    },
});

export const redshiftUpsert = tableWriteComponent({
    type: COMPONENT_TYPE.redshiftUpsert,
    label: 'Redshift Upsert',
    kind: 'redshift',
    mode: 'upsert',
    outputKey: 'redshift',
    description:
        'Writes one row per envelope into an Amazon Redshift table: the row whose Match on columns are equal is updated, otherwise it is inserted (Redshift does not enforce primary keys). Rows go in batches of one table, each in one transaction; in a batch the last envelope with the same match values wins. Each envelope goes on with {action: "inserted" | "updated" | "superseded"} in its output key (default `redshift`). A test run writes nothing.',
    example: {
        connection: '<connection profile id>',
        table: 'sales.customers',
        columns: [
            { column: 'email', value: '$email', expression: true },
            { column: 'name', value: '$name', expression: true },
            { column: 'updated_at', value: 'new Date()', expression: true },
        ],
        match: ['email'],
        batchSize: 500,
    },
});

export const redshiftDelete = tableWriteComponent({
    type: COMPONENT_TYPE.redshiftDelete,
    label: 'Redshift Delete',
    kind: 'redshift',
    mode: 'delete',
    outputKey: 'redshift',
    description:
        'Deletes the rows of an Amazon Redshift table whose Match on columns all equal the envelope\'s values (each a value or an expression on the envelope; null or undefined is an error for that envelope, never a wider delete). Rows go in batches of one table, each in one transaction (all or none of that batch): one DELETE per batch. Each envelope goes on with {action: "deleted", rows} or {action: "notFound"} in its output key (default `redshift`). A test run deletes nothing.',
    example: {
        connection: '<connection profile id>',
        table: 'sales.order_events',
        columns: [{ column: 'order_id', value: '$id', expression: true }],
        batchSize: 500,
    },
});
