export type DetectedServer = { engine: string; version: string };
export type ConnectionServer = DetectedServer & { testedAt: string };
const EXPECTED: Record<string, string> = { redshift: 'Redshift', sqlserver: 'SQL Server', mongodb: 'MongoDB' };

export function serverOfVersion(text: string): DetectedServer | null {
    const found = (engine: string, pattern: RegExp) => {
        const match = pattern.exec(text);
        return match ? { engine, version: match[1] ?? '' } : null;
    };
    return (
        found('Redshift', /\bRedshift\s+([\d.]+)/i) ??
        found('PostgreSQL', /\bPostgreSQL\s+([\d.]+\w*)/i) ??
        found('SQL Server', /\bSQL Server\s+([\d.]+)/i) ??
        found('MongoDB', /\bMongoDB\s+([\d.]+)/i)
    );
}

export function connectionServerWarning(type: string, server: DetectedServer | null | undefined): string | null {
    const expected = EXPECTED[type];
    if (!server || !expected || server.engine === expected) {
        return null;
    }
    const answered = `${server.engine}${server.version ? ` ${server.version}` : ''}`;
    if (type === 'redshift' && server.engine === 'PostgreSQL') {
        return `This Redshift connection answers as ${answered}, not Amazon Redshift: SQL written for Redshift (JSON_PARSE, GETDATE()...) may not run on it, nor SQL written for it (payload::json->>'x', PostgreSQL ${server.version.split('.')[0]} functions) on a real Redshift.`;
    }
    return `This ${expected} connection answers as ${answered}: SQL written for one may not run on the other.`;
}
