import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import type { Logger } from '#shared/logging/logger';
import { DEFAULT_POLL_SECONDS, GIT_SETTING, type GitOptions } from './git-config';
import { recordPoll } from './git-poll-state';
import { onWorkspaceRepository } from './git-handlers';
import { reconcile } from './reconcile';

/** at most one fetch a webhook brings forward per workspace in this time; more calls are absorbed */
export const HOOK_INTERVAL_MS = 5000;

/**
 * Each workspace with git on is fetched on its interval (the `git` setting's pollSeconds) and a new tip of its
 * environment's branch reconciled; the topology is read again at each fetch, so a moved branch is followed. A webhook
 * brings the fetch forward. In the server only: the reconcile's advisory lock keeps one at a time per workspace.
 */
export class GitPoller {
    private readonly polled = new Map<string, number>();
    private readonly hooked = new Map<string, number>();
    private readonly running = new Map<string, Promise<void>>();
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly db: Database,
        private readonly git: GitOptions,
        private readonly keyring?: Keyring,
        private readonly logger?: Logger,
        private readonly now = () => Date.now(),
    ) {}

    start(tickMs = 1000): void {
        this.timer ??= setInterval(() => void this.tick(), tickMs);
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** the workspaces whose interval has passed are fetched (all of them with `due` false) */
    async tick(due = true): Promise<void> {
        const rows = await this.db.query<{ workspace_id: string; value: { on?: boolean; pollSeconds?: number } }>(
            'SELECT workspace_id, value FROM workspace_settings WHERE key = $1',
            [GIT_SETTING],
        );
        await Promise.all(
            rows
                .filter(r => r.value.on)
                .filter(
                    r =>
                        !due || this.now() - (this.polled.get(r.workspace_id) ?? 0) >= (r.value.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1000,
                )
                .map(r => this.poll(r.workspace_id)),
        );
    }

    /** a webhook's call: the fetch now, unless one was brought forward in the last 5 s */
    bringForward(workspaceId: string): 'fetching' | 'absorbed' {
        if (this.now() - (this.hooked.get(workspaceId) ?? -HOOK_INTERVAL_MS) < HOOK_INTERVAL_MS) {
            return 'absorbed';
        }
        this.hooked.set(workspaceId, this.now());
        void this.poll(workspaceId);
        return 'fetching';
    }

    /** the fetches running now are done */
    async idle(): Promise<void> {
        while (this.running.size > 0) {
            await Promise.all(this.running.values());
        }
    }

    poll(workspaceId: string): Promise<void> {
        const running = this.running.get(workspaceId);
        if (running) {
            return running;
        }

        this.polled.set(workspaceId, this.now());
        const done = this.reconcile(workspaceId).finally(() => this.running.delete(workspaceId));
        this.running.set(workspaceId, done);
        return done;
    }

    private async reconcile(workspaceId: string): Promise<void> {
        const ctx = { db: this.db, workspaceId, userId: 'git', keyring: this.keyring, git: this.git };
        try {
            const result = await onWorkspaceRepository(ctx, this.git, (remote, config) => reconcile(ctx, remote, config));
            // another reconcile of the workspace running is no reason to say anything
            if (!result.ok && result.error.message === 'A reconcile of this workspace is already running.') {
                return;
            }
            await recordPoll(this.db, workspaceId, new Date(this.now()), result.ok ? undefined : result.error.message);
            if (!result.ok) {
                this.logger?.warn(`git poll of ${workspaceId}: ${result.error.message}`, { workspaceId });
            }
        } catch (e) {
            this.logger?.error(`git poll of ${workspaceId} failed`, { workspaceId, error: e instanceof Error ? e.message : String(e) });
        }
    }
}
