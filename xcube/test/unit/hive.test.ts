/**
 * Hive and Spark as a data source, without a server: the SQL runner's check
 * for their dialect (R6), the connection's fields (R3), the values Cube's SQL
 * has written into it, the cells read from HiveServer2's column sets, and
 * the SQL xcube's dialect compiles (R8). `test/integration/hive.test.ts` runs
 * against servers.
 */
/* eslint-disable no-template-curly-in-string -- `${…}` here is Hive's variable syntax, the SQL under test */
import net from 'net';

import { prepareCompiler } from '@cubejs-backend/schema-compiler';

import { DRIVERS } from '../../src/connections/drivers';
import {
  columnsOf, HiveConnection, hiveLiteral, inlineValues, int64Cell, PLAIN_PLACEHOLDER, rowsOfColumns, zonedCell,
} from '../../src/connections/hive';
import { XcubeHiveQuery } from '../../src/model/hive-dialect';
import { classifySql, hivePlaceholders, hiveTrailingOffset, SqlRefusal } from '../../src/sql/classify';
import { exportStatement } from '../../src/sql/export';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('hive-driver').thrift.TCLIService_types;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Int64 = require('node-int64');

/** The refusal's code, its statement kind and what it named, or `ok` and the kind. */
function verdict(sql: string): string {
  try {
    return `ok:${classifySql(sql, 'hive').statement}`;
  } catch (e) {
    if (e instanceof SqlRefusal) {
      return `${e.code}:${e.statement ?? '-'}${e.refused ? `:${e.refused.kind}:${e.refused.name}` : ''}`;
    }
    throw e;
  }
}

describe('the SQL runner\'s check: Hive and Spark', () => {
  test('reads, whatever their strings, backticks and comments hold', () => {
    for (const sql of [
      'SELECT 1',
      'SELECT `a`, `b``c` FROM `db`.`t`',
      'SELECT \'it\\\'s; DROP TABLE t\' AS a',
      'SELECT "a double-quoted string; INSERT INTO t" AS a',
      'SELECT `a\\` FROM t',
      'WITH q AS (SELECT 1 AS a) SELECT a FROM q',
      'SELECT a FROM t LATERAL VIEW explode(arr) x AS a',
      'SELECT map(\'k\', 1) AS m, CAST(NULL AS MAP<STRING,INT>) AS n',
      'SELECT transform(arr, x -> x + 1) AS t, reduce(arr, 0, (acc, x) -> acc + x) AS r FROM t',
      'SELECT a.x FROM a JOIN b USING (x)',
      'SELECT map, transform, reduce FROM t',
      'SELECT a FROM t DISTRIBUTE BY a SORT BY a',
      'SELECT 1 /* a comment */ -- another',
      'SELECT 1;',
      'SELECT t.`map` FROM t',
      'SELECT a FROM db.`my_table`',
    ]) {
      expect([sql, verdict(sql)]).toEqual([sql, expect.stringMatching(/^ok:select$/)]);
    }
    expect(verdict('EXPLAIN SELECT 1')).toBe('ok:explain');
    expect(verdict('EXPLAIN EXTENDED SELECT a FROM t')).toBe('ok:explain');
    expect(verdict('EXPLAIN FORMATTED CBO SELECT a FROM t')).toBe('ok:explain');
    expect(verdict('EXPLAIN CODEGEN SELECT a FROM t')).toBe('ok:explain');
  });

  test('R6\'s statements, each refused for its reason', () => {
    for (const [sql, expected] of [
      ['WITH q AS (SELECT 1) INSERT OVERWRITE TABLE t SELECT * FROM q', 'not_read_only:select'],
      ['FROM t INSERT OVERWRITE DIRECTORY \'/tmp/x\' SELECT *', 'not_read_only:from'],
      ['SELECT reflect(\'java.lang.Runtime\',\'getRuntime\')', 'not_read_only:select:function:reflect'],
      ['SELECT java_method(\'java.lang.System\', \'exit\', 0)', 'not_read_only:select:function:java_method'],
      ['SELECT in_file(\'x\', \'/etc/passwd\')', 'not_read_only:select:function:in_file'],
      ['SELECT * FROM parquet.`/data/x`', 'not_read_only:select:clause:FILE'],
      ['SELECT * FROM csv.`s3a://bucket/x.csv`', 'not_read_only:select:clause:FILE'],
      ['EXPLAIN ANALYZE SELECT 1', 'not_read_only:explain'],
      ['EXPLAIN REOPTIMIZATION SELECT 1', 'not_read_only:explain'],
      // Spark reads the second line as the comment's; Hive as a statement after it.
      ['SELECT 1 -- \\\n; DROP TABLE t', 'several_statements:-'],
      ['SELECT a -- \\\nFROM secrets', 'not_read_only:select'],
      ['SELECT TRANSFORM(a) USING \'/bin/sh\' FROM t', 'not_read_only:select:clause:TRANSFORM'],
      ['SELECT REDUCE a USING \'x\' FROM t', 'not_read_only:select:clause:REDUCE'],
      ['SELECT TRANSFORM(a) ROW FORMAT DELIMITED USING "cat" AS (b) FROM t', 'not_read_only:select:clause:TRANSFORM'],
      ['FROM (MAP a USING \'cat\' AS b FROM t) m SELECT b', 'not_read_only:from'],
      ['MAP a USING \'cat\' AS b FROM t', 'not_read_only:map'],
      ['SELECT a FROM t |> WHERE a > 1', 'not_read_only:select:clause:|>'],
      ['SELECT /*+ MAPJOIN(t) */ a FROM t', 'not_read_only:-'],
      // Hive reads the string as unclosed; Spark as a backslash.
      ['SELECT r\'\\\' AS a', 'not_read_only:-'],
      ['SELECT r\'a\\\\b\' AS a', 'not_read_only:select'],
      ['SELECT \'${env:AWS_SECRET_ACCESS_KEY}\' AS a', 'not_read_only:select:clause:${'],
      ['SELECT 1 -- ${system:user.name}', 'not_read_only:select:clause:${'],
      ['SET hive.exec.mode.local.auto=true', 'not_read_only:set'],
      ['ADD JAR /tmp/x.jar', 'not_read_only:add'],
      ['DFS -ls /', 'not_read_only:dfs'],
      ['LOAD DATA INPATH \'/x\' INTO TABLE t', 'not_read_only:load'],
      ['USE other', 'not_read_only:use'],
      ['MSCK REPAIR TABLE t', 'not_read_only:msck'],
      ['SELECT 1; DROP TABLE t', 'several_statements:-'],
    ] as [string, string][]) {
      expect([sql, verdict(sql)]).toEqual([sql, expected]);
    }
  });

  test('a backslash in a backtick name is a character: the name ends at its backtick', () => {
    // Read as an escape, `a\` would run on to the next backtick and hide the DROP from the check.
    expect(verdict('SELECT `a\\` ; DROP TABLE t; `x`')).toBe('several_statements:-');
  });

  test('the placeholders of Cube\'s SQL: never a ? in a string, a name or a comment', () => {
    const sql = 'SELECT \'?\', `?`, a FROM t WHERE b = ? AND c = "?" -- ?\nAND d IN (?, ?)';
    expect(hivePlaceholders(sql).map((at) => sql[at])).toEqual(['?', '?', '?']);
    expect(inlineValues(sql, ['x\'y', 2, null], hivePlaceholders))
      .toBe('SELECT \'?\', `?`, a FROM t WHERE b = \'x\\\'y\' AND c = "?" -- ?\nAND d IN (2, NULL)');
  });
});

describe('an OFFSET Hive before 4 ignores, as rows the reader skips', () => {
  test('only a top-level LIMIT n OFFSET m ending the statement', () => {
    expect(hiveTrailingOffset('SELECT a FROM t ORDER BY a\nLIMIT 10\nOFFSET 20')).toEqual({ sql: 'SELECT a FROM t ORDER BY a\nLIMIT 30', skip: 20 });
    expect(hiveTrailingOffset('SELECT a FROM t LIMIT 2 OFFSET 1;')).toEqual({ sql: 'SELECT a FROM t LIMIT 3', skip: 1 });
    expect(hiveTrailingOffset('SELECT a FROM t LIMIT 2147483647 OFFSET 5')).toEqual({ sql: 'SELECT a FROM t LIMIT 2147483647', skip: 5 });
    expect(hiveTrailingOffset('SELECT * FROM (SELECT a FROM t LIMIT 2 OFFSET 1) q')).toBeNull();
    expect(hiveTrailingOffset('SELECT a FROM t LIMIT 2')).toBeNull();
    expect(hiveTrailingOffset('SELECT \'LIMIT 2 OFFSET 1\'')).toBeNull();
  });

  test('which servers honour OFFSET themselves', () => {
    const offsetWorks = (name: string, version: string) => Object.getOwnPropertyDescriptor(HiveConnection.prototype, 'offsetWorks')!.get!
      .call({ server: { name, version } });
    expect(offsetWorks('Apache Hive', '4.2.1')).toBe(true);
    expect(offsetWorks('Apache Hive', '3.1.3')).toBe(false);
    expect(offsetWorks('Spark SQL', '4.3.0')).toBe(true);
    expect(offsetWorks('Spark SQL', '3.4.1')).toBe(true);
    expect(offsetWorks('Spark SQL', '3.3.2')).toBe(false);
    expect(offsetWorks('', '')).toBe(false);
  });
});

describe('Hive\'s literals', () => {
  test('a string with its backslashes, quotes, control characters and dollars escaped', () => {
    expect(hiveLiteral('it\'s a \\ ${env:HOME}\n')).toBe('\'it\\\'s a \\\\ \\u0024{env:HOME}\\n\'');
    expect(hiveLiteral(12.5)).toBe('12.5');
    expect(hiveLiteral(true)).toBe('TRUE');
    expect(hiveLiteral(null)).toBe('NULL');
    expect(hiveLiteral(new Date('2026-01-02T03:04:05.000Z'))).toBe('\'2026-01-02T03:04:05.000Z\'');
    expect(() => hiveLiteral(Number.NaN)).toThrow(/literal/);
  });
});

describe('Hive\'s connection (R3)', () => {
  const spec = DRIVERS.hive;

  test('its fields, methods and target', () => {
    expect(spec.connection.map((f) => f.key)).toEqual(['host', 'port', 'database', 'ssl', 'sslRejectUnauthorized', 'sslCa']);
    expect(Object.keys(spec.auth)).toEqual(['username', 'password']);
    expect(spec.auth.username.some((f) => f.secret)).toBe(false);
    expect(spec.auth.password.filter((f) => f.secret).map((f) => f.key)).toEqual(['password']);
    expect(spec.target).toEqual(['host', 'port', 'ssl', 'sslRejectUnauthorized', 'sslCa']);
  });

  test('its config: TLS checked by default, a user alone with no password', () => {
    expect(spec.config({ host: 'hive.example', database: 'sales', user: 'ana' }, 'username', {})).toEqual({
      flavour: 'hive',
      host: 'hive.example',
      port: 10000,
      database: 'sales',
      ssl: { rejectUnauthorized: true, ca: undefined },
      mechanism: 'plain',
      user: 'ana',
      password: undefined,
      readOnly: true,
    });
    expect(spec.config({ host: 'h', port: 10001, database: 'd', user: 'u', ssl: false }, 'password', { password: 'p' }))
      .toMatchObject({ port: 10001, ssl: false, user: 'u', password: 'p' });
    expect(PLAIN_PLACEHOLDER).not.toBe('');
  });

  test('a database or host that could add an option is refused before anything connects (R3 test 3)', () => {
    for (const database of ['x;AuthMech=0', 'x,LOGMECH=JWT', 'x:traceFile=/tmp/a;', 'a&b', 'a b', 'a`b', 'a--b', 'a{b}']) {
      expect(() => spec.config({ host: 'h', database, user: 'u' }, 'username', {})).toThrow(/database can't hold/);
    }
    for (const host of ['h:10000', 'user@h', 'h/path', 'h?x=1']) {
      expect(() => spec.config({ host, database: 'd', user: 'u' }, 'username', {})).toThrow(/host must be/);
    }
  });
});

describe('SASL PLAIN as `username` sends it (R3 test 4)', () => {
  test('the user, and a password that isn\'t empty', async () => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on('data', (data) => received.push(data));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    try {
      const { port } = server.address() as net.AddressInfo;
      const config = DRIVERS.hive.config({ host: '127.0.0.1', port, database: 'd', user: 'ana', ssl: false }, 'username', {}) as any;
      await expect(HiveConnection.open({ ...config, connectTimeoutMs: 1000 })).rejects.toThrow(/sign-in within 1000 ms/);
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
    // Two SASL frames, each a status byte and a 4-byte length: START with the mechanism, then OK with authzid\0user\0password.
    const bytes = Buffer.concat(received);
    expect(bytes[0]).toBe(1);
    const mechanism = bytes.subarray(5, 5 + bytes.readUInt32BE(1));
    expect(mechanism.toString()).toBe('PLAIN');
    const second = 5 + mechanism.length;
    expect(bytes[second]).toBe(2);
    const message = bytes.subarray(second + 5, second + 5 + bytes.readUInt32BE(second + 1)).toString().split('\0');
    expect(message).toEqual(['ana', 'ana', PLAIN_PLACEHOLDER]);
    expect(message[2].length).toBeGreaterThan(0);
  });
});

describe('Hive\'s driver reads nothing of Cube\'s environment (R2 test 5)', () => {
  const POISON = {
    CUBEJS_DB_TYPE: 'postgres', CUBEJS_DB_HOST: 'poison.example', CUBEJS_DB_PORT: '1', CUBEJS_DB_USER: 'poison', CUBEJS_DB_PASS: 'poison',
    CUBEJS_DB_NAME: 'poison', CUBEJS_JDBC_URL: 'jdbc:poison://x', CUBEJS_JDBC_DRIVER: 'poison.Driver', CUBEJS_DB_HIVE_TYPE: 'CDH',
    CUBEJS_DB_HIVE_VER: '1', CUBEJS_DB_HIVE_THRIFT_VER: '1', CUBEJS_DB_HIVE_CDH_VER: '1', CUBEJS_DB_SSL: 'false',
  };
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(POISON)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const key of Object.keys(POISON)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test('its config and driver hold the connection\'s values alone', async () => {
    const driver: any = DRIVERS.hive.make!(DRIVERS.hive.config({ host: 'hive.example', database: 'sales', user: 'ana' }, 'password', { password: 'pw' }));
    try {
      expect(JSON.stringify(driver.config)).not.toMatch(/poison/);
      expect(driver.config).toMatchObject({ host: 'hive.example', port: 10000, database: 'sales', user: 'ana', password: 'pw' });
    } finally {
      await driver.release();
    }
  });
});

describe('cells from HiveServer2\'s column sets', () => {
  const desc = (type: number, qualifiers: Record<string, number> = {}) => ({
    types: [{
      primitiveEntry: {
        type,
        typeQualifiers: { qualifiers: Object.fromEntries(Object.entries(qualifiers).map(([k, v]) => [k, { i32Value: v }])) },
      },
    }],
  });

  test('a column\'s type as the server names it', () => {
    expect(columnsOf({
      columns: [
        { columnName: 'd', typeDesc: desc(T.TTypeId.DECIMAL_TYPE, { precision: 31, scale: 9 }) },
        { columnName: 'v', typeDesc: desc(T.TTypeId.VARCHAR_TYPE, { characterMaximumLength: 20 }) },
        { columnName: 'ts', typeDesc: desc(T.TTypeId.TIMESTAMP_TYPE) },
        { columnName: 'z', typeDesc: desc(T.TTypeId.TIMESTAMPLOCALTZ_TYPE) },
      ],
    }).map((c) => c.type)).toEqual(['decimal(31,9)', 'varchar(20)', 'timestamp', 'timestamp with local time zone']);
  });

  test('BIGINT whole past 2^53, NULLs by the bitmap, the rest as the server sent it', () => {
    expect(int64Cell(new Int64('7fffffffffffffff'))).toBe('9223372036854775807');
    expect(int64Cell(new Int64(-5))).toBe(-5);
    expect(int64Cell(new Int64('ffffffffffffffff'))).toBe(-1);
    const columns = columnsOf({
      columns: [
        { columnName: 'big', typeDesc: desc(T.TTypeId.BIGINT_TYPE) },
        { columnName: 'd', typeDesc: desc(T.TTypeId.DECIMAL_TYPE, { precision: 38, scale: 9 }) },
        { columnName: 'b', typeDesc: desc(T.TTypeId.BINARY_TYPE) },
      ],
    });
    const rows = rowsOfColumns(columns, {
      columns: [
        { i64Val: { values: [new Int64('0020000000000001'), new Int64(0)], nulls: Buffer.from([0b10]) } },
        { stringVal: { values: ['12345678901234567890.123456789', ''], nulls: Buffer.from([0b10]) } },
        { binaryVal: { values: [Buffer.from('ab'), Buffer.alloc(0)], nulls: Buffer.from([0]) } },
      ],
    });
    expect(rows).toEqual([['9007199254740993', '12345678901234567890.123456789', Buffer.from('ab')], [null, null, Buffer.alloc(0)]]);
  });

  test('a timestamp with a zone, with its offset at its own wall time', () => {
    expect(zonedCell('2026-03-08 01:30:00.0 America/Los_Angeles')).toBe('2026-03-08 01:30:00-08:00');
    expect(zonedCell('2026-03-08 03:30:00.5 America/Los_Angeles')).toBe('2026-03-08 03:30:00.5-07:00');
    expect(zonedCell('2026-07-01 12:00:00.0 UTC')).toBe('2026-07-01 12:00:00+00:00');
    expect(zonedCell('2026-07-01 12:00:00.0 Nowhere/Else')).toBe('2026-07-01 12:00:00.0 Nowhere/Else');
  });

  test('rows, not columns (a protocol before V6), are refused', () => {
    expect(() => rowsOfColumns([], { rows: [{ colVals: [] }] })).toThrow(/older than V6/);
  });
});

describe('Hive\'s export names (R7)', () => {
  test('backticks, and a name that can\'t be quoted refused', () => {
    expect(exportStatement('hive', { schema: 'Sales', table: 'my table', columns: ['Id'] })).toBe('SELECT `Id` FROM `Sales`.`my table`');
    expect(() => exportStatement('hive', { table: 'a`b' })).toThrow(/can't be a name/);
    expect(() => exportStatement('hive', { table: 'a"b' })).toThrow(/can't be a name/);
  });
});

describe('xcube\'s Hive dialect under Tesseract (R8)', () => {
  let compiled: any;
  const planner = process.env.CUBEJS_TESSERACT_SQL_PLANNER;

  beforeAll(async () => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'true';
    compiled = prepareCompiler({
      localPath: () => '/nowhere',
      dataSchemaFiles: async () => [{
        fileName: 'cubes/f.yml',
        content: `cubes:
  - name: f
    sql_table: default.facts
    dimensions:
      - { name: id, sql: id, type: number, primary_key: true }
      - { name: at, sql: ts, type: time }
      - { name: name, sql: name, type: string }
    measures:
      - { name: total, sql: amount, type: sum }
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

  const sqlOf = (query: Record<string, unknown>) => new XcubeHiveQuery(compiled, { timezone: 'UTC', ...query }).buildSqlAndParams();

  test('backticks, GROUP BY expressions, quarter, LIKE bound to the row, and OFFSET after a LIMIT', () => {
    const [sql, params] = sqlOf({
      measures: ['f.total'],
      dimensions: ['f.name'],
      timeDimensions: [{ dimension: 'f.at', granularity: 'quarter', dateRange: ['2026-01-01', '2026-12-31'] }],
      filters: [{ member: 'f.name', operator: 'contains', values: ['50%'] }],
      offset: 5,
    });
    expect(sql).not.toMatch(/"f"/);
    expect(sql).toMatch(/FROM\s+default\.facts\s+AS `f`/);
    expect(sql).toContain('QUARTER(');
    expect(sql).toMatch(/GROUP BY `f`\.name, CAST\(CONCAT/);
    expect(sql).toContain('LIKE CONCAT(CONCAT(\'%\', LOWER(?), \'%\'), SUBSTR(CAST(`f`.name AS STRING), 1, 0))');
    expect(sql).toMatch(/LIMIT 2147483642\nOFFSET 5/);
    expect(params).toContain('50\\%');
  });

  test('a granularity Hive has no truncation for is refused', () => {
    expect(() => new XcubeHiveQuery(compiled, { timezone: 'UTC' }).timeGroupedColumn('fortnight', 'x')).toThrow(/no fortnight granularity/);
  });
});
