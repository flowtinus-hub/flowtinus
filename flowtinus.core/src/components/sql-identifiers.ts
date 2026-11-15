import type { ExpressionField } from '#types/expression-field.type';

/*
 * Identifiers picked in the run (a tenant's schema, a table per period): `{{name}}` in the SQL of the SQL Server and
 * Redshift components is replaced by the value of the parameter `name` (a value or an expression on the envelope), the
 * way `@name` is a parameter. A value can not travel as a parameter where the database expects a name, so it is pasted
 * into the text, but only after it is checked: `name` or `schema.name`, each part letters, digits, _ and $ (nothing to
 * quote, nothing that could end the name). Anything else is an error of that envelope, and nothing is run.
 *
 * A list of names (`['id', 'name', 'email']`) becomes `id, name, email`: a column list for one generic statement
 * (`INSERT INTO {{table}} ({{columns}}) SELECT {{columns}} FROM ...`). In a list each item is one simple name, never
 * `schema.name` (a column list is what it is for; a qualified name there is more likely a mistake than a need), each
 * checked the same way; an empty list is an error (`()` is no SQL).
 *
 * Only outside strings, quoted names and comments: a `{{x}}` inside '...' stays as it is.
 */

export type SqlDialect = 'sqlserver' | 'redshift';

const PART = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function blankSql(sql: string, dialect: SqlDialect): string {
    let out = '';
    let i = 0;
    const blank = (to: number) => {
        out += sql.slice(i, to).replace(/[^\n]/g, ' ');
        i = to;
    };
    while (i < sql.length) {
        const c = sql[i]!;
        const two = sql.slice(i, i + 2);
        if (two === '--') {
            const end = sql.indexOf('\n', i);
            blank(end < 0 ? sql.length : end);
        } else if (two === '/*') {
            let level = 0;
            let j = i;
            while (j < sql.length) {
                if (sql.startsWith('/*', j)) {
                    level++;
                    j += 2;
                } else if (sql.startsWith('*/', j)) {
                    level--;
                    j += 2;
                    if (level === 0) {
                        break;
                    }
                } else {
                    j++;
                }
            }
            blank(Math.min(j, sql.length));
        } else if (c === "'" || c === '"' || (dialect === 'sqlserver' && c === '[')) {
            const close = c === '[' ? ']' : c;
            const escapes = dialect === 'redshift' && c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
            let j = i + 1;
            while (j < sql.length) {
                if (escapes && sql[j] === '\\') {
                    j += 2;
                } else if (sql[j] === close && sql[j + 1] === close) {
                    j += 2;
                } else if (sql[j] === close) {
                    j++;
                    break;
                } else {
                    j++;
                }
            }
            blank(Math.min(j, sql.length));
        } else if (dialect === 'redshift' && c === '$' && /^\$([A-Za-z_]\w*)?\$/.test(sql.slice(i))) {
            const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))![0];
            const end = sql.indexOf(tag, i + tag.length);
            blank(end < 0 ? sql.length : end + tag.length);
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

export function usedIdentifiers(sql: string, dialect: SqlDialect): string[] {
    return [...new Set([...blankSql(sql, dialect).matchAll(PLACEHOLDER)].map(m => m[1]!))];
}

export function identifierIssue(value: unknown): string | null {
    if (typeof value !== 'string') {
        return `is not text (${value === null ? 'null' : typeof value})`;
    }
    const parts = value.trim().split('.');
    if (!value.trim()) {
        return 'is empty';
    }
    return parts.length > 2 || !parts.every(p => PART.test(p))
        ? `"${value}" is not a valid name (name or schema.name: letters, digits, _ and $)`
        : null;
}

export function identifierListIssue(values: unknown[]): string | null {
    if (values.length === 0) {
        return 'is an empty list (it needs at least one name)';
    }
    for (const [i, value] of values.entries()) {
        if (typeof value !== 'string') {
            return `item ${i + 1} is not text (${value === null ? 'null' : typeof value})`;
        }
        if (!PART.test(value.trim())) {
            return `item ${i + 1} "${value}" is not a valid name (in a list, each item is one name: letters, digits, _ and $)`;
        }
    }
    return null;
}

export function withIdentifiers(sql: string, dialect: SqlDialect, values: Record<string, unknown>): string {
    const byName = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
    let text = '';
    let last = 0;
    for (const match of blankSql(sql, dialect).matchAll(PLACEHOLDER)) {
        const name = match[1]!;
        if (!byName.has(name.toLowerCase())) {
            throw new Error(`{{${name}}} has no parameter.`);
        }
        const value = byName.get(name.toLowerCase());
        const issue = Array.isArray(value) ? identifierListIssue(value) : identifierIssue(value);
        if (issue) {
            throw new Error(`{{${name}}} ${issue}.`);
        }
        const pasted = Array.isArray(value) ? value.map(v => String(v).trim()).join(', ') : String(value).trim();
        text += sql.slice(last, match.index) + pasted;
        last = match.index! + match[0].length;
    }
    return text + sql.slice(last);
}

/**
 * The parameters as a driver binds them: a list a `{{name}}` pastes goes as its pasted text (`a, b, c`), never as a
 * list (a driver binds values, not lists); every other value as it is.
 */
export function boundParameters(sql: string, dialect: SqlDialect, values: Record<string, unknown>): Record<string, unknown> {
    const pasted = new Set(usedIdentifiers(sql, dialect).map(name => name.toLowerCase()));
    return Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
            name,
            Array.isArray(value) && pasted.has(name.toLowerCase()) ? value.map(v => String(v).trim()).join(', ') : value,
        ]),
    );
}

/** a setting that is a fixed name or an expression: plain text (a flow saved before it took expressions) is a fixed value */
export function nameField(value: unknown): ExpressionField {
    if (typeof value === 'string') {
        return { value, expression: false };
    }
    const f = value as Partial<ExpressionField> | undefined;
    return { value: typeof f?.value === 'string' ? f.value : '', expression: f?.expression === true };
}

export function splitStatements(sql: string, dialect: SqlDialect): string[] {
    const blanked = blankSql(sql, dialect);
    const statements: string[] = [];
    let start = 0;
    for (let i = 0; i <= sql.length; i++) {
        if (i === sql.length || blanked[i] === ';') {
            const statement = sql.slice(start, i);
            if (blankSql(statement, dialect).trim()) {
                statements.push(statement.trim());
            }
            start = i + 1;
        }
    }
    return statements;
}
