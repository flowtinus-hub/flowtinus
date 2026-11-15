import type { ComponentContext } from '#types/component-context.type';
import type { ComponentOutput } from '#types/component-output.type';
import type { Envelope } from '#types/envelope.type';
import type { ErrorPolicy } from '#types/error-policy.type';
import type { Issue } from '#types/issue.type';
import type { SettingField } from '#types/setting-field.type';

export type ComponentCategory = 'database' | 'api' | 'code' | 'transformation' | 'flow';

export type ComponentLogic = {
    type: string;
    label: string;
    category: ComponentCategory;
    /** what it does and what it outputs, 1 to 3 lines (the docs, the catalog an agent reads) */
    description: string;
    /** a realistic config, as a flow file holds it (it passes `validate`) */
    example?: Record<string, unknown>;

    inputs: number;
    outputs: number;
    /**
     * Every port takes several edges: an output sends each envelope to all of them (each path gets its own copy), an input
     * joins them in arrival order. A component whose inputs mean different things (Lookup: input and lookup) takes one edge
     * on each instead.
     */
    singleEdgeInputs?: boolean;
    inputLabels?: string[];
    outputLabels?: string[];
    /** outputs that depend on the config, with their names (the Router: one per case and the else); replaces `outputs` */
    outputsFromConfig?: (config: Record<string, unknown>) => { label: string }[] | undefined;
    /** outputs that may stay unconnected: what goes out through them is dropped silently (e.g. Filter's false, Router's else) */
    optionalOutputs?: string[] | ((config: Record<string, unknown>) => string[]);
    variableInputs?: { min: number; max: number; key: string };
    variableOutputs?: { min: number; max: number; key: string };
    /**
     * Default DATA key where the component puts what it produces (the node can change it).
     * Without it, the component writes directly into the DATA fields (e.g. Mapper).
     */
    defaultOutputKey?: string;
    /** Offers Override on the node: what it produces replaces the envelope's DATA instead of being added to it. */
    usesOverride?: boolean;
    /**
     * A target: writes outside the run (a database, an API). In a test run (`validation`, the editor's Run) it does not
     * write and its envelopes go on with `{notSent: true}` in its output key, unless it is pinned (docs/architecture.md, section 12). Runs for real in `execution`.
     * A function of the config when it depends on it (e.g. an HTTP request writes only with POST, PUT, PATCH, DELETE).
     */
    sideEffects?: boolean | ((config: Record<string, unknown>) => boolean);
    settings?: SettingField[];
    /**
     * An On error the config leaves no choice for (e.g. a Flow Invoker that fires and forgets: always Throw, there is no
     * answer to continue or divert with). The engine, the ports and the editor take it over config.onError.
     */
    fixedOnError?: (config: Record<string, unknown>) => ErrorPolicy | undefined;
    validate: (config: Record<string, unknown>) => Issue[];
    execute: (
        inputs: Record<string, AsyncIterable<Envelope>>,
        config: Record<string, unknown>,
        ctx: ComponentContext,
    ) => AsyncIterable<ComponentOutput>;
};
