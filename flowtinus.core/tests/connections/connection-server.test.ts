import { expect, test } from 'bun:test';
import { connectionServerWarning, serverOfVersion } from '../../src/index';

test("a test's version text: Redshift before PostgreSQL (its version() starts with PostgreSQL 8.0.2), SQL Server, MongoDB", () => {
    expect(
        serverOfVersion(
            'PostgreSQL 8.0.2 on i686-pc-linux-gnu, compiled by GCC gcc (GCC) 3.4.2 20041017 (Red Hat 3.4.2-6.fc3), Redshift 1.0.12103',
        ),
    ).toEqual({ engine: 'Redshift', version: '1.0.12103' });
    expect(serverOfVersion('Redshift 1.0.77467')).toEqual({ engine: 'Redshift', version: '1.0.77467' });
    expect(serverOfVersion('PostgreSQL 18.0 (Debian 18.0-1.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc')).toEqual({
        engine: 'PostgreSQL',
        version: '18.0',
    });
    expect(serverOfVersion('PostgreSQL 17beta1')).toEqual({ engine: 'PostgreSQL', version: '17beta1' });
    expect(serverOfVersion('SQL Server 16.0.4135.4')).toEqual({ engine: 'SQL Server', version: '16.0.4135.4' });
    expect(serverOfVersion('MongoDB 8.0.4')).toEqual({ engine: 'MongoDB', version: '8.0.4' });
    expect(serverOfVersion('Got a token from https://auth.example.com, valid for 60 min.')).toBeNull();
});

test('a warning when the server answers as another engine than its type: a Redshift that is a PostgreSQL; none when it matches', () => {
    const postgres = { engine: 'PostgreSQL', version: '18.0' };
    expect(connectionServerWarning('redshift', postgres)).toBe(
        "This Redshift connection answers as PostgreSQL 18.0, not Amazon Redshift: SQL written for Redshift (JSON_PARSE, GETDATE()...) may not run on it, nor SQL written for it (payload::json->>'x', PostgreSQL 18 functions) on a real Redshift.",
    );
    expect(connectionServerWarning('redshift', { engine: 'Redshift', version: '1.0.12103' })).toBeNull();
    expect(connectionServerWarning('sqlserver', { engine: 'SQL Server', version: '16.0' })).toBeNull();
    expect(connectionServerWarning('sqlserver', postgres)).toBe(
        'This SQL Server connection answers as PostgreSQL 18.0: SQL written for one may not run on the other.',
    );
    expect(connectionServerWarning('redshift', null)).toBeNull();
    expect(connectionServerWarning('rest-oauth2', postgres)).toBeNull();
});
