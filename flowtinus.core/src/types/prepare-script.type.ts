import type { ParameterValue } from '#types/parameter.type';
import type { ScriptFunction } from '#types/script-function.type';
import type { FlowCurrentRun } from '#types/flow-current-run.type';
import type { LogLevel } from '#types/log-level.type';

export type PrepareScript = (
    code: string,
    globals: {
        run: FlowCurrentRun;
        parameters: Record<string, ParameterValue>;
        secrets: Record<string, string>;
        variables: Record<string, string>;
        log: (message: string, level?: LogLevel) => void;
        /**
         * What the script waits for outside (a fetch, a timer): the runner passes each such promise through it, so that time
         * counts as the component's Waiting, not its Active (several at once count once).
         */
        wait: <T>(promise: Promise<T>) => Promise<T>;
    },
) => Promise<ScriptFunction>;
