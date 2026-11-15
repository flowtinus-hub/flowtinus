import { type ComponentCategory, aggregate, datagrid, distinct, filter, httpRequest, limit, log, lookup, mapper, mongodbDelete, mongodbPipeline, mongodbUpsert, redshiftQuery, redshiftDelete, redshiftExecute, redshiftInsert, redshiftUpsert, router, sqlServerDelete, sqlServerExecute, sqlServerInsert, sqlServerUpdate, sort, split, sqlserverQuery, typescript, scriptInvoker, flowInvoker, discard, wait, loop, loopBreak, loopContinueWith, loopNext, END, START } from '@flowtinus/core';
import { ArrowDownUp, Database, FileCode, FingerprintPattern, Funnel, Globe, Layers, Leaf, ListEnd, Repeat, ScrollText, SearchCheck, Shuffle, Split, SquareFunction, Table, Trash2, Warehouse, Ungroup, Workflow, Flag, Hourglass, OctagonX, Play, RotateCcw, type LucideIcon, SkipForward } from 'lucide-react';

/*
 * The components the editor offers, as in the PoC: the logic (validate, run) is @flowtinus/core's, here only how each one
 * looks (the palette's short description, icon). Its name and category are the core's. Grouped by the system a component talks to.
 */

export type Category = ComponentCategory;

/** order of the categories in the palette; within each one, by label */
export const CATEGORY_ORDER: Category[] = ['database', 'api', 'code', 'transformation', 'flow'];

/** label and color (a CSS variable from index.css, light and dark) of each category */
export const CATEGORIES: Record<Category, { label: string; color: string }> = {
    database: { label: 'Databases', color: 'var(--category-database)' },
    api: { label: 'APIs', color: 'var(--category-api)' },
    code: { label: 'Scripting', color: 'var(--category-code)' },
    transformation: { label: 'Transformation', color: 'var(--category-transformation)' },
    flow: { label: 'Flow', color: 'var(--category-flow)' },
};

export type ComponentInfo = {
    /** the core component's type */
    type: string;
    label: string;
    description: string;
    category: Category;
    icon: LucideIcon;
};

const COMPONENTS: ComponentInfo[] = [
    {
        type: sqlserverQuery.type,
        label: sqlserverQuery.label,
        description: 'Reads rows from SQL Server (read only)',
        category: sqlserverQuery.category,
        icon: Database,
    },
    {
        type: redshiftQuery.type,
        label: redshiftQuery.label,
        description: 'Reads rows from Amazon Redshift (read only)',
        category: redshiftQuery.category,
        icon: Warehouse,
    },
    {
        type: redshiftInsert.type,
        label: redshiftInsert.label,
        description: 'Inserts each envelope as a row of a table',
        category: redshiftInsert.category,
        icon: Warehouse,
    },
    {
        type: redshiftUpsert.type,
        label: redshiftUpsert.label,
        description: 'Updates or inserts each envelope as a row of a table',
        category: redshiftUpsert.category,
        icon: Warehouse,
    },
    {
        type: redshiftDelete.type,
        label: redshiftDelete.label,
        description: 'Deletes the rows each envelope matches',
        category: redshiftDelete.category,
        icon: Warehouse,
    },
    {
        type: redshiftExecute.type,
        label: redshiftExecute.label,
        description: 'Runs any SQL in a transaction',
        category: redshiftExecute.category,
        icon: Warehouse,
    },
    {
        type: sqlServerInsert.type,
        label: sqlServerInsert.label,
        description: 'Inserts each envelope as a row of a table',
        category: sqlServerInsert.category,
        icon: Database,
    },
    {
        type: sqlServerUpdate.type,
        label: sqlServerUpdate.label,
        description: 'Updates the rows each envelope matches',
        category: sqlServerUpdate.category,
        icon: Database,
    },
    {
        type: sqlServerDelete.type,
        label: sqlServerDelete.label,
        description: 'Deletes the rows each envelope matches',
        category: sqlServerDelete.category,
        icon: Database,
    },
    {
        type: sqlServerExecute.type,
        label: sqlServerExecute.label,
        description: 'Runs any SQL in a transaction',
        category: sqlServerExecute.category,
        icon: Database,
    },
    {
        type: mongodbPipeline.type,
        label: mongodbPipeline.label,
        description: 'Reads documents with an aggregation pipeline',
        category: mongodbPipeline.category,
        icon: Leaf,
    },
    {
        type: mongodbUpsert.type,
        label: mongodbUpsert.label,
        description: 'Writes each envelope into a collection',
        category: mongodbUpsert.category,
        icon: Leaf,
    },
    {
        type: mongodbDelete.type,
        label: mongodbDelete.label,
        description: 'Deletes the documents that match a filter',
        category: mongodbDelete.category,
        icon: Leaf,
    },
    {
        type: httpRequest.type,
        label: httpRequest.label,
        description: 'Sends one HTTP request per envelope',
        category: httpRequest.category,
        icon: Globe,
    },
    {
        type: typescript.type,
        label: typescript.label,
        description: 'Processes the envelopes with code',
        category: typescript.category,
        icon: FileCode,
    },
    {
        type: scriptInvoker.type,
        label: scriptInvoker.label,
        description: 'Calls a function a project script exports',
        category: scriptInvoker.category,
        icon: SquareFunction,
    },
    {
        type: aggregate.type,
        label: aggregate.label,
        description: 'Groups the envelopes into batches',
        category: aggregate.category,
        icon: Layers,
    },
    {
        type: datagrid.type,
        label: datagrid.label,
        description: 'A typed table that emits one envelope per row',
        category: datagrid.category,
        icon: Table,
    },
    {
        type: distinct.type,
        label: distinct.label,
        description: 'Lets through only the first envelope of each key',
        category: distinct.category,
        icon: FingerprintPattern,
    },
    {
        type: filter.type,
        label: filter.label,
        description: 'Splits the envelopes into true and false',
        category: filter.category,
        icon: Funnel,
    },
    {
        type: limit.type,
        label: limit.label,
        description: 'Lets only the first or last N envelopes through',
        category: limit.category,
        icon: ListEnd,
    },
    {
        type: lookup.type,
        label: lookup.label,
        description: 'Finds the envelope of another input by key',
        category: lookup.category,
        icon: SearchCheck,
    },
    {
        type: mapper.type,
        label: mapper.label,
        description: 'Writes fields into the envelope (source → target)',
        category: mapper.category,
        icon: Shuffle,
    },
    {
        type: router.type,
        label: router.label,
        description: 'Sends each envelope to the first true case',
        category: router.category,
        icon: Split,
    },
    { type: sort.type, label: sort.label, description: 'Sorts the envelopes by keys', category: sort.category, icon: ArrowDownUp },
    {
        type: split.type,
        label: split.label,
        description: 'Yields one envelope per item of a list',
        category: split.category,
        icon: Ungroup,
    },
    { type: log.type, label: log.label, description: 'Records a message for each envelope', category: log.category, icon: ScrollText },
    {
        type: discard.type,
        label: discard.label,
        description: 'Drops every envelope that reaches it (no output)',
        category: discard.category,
        icon: Trash2,
    },
    {
        type: wait.type,
        label: wait.label,
        description: 'Holds envelopes until another input ends, then says how it ended',
        category: wait.category,
        icon: Hourglass,
    },
    {
        type: flowInvoker.type,
        label: flowInvoker.label,
        description: 'Calls another flow with the parameters of its Start',
        category: flowInvoker.category,
        icon: Workflow,
    },
    {
        // a box on the canvas, not a card (editor/loop.ts)
        type: loop.type,
        label: loop.label,
        description: 'Runs the components inside it again and again',
        category: loop.category,
        icon: Repeat,
    },
    {
        // not in the palette: dragged from the Loop card's bar (editor/loop-node.tsx)
        type: loopContinueWith.type,
        label: loopContinueWith.label,
        description: 'The envelope that reaches it is the loop state of the next iteration',
        category: loopContinueWith.category,
        icon: RotateCcw,
    },
    {
        type: loopNext.type,
        label: loopNext.label,
        description: 'An envelope that reaches it ends the iteration right away; the next one starts with the same loop state',
        category: loopNext.category,
        icon: SkipForward,
    },
    {
        type: loopBreak.type,
        label: loopBreak.label,
        description: 'An envelope that reaches it ends the loop after the iteration',
        category: loopBreak.category,
        icon: OctagonX,
    },
];

/** the component of a type (undefined for one the editor does not know) */
/**
 * Start and End, as in the PoC: every flow has one of each, they cannot be deleted and are not in the palette. The
 * Start's output and the End's input take several edges (the flow begins and finishes in several places).
 */
const FIXED: ComponentInfo[] = [
    { type: START, label: 'Start', description: 'Starting point of the flow', category: 'flow', icon: Play },
    { type: END, label: 'End', description: 'Every chain ends here', category: 'flow', icon: Flag },
];

export const isFixedType = (type: string) => type === START || type === END;

export const componentInfo = (type: string): ComponentInfo | undefined => [...COMPONENTS, ...FIXED].find(c => c.type === type);

const IN_LOOP_ONLY = new Set<string>([loopContinueWith.type, loopNext.type, loopBreak.type]);

/** the palette's sections: each category (in CATEGORY_ORDER) with its components by label; `search` filters by label or description */
export function paletteSections(search = ''): { category: Category; components: ComponentInfo[] }[] {
    const term = search.trim().toLowerCase();
    const matches = (c: ComponentInfo) => !term || c.label.toLowerCase().includes(term) || c.description.toLowerCase().includes(term);

    return CATEGORY_ORDER.map(category => ({
        category,
        components: COMPONENTS.filter(c => c.category === category && !IN_LOOP_ONLY.has(c.type) && matches(c)).sort((a, b) =>
            a.label.localeCompare(b.label, 'en'),
        ),
    })).filter(section => section.components.length > 0);
}
