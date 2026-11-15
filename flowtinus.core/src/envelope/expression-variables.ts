import type { Envelope } from '#types/envelope.type';

export function envelopeVariables(
    doc: Envelope,
    secrets: Record<string, string> = {},
    projectVariables: Record<string, string> = {},
    /** variables of the place it runs in ($_loopIndex in a loop region): they win over a DATA key of the same name */
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    const variables: Record<string, unknown> = {
        $FLOW_CURRENT_RUN: doc.FLOW_CURRENT_RUN,
        $PARAMETERS: doc.PARAMETERS,
        $SECRETS: secrets,
        $VARIABLES: projectVariables,
        $DATA: doc.DATA,
    };

    for (const [key, value] of Object.entries(doc.DATA)) {
        variables[`$${key}`] = value;
    }
    Object.assign(variables, extra);

    return variables;
}

export function missingFields(expression: string, variables: Record<string, unknown>): string[] {
    return [...new Set([...expression.matchAll(/\$[A-Za-z_][\w$]*/g)].map(([name]) => name))].filter(name => !(name in variables));
}

/**
 * The variables an expression is evaluated with: each `$name` it mentions that this envelope does not have is there,
 * undefined, so a field missing from some envelopes can be tested (`!$shipments ? 0 : $shipments.length`,
 * `$shipments ?? []`) instead of failing with "$shipments is not defined". Reading into it still fails (the runner
 * names the missing fields in that error).
 */
export function expressionScope(expression: string, variables: Record<string, unknown>): Record<string, unknown> {
    const scope = { ...variables };
    for (const name of missingFields(expression, variables)) {
        scope[name] = undefined;
    }
    return scope;
}
