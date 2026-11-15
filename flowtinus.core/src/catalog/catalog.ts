import { COMPONENT_TYPE } from '#components/component-types';
import { COMPONENTS } from '../components';
import { START_SETTINGS } from '../components/built-in/start';
import { CONNECTION_GROUPS, CONNECTION_TYPES, type ConnectionGroup } from '../connections/types/connection-types';
import { CONNECTION_KEY, DYNAMIC_CONNECTION, INLINE_FIELDS } from '../connections/connection-access';
import { DYNAMIC_TARGET } from '../components/dynamic-target';
import { END, ITERATION_END, ITERATION_START, START } from '#engine/constants';
import { ERROR_PORT, inputPorts, outputPorts } from '#validation/ports';
import { RESERVED_NAMES } from '#validation/key-name';
import { FLOW_FILE_VERSION, MAX_PINNED_BYTES } from '../flows/flow-file';
import type { ComponentCategory, ComponentLogic } from '#types/component-logic.type';
import type { SettingField } from '#types/setting-field.type';

export const COMPONENT_CATEGORIES: { category: ComponentCategory; label: string }[] = [
    { category: 'database', label: 'Databases' },
    { category: 'api', label: 'APIs' },
    { category: 'code', label: 'Scripting' },
    { category: 'transformation', label: 'Transformation' },
    { category: 'flow', label: 'Flow' },
];

export type CatalogPort = { id: string; label?: string; optional?: boolean; single?: boolean };

export type CatalogSetting = {
    key: string;
    label: string;
    kind: SettingField['kind'];
    description?: string;
    required?: boolean;
    default?: unknown;
    placeholder?: string;
    options?: { value: string; label: string }[];
    min?: number;
    max?: number;
    language?: string;
    connectionType?: string;
    connectionTypes?: string[];
    connectionDynamic?: boolean;
    item?: CatalogSetting[];
    /** a list item stored as its own `value` and `expression` keys */
    spread?: boolean;
    /** a list whose items are the value of their single setting */
    flat?: boolean;
    /** shown (and read) only when these other settings of the same level have one of these values */
    when?: { key: string; values: unknown[] }[];
};

export type CatalogComponent = {
    type: string;
    label: string;
    category: ComponentCategory;
    description: string;
    inputs: CatalogPort[];
    outputs: CatalogPort[];
    portsFromConfig?: string;
    defaultOutputKey?: string;
    usesOverride: boolean;
    sideEffects: true | false | 'depends on config';
    fixedOnError?: string;
    settings: CatalogSetting[];
    example?: Record<string, unknown>;
};

export type CatalogConnectionType = {
    type: string;
    label: string;
    group: ConnectionGroup;
    description?: string;
    fields: {
        key: string;
        label: string;
        kind: string;
        required?: boolean;
        default?: string;
        secret?: boolean;
        options?: string[];
        when?: unknown;
    }[];
    inlineFields?: string[];
};

export type Catalog = {
    components: CatalogComponent[];
    start: { description: string; settings: CatalogSetting[] };
    end: { description: string };
    common: { description: string; settings: CatalogSetting[] };
    connectionTypes: CatalogConnectionType[];
    flowFile: typeof FLOW_FILE;
    expressions: typeof EXPRESSIONS;
    rules: string[];
    patterns: FlowPattern[];
};

export type FlowPattern = { name: string; when: string; steps: string[] };

const toSetting = (f: SettingField): CatalogSetting => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    ...(f.description ? { description: f.description } : {}),
    ...(f.required ? { required: true } : {}),
    ...(f.default !== undefined && f.default !== '' ? { default: f.default } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.options ? { options: f.options.map(o => ({ value: o.value, label: o.label })) } : {}),
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
    ...(f.language ? { language: f.language } : {}),
    ...(f.connectionType ? { connectionType: f.connectionType } : {}),
    ...(f.connectionTypes && f.connectionTypes.join() !== f.connectionType ? { connectionTypes: f.connectionTypes } : {}),
    ...(f.connectionDynamic ? { connectionDynamic: true } : {}),
    ...(f.item ? { item: f.item.map(toSetting) } : {}),
    ...(f.spread ? { spread: true } : {}),
    ...(f.flat ? { flat: true } : {}),
    ...(f.when ? { when: Array.isArray(f.when) ? f.when : [f.when] } : {}),
});

const sideEffectsOf = (logic: ComponentLogic): CatalogComponent['sideEffects'] =>
    typeof logic.sideEffects === 'function' ? 'depends on config' : logic.sideEffects === true;

const portsNote = (logic: ComponentLogic): string | undefined => {
    if (logic.type === COMPONENT_TYPE.router) {
        return 'one output per case (named by the case), then the else output, the last one (optional)';
    }
    if (logic.outputsFromConfig) {
        return 'the outputs depend on the config (see the description)';
    }
    if (logic.variableInputs) {
        return `${logic.variableInputs.min} to ${logic.variableInputs.max} inputs, the count in config.${logic.variableInputs.key}`;
    }
    if (logic.variableOutputs) {
        return `${logic.variableOutputs.min} to ${logic.variableOutputs.max} outputs, the count in config.${logic.variableOutputs.key}`;
    }
    return undefined;
};

export function catalogComponent(logic: ComponentLogic): CatalogComponent {
    const config = logic.example ?? {};
    const fixed = logic.fixedOnError?.({ ...config, call: 'fire-and-forget' });
    const note = portsNote(logic);
    return {
        type: logic.type,
        label: logic.label,
        category: logic.category,
        description: logic.description,
        inputs: inputPorts(logic.type, config),
        outputs: outputPorts(logic.type, config),
        ...(note ? { portsFromConfig: note } : {}),
        ...(logic.defaultOutputKey ? { defaultOutputKey: logic.defaultOutputKey } : {}),
        usesOverride: logic.usesOverride === true,
        sideEffects: sideEffectsOf(logic),
        ...(fixed ? { fixedOnError: `${fixed} when call is fire-and-forget` } : {}),
        settings: (logic.settings ?? []).map(toSetting),
        ...(logic.example ? { example: logic.example } : {}),
    };
}

export function catalogComponents(): CatalogComponent[] {
    const order = COMPONENT_CATEGORIES.map(c => c.category);
    return Object.values(COMPONENTS)
        .map(catalogComponent)
        .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.label.localeCompare(b.label, 'en'));
}

const COMMON_SETTINGS: SettingField[] = [
    {
        key: 'onError',
        label: 'On error',
        kind: 'select',
        default: 'throw',
        description:
            'What an envelope that fails in the component does: throw stops the run; continue goes on as it came in; divert goes out through the error port (`error`), with DATA.errors.',
        options: [
            { value: 'throw', label: 'Throw (stop the run)' },
            { value: 'continue', label: 'Continue' },
            { value: 'divert', label: 'Divert to the error port' },
        ],
    },
];

const FLOW_FILE = {
    version: FLOW_FILE_VERSION,
    format: 'YAML (or the same object as JSON)',
    shape: {
        version: `${FLOW_FILE_VERSION} (the file format)`,
        name: 'the flow name (the flow row keeps its own name: this one is informative)',
        nodes: [
            {
                id: 'unique in the flow; the Start is `start` and the End is `end` by convention',
                type: `a component type, or \`${START}\` / \`${END}\``,
                label: 'optional: its name on the canvas and in the run record (default: the component name)',
                position: '{x, y} on the canvas (required; ~300 px apart left to right reads well)',
                config: "the component's settings (see each component)",
                outputKey: 'optional: the DATA key where it writes its result, for a component with a defaultOutputKey',
                override: 'optional, true: what it produces replaces DATA (only components with usesOverride)',
                disabled: 'optional, true: envelopes pass through it untouched',
                pinned: 'optional: {port: [DATA, ...]} replayed by test runs instead of running it',
                notes: 'optional: free text for people',
                loop: 'optional: the id of the Loop whose loop region holds this node directly (never on the Start or the End)',
                size: "a Loop's, {width, height}: where its Loop end card is on the canvas, as an offset from the Loop card's position",
            },
        ],
        edges: [{ source: 'node id', sourcePort: 'out-N or error', target: 'node id', targetPort: 'in-N' }],
        groups: [{ id: 'string', title: 'string', color: 'string', position: '{x, y}', size: '{width, height}' }],
    },
    ports: `Inputs are in-0, in-1... and outputs out-0, out-1... in the order the component lists them. The error port is \`${ERROR_PORT}\`, there only while the component's onError is divert. The Start has only out-0 and the End only in-0. A Loop has in-0 and out-0 (one edge each) facing outside, and two inner ports used from inside its loop region: \`${ITERATION_START}\` (a source, where each iteration starts) and \`${ITERATION_END}\` (a target, where the paths of an iteration finish), several edges each.`,
    connectionReference: `A component that talks to a database or an API picks a connection profile of the workspace by its id in config.${CONNECTION_KEY} (list_connections gives them), or leaves it '' and fills the profile's fields in its own config (password-like fields always name a secret of the workspace). Any of them may set config.${CONNECTION_KEY} = '${DYNAMIC_CONNECTION}' and name the profile in config.connectionName: a text, or an expression on $PARAMETERS, $VARIABLES and $SECRETS only (never the envelope: $DATA or its keys), evaluated once, so the component uses one connection for the whole run (e.g. "'Orders_' + $PARAMETERS.env"). To use another connection per item, a Flow Invoker calls a flow with the name as a parameter.`,
    dynamicTarget: `A Flow Invoker's flowId (or a Script Invoker's function) set to '${DYNAMIC_TARGET}' takes the flow (function) from an expression on each envelope (flowPath / functionPath).`,
    maxPinnedBytes: MAX_PINNED_BYTES,
    example: `version: ${FLOW_FILE_VERSION}
name: Active customers to the CRM
nodes:
  - id: start
    type: start
    position: { x: 0, y: 0 }
    config:
      parameters:
        - { name: since, type: text, default: '2026-01-01' }
  - id: read
    type: sqlserver
    label: Read customers
    position: { x: 300, y: 0 }
    config:
      connection: <connection profile id>
      sql: |
        SELECT id, name, email FROM Customer WHERE updatedAt > @since
      parameters:
        - { name: since, value: $PARAMETERS.since, expression: true }
  - id: active
    type: filter
    position: { x: 600, y: 0 }
    config:
      condition: $email != null
  - id: send
    type: http-request
    position: { x: 900, y: 0 }
    config:
      connection: <connection profile id>
      method: POST
      url: { value: 'https://crm.example.com/contacts', expression: false }
      body: { value: '{name: $name, email: $email}', expression: true }
      onError: divert
  - id: failed
    type: log
    position: { x: 1200, y: 200 }
    config:
      level: warn
      message: "\`could not send \${$id}: \${$errors[0].message}\`"
  - id: end
    type: end
    position: { x: 1200, y: 0 }
    config: {}
edges:
  - { source: start, sourcePort: out-0, target: read, targetPort: in-0 }
  - { source: read, sourcePort: out-0, target: active, targetPort: in-0 }
  - { source: active, sourcePort: out-0, target: send, targetPort: in-0 }
  - { source: send, sourcePort: out-0, target: end, targetPort: in-0 }
  - { source: send, sourcePort: error, target: failed, targetPort: in-0 }
  - { source: failed, sourcePort: out-0, target: end, targetPort: in-0 }
`,
};

const EXPRESSIONS = {
    language:
        'JavaScript expressions evaluated on each envelope (no statements, no `return`). Keep each one short: a value, a condition, a small formula. Logic with helpers, several statements or validation (an IIFE such as `(() => { ... })()`) reads better in a TypeScript component, which can import project scripts, or a Script Invoker; validate_flow warns about it (a suggestion, not an error).',
    variables: [
        '$<key>: a top-level key of the envelope DATA ($price, $customer.name, $items[0])',
        '$DATA: the whole DATA object',
        '$PARAMETERS.<name>: the Start parameters of the run',
        "$VARIABLES.<name>: the workspace's variables",
        "$SECRETS.<name> / $SECRETS['name']: the workspace's secret values (masked in the logs)",
        '$FLOW_CURRENT_RUN: the run, the same in every envelope: {id, mode, workspace, project, flow, startedAt, parentId?}',
        "$_loopIndex: in a Loop's loop region and its stop condition, the number of the iteration, 0 in the first; in nested Loops, that of the Loop whose region holds the component directly",
    ],
    flowCurrentRun: {
        id: "the run's id (a flow a Flow Invoker calls runs as a run of its own, with its own id)",
        mode: "`validation` in a test run (the editor's Run, test_run: nothing is written outside), `execution` in a run for real (Run for real, a schedule, a webhook)",
        workspace: "the workspace's name",
        project: "the project's name",
        flow: "the flow's name, not its id (e.g. for a log or an error message: `$FLOW_CURRENT_RUN.flow`)",
        startedAt: 'when the run started, ISO 8601 in UTC (e.g. 2026-11-09T00:45:54.260Z)',
        parentId: 'only in a flow called by a Flow Invoker: the id of the run that called it',
    },
    valueFields:
        "A setting of kind `value` is {value, expression}: expression false = the text as it is; true = an expression. In a list item marked `spread`, value and expression are the item's own keys ({name, value, expression}).",
    keyNames: `Output keys and field names: letters, digits and _, not starting with a digit, and not ${RESERVED_NAMES.join(', ')}.`,
};

export const FLOW_RULES: string[] = [
    `The file has version ${FLOW_FILE_VERSION}, a name, and nodes each with an id (unique), a type and a position.`,
    'Exactly one Start and one End.',
    'Every edge connects two nodes of the flow, on ports their components have with their config (an edge on a port that is gone is an error).',
    'Every port takes several edges (an output copies each envelope to all of them; an input joins them in arrival order), except the Lookup: one edge on each of its inputs.',
    'The same two ports are not connected twice, and the Start never goes straight to the End.',
    `Edges out of the error port (\`${ERROR_PORT}\`) only from a component whose onError is divert.`,
    "No cycles: the flow is a directed acyclic graph (a Loop's iteration-start → … → iteration-end is a path inside its region, not a cycle).",
    "A loop region is closed: an edge joins two nodes with the same `loop` (a Loop's inner ports count as inside its region, its in-0 and out-0 as outside). The Start and End have no `loop`; a Continue with, a Next and a Break always have one; a `loop` names a Loop of the flow. Loops nest (a Loop with a `loop` is inside another), but never inside themselves, directly or through others.",
    'Every component type exists; each enabled component passes its own checks (required settings, names, SQL read only, and so on).',
    'Expressions compile (syntax only; unknown $variables are not an error, a key may come from upstream).',
    'Output keys and field names are valid names (letters, digits, _; not a reserved name).',
    "A Flow Invoker calls a flow of the same project; scripts are the project's. Connection profiles and secrets are the workspace's: one it does not have yet (by id, or a dynamic connection name known before the run) is a warning, not an issue: the draft is saved, and the run fails at that component until a person creates it.",
    "The Start's parameters have unique valid names and defaults of their type; its default input is valid JSON.",
    `Pinned outputs take at most ${MAX_PINNED_BYTES / 1024 ** 2} MB in all.`,
];

export const FLOW_PATTERNS: FlowPattern[] = [
    {
        name: 'Do something once, after everything before it finished, knowing how it ended (a barrier)',
        when: 'A step must happen once and only after all the envelopes of a process were handled: advance a checkpoint, release a lock, report a failure, log a total. Also when nothing may come out of that process (an empty source).',
        steps: [
            'Use a Wait. Its `hold` input takes the envelope that goes on afterwards (e.g. the one that took the lock, with its ids); its `watch` input takes what comes out of the process: its output AND its error port (onError `divert`), both edges into `watch`.',
            'When `watch` ends (every component before it finished with every envelope) the held envelope goes on once with `$wait` = {status, envelopes, errors, firstError, last}: status `success` (envelopes arrived, no errors), `failure` (an envelope came from an error port) or `empty` (nothing arrived). It always answers, even when the process produced nothing.',
            'After it, a Router on `$wait.status`: success → advance the checkpoint; empty → release only (or advance, when an empty window is complete for you); failure → release, then a component that throws `$wait.firstError.message` so the run ends as failed.',
            'Without a status, a Limit with mode `bottom` (Last) and count 1 is the simplest barrier: it lets the last envelope through when its input ends, and nothing when no envelope arrives. With a Limit, keep onError `throw` on the components before it: an envelope that failed with `continue` or `divert` does not stop the run, so the barrier would still open.',
        ],
    },
    {
        name: 'Incremental load with a checkpoint (watermark)',
        when: 'Each run reads only what changed since the last run that finished, from a source with a change date or an increasing key.',
        steps: [
            'Keep the checkpoint in a control table (one row per source: name, checkpoint). The run reads it first (a SQL Server or Redshift query) and computes the window end (`to`, e.g. now) once; the window is checkpoint → to. When the process calls another flow per source, pass the window as parameters.',
            'Read the window (a Pipeline or query with checkpoint < date <= to), process and write.',
            'Then a Wait (the barrier pattern): `hold` = the envelope with the source and the window, `watch` = the output and the error port of the processing. On success, a SQL Server Update of the control row: set checkpoint = `to`, Match on the source name, Expected values checkpoint = the old one (compare-and-set) and If no row matches = Error, so a concurrent run that moved it first is an error, not a silent overwrite.',
            'An empty window is safe either way: keeping the checkpoint, the next run reads from the same point up to its own `to`, covering it again. A failed run does not move it: the next run reads that window again, so the writes must be idempotent (an upsert or an update by key, not a plain insert).',
            'A Flow Invoker that waits passes on the envelopes that reach the End of the called flow as they arrive, and none when nothing reaches it: it is not a "finished" signal by itself. Its output and its error port into the `watch` of a Wait are: the Wait answers when the call finished, with how.',
        ],
    },
    {
        name: 'One run at a time (a lock)',
        when: 'Two runs must not process the same source at once (a schedule that overlaps a slow run).',
        steps: [
            'A lock row in the control table (name, lockedBy, lockedUntil). At the start, read it; when it is free (lockedBy null) or expired (lockedUntil in the past), take it with a SQL Server Update: set lockedBy = the run, lockedUntil = now + a timeout, Expected values = the lockedBy and lockedUntil just read (compare-and-set) and If no row matches = Error. Two runs that read the same free lock: only one Update matches.',
            'At the end, after a Wait (the barrier pattern), release it whatever the status: set lockedBy and lockedUntil to null, Expected values lockedBy = the run.',
            'A run that is cancelled or whose worker stops does not release it: the expiry (lockedUntil) frees it for the next run. Choose a timeout longer than the slowest run.',
        ],
    },
];

export function buildCatalog(): Catalog {
    return {
        components: catalogComponents(),
        start: {
            description:
                "Where every flow begins (not deletable, only an output). Its config holds whether the flow accepts an input (a webhook body, a calling flow's envelope, a test run's input), the input a test run uses by default, its type (a project script's type, `path#Name`) and the flow's parameters ($PARAMETERS). Without an input it yields one empty envelope; an input object is one envelope, a list one per item.",
            settings: START_SETTINGS.map(toSetting),
        },
        end: {
            description:
                "Where every chain ends (only an input, several edges allowed). What reaches it is the flow's result: a calling Flow Invoker (wait) gets these envelopes.",
        },
        common: { description: 'Settings every component has, besides its own.', settings: COMMON_SETTINGS.map(toSetting) },
        connectionTypes: CONNECTION_GROUPS.flatMap(({ group }) =>
            CONNECTION_TYPES.filter(t => t.group === group).map(t => ({
                type: t.type,
                label: t.label,
                group: t.group,
                ...(t.description ? { description: t.description } : {}),
                fields: t.fields.map(f => ({
                    key: f.key,
                    label: f.label,
                    kind: f.kind,
                    ...(f.required ? { required: true } : {}),
                    ...(f.default !== undefined ? { default: f.default } : {}),
                    ...(f.kind === 'secret' ? { secret: true } : {}),
                    ...(f.options ? { options: f.options.filter(o => !o.disabled).map(o => o.value) } : {}),
                    ...(f.when ? { when: f.when } : {}),
                })),
                ...(INLINE_FIELDS[t.type] ? { inlineFields: INLINE_FIELDS[t.type] } : {}),
            })),
        ),
        flowFile: FLOW_FILE,
        expressions: EXPRESSIONS,
        rules: FLOW_RULES,
        patterns: FLOW_PATTERNS,
    };
}
