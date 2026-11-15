const MAX_CAUSES = 10;

export function errorOrigins(error: unknown): string[] {
    const found: string[] = [];
    const add = (name: unknown) => {
        if (typeof name === 'string' && name.trim() && found.at(-1) !== name) {
            found.push(name);
        }
    };
    let cause = (error as { cause?: unknown } | null | undefined)?.cause;
    for (let i = 0; i < MAX_CAUSES && cause !== null && typeof cause === 'object'; i++) {
        const c = cause as { component?: unknown; origin?: unknown; cause?: unknown };
        add(c.component);
        add(c.origin);
        cause = c.cause;
    }
    return found;
}

export const errorOrigin = (error: unknown): string | undefined => errorOrigins(error).at(-1);

export function errorWithOrigin(label: string, error: Error): string {
    const chain = [label, ...errorOrigins(error).filter((name, i) => i > 0 || name !== label)];
    return `${chain.map(name => `"${name}"`).join(' ← ')}: ${error.message}`;
}

export function messageWithOrigin(error: Error): string {
    const origins = errorOrigins(error);
    return origins.length ? `${error.message} (from ${origins.map(name => `"${name}"`).join(' ← ')})` : error.message;
}

export function rethrow(error: unknown): void {
    if (error === null || error === undefined) {
        return;
    }
    if (error instanceof Error) {
        throw error;
    }
    if (typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
        const entry = error as { error?: unknown; message: string };
        const thrown = new Error(entry.message, { cause: error });
        if (typeof entry.error === 'string' && entry.error) {
            thrown.name = entry.error;
        }
        throw thrown;
    }
    throw new Error(String(error));
}
