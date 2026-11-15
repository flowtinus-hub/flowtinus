import type { EnvelopeData } from '#types/envelope-data.type';

const MAX_DEPTH = 6;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const property = (key: string) => (IDENTIFIER.test(key) ? key : JSON.stringify(key));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOf(values: unknown[], depth: number): string {
    if (depth > MAX_DEPTH) {
        return 'unknown';
    }
    const types = new Set<string>();
    const objects = values.filter(isObject);
    const arrays = values.filter(Array.isArray);
    for (const v of values) {
        if (v === null) {
            types.add('null');
        } else if (typeof v === 'string') {
            types.add('string');
        } else if (typeof v === 'number') {
            types.add('number');
        } else if (typeof v === 'boolean') {
            types.add('boolean');
        }
    }
    if (arrays.length) {
        const item = typeOf(arrays.flat(), depth + 1);
        types.add(item.includes(' | ') ? `(${item})[]` : `${item}[]`);
    }
    if (objects.length) {
        const keys = [...new Set(objects.flatMap(o => Object.keys(o)))];
        const fields = keys.map(key => {
            const present = objects.filter(o => key in o);
            const optional = present.length < objects.length ? '?' : '';
            return `${property(key)}${optional}: ${typeOf(
                present.map(o => o[key]),
                depth + 1,
            )}`;
        });
        types.add(fields.length ? `{ ${fields.join('; ')} }` : 'Record<string, unknown>');
    }
    return types.size ? [...types].join(' | ') : 'unknown';
}

export function dataTypeFromSamples(samples: EnvelopeData[]): string {
    return samples.length ? typeOf(samples, 1) : 'Record<string, unknown>';
}
