/**
 * Reading the values of a canonical Extended JSON document (a MongoDB Pipeline with Output format = Extended JSON)
 * into plain values for a warehouse row. A value that does not fit throws, naming the field.
 */

/** an id as text: {$oid} → its hex; text or a number → as text; null/undefined → null */
export function id(value: unknown): string | null {
    if (value == null) {
        return null;
    }
    if (typeof value === 'object' && (value as { $oid?: unknown }).$oid != null) {
        return String((value as { $oid: unknown }).$oid);
    }
    return String(value);
}

/** a 32-bit integer: {$numberInt}, {$numberLong}, {$numberDouble} or a number; null/undefined → 0 */
export function int32(value: unknown, field: string): number {
    if (value == null) {
        return 0;
    }
    const wrapped = value as Record<string, unknown>;
    const n = typeof value === 'object' ? Number(wrapped.$numberInt ?? wrapped.$numberLong ?? wrapped.$numberDouble) : Number(value);
    if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
        throw new Error(`Invalid Int32: ${field}`);
    }
    return n;
}

/** a date as ISO text: {$date: {$numberLong}}, {$date: '…'}, a date or text; null/undefined → null (or an error when required) */
export function isoDate(value: unknown, field: string, options: { required?: boolean } = {}): string | null {
    if (value == null) {
        if (options.required) {
            throw new Error(`${field} is required`);
        }
        return null;
    }
    const raw = typeof value === 'object' && (value as { $date?: unknown }).$date != null ? (value as { $date: unknown }).$date : value;
    const date =
        typeof raw === 'object' && raw !== null && (raw as { $numberLong?: unknown }).$numberLong != null
            ? new Date(Number((raw as { $numberLong: unknown }).$numberLong))
            : new Date(raw as string);
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid date: ${field}`);
    }
    return date.toISOString();
}

/** a boolean, strictly; null/undefined → false */
export function bool(value: unknown, field: string): boolean {
    if (value == null) {
        return false;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`Invalid Boolean: ${field}`);
    }
    return value;
}
