import type { RunOptions } from '#types/run-options.type';

type SubRunKind = 'call' | 'iteration';
type FieldRule = 'keep' | 'drop' | 'give' | 'give?';

const inherited = { call: 'keep', iteration: 'keep' } as const;
const perRun = { call: 'give', iteration: 'keep' } as const;

const subRunFields = {
    mode: inherited,
    evaluate: inherited,
    prepareScript: inherited,
    databases: inherited,
    databaseWrites: inherited,
    databaseExecutes: inherited,
    documentStores: inherited,
    documentQueries: inherited,
    documentDeletes: inherited,
    http: inherited,
    flows: inherited,
    queueFlow: inherited,
    maxFireAndForgetRuns: inherited,
    secrets: inherited,
    variables: inherited,
    connections: inherited,
    oauthTokens: inherited,
    id: perRun,
    parentId: perRun,
    chain: perRun,
    rootName: perRun,
    parameterValues: perRun,
    signal: { call: 'give', iteration: 'give' },
    onReachEnd: { call: 'give', iteration: 'give' },
    onProgress: { call: 'give?', iteration: 'give?' },
    input: { call: 'give?', iteration: 'drop' },
    loop: { call: 'drop', iteration: 'give' },
    runFrom: { call: 'drop', iteration: 'drop' },
    // the timeout is the run's: it cancels the sub-run along with the run, through its signal
    timeoutMs: { call: 'drop', iteration: 'drop' },
} as const satisfies Record<keyof RunOptions, Record<SubRunKind, FieldRule>>;

type Field = keyof typeof subRunFields;
type FieldsWith<K extends SubRunKind, C extends FieldRule> = {
    [F in Field]: (typeof subRunFields)[F][K] extends C ? F : never;
}[Field];

type SubRunOwn<K extends SubRunKind> = { [F in FieldsWith<K, 'give'>]: NonNullable<RunOptions[F]> } & {
    [F in FieldsWith<K, 'give?'>]: RunOptions[F] | undefined;
} & { [F in FieldsWith<K, 'keep' | 'drop'>]?: never };

export function subRunOptions(parent: RunOptions, kind: 'call', own: SubRunOwn<'call'>): RunOptions;
export function subRunOptions(parent: RunOptions, kind: 'iteration', own: SubRunOwn<'iteration'>): RunOptions;
export function subRunOptions(parent: RunOptions, kind: SubRunKind, own: SubRunOwn<SubRunKind>): RunOptions {
    const given: Partial<Record<Field, unknown>> = own;
    const entries = Object.entries(subRunFields).flatMap(([field, rules]): [string, unknown][] => {
        const rule: FieldRule = rules[kind];
        if (rule === 'keep') {
            return field in parent ? [[field, parent[field as Field]]] : [];
        }
        return rule === 'drop' ? [] : [[field, given[field as Field]]];
    });
    return Object.fromEntries(entries) as RunOptions;
}
