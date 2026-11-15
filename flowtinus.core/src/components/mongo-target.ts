import { usesProfile } from '../connections/connection-access';
import type { ComponentContext } from '#types/component-context.type';
import type { Envelope } from '#types/envelope.type';
import type { ExpressionField } from '#types/expression-field.type';

/*
 * The database and the collection of the MongoDB components: each a fixed value or an expression on the envelope (the
 * field's "fx" button), like the HTTP Request's URL. A flow saved before they took expressions has them as plain text,
 * read as a fixed value. An empty database is the connection's.
 */

export type MongoTarget = { database: string; collection: string };

/** The setting as a field: plain text (an older flow) is a fixed value. */
export function mongoTargetField(value: unknown): ExpressionField {
    if (typeof value === 'string') {
        return { value, expression: false };
    }
    const f = value as Partial<ExpressionField> | undefined;
    return { value: typeof f?.value === 'string' ? f.value : '', expression: f?.expression === true };
}

export const MONGO_TARGET_SETTINGS = [
    {
        key: 'database',
        label: 'Database',
        kind: 'value' as const,
        default: { value: '', expression: false },
        placeholder: 'From the connection',
    },
    {
        key: 'collection',
        label: 'Collection',
        kind: 'value' as const,
        required: true,
        default: { value: '', expression: false },
        placeholder: 'orders',
    },
];

export function mongoTargetIssues(config: Record<string, unknown>, database: ExpressionField, collection: ExpressionField): string[] {
    const issues: string[] = [];
    if (database.expression ? false : !database.value.trim() && !usesProfile('mongodb', config)) {
        issues.push('has no database.');
    }
    if (!collection.value.trim()) {
        issues.push(collection.expression ? 'has no collection expression.' : 'has no collection.');
    }
    return issues;
}

function nameIssue(what: 'database' | 'collection', name: unknown): string | null {
    if (typeof name !== 'string') {
        return `is not text (${name === null ? 'null' : typeof name})`;
    }
    if (name.includes('\0')) {
        return 'has a NUL character';
    }
    if (what === 'collection' && name.trim().startsWith('$')) {
        return 'starts with $';
    }
    if (what === 'database' && /[/\\. "$*<>:|?]/.test(name.trim())) {
        return 'has a character a database name cannot have (/\\. "$*<>:|?)';
    }
    return null;
}

export function mongoTarget(
    config: Record<string, unknown>,
    database: ExpressionField,
    collection: ExpressionField,
    doc: Envelope,
    ctx: Pick<ComponentContext, 'fieldValue'>,
): MongoTarget {
    const named = (what: 'database' | 'collection', field: ExpressionField): string => {
        const name = field.expression ? (ctx.fieldValue(field, doc) ?? '') : field.value;
        const issue = nameIssue(what, name);
        if (issue) {
            throw new Error(`The ${what} ${field.expression ? 'expression gives a name that' : 'name'} ${issue}.`);
        }
        return (name as string).trim();
    };
    const target = { database: named('database', database), collection: named('collection', collection) };
    if (!target.collection) {
        throw new Error(`The collection ${collection.expression ? 'expression gives an empty name' : 'is empty'}.`);
    }
    if (!target.database && !usesProfile('mongodb', config)) {
        throw new Error(
            `The database ${database.expression ? 'expression gives an empty name' : 'is empty'} and there is no connection profile with one.`,
        );
    }
    return target;
}

export const targetName = (t: MongoTarget) => (t.database ? `${t.database}.${t.collection}` : t.collection);

export function targetsText(targets: Set<string>): string {
    const all = [...targets];
    if (all.length === 0) {
        return 'no collection';
    }
    const shown = all.slice(0, 3).join(', ');
    return all.length > 3 ? `${shown} and ${all.length - 3} more` : shown;
}
