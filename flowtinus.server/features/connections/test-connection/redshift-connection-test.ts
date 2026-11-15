import { TEST_TIMEOUT_MS, type ConnectionTest, type ConnectionTestInput } from './connection-test';

export class RedshiftConnectionTest implements ConnectionTest {
    constructor(private readonly timeoutMs = TEST_TIMEOUT_MS) {}

    async test({ config, secrets }: ConnectionTestInput): Promise<string> {
        const { default: pg } = await import('pg');
        const client = new pg.Client({
            host: config.host,
            port: Number(config.port || '5439'),
            database: config.database,
            user: config.user,
            password: secrets.password,
            ssl: config.ssl === 'off' ? false : { rejectUnauthorized: true },
            connectionTimeoutMillis: this.timeoutMs,
            query_timeout: this.timeoutMs,
            application_name: 'flowtinus',
        });
        try {
            await client.connect();
            const result = await client.query<{ version: string }>('SELECT version() AS version');
            const version = result.rows[0]?.version ?? '';
            return /redshift/i.test(version)
                ? `Redshift ${/Redshift ([\d.]+)/i.exec(version)?.[1] ?? ''}`.trim()
                : version.split(' on ')[0] || 'Redshift';
        } finally {
            await client.end().catch(() => undefined);
        }
    }
}
