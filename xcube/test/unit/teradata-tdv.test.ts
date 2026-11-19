/**
 * Teradata and TIBCO Data Virtualization as data sources, without a server
 * or a JVM (wechart's db_support, after Db2): their URLs and properties
 * (R3), the SQL runner's check for their dialects (R6), parameters and
 * sessions (R5, R7), their types as Cube resolves them, and the SQL xcube's
 * dialects compile (R8), as text. No server of either runs here (none is
 * reachable: Teradata's is a VM behind a registration, TDV's a licensed
 * build); every test that needs one is reported as not run.
 */
import { prepareCompiler } from '@cubejs-backend/schema-compiler';
import { CubejsServerCore } from '@cubejs-backend/server-core';

import { DRIVERS, driverAvailability } from '../../src/connections/drivers';
import { JdbcDriver, JdbcError } from '../../src/connections/jdbc';
import { JDBC_TYPES, readJdbcDrivers, resetJdbcDrivers } from '../../src/connections/jvm';
import {
  TDV_DIALECT, tdvInline, tdvTarget,
} from '../../src/connections/tdv';
import {
  TERADATA_DIALECT, teradataInline, teradataLiteral, teradataTarget,
} from '../../src/connections/teradata';
import { dialectFactory } from '../../src/model/dialects';
import { XcubeTdvQuery } from '../../src/model/tdv-dialect';
import { XcubeTeradataQuery } from '../../src/model/teradata-dialect';
import { classifySql, SqlRefusal, type SqlDialect } from '../../src/sql/classify';
import { exportStatement } from '../../src/sql/export';
import { bindParameters, DIALECT_NAMES, MAX_BOUND } from '../../src/sql/parameters';
import { isTimeout, openSession } from '../../src/sql/runner';

/** The refusal's code, its statement kind and what it named, or `ok` and the kind. */
const verdictOn = (dialect: SqlDialect) => (sql: string): string => {
  try {
    return `ok:${classifySql(sql, dialect).statement}`;
  } catch (e) {
    if (e instanceof SqlRefusal) {
      return `${e.code}:${e.statement ?? '-'}${e.refused ? `:${e.refused.kind}:${e.refused.name}` : ''}`;
    }
    throw e;
  }
};

describe('their jars (R2)', () => {
  afterEach(() => resetJdbcDrivers());

  test('each its own directory and driver class; unavailable without its jar', () => {
    expect(JDBC_TYPES.teradata).toEqual({ dir: 'teradata', driverClass: 'com.teradata.jdbc.TeraDriver' });
    expect(JDBC_TYPES.tdv).toEqual({ dir: 'tdv', driverClass: 'cs.jdbc.driver.CompositeDriver' });
    resetJdbcDrivers(readJdbcDrivers(undefined));
    for (const type of ['teradata', 'tdv']) {
      expect(driverAvailability()).toContainEqual({
        type, available: false, reason: `No driver jar is mounted for ${type}: this deployment sets no XCUBE_JDBC_DRIVERS_DIR`,
      });
    }
  });
});

describe('Teradata\'s connection (R3)', () => {
  const spec = DRIVERS.teradata;
  const base = { host: 'td.example', user: 'ana' };

  test('its fields, method and target', () => {
    expect(spec.cubeType).toBe('teradata');
    expect(spec.connection.map((f) => f.key)).toEqual(['host', 'port', 'database', 'logmech', 'ssl', 'sslRejectUnauthorized', 'sslCa']);
    expect(Object.keys(spec.auth)).toEqual(['password']);
    expect(spec.target).toEqual(['host', 'port', 'logmech', 'ssl', 'sslRejectUnauthorized', 'sslCa']);
  });

  test('its config: TLS checked by default on 443, 1025 without, TD2 unless LDAP', () => {
    expect(spec.config({ ...base, database: 'SALES' }, 'password', { password: 'p' })).toEqual({
      host: 'td.example', port: 443, database: 'SALES', logmech: 'TD2', user: 'ana', password: 'p', ssl: { rejectUnauthorized: true, ca: undefined }, readOnly: true,
    });
    expect(spec.config({ ...base, ssl: false, logmech: 'LDAP' }, 'password', { password: 'p' })).toMatchObject({ port: 1025, logmech: 'LDAP', ssl: false });
  });

  test('the URL is xcube\'s list of parameters alone; the user and password are properties (R3 test 2)', () => {
    const config = { host: 'td.example', port: 443, database: 'SALES', logmech: 'LDAP' as const, user: 'ana', password: 'p,w=1' };
    expect(teradataTarget({ ...config, ssl: { rejectUnauthorized: true, ca: 'pem' } }, '/tmp/xcube-teradata-x/ca.pem')).toEqual({
      type: 'teradata',
      url: 'jdbc:teradata://td.example/DATABASE=SALES,LOGMECH=LDAP,TMODE=ANSI,CHARSET=UTF8,LOGON_TIMEOUT=30,STRICT_NAMES=ON,'
        + 'HTTPS_PORT=443,SSLMODE=VERIFY-FULL,SSLCA=/tmp/xcube-teradata-x/ca.pem',
      properties: { user: 'ana', password: 'p,w=1' },
    });
    expect(teradataTarget({ ...config, ssl: { rejectUnauthorized: false } }, null).url).toMatch(/,HTTPS_PORT=443,SSLMODE=REQUIRE$/);
    expect(teradataTarget({ ...config, port: 1025, database: undefined, ssl: false }, null).url)
      .toBe('jdbc:teradata://td.example/LOGMECH=LDAP,TMODE=ANSI,CHARSET=UTF8,LOGON_TIMEOUT=30,STRICT_NAMES=ON,DBS_PORT=1025,SSLMODE=DISABLE,ENCRYPTDATA=ON');
    expect(() => teradataTarget({ ...config, logmech: 'JWT' as any, ssl: false }, null)).toThrow(/logmech must be one of TD2, LDAP/);
  });

  test('a value that could add a parameter is refused before anything connects (R3 test 3)', () => {
    for (const database of ['x,LOGMECH=JWT', 'x;AuthMech=0', 'x:traceFile=/tmp/a;', 'a\'b', 'a b']) {
      expect(() => spec.config({ ...base, database }, 'password', { password: 'p' })).toThrow(/database can't hold/);
    }
    expect(() => spec.config({ ...base, logmech: 'KRB5' }, 'password', { password: 'p' })).toThrow(/logmech must be one of/);
    expect(() => spec.config({ ...base, host: 'td.example/DBS_PORT=1' }, 'password', { password: 'p' })).toThrow(/host must be/);
  });
});

describe('TDV\'s connection (R3)', () => {
  const spec = DRIVERS.tdv;
  const base = { host: 'tdv.example', dataSource: 'sales', user: 'ana' };

  test('its fields, method and target: its CA is the deployment\'s, never a field', () => {
    expect(spec.cubeType).toBe('tdv');
    expect(spec.connection.map((f) => f.key)).toEqual(['host', 'port', 'domain', 'dataSource', 'ssl', 'sslRejectUnauthorized']);
    expect(spec.target).toEqual(['host', 'port', 'domain', 'ssl', 'sslRejectUnauthorized']);
  });

  test('its config: port 9401, the composite domain, TLS checked by default; the published data source survives Cube\'s own `dataSource`', () => {
    const config = { ...spec.config(base, 'password', { password: 'p' }), dataSource: 'conn_x' };
    expect(tdvTarget(config as any).url).toContain('&dataSource=sales&');
    expect(spec.config(base, 'password', { password: 'p' })).toEqual({
      host: 'tdv.example', port: 9401, domain: 'composite', publishedDataSource: 'sales', user: 'ana', password: 'p', ssl: { rejectUnauthorized: true }, readOnly: true,
    });
  });

  test('the URL is xcube\'s list of properties alone; the user and password are properties (R3 test 2)', () => {
    const config = { host: 'tdv.example', port: 9401, domain: 'composite', publishedDataSource: 'sales', user: 'ana', password: 'p&w=1' };
    expect(tdvTarget({ ...config, ssl: { rejectUnauthorized: true } })).toEqual({
      type: 'tdv',
      url: 'jdbc:compositesw:dbapi@tdv.example:9401?domain=composite&dataSource=sales&encrypt=true&validateRemoteCert=true'
        + '&validateRemoteHostname=true&connectTimeout=30&requestTimeout=600000',
      properties: { user: 'ana', password: 'p&w=1' },
    });
    expect(tdvTarget({ ...config, ssl: false, queryTimeout: 30 }).url).toBe('jdbc:compositesw:dbapi@tdv.example:9401?domain=composite&dataSource=sales'
      + '&encrypt=false&validateRemoteCert=false&validateRemoteHostname=false&connectTimeout=30&requestTimeout=30000');
  });

  test('a domain or data source that could add a property is refused before anything connects (R3 test 3)', () => {
    expect(() => spec.config({ ...base, domain: 'a&traceFolder=/tmp' }, 'password', { password: 'p' })).toThrow(/domain can't hold/);
    for (const dataSource of ['s?x=1', 's@h', 's/x', 's=1', 's x']) {
      expect(() => spec.config({ ...base, dataSource }, 'password', { password: 'p' })).toThrow(/dataSource can't hold/);
    }
  });
});

describe('their values in Cube\'s SQL', () => {
  test('a quote doubled, a `?` outside strings and comments taken; Teradata\'s booleans as 1 and 0', () => {
    expect(teradataInline('SELECT ? AS a, \'?\' AS b /* ? */ WHERE c = ? AND d = ?', ['it\'s', true, -3])).toBe('SELECT \'it\'\'s\' AS a, \'?\' AS b /* ? */ WHERE c = 1 AND d = (-3)');
    expect(teradataLiteral('back\\slash')).toBe('\'back\\slash\'');
    expect(tdvInline('SELECT ? WHERE b = ?', ['x', false])).toBe('SELECT \'x\' WHERE b = FALSE');
  });

  test('Teradata\'s catalog: the X views (what the user may access), the system\'s databases out, its type codes named', () => {
    expect(TERADATA_DIALECT.catalogSql!()).toMatch(/FROM DBC\.ColumnsVX c JOIN DBC\.TablesVX t/);
    expect(TERADATA_DIALECT.catalogSql!()).toContain('WHEN \'CV\' THEN \'VARCHAR\'');
    expect(TERADATA_DIALECT.tablesSql!('O\'Brien')).toContain('DatabaseName = \'O\'\'Brien\'');
    expect(TDV_DIALECT.metadata).toBe(true);
  });

  test('TDV\'s catalog through DatabaseMetaData: a published catalog is part of each schema\'s name', async () => {
    class Read extends JdbcDriver {
      public override metadata(what: string): Promise<(string | null)[][]> {
        return Promise.resolve({
          schemas: [['shop', 'sales'], ['shop', 'hr']],
          tables: [['shop', 'sales', 'orders', 'TABLE']],
          columns: [['shop', 'sales', 'orders', 'id', 'INTEGER'], ['shop', 'sales', 'orders', 'at', 'TIMESTAMP']],
        }[what as 'schemas']);
      }
    }
    const driver = new Read({ ...tdvTarget({ host: 'h', port: 9401, domain: 'composite', publishedDataSource: 'd', ssl: false }), readOnly: false }, TDV_DIALECT);
    expect(await driver.getSchemas()).toEqual([{ schema_name: 'shop.sales' }, { schema_name: 'shop.hr' }]);
    expect(await driver.getTablesForSpecificSchemas([{ schema_name: 'shop.sales' }])).toEqual([{ schema_name: 'shop.sales', table_name: 'orders', table_type: 'TABLE' }]);
    expect(await driver.tablesSchema()).toEqual({
      'shop.sales': { orders: [{ name: 'id', type: 'integer', attributes: [] }, { name: 'at', type: 'timestamp', attributes: [] }] },
    });
    await driver.release();
  });
});

describe('the SQL runner\'s check: Teradata (R6)', () => {
  const verdict = verdictOn('teradata');

  test('reads', () => {
    for (const sql of [
      'SELECT 1',
      'SEL a FROM t',
      'SELECT TOP 10 a FROM "S"."T" ORDER BY 1',
      'SELECT \'it\'\'s; DELETE FROM t\', \'00FF\'XB, U&\'\\0041\'',
      'LOCKING ROW FOR ACCESS SELECT a FROM t',
      'LOCK TABLE t FOR READ SELECT a FROM t',
      'SELECT a FROM t QUALIFY ROW_NUMBER() OVER (ORDER BY a) <= 5',
      'WITH q (a) AS (SELECT 1) SELECT a FROM q',
      'SELECT \'name@server\', \'AND CONSUME\'',
    ]) {
      expect([sql, verdict(sql)]).toEqual([sql, 'ok:select']);
    }
    expect(verdict('EXPLAIN SELECT a FROM t')).toBe('ok:explain');
  });

  test('R6\'s statements, each refused for its reason', () => {
    for (const [sql, expected] of [
      ['SELECT AND CONSUME TOP 1 * FROM q', 'not_read_only:select'],
      ['SELECT * FROM WRITE_NOS (ON (SELECT 1) USING LOCATION(\'/s3/b/x\')) AS d', 'not_read_only:select:function:write_nos'],
      ['SELECT * FROM READ_NOS (USING LOCATION(\'/s3/b/x\')) AS d', 'not_read_only:select:function:read_nos'],
      ['SELECT * FROM SCRIPT (ON t SCRIPT_COMMAND(\'rm -rf /\')) AS d', 'not_read_only:select:function:script'],
      ['SELECT * FROM FOREIGN TABLE (SELECT 1)@remote AS f', 'not_read_only:select:clause:FOREIGN TABLE'],
      ['SELECT * FROM sales@remote', 'not_read_only:select:clause:@'],
      ['LOCKING TABLE t FOR WRITE SELECT * FROM t', 'not_read_only:select'],
      ['LOCKING TABLE t FOR EXCLUSIVE SELECT * FROM t', 'not_read_only:select'],
      ['LOCKING TABLE t FOR ACCESS UPDATE t SET a = 1', 'not_read_only:select'],
      ['SELECT 1; DELETE FROM t', 'several_statements:-'],
      ['EXEC my_macro', 'not_read_only:exec'],
      ['CALL p()', 'not_read_only:call'],
      ['SELECT a FROM t WHERE EXISTS (DEL FROM u)', 'not_read_only:select'],
      ['INS INTO t VALUES (1)', 'not_read_only:ins'],
    ]) {
      expect([sql, verdict(sql)]).toEqual([sql, expected]);
    }
  });
});

describe('the SQL runner\'s check: TDV (R6)', () => {
  const verdict = verdictOn('tdv');

  test('reads', () => {
    for (const sql of [
      'SELECT 1',
      'SELECT a FROM "shop"."sales"."orders" o JOIN /shared/x/y z ON o.a = z.a',
      'SELECT TOP 5 a FROM t',
      'SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
      'SELECT a FROM (SELECT a FROM t) s',
      'SELECT a FROM t WHERE b IN (SELECT b FROM u) AND f(a) > 1',
      'SELECT \'{OPTION}\', \'p(1)\' FROM t',
    ]) {
      expect([sql, verdict(sql)]).toEqual([sql, 'ok:select']);
    }
  });

  test('R6\'s statements, each refused for its reason', () => {
    for (const [sql, expected] of [
      ['SELECT * FROM proc(1) p', 'not_read_only:select:function:proc'],
      ['SELECT * FROM t, /shared/procs/loader(2) p', 'not_read_only:select:function:loader'],
      ['SELECT * FROM t JOIN "shop".proc(1) p ON 1 = 1', 'not_read_only:select:function:proc'],
      ['SELECT {OPTION MAX_ROWS_LIMIT=1} * FROM t', 'not_read_only:select:clause:{'],
      ['SELECT {fn NOW()} FROM t', 'not_read_only:select:clause:{'],
      ['CALL p(1)', 'not_read_only:call'],
      ['EXPLAIN SELECT 1', 'not_read_only:explain'],
      ['SELECT 1; DELETE FROM t', 'several_statements:-'],
    ]) {
      expect([sql, verdict(sql)]).toEqual([sql, expected]);
    }
  });
});

describe('their parameters (R5, R7)', () => {
  test('Teradata: `?` typed in the SQL, the date and time with a space; TDV: typed, a boolean too', () => {
    const parameters = {
      t: { type: 'text' as const, value: 'x' },
      n: { type: 'number' as const, value: '1.25' },
      d: { type: 'date' as const, value: '2026-02-28' },
      at: { type: 'datetime' as const, value: '2026-03-08T02:30:00' },
    };
    const sql = 'SELECT {{t}}, {{n}}, {{d}}, {{at}}';
    expect(bindParameters(sql, 'teradata', parameters).sql)
      .toBe('SELECT  ? ,  CAST(? AS DECIMAL(38, 2)) ,  CAST(? AS DATE FORMAT \'YYYY-MM-DD\') ,  CAST(? AS TIMESTAMP(6)) ');
    expect(bindParameters(sql, 'teradata', parameters).binds.map((b) => b.value)).toEqual(['x', '1.25', '2026-02-28', '2026-03-08 02:30:00.000000']);
    expect(bindParameters(`${sql}, {{b}}`, 'tdv', { ...parameters, b: { type: 'boolean', value: true } }).sql)
      .toBe('SELECT  ? ,  CAST(? AS DECIMAL(38, 2)) ,  CAST(? AS DATE) ,  CAST(? AS TIMESTAMP) ,  CAST(? AS BOOLEAN) ');
    expect([DIALECT_NAMES.teradata, DIALECT_NAMES.tdv, MAX_BOUND.teradata, MAX_BOUND.tdv])
      .toEqual(['Teradata', 'TDV', { total: 2048, list: 2048 }, { total: 10000, list: 10000 }]);
  });

  test('Teradata\'s session refuses a boolean (it has no BOOLEAN), and reads its timeouts', async () => {
    const driver = { openConnection: async () => ({ close: async () => undefined }), release: async () => undefined };
    const session = await openSession('teradata', driver, { maxRows: 1, timeoutMs: 1000, maxBytes: 1000 }, () => {
      throw new Error('refused');
    });
    expect(session.unbindable!([{ id: '1', type: 'boolean', value: true }])).toBe('Teradata has no Boolean type to bind one as');
    expect(session.unbindable!([{ id: '1', type: 'text', value: 'x' }])).toBeNull();
    const tdvSession = await openSession('tdv', driver, { maxRows: 1, timeoutMs: 1000, maxBytes: 1000 }, () => {
      throw new Error('refused');
    });
    expect(tdvSession.unbindable!([{ id: '1', type: 'boolean', value: true }])).toBeNull();
    const aborted = new JdbcError('[Error 3110] The transaction was aborted by the user.', 'query', '25000', 3110);
    expect(isTimeout('teradata', aborted, { ms: 9900, timeoutMs: 10000 })).toBe(true);
    expect(isTimeout('teradata', aborted, { ms: 1000, timeoutMs: 10000 })).toBe(false);
    expect(isTimeout('tdv', new JdbcError('Request timed out', 'query'), { ms: 10000, timeoutMs: 10000 })).toBe(true);
    expect(isTimeout('tdv', new JdbcError('x', 'timeout'))).toBe(true);
  });
});

describe('their types as Cube resolves them, and their export names (R7)', () => {
  test('Cube finds `teradata` and `tdv`, each with xcube\'s dialect', () => {
    for (const [type, Query] of [['teradata', XcubeTeradataQuery], ['tdv', XcubeTdvQuery]] as const) {
      const Found = CubejsServerCore.lookupDriverClass(type as any) as any;
      expect(Found.dialectClass()).toBe(Query);
      expect(() => new Found()).toThrow(/made from its connection/);
      expect(dialectFactory()({ dbType: type })).toBe(Query);
    }
  });

  test('double quotes; TDV\'s table in a published catalog has three parts; no other takes a catalog', () => {
    expect(exportStatement('teradata', { schema: 'Sales', table: 'my Table' })).toBe('SELECT * FROM "Sales"."my Table"');
    expect(exportStatement('tdv', { catalog: 'shop', schema: 'sales', table: 'Orders', columns: ['id'] })).toBe('SELECT "id" FROM "shop"."sales"."Orders"');
    expect(exportStatement('tdv', { schema: 'sales', table: 'Orders' })).toBe('SELECT * FROM "sales"."Orders"');
    expect(() => exportStatement('db2', { catalog: 'c', schema: 's', table: 't' })).toThrow(/TDV only/);
    expect(() => exportStatement('tdv', { catalog: 'a"b', table: 't' })).toThrow(/can't be a name/);
  });
});

describe('xcube\'s Teradata and TDV dialects (R8), as text', () => {
  let compiled: any;
  const planner = process.env.CUBEJS_TESSERACT_SQL_PLANNER;

  beforeAll(async () => {
    compiled = prepareCompiler({
      localPath: () => '/nowhere',
      dataSchemaFiles: async () => [{
        fileName: 'cubes/f.yml',
        content: `cubes:
  - name: f
    sql_table: SALES.FACTS
    dimensions:
      - { name: id, sql: ID, type: number, primary_key: true }
      - { name: at, sql: TS, type: time }
      - { name: name, sql: NAME, type: string }
    measures:
      - { name: total, sql: AMOUNT, type: sum }
      - { name: distinct, sql: NAME, type: count_distinct }
`,
      }],
    }, { standalone: true, allowNodeRequire: false });
    await compiled.compiler.compile();
  });

  afterAll(() => {
    if (planner === undefined) {
      delete process.env.CUBEJS_TESSERACT_SQL_PLANNER;
    } else {
      process.env.CUBEJS_TESSERACT_SQL_PLANNER = planner;
    }
  });

  const query = {
    measures: ['f.total', 'f.distinct'],
    dimensions: ['f.name'],
    timeDimensions: [{ dimension: 'f.at', granularity: 'quarter', dateRange: ['2026-01-01', '2026-12-31'] }],
    filters: [{ member: 'f.name', operator: 'contains', values: ['50%'] }],
    order: [{ id: 'f.total', desc: true }],
    rowLimit: 10,
  };
  const sqlOf = (Q: any, extra: Record<string, unknown>) => new Q(compiled, { timezone: 'UTC', ...query, ...extra }).buildSqlAndParams();

  test.each([['Tesseract', 'true'], ['the legacy planner', 'false']])('Teradata, %s: TOP, TRUNC as a timestamp, LIKE lowered, no LIMIT', (_planner, tesseract) => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = tesseract;
    const [sql, params] = sqlOf(XcubeTeradataQuery, {});
    expect(sql).toMatch(/^SELECT TOP 10\s/);
    expect(sql).toContain('CAST(TRUNC("f".TS, \'Q\') AS TIMESTAMP(0))');
    expect(sql).toMatch(/LOWER\("f"\.NAME\) LIKE LOWER\(.*\) ESCAPE '\\'/);
    expect(sql).toContain('CAST(OREPLACE(OREPLACE(?, \'T\', \' \'), \'Z\', \'\') AS TIMESTAMP(3))');
    expect(sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b|ILIKE/);
    expect(classifySql(teradataInline(sql, params), 'teradata').statement).toBe('select');
  });

  test('Teradata on Tesseract: an offset as QUALIFY over the order; the legacy planner refuses one', () => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'true';
    const [sql] = sqlOf(XcubeTeradataQuery, { offset: 5 });
    expect(sql).toMatch(/QUALIFY ROW_NUMBER\(\) OVER \(ORDER BY sum\("f"\.AMOUNT\) DESC\) > 5 AND ROW_NUMBER\(\) OVER \(ORDER BY sum\("f"\.AMOUNT\) DESC\) <= 5 \+ 10\s+ORDER BY sum\("f"\.AMOUNT\) DESC$/);
    expect(sql).not.toMatch(/TOP/);
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'false';
    expect(() => sqlOf(XcubeTeradataQuery, { offset: 5 })).toThrow(/planned by Tesseract only/);
  });

  test('Teradata refuses a time zone other than UTC with a time dimension, rather than guess one', () => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'true';
    expect(() => sqlOf(XcubeTeradataQuery, { timezone: 'America/Los_Angeles' })).toThrow(/UTC only/);
  });

  test('Teradata\'s granularities and intervals', () => {
    const q = new XcubeTeradataQuery(compiled, { timezone: 'UTC' });
    expect(q.timeGroupedColumn('hour', 'x')).toBe('CAST(TO_CHAR(x, \'YYYY-MM-DD HH24\') || \':00:00\' AS TIMESTAMP(0))');
    expect(q.timeGroupedColumn('week', 'x')).toBe('CAST(TRUNC(x, \'IW\') AS TIMESTAMP(0))');
    expect(q.addInterval('d', '1 quarter')).toBe('ADD_MONTHS(d, 3)');
    expect(q.subtractInterval('d', '1 year 2 weeks')).toBe('(ADD_MONTHS(d, -12) - INTERVAL \'14\' DAY(4))');
    expect(() => q.addInterval('d', '10000 days')).toThrow(/no interval/);
  });

  test.each([['Tesseract', 'true'], ['the legacy planner', 'false']])('TDV, %s: TOP, OFFSET … FETCH NEXT, TZCONVERTOR, TRUNC to a quarter', (_planner, tesseract) => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = tesseract;
    const [limited, params] = sqlOf(XcubeTdvQuery, { timezone: 'America/Los_Angeles' });
    expect(limited).toMatch(/^SELECT TOP 10\s/);
    expect(limited).toContain('CAST(TRUNC(TZCONVERTOR("f".TS, \'UTC\', \'America/Los_Angeles\'), \'Q\') AS TIMESTAMP)');
    expect(limited).toMatch(/LOWER\("f"\.NAME\) LIKE LOWER\(.*\) ESCAPE '\\'/);
    expect(classifySql(tdvInline(limited, params), 'tdv').statement).toBe('select');
    const [offset] = sqlOf(XcubeTdvQuery, { offset: 5 });
    expect(offset).toMatch(/OFFSET 5 ROWS\s+FETCH NEXT 10 ROWS ONLY$/);
    expect(offset).not.toMatch(/TOP/);
  });

  test('TDV\'s granularities, intervals, and a zone that isn\'t one', () => {
    const q = new XcubeTdvQuery(compiled, { timezone: 'UTC' });
    expect(q.timeGroupedColumn('hour', 'x')).toBe('CAST(DATE_TRUNC(\'HOUR\', x) AS TIMESTAMP)');
    expect(q.timeGroupedColumn('week', 'x')).toBe('CAST(TRUNC(x, \'IW\') AS TIMESTAMP)');
    expect(q.addInterval('d', '1 quarter')).toBe('TIMESTAMPADD(MONTH, 3, d)');
    expect(q.subtractInterval('d', '2 weeks')).toBe('TIMESTAMPADD(DAY, -14, d)');
    (q as any).timezone = 'Mars/Olympus_Mons';
    expect(() => q.convertTz('x')).toThrow(/IANA time zone/);
  });
});
