import type { TriggersOn } from '@/data/flows/project-tree';

const names = (list: string[]) => (list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`);

/** "These will be turned off": the deployed flows, the schedules and the webhooks on among what is archived or deleted */
export function TriggersWarning({ on }: { on: TriggersOn }) {
    return (
        <div className="grid gap-1">
            <p className="font-medium">These will be turned off:</p>
            <ul className="list-disc pl-5">
                {on.deployed.length > 0 && <li>Deploy: {names(on.deployed)}</li>}
                {on.schedules.length > 0 && <li>Schedules: {names(on.schedules)}</li>}
                {on.webhooks.length > 0 && <li>Webhooks: {names(on.webhooks)}</li>}
            </ul>
            <p className="text-xs opacity-80">Restoring does not turn them back on.</p>
        </div>
    );
}
