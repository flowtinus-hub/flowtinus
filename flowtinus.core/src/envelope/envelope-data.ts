import type { Envelope } from '#types/envelope.type';
import type { EnvelopeData } from '#types/envelope-data.type';

export function withKey(doc: Envelope, key: string, value: unknown, override = false): Envelope {
    return {
        FLOW_CURRENT_RUN: doc.FLOW_CURRENT_RUN,
        PARAMETERS: doc.PARAMETERS,
        DATA: override ? { [key]: value } : { ...doc.DATA, [key]: value },
    };
}

export function mergeFields(doc: Envelope, fields: EnvelopeData, override = false): Envelope {
    return {
        FLOW_CURRENT_RUN: doc.FLOW_CURRENT_RUN,
        PARAMETERS: doc.PARAMETERS,
        DATA: override ? { ...fields } : { ...doc.DATA, ...fields },
    };
}
