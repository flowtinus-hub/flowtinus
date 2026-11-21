import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { LoaderCircle } from 'lucide-react';
import { SCRIPT_GLOBALS, scriptModuleUri } from '@flowtinus/core';
import { replaceScript, saveScript, useProjectScripts, useScriptContent } from '@/data/scripts/scripts-store';
import { useBranchOffer } from '@/layout/use-branch-offer';
import { ts, useScriptModels } from '@/editor/monaco-setup';

const isDark = () => document.documentElement.classList.contains('dark');

/**
 * A script's code in Monaco, on its own model (the one every editor of the project shares), so the other scripts and
 * the TypeScript components see it as it is typed. Its code loads when it is opened (and what it imports, then).
 */
export default function ScriptEditor({ projectId, path }: { projectId: string; path: string }) {
    const [dark, setDark] = useState(isDark);
    const content = useScriptContent(projectId, path);
    const importPath = useProjectScripts(projectId).scripts.find(s => s.path === path)?.importPath;
    const branchOffer = useBranchOffer();
    const editor = useRef<Parameters<OnMount>[0] | null>(null);
    useScriptModels(projectId);
    // a script runs in a TypeScript component: it sees the runner's globals too (log, $PARAMETERS...)
    useEffect(() => ts.typescriptDefaults.setExtraLibs([{ content: SCRIPT_GLOBALS, filePath: 'file:///flowtinus-globals.d.ts' }]), []);
    useEffect(() => {
        const observer = new MutationObserver(() => setDark(isDark()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    if (!content || !importPath) {
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
            </div>
        );
    }

    const change = (code: string) => {
        if (!branchOffer.offers) {
            saveScript(projectId, path, code);
            return;
        }
        if (code === content.code) {
            return;
        }
        branchOffer.offer(
            { name: path.split('/').at(-1)!, replay: () => replaceScript(projectId, path, editor.current?.getValue() ?? code) },
            () => editor.current?.setValue(content.code),
        );
    };

    return (
        <>
            <Editor
                language="typescript"
                path={scriptModuleUri(importPath)}
                value={content.code}
                theme={dark ? 'vs-dark' : 'light'}
                onMount={mounted => {
                    editor.current = mounted;
                }}
                onChange={next => change(next ?? '')}
                options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    tabSize: 2,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    fixedOverflowWidgets: true,
                    editContext: false,
                }}
            />
            {branchOffer.dialog}
        </>
    );
}
