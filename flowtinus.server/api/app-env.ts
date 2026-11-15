import type { ApiScope } from '#features/api-tokens/api-tokens';
import type { RunScope } from '#features/api-tokens/run-scope';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';

export type AppEnv = {
    Variables: {
        useCase: UseCaseContext;
        /** what the request's personal access token may do (bearerAuth: the MCP); unset on the editor's routes */
        scopes?: ApiScope[];
        /** what the token's runs:execute may run (bearerAuth); null: any flow, with the user's approval */
        runScope?: RunScope | null;
    };
};
