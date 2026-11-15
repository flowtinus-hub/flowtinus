import { COMPONENT_TYPE } from '#components/component-types';
import { connectionIssues, connectionSettings } from '../../connections/connection-access';
import { runConnection } from '../run-connection';
import { toError } from '#errors/normalize-error';
import { mergeFields } from '#envelope/envelope-data';
import type { ExpressionField } from '#types/expression-field.type';
import type { ComponentLogic } from '#types/component-logic.type';
import { serverTimed } from '../server-timed';
import { boundParameters, usedIdentifiers, withIdentifiers } from '../sql-identifiers';

export type SqlServerParameter = ExpressionField & { name: string };

export const DEFAULT_SQL_SERVER_TIMEOUT_S = 300;

export function sqlServerConfig(config: Record<string, unknown>) {
    const timeout = Math.round(Number(config.timeoutS ?? DEFAULT_SQL_SERVER_TIMEOUT_S));
    return {
        connection: typeof config.connection === 'string' ? config.connection : '',
        sql: typeof config.sql === 'string' ? config.sql : '',
        parameters: Array.isArray(config.parameters) ? (config.parameters as SqlServerParameter[]) : [],
        timeoutS: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_SQL_SERVER_TIMEOUT_S,
    };
}

/**
 * Removes comments, quoted strings and bracketed names, so the checks do not look inside them.
 * Reads left to right, like SQL Server: whatever opens first wins (`'--'` is a string, not a comment), and
 * block comments can be nested (a block inside another). An unclosed string or comment runs to the end.
 */
function stripStrings(sql: string) {
    let output = '';
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        const two = sql.slice(i, i + 2);
        if (two === '--') {
            const end = sql.indexOf('\n', i);
            i = end < 0 ? sql.length : end;
            output += ' ';
        } else if (two === '/*') {
            let level = 0;
            while (i < sql.length) {
                if (sql.startsWith('/*', i)) {
                    level++;
                    i += 2;
                } else if (sql.startsWith('*/', i)) {
                    level--;
                    i += 2;
                    if (level === 0) {
                        break;
                    }
                } else {
                    i++;
                }
            }
            output += ' ';
        } else if (c === "'" || c === '"' || c === '[') {
            const close = c === '[' ? ']' : c;
            i++;
            // doubled quotes ('' or ]]) are the character itself inside the string
            while (i < sql.length && !(sql[i] === close && sql[i + 1] !== close)) {
                i += sql[i] === close ? 2 : 1;
            }
            i++;
            output += c === '[' ? '[]' : `${c}${c}`;
        } else {
            output += c;
            i++;
        }
    }
    return output;
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
    'DENY',
    'EXEC',
    'EXECUTE',
    'INTO',
    'BACKUP',
    'RESTORE',
    'DBCC',
    'SHUTDOWN',
    'KILL',
    'BULK',
    'OPENROWSET',
    'OPENQUERY',
    'OPENDATASOURCE',
    'OPENXML',
    'USE',
    'WAITFOR',
    'RECONFIGURE',
    'CHECKPOINT',
    'SET',
    'DECLARE',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'SAVE',
    'TRANSACTION',
    'UPDATETEXT',
    'WRITETEXT',
];

export function sqlServerReadOnlyIssue(sql: string): string | null {
    const clean = stripStrings(sql).trim().replace(/;\s*$/, '');
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
        return `cannot use ${word[1].toUpperCase()} (it is read-only)`;
    }
    const procedure = clean.match(/\b(sp_|xp_)\w*/i);
    if (procedure) {
        return `cannot call ${procedure[0]} (it is read-only)`;
    }
    return null;
}

export function sqlServerUsedParameters(sql: string): string[] {
    return [...new Set([...stripStrings(sql).matchAll(/(?<!@)@([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const sqlserverQuery: ComponentLogic = {
    type: COMPONENT_TYPE.sqlServerQuery,
    label: 'SQL Server Query',
    category: 'database',
    description:
        "Runs a read-only query (one SELECT or WITH) once per incoming envelope and yields one envelope per row, the columns written into DATA (Override: only the columns). The `@name`s are parameters, each a value or an expression on the envelope; a `{{name}}` is a schema or table name picked in the run (the parameter's value, checked: name or schema.name, letters, digits, _ and $). Connects with a connection profile of the workspace (its id in `connection`) or the component's own fields, the password always a secret.",
    example: {
        connection: '<connection profile id>',
        sql: 'SELECT id, name, email FROM Customer WHERE updatedAt > @since',
        parameters: [{ name: 'since', value: '$PARAMETERS.since', expression: true }],
        timeoutS: 60,
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    settings: [
        ...connectionSettings('sqlserver'),
        {
            key: 'sql',
            label: 'Query',
            kind: 'code',
            language: 'sql',
            required: true,
            placeholder: 'SELECT id, name FROM Customer WHERE id > @since',
        },
        {
            key: 'parameters',
            label: 'Parameters',
            kind: 'list',
            itemLabel: 'parameter',
            description:
                'Each @name the query uses, with its value; a {{name}} in the query (e.g. FROM {{schema}}.Customer) is pasted as a name, after it is checked; a list of names is pasted as a, b, c.',
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
        { key: 'timeoutS', label: 'Timeout (seconds)', kind: 'number', default: DEFAULT_SQL_SERVER_TIMEOUT_S, min: 1 },
    ],

    validate(config) {
        const { sql, parameters } = sqlServerConfig(config);
        const issues: string[] = [...connectionIssues('sqlserver', config)];
        const issue = sqlServerReadOnlyIssue(sql);
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
        for (const used of sqlServerUsedParameters(sql)) {
            if (!names.has(used.toLowerCase())) {
                issues.push(`uses @${used}, which is not in the parameters.`);
            }
        }
        for (const used of usedIdentifiers(sql, 'sqlserver')) {
            if (!names.has(used.toLowerCase())) {
                issues.push(`uses {{${used}}}, which is not in the parameters.`);
            }
        }
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const { sql, parameters, timeoutS } = sqlServerConfig(config);
        const connection = runConnection('sqlserver', config, ctx);
        const issue = sqlServerReadOnlyIssue(sql);
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
                    ctx.queryDatabase('sqlserver', {
                        connection,
                        sql: withIdentifiers(sql, 'sqlserver', values),
                        parameters: boundParameters(sql, 'sqlserver', values),
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
