import { COMPONENT_TYPE } from '#components/component-types';
import { connectionIssues, connectionSettings } from '../../connections/connection-access';
import { runConnection } from '../run-connection';
import { toError } from '#errors/normalize-error';
import { mergeFields } from '#envelope/envelope-data';
import type { ExpressionField } from '#types/expression-field.type';
import type { ComponentLogic } from '#types/component-logic.type';
import { serverTimed } from '../server-timed';
import { boundParameters, usedIdentifiers, withIdentifiers } from '../sql-identifiers';

export type RedshiftParameter = ExpressionField & { name: string };

export const DEFAULT_REDSHIFT_TIMEOUT_S = 300;

export function redshiftConfig(config: Record<string, unknown>) {
    const timeout = Math.round(Number(config.timeoutS ?? DEFAULT_REDSHIFT_TIMEOUT_S));
    return {
        sql: typeof config.sql === 'string' ? config.sql : '',
        parameters: Array.isArray(config.parameters) ? (config.parameters as RedshiftParameter[]) : [],
        timeoutS: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_REDSHIFT_TIMEOUT_S,
    };
}

/**
 * The query with its comments, strings and quoted names blanked to spaces (their place kept, so positions do not move), the way
 * Redshift (Postgres) reads it: `--` and nested block comments, '...' with '' inside, E'...' with \ escapes, "names"
 * and $tag$...$tag$. An unclosed one runs to the end.
 */
function blankStrings(sql: string): string {
    let out = '';
    let i = 0;
    const blank = (from: number, to: number) => {
        out += sql.slice(from, to).replace(/[^\n]/g, ' ');
        i = to;
    };
    while (i < sql.length) {
        const two = sql.slice(i, i + 2);
        if (two === '--') {
            const end = sql.indexOf('\n', i);
            blank(i, end < 0 ? sql.length : end);
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
            blank(i, j);
        } else if (sql[i] === "'" || sql[i] === '"' || (/[eE]/.test(sql[i]!) && sql[i + 1] === "'" && !/\w/.test(sql[i - 1] ?? ''))) {
            const escapes = sql[i] !== "'" && sql[i] !== '"';
            const quote = escapes ? "'" : sql[i]!;
            let j = escapes ? i + 2 : i + 1;
            while (j < sql.length) {
                if (escapes && sql[j] === '\\') {
                    j += 2;
                } else if (sql[j] === quote && sql[j + 1] === quote) {
                    j += 2;
                } else if (sql[j] === quote) {
                    j++;
                    break;
                } else {
                    j++;
                }
            }
            blank(i, Math.min(j, sql.length));
        } else if (sql[i] === '$' && /^\$([A-Za-z_]\w*)?\$/.test(sql.slice(i))) {
            const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))![0];
            const end = sql.indexOf(tag, i + tag.length);
            blank(i, end < 0 ? sql.length : end + tag.length);
        } else {
            out += sql[i];
            i++;
        }
    }
    return out;
}

const FORBIDDEN = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'TRUNCATE',
    'DROP',
    'ALTER',
    'CREATE',
    'GRANT',
    'REVOKE',
    'INTO',
    'COPY',
    'UNLOAD',
    'VACUUM',
    'CALL',
    'EXECUTE',
    'PREPARE',
    'DEALLOCATE',
    'SET',
    'RESET',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'DECLARE',
    'REFRESH',
];

export function redshiftReadOnlyIssue(sql: string): string | null {
    const clean = blankStrings(sql).trim().replace(/;\s*$/, '');
    if (!clean) {
        return 'has no query';
    }
    if (clean.includes(';')) {
        return 'has more than one statement (only one SELECT per component)';
    }
    if (!/^(SELECT|WITH)\b/i.test(clean)) {
        return 'does not start with SELECT or WITH (it is read-only)';
    }
    const word = clean.match(new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'i'));
    if (word) {
        return `cannot use ${word[1]!.toUpperCase()} (it is read-only)`;
    }
    return null;
}

const PARAMETER = /(?<![@\w])@([A-Za-z_][A-Za-z0-9_]*)/g;

export function redshiftUsedParameters(sql: string): string[] {
    return [...new Set([...blankStrings(sql).matchAll(PARAMETER)].map(m => m[1]!))];
}

export function positionalSql(sql: string): { text: string; names: string[] } {
    const names: string[] = [];
    const blanked = blankStrings(sql);
    let text = '';
    let last = 0;
    for (const match of blanked.matchAll(PARAMETER)) {
        const name = match[1]!;
        let at = names.findIndex(n => n.toLowerCase() === name.toLowerCase());
        if (at < 0) {
            at = names.push(name) - 1;
        }
        text += `${sql.slice(last, match.index)}$${at + 1}`;
        last = match.index! + match[0].length;
    }
    return { text: text + sql.slice(last), names };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const redshiftQuery: ComponentLogic = {
    type: COMPONENT_TYPE.redshiftQuery,
    label: 'Redshift Query',
    category: 'database',
    description:
        "Runs a read-only query (one SELECT or WITH) on Amazon Redshift once per incoming envelope and yields one envelope per row, the columns written into DATA (Override: only the columns). The `@name`s are parameters, each a value or an expression on the envelope (sent as $1, $2..., never pasted into the text); a `{{name}}` is a schema or table name picked in the run (the parameter's value, checked: name or schema.name, letters, digits, _ and $). Connects with a connection profile of the workspace (its id in `connection`) or the component's own fields, the password always a secret.",
    example: {
        connection: '<connection profile id>',
        sql: 'SELECT email, name FROM sales.customers WHERE region = @region AND updated_at > @since',
        parameters: [
            { name: 'region', value: '$region', expression: true },
            { name: 'since', value: '$PARAMETERS.since', expression: true },
        ],
        timeoutS: 120,
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    settings: [
        ...connectionSettings('redshift'),
        {
            key: 'sql',
            label: 'Query',
            kind: 'code',
            language: 'sql',
            required: true,
            placeholder: 'SELECT id, name FROM sales.customers WHERE updated_at > @since',
        },
        {
            key: 'parameters',
            label: 'Parameters',
            kind: 'list',
            itemLabel: 'parameter',
            description:
                "Each @name the query uses, with its value. A list of values for IN: split it in the query (e.g. split_to_array(@ids, ',')). A {{name}} in the query (e.g. FROM {{schema}}.briefs) is pasted as a name, after it is checked; a list of names is pasted as a, b, c.",
            item: [
                { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'since' },
                {
                    key: 'value',
                    label: 'Value',
                    kind: 'value',
                    spread: true,
                    default: { value: '', expression: true },
                    placeholder: '$PARAMETERS.since',
                },
            ],
        },
        { key: 'timeoutS', label: 'Timeout (seconds)', kind: 'number', default: DEFAULT_REDSHIFT_TIMEOUT_S, min: 1 },
    ],

    validate(config) {
        const { sql, parameters } = redshiftConfig(config);
        const issues: string[] = [...connectionIssues('redshift', config)];
        const issue = redshiftReadOnlyIssue(sql);
        if (issue) {
            issues.push(`${issue}.`);
        }
        const names = new Set<string>();
        parameters.forEach((p, i) => {
            if (!IDENTIFIER.test(p.name ?? '')) {
                issues.push(`parameter ${i + 1} ${p.name ? `"@${p.name}" is not a valid name` : 'has no name'}.`);
            } else if (names.has(p.name.toLowerCase())) {
                issues.push(`has the parameter "@${p.name}" more than once.`);
            }
            names.add((p.name ?? '').toLowerCase());
        });
        for (const used of redshiftUsedParameters(sql)) {
            if (!names.has(used.toLowerCase())) {
                issues.push(`uses @${used}, which is not in the parameters.`);
            }
        }
        for (const used of usedIdentifiers(sql, 'redshift')) {
            if (!names.has(used.toLowerCase())) {
                issues.push(`uses {{${used}}}, which is not in the parameters.`);
            }
        }
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const { sql, parameters, timeoutS } = redshiftConfig(config);
        const connection = runConnection('redshift', config, ctx);
        const issue = redshiftReadOnlyIssue(sql);
        if (issue) {
            throw new Error(`The query ${issue}.`);
        }
        let queries = 0;
        let rows = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            queries += 1;
            const t0 = Date.now();
            let thisQuery = 0;
            let server = 0;
            try {
                const values = Object.fromEntries(parameters.map(p => [p.name, ctx.fieldValue(p, doc)]));
                const query = serverTimed(
                    ctx.queryDatabase('redshift', {
                        connection,
                        sql: withIdentifiers(sql, 'redshift', values),
                        parameters: boundParameters(sql, 'redshift', values),
                        timeoutMs: timeoutS * 1000,
                    }),
                    ms => {
                        server += ms;
                    },
                );
                for await (const row of ctx.waitEach(query)) {
                    thisQuery += 1;
                    yield { port: 'out-0', doc: mergeFields(doc, row, ctx.node.override) };
                }
                ctx.log('debug', `Query ${queries}: ${thisQuery} row(s) in ${Date.now() - t0} ms (server ${Math.round(server)} ms).`);
            } catch (e) {
                // rows already yielded move on; the envelope that triggered the query goes to the error policy
                if (thisQuery) {
                    ctx.log('warning', `Query ${queries} stopped after ${thisQuery} row(s).`);
                }
                yield { error: toError(e), doc };
            }
            rows += thisQuery;
        }
        ctx.log('debug', `${rows} row(s) read in ${queries} query(ies).`);
    },
};
