import type { Envelope } from '#types/envelope.type';
import type { ErrorPolicy } from '#types/error-policy.type';
import type { ExecutableNode } from '#types/executable-node.type';
import { onErrorOf } from '#validation/ports';
import { errorOrigin } from '#errors/error-origin';

export function withError(doc: Envelope, error: Error, component: string): Envelope {
    const previous = Array.isArray(doc.DATA.errors) ? doc.DATA.errors : [];
    const origin = errorOrigin(error);
    const entry = {
        error: error.name || 'Error',
        message: error.message,
        component,
        ...(origin && origin !== component ? { origin } : {}),
    };
    return { ...doc, DATA: { ...doc.DATA, errors: [...previous, entry] } };
}

export function errorPolicy(node: ExecutableNode): ErrorPolicy {
    return onErrorOf(node.type, node.config);
}
