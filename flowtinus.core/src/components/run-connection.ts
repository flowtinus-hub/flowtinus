import { connectionUse, dynamicConnection, type ConnectionUse } from '../connections/connection-access';
import type { ConnectionTypeName } from '../connections/types/connection-types';
import type { ComponentContext } from '#types/component-context.type';

/**
 * The connection a component uses for the whole run: a profile's id, its inline fields, or (DYNAMIC_CONNECTION) the
 * profile the connection name gives, evaluated once on the run's values ($PARAMETERS, $VARIABLES, $SECRETS), never
 * on an envelope (connectionIssues refuses a name that reads one). Throws when the name is empty: the component fails.
 */
export function runConnection(type: ConnectionTypeName, config: Record<string, unknown>, ctx: ComponentContext): ConnectionUse {
    const byName = dynamicConnection(config);
    if (!byName) {
        return connectionUse(type, config);
    }
    const name = String(ctx.fieldValue(byName, { FLOW_CURRENT_RUN: ctx.run, PARAMETERS: ctx.parameters ?? {}, DATA: {} }) ?? '').trim();
    if (!name) {
        throw new Error('The connection name is empty.');
    }
    return { profile: name };
}
