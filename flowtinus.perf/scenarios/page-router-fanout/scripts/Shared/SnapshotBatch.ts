type Snapshot = Record<string, unknown> & { OriginalId: string };

/** a page's snapshots, the latest version of each (a later one replaces an earlier one with the same OriginalId) */
export function latestSnapshots(snapshots: Record<string, unknown>[]): Snapshot[] {
    if (!Array.isArray(snapshots)) {
        throw new Error('snapshots must be an array');
    }
    const latest = new Map<string, Snapshot>();
    for (const snapshot of snapshots) {
        if (!snapshot || typeof snapshot.OriginalId !== 'string' || !snapshot.OriginalId) {
            throw new Error('Every snapshot must have a string OriginalId');
        }
        latest.set(snapshot.OriginalId, { ...snapshot, OriginalId: snapshot.OriginalId });
    }
    return Array.from(latest.values());
}
