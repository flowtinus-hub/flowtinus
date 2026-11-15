const routes: Record<string, { path: string; fields: string[] }[]> = {
    pages: [{ path: 'perf: list transformer', fields: ['Entities', 'Locations'] }],
};

export function transformerRoutes(collection: string): { path: string; fields: string[] }[] {
    if (!Object.prototype.hasOwnProperty.call(routes, collection)) {
        throw new Error(`Unknown transformer collection: ${collection}`);
    }
    return routes[collection]!;
}
