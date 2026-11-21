import { useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { getChanges, requiredBy, type WorkingChange } from '@/data/git/git-api';

/**
 * What a flow's Commit takes, as the server builds it: the flow's file and every change it needs (the changed scripts it
 * imports, a new project, a new flow it calls, a new connection), each with why; none of them can be left out.
 */
export function CommitFiles({ workspace, flowId, scripts }: { workspace: string; flowId: string; scripts: string[] }) {
    const [changes, setChanges] = useState<WorkingChange[] | null>(null);
    useEffect(() => {
        let gone = false;
        void getChanges(workspace).then(result => !gone && setChanges(result.ok ? result.value.changes : []));
        return () => {
            gone = true;
        };
    }, [workspace]);

    const own = changes?.find(c => c.fileId === flowId) ?? null;
    const locked = useMemo(() => (own ? requiredBy(changes ?? [], new Set([own.path])) : new Map<string, string>()), [changes, own]);
    if (changes === null) {
        return null;
    }
    const files = own
        ? [{ path: own.path, reason: null as string | null }, ...[...locked].map(([path, reason]) => ({ path, reason }))]
        : scripts.map(path => ({ path: `${path}.ts`, reason: 'It imports the script' as string | null }));
    if (files.length <= 1 && !scripts.length) {
        return null;
    }
    return (
        <div className="grid gap-1 text-sm">
            <span className="text-muted-foreground">In this commit:</span>
            <ul className="grid gap-1">
                {files.map(file => (
                    <li key={file.path} className="grid min-w-0">
                        <span className="truncate font-mono text-xs" title={file.path}>
                            {file.path.startsWith(`${workspace}/`) ? file.path.slice(workspace.length + 1) : file.path}
                        </span>
                        {file.reason && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Lock className="size-3 shrink-0" />
                                {file.reason}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
