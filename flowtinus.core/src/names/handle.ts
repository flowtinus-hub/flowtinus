export const HANDLE_MAX = 40;

/** lowercase letters, digits and hyphens, 1 to 40, not starting or ending with a hyphen */
export const HANDLE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** "Vendás BR (Norte)" → "vendas-br-norte"; empty when the name has no letter or digit of a-z, 0-9 */
export const handleOf = (name: string): string =>
    name
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, HANDLE_MAX)
        .replace(/-+$/g, '');

/** the project among `others` whose name makes the same handle as `name` */
export function handleHolder<T extends { name: string }>(name: string, others: T[]): T | undefined {
    const handle = handleOf(name);
    return others.find(other => handleOf(other.name) === handle);
}

export const handleTakenMessage = (name: string, holder: { name: string; archived?: boolean; workspace?: string }) =>
    `The handle "${handleOf(name)}" is taken by the ${holder.archived ? 'archived ' : ''}project "${holder.name}"` +
    `${holder.workspace === undefined ? '' : ` in "${holder.workspace}"`}.`;
