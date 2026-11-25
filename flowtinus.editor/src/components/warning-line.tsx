import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

export function WarningLine({ children }: { children: ReactNode }) {
    return (
        <p className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {children}
        </p>
    );
}
