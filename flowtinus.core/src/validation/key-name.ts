export const RESERVED_NAMES = ['FLOW_CURRENT_RUN', 'PARAMETERS', 'SECRETS', 'VARIABLES', 'DATA'];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function nameIssue(name: string): string | null {
    if (!name) {
        return 'has no name';
    }
    if (!IDENTIFIER.test(name)) {
        return `"${name}" is not a valid name (letters, digits and _, not starting with a digit)`;
    }
    if (RESERVED_NAMES.includes(name)) {
        return `"${name}" is a reserved name`;
    }
    return null;
}
