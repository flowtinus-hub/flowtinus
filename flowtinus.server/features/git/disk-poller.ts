import { fingerprint } from '@flowtinus/core/disk';
import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import type { Logger } from '#shared/logging/logger';
import { reconcileDisk } from './disk-reconcile';
import type { GitOptions } from './git-config';

export const SETTLE_MS = 1000;

export type DiskTick = 'settling' | 'unchanged' | 'reconciled' | 'busy';

// a scan, not a file watcher: their events often do not cross a bind mount from Windows or macOS
export class DiskPoller {
    private seen: { fingerprint: string; since: number } | null = null;
    private reconciled: string | null = null;
    private running: Promise<void> | null = null;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly db: Database,
        private readonly git: GitOptions,
        private readonly root: string,
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

    async idle(): Promise<void> {
        await this.running;
    }

    async tick(): Promise<DiskTick> {
        if (this.running) {
            return 'busy';
        }

        let current: string;
        try {
            current = fingerprint(this.root);
        } catch (e) {
            this.logger?.error('the local repository could not be read', { error: e instanceof Error ? e.message : String(e) });
            return 'unchanged';
        }
        if (current !== this.seen?.fingerprint) {
            this.seen = { fingerprint: current, since: this.now() };
            return 'settling';
        }
        if (current === this.reconciled) {
            return 'unchanged';
        }
        if (this.now() - this.seen.since < SETTLE_MS) {
            return 'settling';
        }

        this.reconciled = current;
        this.running = this.reconcile().finally(() => (this.running = null));
        await this.running;
        return 'reconciled';
    }

    private async reconcile(): Promise<void> {
        try {
            for (const result of await reconcileDisk({ db: this.db, keyring: this.keyring, git: this.git }, this.root)) {
                if (result.outcome === 'refused' || result.outcome === 'not-a-handle') {
                    this.logger?.warn(`the disk's workspace ${result.handle} is ${result.outcome}`, { workspace: result.handle });
                }
            }
        } catch (e) {
            this.logger?.error('the disk reconcile failed', { error: e instanceof Error ? e.message : String(e) });
        }
    }
}
