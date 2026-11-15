import { COMPONENT_TYPE } from '#components/component-types';
import { tableWriteComponent } from './table-write';

export const sqlServerUpdate = tableWriteComponent({
    type: COMPONENT_TYPE.sqlServerUpdate,
    label: 'SQL Server Update',
    kind: 'sqlserver',
    mode: 'update',
    outputKey: 'sqlserver',
    description:
        'Updates SQL Server rows, one UPDATE per envelope: the rows whose Match on columns equal the envelope\'s values get the other columns (each a value or an expression on the envelope). Optional expected values add independent WHERE conditions for compare-and-set. Batches of one table, in one transaction each (all or none of that batch). Each envelope goes on with {action: "updated", rows} or {action: "notFound"} in its output key (default `sqlserver`). It never inserts. A test run writes nothing.',
    example: {
        connection: '<connection profile id>',
        table: 'dbo.Ticket',
        columns: [
            { column: 'Id', value: '$id', expression: true },
            { column: 'Status', value: 'closed', expression: false },
            { column: 'ClosedAt', value: 'new Date()', expression: true },
        ],
        match: ['Id'],
        batchSize: 500,
    },
});

export const sqlServerInsert = tableWriteComponent({
    type: COMPONENT_TYPE.sqlServerInsert,
    label: 'SQL Server Insert',
    kind: 'sqlserver',
    mode: 'insert',
    outputKey: 'sqlserver',
    description:
        'Inserts one row per envelope into a SQL Server table, each column a value or an expression on the envelope (an identity or defaulted column can be left out). Rows go in batches of one table, each in one transaction (all or none of that batch); each envelope goes on with {action: "inserted"} in its output key (default `sqlserver`). A test run writes nothing.',
    example: {
        connection: '<connection profile id>',
        table: 'dbo.TicketHistory',
        columns: [
            { column: 'TicketId', value: '$id', expression: true },
            { column: 'Status', value: '$status', expression: true },
            { column: 'ChangedAt', value: 'new Date()', expression: true },
        ],
        batchSize: 500,
    },
});

export const sqlServerDelete = tableWriteComponent({
    type: COMPONENT_TYPE.sqlServerDelete,
    label: 'SQL Server Delete',
    kind: 'sqlserver',
    mode: 'delete',
    outputKey: 'sqlserver',
    description:
        'Deletes SQL Server rows, one DELETE per envelope: the rows whose Match on columns all equal the envelope\'s values (each a value or an expression on the envelope; null or undefined is an error for that envelope, never a wider delete). Batches of one table, in one transaction each (all or none of that batch). Each envelope goes on with {action: "deleted", rows} or {action: "notFound"} in its output key (default `sqlserver`). A test run deletes nothing.',
    example: {
        connection: '<connection profile id>',
        table: 'dbo.Session',
        columns: [{ column: 'CustomerId', value: '$id', expression: true }],
        batchSize: 500,
    },
});
