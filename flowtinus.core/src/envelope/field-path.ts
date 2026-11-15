import type { Envelope } from '#types/envelope.type';

/*
 * The expressions that only read a value (`$email`, `$customer.address.city`, `$PARAMETERS.since`, `$SECRETS.token`),
 * the most common there are (a column of a write, a field of a Mapper), read straight from the envelope instead of
 * through the runner's evaluator, which builds the envelope's variables and runs a script for each one: for a write of
 * 10,000 rows with 7 columns that was most of the run's time. The value is the same the evaluator gives
 * (tests/unit/runner/field-path-compat.test.ts in the server holds them to each other): the names resolve as
 * envelopeVariables does them (a DATA field first, then $DATA, $PARAMETERS, $FLOW_CURRENT_RUN, $SECRETS, $VARIABLES; a
 * name the envelope lacks is undefined, and so is a property a value does not have). Anything else goes to the
 * evaluator as before: a null or undefined on the way (the evaluator's error says which field is missing), a property
 * the value inherits (`constructor`, `toFixed`), brackets, calls, operators, a name beyond ASCII.
 */

export const NOT_A_PATH: unique symbol = Symbol('not a path');

const PATH = /^\s*\$([A-Za-z_][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\s*$/;

const parsed = new Map<string, string[] | null>();
const KEPT = 2000;

function partsOf(expression: string): string[] | null {
    let parts = parsed.get(expression);
    if (parts === undefined) {
        const match = PATH.exec(expression);
        parts = match ? [match[1]!, ...(match[2] ? match[2].slice(1).split('.') : [])] : null;
        if (parsed.size >= KEPT) {
            parsed.clear();
        }
        parsed.set(expression, parts);
    }

    return parts;
}

function variable(
    name: string,
    doc: Envelope,
    secrets: Record<string, string>,
    variables: Record<string, string>,
    extra: Record<string, unknown>,
): unknown {
    if (Object.hasOwn(extra, `$${name}`)) {
        return extra[`$${name}`];
    }
    const data = doc.DATA as Record<string, unknown>;
    if (Object.hasOwn(data, name)) {
        return data[name];
    }
    switch (name) {
        case 'DATA':
            return doc.DATA;
        case 'PARAMETERS':
            return doc.PARAMETERS;
        case 'FLOW_CURRENT_RUN':
            return doc.FLOW_CURRENT_RUN;
        case 'SECRETS':
            return secrets;
        case 'VARIABLES':
            return variables;
        default:
            return undefined;
    }
}

export function readPath(
    expression: string,
    doc: Envelope,
    secrets: Record<string, string> = {},
    variables: Record<string, string> = {},
    extra: Record<string, unknown> = {},
): unknown {
    const parts = partsOf(expression);
    if (!parts) {
        return NOT_A_PATH;
    }

    let value = variable(parts[0]!, doc, secrets, variables, extra);
    for (let i = 1; i < parts.length; i++) {
        if (value === null || value === undefined) {
            return NOT_A_PATH;
        }
        const property = parts[i]!;
        const holder = Object(value) as Record<string, unknown>;
        if (Object.hasOwn(holder, property)) {
            value = holder[property];
        } else if (property in holder) {
            return NOT_A_PATH;
        } else {
            value = undefined;
        }
    }

    return value;
}
