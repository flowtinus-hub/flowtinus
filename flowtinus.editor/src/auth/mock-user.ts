/*
 * There is no authentication yet: the screens use this user until the server has login. Replace it (and logout)
 * with the real session when it exists.
 */

export type CurrentUser = {
    /** sent as X-User-Id */
    id: string;
    name: string;
    email: string;
};

export const mockUser: CurrentUser = {
    // the user the api creates on start in DEV (flowtinus.server/shared/database/seed-dev.ts: keep it the same)
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Dev',
    email: 'dev@example.com',
};

/** placeholder: there is no session to end yet */
export function logout(): void {
    console.info('logout: no authentication yet');
}

/** "Ana Silva" -> "AS" */
export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts;
    return letters.map(part => part[0]!.toUpperCase()).join('');
}
