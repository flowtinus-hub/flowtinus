import { Wifi, WifiOff } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useServerConnection, type ServerConnection } from '@/lib/server-connection';

function label(connection: ServerConnection): string {
    if (connection.state === 'checking') {
        return 'Checking the server...';
    }

    if (connection.state === 'offline') {
        return 'Server unreachable, retrying';
    }

    return connection.environment ? `Connected to the server (${connection.environment})` : 'Connected to the server';
}

const badge: Record<ServerConnection['state'], { text: string; className: string }> = {
    checking: { text: 'checking', className: 'bg-muted text-muted-foreground' },
    online: { text: 'live', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
    offline: { text: 'offline', className: 'bg-red-500/10 text-red-700 dark:text-red-400' },
};

/** A green 'live' pill while flowtinus.server answers, a red 'offline' one when it stops answering (gray during the first check). */
export function ConnectionStatus() {
    const connection = useServerConnection();
    const Icon = connection.state === 'offline' ? WifiOff : Wifi;
    const text = label(connection);
    const { text: short, className } = badge[connection.state];

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span
                    role="status"
                    aria-label={text}
                    className={cn('flex h-7 items-center gap-1.5 rounded-full px-2.5 font-mono text-xs font-medium', className)}
                >
                    <Icon className="size-3.5" />
                    {short}
                </span>
            </TooltipTrigger>
            <TooltipContent>{text}</TooltipContent>
        </Tooltip>
    );
}
