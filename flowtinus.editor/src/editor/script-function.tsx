import { useContext, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { DYNAMIC_TARGET, inputTypeRef, scriptFunctions, type ExportedFunction, type ExpressionField, type ScriptArgument } from '@flowtinus/core';
import { useScriptContent } from '@/data/scripts/scripts-store';
import { scriptByImport, useWorkspaceScripts } from '@/data/scripts/workspace-scripts';
import { ProjectResourcesContext } from './project-resources';
import { scriptPath } from '@/app/paths';
import { OpenInNewTab } from './open-in-new-tab';
import { useWorkspaceHandle } from '@/data/workspaces/use-workspace';

/*
 * A Script Invoker's settings: the function it calls (one a script of any project of the workspace exports, `<import path>#name`) and its arguments,
 * one row per parameter of that function, in its order (the call passes them by position).
 */

const SELECT = 'h-8 w-full rounded-md border bg-transparent px-2 text-sm';

/** the functions the scripts of every project export (`export function`), grouped by project, as `<import path>#name` */
export function ScriptFunctionPicker({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
    const ws = useWorkspaceHandle();
    const { projectId } = useContext(ProjectResourcesContext);
    const workspace = useWorkspaceScripts();
    const projects = [...workspace.projects]
        .sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId))
        .map(p => ({ ...p, functions: p.scripts.flatMap(s => s.exports.filter(e => e.function).map(e => ({ script: s, name: e.name }))) }))
        .filter(p => p.functions.length > 0);
    const chosen = inputTypeRef(value);
    const chosenScript = chosen && scriptByImport(workspace, chosen.path);
    const unlisted = chosen && value !== DYNAMIC_TARGET && !chosenScript?.exports.some(e => e.function && e.name === chosen.name);
    const missing = unlisted && workspace.status !== 'loading';
    // one chosen here (not by expression) opens its script in a new tab from the button beside it
    const open = chosen && !unlisted && value !== DYNAMIC_TARGET;
    return (
        <div className="flex items-center gap-1">
            <select id={id} value={value} className={SELECT} onChange={event => onChange(event.target.value)}>
                <option value="">{projects.length ? 'Choose a function' : 'No script exports a function'}</option>
                <option value={DYNAMIC_TARGET}>By path (expression)</option>
                {unlisted && <option value={value}>{`${chosen.name} (${chosen.path}${missing ? ', missing' : ''})`}</option>}
                {projects.map(p => (
                    <optgroup key={p.id} label={p.name}>
                        {p.functions.map(f => (
                            <option key={`${f.script.path}#${f.name}`} value={`${f.script.importPath}#${f.name}`}>
                                {`${f.script.path} › ${f.name}`}
                            </option>
                        ))}
                    </optgroup>
                ))}
            </select>
            {open && chosenScript && (
                <OpenInNewTab
                    href={scriptPath(ws, chosenScript.projectId, chosenScript.path)}
                    label={`Open ${chosenScript.path} in a new tab`}
                />
            )}
        </div>
    );
}

export type CalledFunction = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; fn: ExportedFunction };

/** the function `<import path>#name` names, read from its script (loaded when needed, read again when it changes) */
export function useScriptFunction(ref: string): CalledFunction {
    const workspace = useWorkspaceScripts();
    const target = inputTypeRef(ref);
    const script = target ? scriptByImport(workspace, target.path) : undefined;
    const content = useScriptContent(script?.projectId ?? '', script?.path ?? null);
    if (!target || (workspace.status === 'ready' && !script)) {
        return { status: 'missing' };
    }
    if (content === undefined) {
        return { status: 'loading' };
    }
    const fn = scriptFunctions(content.code).find(f => f.name === target.name);
    return fn ? { status: 'ready', fn } : { status: 'missing' };
}

/** the arguments for the function's parameters, in its order, each with the value already given for it (by name) */
export function argumentsFor(fn: ExportedFunction, items: ScriptArgument[]): ScriptArgument[] {
    return fn.params.map(p => {
        const given = items.find(item => item.name === p.name);
        return { name: p.name, type: p.type, value: given?.value ?? '', expression: given?.expression ?? false };
    });
}

/** whether the arguments kept are the function's parameters, in its order (a changed function shifts them) */
const inStep = (fn: ExportedFunction, items: ScriptArgument[]) =>
    items.length === fn.params.length && fn.params.every((p, i) => items[i]?.name === p.name && (items[i]?.type ?? '') === p.type);

/**
 * One row per parameter of the function (its type, whether it is optional), each a fixed value or an expression; empty:
 * undefined (its default applies). Kept arguments that no longer match the function: a note, and a button to match it.
 */
export function ScriptArgumentsSetting(props: {
    id: string;
    fn: ExportedFunction;
    items: ScriptArgument[];
    onChange: (items: ScriptArgument[]) => void;
    renderValue: (id: string, value: ExpressionField, placeholder: string, onChange: (value: ExpressionField) => void) => ReactNode;
}) {
    const { id, fn, items, onChange, renderValue } = props;
    const rows = argumentsFor(fn, items);
    const stale = items.length > 0 && !inStep(fn, items);
    const gone = items.filter(item => !fn.params.some(p => p.name === item.name));
    const set = (name: string, value: ExpressionField) => onChange(rows.map(row => (row.name === name ? { ...row, ...value } : row)));

    return (
        <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm leading-none font-medium">Arguments</legend>
            {stale && (
                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                    <span>
                        The function's parameters changed{gone.length ? ` (${gone.map(g => g.name).join(', ')} no longer there)` : ''}: the
                        call still sends the arguments as they were.{' '}
                        <button type="button" className="underline" onClick={() => onChange(rows)}>
                            Match the function
                        </button>
                    </span>
                </p>
            )}
            {fn.params.length === 0 && <p className="text-xs text-muted-foreground">The function takes no arguments.</p>}
            {rows.map((row, index) => {
                const param = fn.params[index]!;
                const empty = row.expression ? !row.value.trim() : row.value === '';
                return (
                    <div
                        key={row.name}
                        role="group"
                        aria-label={`argument ${row.name}`}
                        className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-1.5"
                    >
                        <div className="grid min-h-8 min-w-0 content-center">
                            <span className="truncate font-mono text-sm" title={row.name}>
                                {param.rest ? '...' : ''}
                                {row.name}
                            </span>
                            <span className="truncate text-xs text-muted-foreground" title={param.type || 'any'}>
                                {param.type || 'any'}
                                {!param.optional && (
                                    <>
                                        {' · '}
                                        <span
                                            className={empty ? 'text-destructive' : undefined}
                                            title={empty ? 'Required: give it a value' : 'Required'}
                                        >
                                            required
                                        </span>
                                    </>
                                )}
                            </span>
                        </div>
                        {renderValue(`${id}-${index}`, row, param.optional ? 'optional' : '', value => set(row.name, value))}
                    </div>
                );
            })}
        </fieldset>
    );
}
