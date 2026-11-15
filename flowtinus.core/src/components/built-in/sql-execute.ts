import { COMPONENT_TYPE } from '#components/component-types';
import { connectionIssues, connectionSettings } from '../../connections/connection-access';
import { runConnection } from '../run-connection';
import { toError } from '#errors/normalize-error';
import { withKey } from '#envelope/envelope-data';
import type { ComponentLogic } from '#types/component-logic.type';
import type { DatabaseKind } from '#types/database-kind.type';
import type { ExpressionField } from '#types/expression-field.type';
import { redshiftUsedParameters } from './redshift-query';
import { boundParameters, usedIdentifiers, withIdentifiers } from '../sql-identifiers';

/*\n * SQL Server Execute and Redshift Execute: free SQL in a transaction of its own. Nothing checks what the SQL does:\n * whoever writes it owns the risk, the way a script does.\n */

export type SqlExecuteParameter = ExpressionField & { name: string };

export const DEFAULT_EXECUTE_TIMEOUT_S = 300;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function sqlExecuteConfig(config: Record<string, unknown>) {
    const timeout = Math.round(Number(config.timeoutS ?? DEFAULT_EXECUTE_TIMEOUT_S));
    return {
        sql: typeof config.sql === 'string' ? config.sql : '',
        parameters: Array.isArray(config.parameters) ? (config.parameters as SqlExecuteParameter[]) : [],
        atEnd: config.atEnd === 'rollback' ? ('rollback' as const) : ('commit' as const),
        timeoutS: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_EXECUTE_TIMEOUT_S,
    };
}

function component(options: {
    type: string;
    label: string;
    kind: DatabaseKind;
    outputKey: string;
    description: string;
    example: Record<string, unknown>;
    placeholder: string;
}): ComponentLogic {
    const { kind } = options;
    return {
        type: options.type,
        label: options.label,
        category: 'database',
        description: options.description,
        example: options.example,
        inputs: 1,
        outputs: 1,
        usesOverride: true,
        defaultOutputKey: options.outputKey,
        sideEffects: true,
        settings: [
            ...connectionSettings(kind),
            {
                key: 'sql',
                label: 'SQL',
                kind: 'code',
                language: 'sql',
                required: true,
                description:
                    'Any SQL, one or more statements, run as written in one transaction (a COMMIT or ROLLBACK in it is its own). Nothing checks what it does.',
                placeholder: options.placeholder,
            },
            {
                key: 'parameters',
                label: 'Parameters',
                kind: 'list',
                itemLabel: 'parameter',
                description:
                    'Each @name the SQL uses, with its value (sent as a parameter); a {{name}} in the SQL (e.g. {{schema}}.briefs) is pasted as a name, after it is checked; a list of names (e.g. ["id", "name"]) is pasted as id, name, each item one simple name (no schema.name), an empty list an error.',
                item: [
                    { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'id' },
                    {
                        key: 'value',
                        label: 'Value',
                        kind: 'value',
                        spread: true,
                        default: { value: '', expression: true },
                        placeholder: '$id',
                    },
                ],
            },
            {
                key: 'atEnd',
                label: 'At the end',
                kind: 'select',
                default: 'commit',
                description:
                    'What happens to the transaction still open when the SQL ends without error: Commit, or Rollback (only what the SQL committed itself stays). An error always rolls back.',
                options: [
                    { value: 'commit', label: 'Commit' },
                    { value: 'rollback', label: 'Rollback' },
                ],
            },
            { key: 'timeoutS', label: 'Timeout (seconds)', kind: 'number', default: DEFAULT_EXECUTE_TIMEOUT_S, min: 1 },
        ],

        validate(config) {
            const { sql, parameters } = sqlExecuteConfig(config);
            const issues: string[] = [...connectionIssues(kind, config)];
            if (!sql.trim()) {
                issues.push('has no SQL.');
            }
            const names = new Set<string>();
            parameters.forEach((p, i) => {
                if (!NAME.test(p.name ?? '')) {
                    issues.push(`parameter ${i + 1} ${p.name ? `"@${p.name}" is not a valid name` : 'has no name'}.`);
                } else if (names.has(p.name.toLowerCase())) {
                    issues.push(`has the parameter "@${p.name}" more than once.`);
                }
                names.add((p.name ?? '').toLowerCase());
            });
            // SQL Server's own variables (DECLARE @x) are @names too: only Redshift's must all be parameters
            if (kind === 'redshift') {
                for (const used of redshiftUsedParameters(sql)) {
                    if (!names.has(used.toLowerCase())) {
                        issues.push(`uses @${used}, which is not in the parameters.`);
                    }
                }
            }
            for (const used of usedIdentifiers(sql, kind)) {
                if (!names.has(used.toLowerCase())) {
                    issues.push(`uses {{${used}}}, which is not in the parameters.`);
                }
            }
            return issues;
        },

        async *execute(inputs, config, ctx) {
            const { sql, parameters, atEnd, timeoutS } = sqlExecuteConfig(config);
            const connection = runConnection(kind, config, ctx);
            const key = ctx.node.outputKey || options.outputKey;
            let runs = 0;
            let affected = 0;
            for await (const doc of inputs['in-0'] ?? []) {
                runs += 1;
                const t0 = performance.now();
                try {
                    const values = Object.fromEntries(parameters.map(p => [p.name, ctx.fieldValue(p, doc)]));
                    const answer = await ctx.executeSql(kind, {
                        connection,
                        sql: withIdentifiers(sql, kind, values),
                        parameters: boundParameters(sql, kind, values),
                        atEnd,
                        timeoutMs: timeoutS * 1000,
                    });
                    if (answer === null) {
                        yield { port: 'out-0', doc: withKey(doc, key, { notSent: true }, ctx.node.override) };
                        continue;
                    }
                    affected += answer.rowsAffected;
                    ctx.wrote('sql', { affected: answer.rowsAffected, batches: 1 });
                    ctx.log(
                        'debug',
                        `Run ${runs}: ${answer.rowsAffected} row(s) affected, ${answer.rows.length} returned, ${answer.transaction === 'sql' ? 'transaction ended by the SQL' : answer.transaction} (${Math.round(performance.now() - t0)} ms).`,
                    );
                    yield { port: 'out-0', doc: withKey(doc, key, answer, ctx.node.override) };
                } catch (e) {
                    ctx.wrote('sql', { failed: 1 });
                    yield { error: toError(e), doc };
                }
            }
            ctx.log('debug', `${runs} run(s), ${affected} row(s) affected.`);
        },
    };
}

export const sqlServerExecute = component({
    type: COMPONENT_TYPE.sqlServerExecute,
    label: 'SQL Server Execute',
    kind: 'sqlserver',
    outputKey: 'sqlserver',
    description:
        'Runs any SQL on SQL Server (one or more statements; nothing checks what it does) once per envelope, in a transaction of its own: a COMMIT or ROLLBACK in the SQL is its own; what is still open at the end is committed (At the end: Commit, the default) or rolled back; an error rolls back. The `@name`s are parameters (a value or an expression on the envelope); a `{{name}}` is a schema or table name picked in the run (checked, then pasted) (or a list of names: a, b, c). The envelope goes on with {rowsAffected, rows, transaction} in its output key (default `sqlserver`). A test run runs nothing.',
    example: {
        connection: '<connection profile id>',
        sql: 'DELETE FROM dbo.ProjectItem WHERE BriefId = @briefId;\nINSERT INTO dbo.ProjectItem (BriefId, Name) SELECT @briefId, value FROM OPENJSON(@names);',
        parameters: [
            { name: 'briefId', value: '$id', expression: true },
            { name: 'names', value: 'JSON.stringify($projects.map(p => p.name))', expression: true },
        ],
        atEnd: 'commit',
    },
    placeholder: 'UPDATE dbo.Ticket SET Status = @status WHERE Id = @id',
});

export const redshiftExecute = component({
    type: COMPONENT_TYPE.redshiftExecute,
    label: 'Redshift Execute',
    kind: 'redshift',
    outputKey: 'redshift',
    description:
        'Runs any SQL on Amazon Redshift (one or more statements; nothing checks what it does) once per envelope, in a transaction of its own: a COMMIT or ROLLBACK in the SQL is its own; what is still open at the end is committed (At the end: Commit, the default) or rolled back; an error rolls back. The `@name`s are parameters (a value or an expression on the envelope); a `{{name}}` is a schema or table name picked in the run (checked, then pasted) (or a list of names: a, b, c). The envelope goes on with {rowsAffected, rows, transaction} in its output key (default `redshift`). A test run runs nothing.',
    example: {
        connection: '<connection profile id>',
        sql: 'DELETE FROM {{schema}}.projects WHERE brief_id = @briefId;\nINSERT INTO {{schema}}.projects (brief_id, name) VALUES (@briefId, @name);',
        parameters: [
            { name: 'schema', value: '$tenant', expression: true },
            { name: 'briefId', value: '$id', expression: true },
            { name: 'name', value: '$project.name', expression: true },
        ],
        atEnd: 'commit',
    },
    placeholder: 'UPDATE sales.orders SET status = @status WHERE id = @id',
});
