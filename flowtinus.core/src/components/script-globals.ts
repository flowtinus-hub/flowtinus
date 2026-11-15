import type { FlowParameter } from '#types/flow-parameter.type';
import { SCRIPT_RUNTIME_TYPES } from './script-runtime';

/*
 * What a TypeScript component's code sees, as a declaration file: the editor gives it to its code editor (autocomplete
 * and checks), the runner provides these globals when it runs the code (PrepareScript). Kept here so both read one
 * description.
 */

const TS_TYPE = { text: 'string', number: 'number', boolean: 'boolean' } as const;

export function scriptGlobals(parameters: FlowParameter[] = [], dataType?: string): string {
    const globals = dataType ? SCRIPT_GLOBALS.replace('type Data = Record<string, any>', `type Data = ${dataType}`) : SCRIPT_GLOBALS;
    if (parameters.length === 0) {
        return globals;
    }
    const typed = parameters
        .filter(p => p.name)
        .map(p => `  ${JSON.stringify(p.name)}: ${TS_TYPE[p.type]}`)
        .join('\n');
    return globals.replace(
        'declare const $PARAMETERS: Record<string, string | number | boolean>',
        `declare const $PARAMETERS: {\n${typed}\n}`,
    );
}

export const SCRIPT_GLOBALS = `
/** the envelope's DATA, what process receives as $input */
type Data = Record<string, any>
/** the flow's parameters (its Start), already converted to their types */
declare const $PARAMETERS: Record<string, string | number | boolean>
/** the workspace's secrets (a database password, an API token): their values never reach the logs */
declare const $SECRETS: Record<string, string>
/** the workspace's variables (plain values, e.g. a region or a base URL) */
declare const $VARIABLES: Record<string, string>
/** this run (the same in every envelope) */
declare const $FLOW_CURRENT_RUN: {
  /** the run's id (a flow a Flow Invoker calls runs as a run of its own) */
  id: string
  /** 'validation': a test run (the editor's Run, test_run), nothing written outside; 'execution': for real (Run for real, a schedule, a webhook) */
  mode: 'validation' | 'execution'
  /** the workspace's name */
  workspace: string
  /** the project's name */
  project: string
  /** the flow's name (not its id) */
  flow: string
  /** when the run started, ISO 8601 in UTC */
  startedAt: string
  /** the run that called this one (Flow Invoker); missing when it was started from outside */
  parentId?: string
}
/** writes to the component's log */
declare function log(...parts: unknown[]): void
/** an error that came from another component: a Wait's firstError, an entry of DATA.errors */
interface ComponentError {
  /** its type (the Error's name) */
  error: string
  message: string
  /** the component that sent it to its error port */
  component: string
  /** where it began, when that component threw it again */
  origin?: string
}
/**
 * Throws again an error that came from another component (e.g. rethrow($input.wait.firstError)), its message and type
 * kept: the run's error says where it began ("This" ← "Insert": message). null or undefined (no error): does nothing.
 */
declare function rethrow(error: ComponentError | Error | string | null | undefined): void
${SCRIPT_RUNTIME_TYPES}`;
