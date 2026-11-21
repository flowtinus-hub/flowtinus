export const HANDLE_MAX = 40;

export const HANDLE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export const slugOf = (name: string): string =>
    name
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

export const handleOf = (name: string): string => slugOf(name).slice(0, HANDLE_MAX).replace(/-+$/g, '');

export function handleHolder<T extends { name: string }>(name: string, others: T[]): T | undefined {
    const handle = handleOf(name);
    return others.find(other => handleOf(other.name) === handle);
}

export const handleTakenMessage = (name: string, holder: { name: string; archived?: boolean; workspace?: string }) =>
    `The handle "${handleOf(name)}" is taken by the ${holder.archived ? 'archived ' : ''}project "${holder.name}"` +
    `${holder.workspace === undefined ? '' : ` in "${holder.workspace}"`}.`;
