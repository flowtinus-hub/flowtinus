import type { DatabaseKind } from '#types/database-kind.type';
import { COMPONENT_TYPE } from '#components/component-types';
import { connectionUse, dynamicConnection } from '../connections/connection-access';
import { connectionType, type ConnectionTypeName } from '../connections/types/connection-types';
import { aggregateConfig } from './built-in/aggregate';
import { startConfig } from './built-in/start';
import { dataGridConfig } from './built-in/datagrid';
import { distinctKeys } from './built-in/distinct';
import { filterCondition } from './built-in/filter';
import { flowInvokerConfig } from './built-in/flow-invoker';
import { scriptInvokerConfig } from './built-in/script-invoker';
import { httpConfig } from './built-in/http-request';
import { limitConfig } from './built-in/limit';
import { logConfig } from './built-in/log';
import { loopConfig, PARALLEL_LOOPS } from './built-in/loop';
import { lookupConfig } from './built-in/lookup';
import { mapperFields } from './built-in/mapper';
import { mongoDeleteConfig } from './built-in/mongodb-delete';
import { mongoPipelineConfig } from './built-in/mongodb-pipeline';
import { mongoUpsertConfig } from './built-in/mongodb-upsert';
import { routerCases } from './built-in/router';
import { sortKeys } from './built-in/sort';
import { splitList } from './built-in/split';
import type { ExpressionField } from '#types/expression-field.type';
import { sqlServerConfig } from './built-in/sqlserver-query';
import { redshiftConfig } from './built-in/redshift-query';
import { tableWriteConfig } from './table-write';
import { sqlExecuteConfig } from './built-in/sql-execute';
import { typescriptConfig } from './built-in/typescript';

/*
 * What a component does, at a glance, read from its config with each component's own helpers (so it shows what will
 * really run): the fields a Mapper writes, a Router's cases, a Filter's condition, a Log's message... The editor shows
 * it apart from the card (the card has a fixed size); here it is only text, the editor decides how it looks.
 */

export type SummaryLine = { label?: string; value: string; code?: boolean };

export type SummarySection = { title: string; lines: SummaryLine[] };

function textOf(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object' && 'value' in value) {
        return textOf((value as { value: unknown }).value);
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const shown = (value: unknown, expression = true) => (expression ? textOf(value) : JSON.stringify(textOf(value)));
const section = (title: string, lines: SummaryLine[]): SummarySection[] => (lines.length > 0 ? [{ title, lines }] : []);
const single = (title: string, value: string, code = true): SummarySection[] => (value.trim() ? [{ title, lines: [{ value, code }] }] : []);
function collection(database: ExpressionField, name: ExpressionField): SummarySection[] {
    if (!database.expression && !name.expression) {
        return single('Collection', [database.value, name.value].filter(v => v.trim()).join('.'), false);
    }
    const lines = [
        ...(database.value.trim() ? [{ label: 'Database', value: shown(database.value, database.expression), code: true }] : []),
        ...(name.value.trim() ? [{ label: 'Collection', value: shown(name.value, name.expression), code: true }] : []),
    ];
    return section('Collection', lines);
}

/**
 * How it gets in: the profile's name (`nameOf` turns an id into it: the core does not know the project's
 * profiles nor its flows) or what its own fields say (host and database, the authentication).
 */
function connection(
    type: ConnectionTypeName,
    config: Record<string, unknown>,
    nameOf?: (id: string) => string | undefined,
): SummarySection[] {
    const byName = dynamicConnection(config);
    if (byName) {
        return single('Connection', shown(byName.value, byName.expression), byName.expression);
    }
    const use = connectionUse(type, config);
    if ('profile' in use) {
        return [{ title: 'Connection', lines: [{ value: nameOf?.(use.profile) ?? use.profile }] }];
    }
    if (type === 'http-client' && (use.inline.auth ?? 'none') === 'none') {
        return [];
    }
    return single('Connection', connectionType(type).summary(use.inline), false);
}

export function componentSummary(
    type: string,
    config: Record<string, unknown>,
    nameOf?: (id: string) => string | undefined,
): SummarySection[] {
    const asText = (line: SummaryLine): SummaryLine =>
        line.label === undefined
            ? { ...line, value: textOf(line.value) }
            : { ...line, label: textOf(line.label), value: textOf(line.value) };
    return sections(type, config, nameOf).map(s => ({ ...s, lines: s.lines.map(asText) }));
}

const SQL_SERVER_COMPONENTS: string[] = [
    COMPONENT_TYPE.sqlServerExecute,
    COMPONENT_TYPE.sqlServerInsert,
    COMPONENT_TYPE.sqlServerUpdate,
    COMPONENT_TYPE.sqlServerDelete,
];

const databaseOf = (type: string): DatabaseKind => (SQL_SERVER_COMPONENTS.includes(type) ? 'sqlserver' : 'redshift');

function sections(type: string, config: Record<string, unknown>, nameOf?: (id: string) => string | undefined): SummarySection[] {
    switch (type) {
        case COMPONENT_TYPE.start: {
            const { acceptsInput, testInput, parameters } = startConfig(config);
            return [
                ...(acceptsInput
                    ? [{ title: 'Input', lines: [{ value: testInput.trim() || 'Accepts input', code: testInput.trim() !== '' }] }]
                    : []),
                ...section(
                    'Parameters',
                    parameters.map(p => ({
                        label: p.name,
                        value: `${p.type}${p.default !== '' ? ` = ${p.type === 'text' ? JSON.stringify(p.default) : p.default}` : ''}${p.required ? ' (required)' : ''}`,
                        code: true,
                    })),
                ),
            ];
        }
        case COMPONENT_TYPE.discard:
            return [{ title: 'Discard', lines: [{ value: 'Drops every envelope' }] }];
        case COMPONENT_TYPE.loopContinueWith:
            return [{ title: 'Continue with', lines: [{ value: 'Its envelope is the loop state of the next iteration' }] }];
        case COMPONENT_TYPE.loopNext:
            return [{ title: 'Next', lines: [{ value: 'Ends the iteration right away; the next one starts with the same loop state' }] }];
        case COMPONENT_TYPE.loopBreak:
            return [{ title: 'Break', lines: [{ value: 'Ends the loop after the iteration' }] }];
        case COMPONENT_TYPE.loop: {
            const { maxIterations, stopCondition, checkTiming, parallel } = loopConfig(config);
            return [
                { title: 'Max iterations', lines: [{ value: maxIterations.toLocaleString('en'), code: false }] },
                ...section(
                    'Stop condition',
                    stopCondition
                        ? [
                              {
                                  label: checkTiming === 'after' ? 'after each iteration' : 'before each iteration',
                                  value: stopCondition,
                                  code: true,
                              },
                          ]
                        : [],
                ),
                ...(parallel ? single('Parallel', `Up to ${PARALLEL_LOOPS} loops at once`, false) : []),
            ];
        }
        case COMPONENT_TYPE.wait:
            return [{ title: 'Wait', lines: [{ value: 'Holds `hold` until `watch` ends: success, failure or empty' }] }];
        case COMPONENT_TYPE.mapper:
            return section(
                'Fields',
                mapperFields(config).map(f => ({ label: `$${f.target}`, value: shown(f.value, f.expression), code: true })),
            );
        case COMPONENT_TYPE.filter:
            return single('Condition', filterCondition(config));
        case COMPONENT_TYPE.router:
            return section(
                'Cases',
                routerCases(config).map((c, i) => ({ label: c.label?.trim() || `case ${i + 1}`, value: c.condition, code: true })),
            );
        case COMPONENT_TYPE.log: {
            const { level, message } = logConfig(config);
            return message.trim() ? [{ title: 'Message', lines: [{ label: level, value: message, code: true }] }] : [];
        }
        case COMPONENT_TYPE.sort:
            return section(
                'Keys',
                sortKeys(config)
                    .filter(k => k.value.trim())
                    .map(k => ({ label: k.direction, value: k.value, code: true })),
            );
        case COMPONENT_TYPE.limit: {
            const { mode, count } = limitConfig(config);
            return [{ title: 'Limit', lines: [{ value: `${mode === 'top' ? 'First' : 'Last'} ${count}` }] }];
        }
        case COMPONENT_TYPE.distinct:
            return section(
                'Keys',
                distinctKeys(config).map(k => ({ value: k, code: true })),
            );
        case COMPONENT_TYPE.lookup:
            return section(
                'Keys',
                lookupConfig(config).keys.map(k => ({ label: k.main, value: k.lookup, code: true })),
            );
        case COMPONENT_TYPE.aggregate: {
            const { mode, size, field, whenEmpty } = aggregateConfig(config);
            const batches = mode === 'all' ? `all in one batch, in $${field}` : `${size} per batch, in $${field}`;
            return [{ title: 'Batches', lines: [{ value: whenEmpty ? `${batches}; [] when empty` : batches }] }];
        }
        case COMPONENT_TYPE.split:
            return single('List', splitList(config));
        case COMPONENT_TYPE.datagrid: {
            const { columns, rows } = dataGridConfig(config);
            return [
                ...section(
                    'Columns',
                    columns.map(c => ({ label: c.type, value: c.name, code: true })),
                ),
                ...(rows.length > 0 ? [{ title: 'Rows', lines: [{ value: String(rows.length) }] }] : []),
            ];
        }
        case COMPONENT_TYPE.sqlServerQuery: {
            return [...connection('sqlserver', config, nameOf), ...single('Query', sqlServerConfig(config).sql)];
        }
        case COMPONENT_TYPE.redshiftQuery: {
            return [...connection('redshift', config, nameOf), ...single('Query', redshiftConfig(config).sql)];
        }
        case COMPONENT_TYPE.sqlServerExecute:
        case COMPONENT_TYPE.redshiftExecute: {
            const kind = databaseOf(type);
            const { sql, atEnd } = sqlExecuteConfig(config);
            return [
                ...connection(kind, config, nameOf),
                ...single('SQL', sql),
                ...(atEnd === 'rollback' ? single('At the end', 'Rollback') : []),
            ];
        }
        case COMPONENT_TYPE.redshiftInsert:
        case COMPONENT_TYPE.redshiftUpsert:
        case COMPONENT_TYPE.redshiftDelete:
        case COMPONENT_TYPE.sqlServerInsert:
        case COMPONENT_TYPE.sqlServerUpdate:
        case COMPONENT_TYPE.sqlServerDelete: {
            const { table, columns, match } = tableWriteConfig(config);
            return [
                ...connection(databaseOf(type), config, nameOf),
                ...single('Table', table),
                ...(columns.length
                    ? [
                          {
                              title: type.endsWith('-delete') ? 'Match on' : 'Columns',
                              lines: [{ value: columns.map(c => c.column).join(', ') }],
                          },
                      ]
                    : []),
                ...(!type.endsWith('-insert') && match.length ? [{ title: 'Match on', lines: [{ value: match.join(', ') }] }] : []),
            ];
        }
        case COMPONENT_TYPE.mongoDbPipeline: {
            const { database, collection: name, pipeline } = mongoPipelineConfig(config);
            return [...connection('mongodb', config, nameOf), ...collection(database, name), ...single('Pipeline', pipeline)];
        }
        case COMPONENT_TYPE.mongoDbUpsert: {
            const { database, collection: name, filter } = mongoUpsertConfig(config);
            return [
                ...connection('mongodb', config, nameOf),
                ...collection(database, name),
                ...section(
                    'Match on',
                    filter.map(k => ({ value: JSON.stringify(k), code: true })),
                ),
            ];
        }
        case COMPONENT_TYPE.mongoDbDelete: {
            const { database, collection: name, filter } = mongoDeleteConfig(config);
            return [...connection('mongodb', config, nameOf), ...collection(database, name), ...single('Filter', filter)];
        }
        case COMPONENT_TYPE.httpRequest: {
            const { method, url } = httpConfig(config);
            return url.value.trim()
                ? [
                      { title: 'Request', lines: [{ label: method, value: shown(url.value, url.expression), code: true }] },
                      ...connection('http-client', config, nameOf),
                  ]
                : [];
        }
        case COMPONENT_TYPE.typescript:
            return single('Code', typescriptConfig(config).code);
        case COMPONENT_TYPE.flowInvoker: {
            const { flowId, flowPath, parameters } = flowInvokerConfig(config);
            const flow = flowPath
                ? single('Flow', shown(flowPath.value, flowPath.expression), flowPath.expression)
                : single('Flow', flowId ? (nameOf?.(flowId) ?? flowId) : '', false);
            return [
                ...flow,
                ...section(
                    'Parameters',
                    parameters.map(p => ({ label: p.name, value: shown(p.value, p.expression), code: true })),
                ),
            ];
        }
        case COMPONENT_TYPE.scriptInvoker: {
            const { target, functionPath, arguments: args } = scriptInvokerConfig(config);
            const given = args.filter(a => (a.expression ? a.value.trim() : a.value !== ''));
            const fn = functionPath
                ? single('Function', shown(functionPath.value, functionPath.expression), functionPath.expression)
                : single('Function', target ? `${target.name} (${target.path})` : '', false);
            return [
                ...fn,
                ...section(
                    'Arguments',
                    given.map(a => ({ label: a.name, value: shown(a.value, a.expression), code: true })),
                ),
            ];
        }
        default:
            return [];
    }
}
