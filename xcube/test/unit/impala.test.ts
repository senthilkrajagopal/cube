/**
 * Impala as a data source, without a server: the SQL runner's check for its
 * dialect (R6), the connection's fields (R3), its type as Cube resolves it,
 * and the SQL xcube's Impala dialect compiles (R8).
 * `test/integration/impala.test.ts` runs against a cluster.
 */
/* eslint-disable no-template-curly-in-string -- `${…}` here is SQL under test */
import { prepareCompiler } from '@cubejs-backend/schema-compiler';
import { CubejsServerCore } from '@cubejs-backend/server-core';

import { DRIVERS, driverAvailability } from '../../src/connections/drivers';
import { HiveConnection, inlineValues } from '../../src/connections/hive';
import { dialectFactory } from '../../src/model/dialects';
import { XcubeImpalaQuery } from '../../src/model/impala-dialect';
import {
  classifySql, hivePlaceholders, redactSql, SqlRefusal,
} from '../../src/sql/classify';
import { exportStatement } from '../../src/sql/export';
import { DIALECT_NAMES, LITERAL_DIALECTS } from '../../src/sql/parameters';

/** The refusal's code, its statement kind and what it named, or `ok` and the kind. */
function verdict(sql: string): string {
  try {
    return `ok:${classifySql(sql, 'impala').statement}`;
  } catch (e) {
    if (e instanceof SqlRefusal) {
      return `${e.code}:${e.statement ?? '-'}${e.refused ? `:${e.refused.kind}:${e.refused.name}` : ''}`;
    }
    throw e;
  }
}

describe('the SQL runner\'s check: Impala', () => {
  test('reads, whatever their strings, backticks and comments hold', () => {
    for (const sql of [
      'SELECT 1',
      'SELECT `a`, `b` FROM `db`.`t`',
      'SELECT \'it\\\'s; DROP TABLE t\' AS a',
      'SELECT "a double-quoted string; INSERT INTO t" AS a',
      'WITH q AS (SELECT 1 AS a) SELECT a FROM q',
      'SELECT 1 /* a comment */ -- another',
      'SELECT 1 --a comment',
      'SELECT 1;',
      // Impala substitutes no variable.
      'SELECT \'${env:HOME}\' AS a',
      'SELECT a FROM t ORDER BY a LIMIT 10 OFFSET 5',
      'SELECT NDV(a), APPX_MEDIAN(b) FROM t',
    ]) {
      expect([sql, verdict(sql)]).toEqual([sql, 'ok:select']);
    }
    expect(verdict('EXPLAIN SELECT 1')).toBe('ok:explain');
  });

  test('R6\'s statements, each refused for its reason', () => {
    for (const [sql, expected] of [
      ['WITH q AS (SELECT 1) INSERT INTO t SELECT * FROM q', 'not_read_only:select'],
      ['WITH q AS (SELECT 1) UPSERT INTO t SELECT * FROM q', 'not_read_only:select'],
      ['INSERT INTO t VALUES (1)', 'not_read_only:insert'],
      ['UPSERT INTO t VALUES (1)', 'not_read_only:upsert'],
      ['SET MEM_LIMIT=1', 'not_read_only:set'],
      ['USE other', 'not_read_only:use'],
      ['REFRESH t', 'not_read_only:refresh'],
      ['INVALIDATE METADATA t', 'not_read_only:invalidate'],
      ['COMPUTE STATS t', 'not_read_only:compute'],
      ['LOAD DATA INPATH \'/x\' INTO TABLE t', 'not_read_only:load'],
      [':SHUTDOWN()', 'not_read_only:-'],
      ['ALTER TABLE t RENAME TO u', 'not_read_only:alter'],
      ['COMMENT ON TABLE t IS \'x\'', 'not_read_only:comment'],
      ['SELECT 1; DROP TABLE t', 'several_statements:-'],
      // Its hints, every form.
      ['SELECT /*+straight_join*/ 1', 'not_read_only:-'],
      ['SELECT /* +straight_join */ 1', 'not_read_only:-'],
      ['SELECT 1 FROM a JOIN -- +SHUFFLE\nb ON a.x = b.x', 'not_read_only:-'],
      ['SELECT 1 FROM a JOIN [SHUFFLE] b ON a.x = b.x', 'not_read_only:-'],
    ] as [string, string][]) {
      expect([sql, verdict(sql)]).toEqual([sql, expected]);
    }
  });

  test('a backslash in a backtick name escapes the next character: `a\\`; drop table t` is one name (R6)', () => {
    expect(verdict('SELECT `a\\`; drop table t`')).toBe('ok:select');
    // Read so, Hive's split (`a\` a name, then a second statement) leaves a backtick unclosed: unreadable.
    expect(verdict('SELECT `a\\` ; DROP TABLE t; `x`')).toBe('not_read_only:-');
    // A backslash escaping a backslash, then the closing backtick: the second statement is seen.
    expect(verdict('SELECT `a\\\\` ; DROP TABLE t')).toBe('several_statements:-');
  });

  test('a doubled quote is two strings, not one with a quote in it', () => {
    expect(redactSql('SELECT \'a\'\'b\' AS x', 'impala')).toBe('SELECT ?? AS x');
    expect(redactSql('SELECT `a``b`', 'impala')).toBe('SELECT `a``b`');
  });

  test('the placeholders of Cube\'s SQL, read as Impala does', () => {
    const sql = 'SELECT \'?\', `a\\`?`, x FROM t WHERE b = ? AND c = "?" -- ?\nAND d IN (?, ?)';
    expect(hivePlaceholders(sql, 'impala').map((at) => sql[at])).toEqual(['?', '?', '?']);
    expect(inlineValues(sql, ['x\'y', 2, null], (s) => hivePlaceholders(s, 'impala')))
      .toBe('SELECT \'?\', `a\\`?`, x FROM t WHERE b = \'x\\\'y\' AND c = "?" -- ?\nAND d IN (2, NULL)');
  });

  test('parameters are written in as literals (R12), and it names itself so', () => {
    expect(LITERAL_DIALECTS.has('impala')).toBe(true);
    expect(DIALECT_NAMES.impala).toBe('Impala');
  });
});

describe('Impala\'s connection (R3)', () => {
  const spec = DRIVERS.impala;

  test('its fields, methods and target', () => {
    expect(spec.cubeType).toBe('impala');
    expect(spec.connection.map((f) => f.key)).toEqual(['host', 'port', 'database', 'ssl', 'sslRejectUnauthorized', 'sslCa']);
    expect(Object.keys(spec.auth)).toEqual(['none', 'username', 'password']);
    expect(spec.auth.none).toEqual([]);
    expect(spec.auth.username.some((f) => f.secret)).toBe(false);
    expect(spec.auth.password.filter((f) => f.secret).map((f) => f.key)).toEqual(['password']);
    expect(spec.target).toEqual(['host', 'port', 'ssl', 'sslRejectUnauthorized', 'sslCa']);
    expect(driverAvailability()).toContainEqual({ type: 'impala', available: true });
  });

  test('its config: port 21050, TLS checked by default, NOSASL for `none`, SASL PLAIN otherwise', () => {
    expect(spec.config({ host: 'impala.example', database: 'sales', user: 'ignored' }, 'none', {})).toEqual({
      flavour: 'impala',
      host: 'impala.example',
      port: 21050,
      database: 'sales',
      ssl: { rejectUnauthorized: true, ca: undefined },
      mechanism: 'nosasl',
      user: undefined,
      password: undefined,
      readOnly: true,
    });
    expect(spec.config({ host: 'h', database: 'd', user: 'ana' }, 'username', {})).toMatchObject({ mechanism: 'plain', user: 'ana', password: undefined });
    expect(spec.config({ host: 'h', port: 21051, database: 'd', user: 'u', ssl: false }, 'password', { password: 'p' }))
      .toMatchObject({ port: 21051, ssl: false, mechanism: 'plain', user: 'u', password: 'p' });
  });

  test('a database or host that could add an option is refused before anything connects (R3 test 3)', () => {
    for (const database of ['x;AuthMech=0', 'a b', 'a`b', 'a--b']) {
      expect(() => spec.config({ host: 'h', database }, 'none', {})).toThrow(/database can't hold/);
    }
    expect(() => spec.config({ host: 'h:21050', database: 'd' }, 'none', {})).toThrow(/host must be/);
  });

  test('the server honours OFFSET itself: no rows are skipped by the reader', () => {
    const offsetWorks = Object.getOwnPropertyDescriptor(HiveConnection.prototype, 'offsetWorks')!.get!
      .call({ server: { name: 'Impala', version: '4.5.3-RELEASE' } });
    expect(offsetWorks).toBe(true);
  });
});

describe('Impala\'s type, as Cube resolves it', () => {
  test('Cube finds `impala` (its queue looks a type up by name), and its dialect is xcube\'s', () => {
    const Found = CubejsServerCore.lookupDriverClass('impala') as any;
    expect(Found.dialectClass()).toBe(XcubeImpalaQuery);
    expect(Found.getDefaultConcurrency).toBeUndefined();
    expect(() => new Found()).toThrow(/made from its connection/);
    expect(dialectFactory()({ dbType: 'impala' })).toBe(XcubeImpalaQuery);
  });
});

describe('Impala\'s export names (R7)', () => {
  test('backticks, and a name that can\'t be quoted refused', () => {
    expect(exportStatement('impala', { schema: 'Sales', table: 'my table', columns: ['Id'] })).toBe('SELECT `Id` FROM `Sales`.`my table`');
    expect(() => exportStatement('impala', { table: 'a`b' })).toThrow(/can't be a name/);
    expect(() => exportStatement('impala', { table: 'a\\b' })).toThrow(/can't be a name/);
  });
});

describe('xcube\'s Impala dialect (R8)', () => {
  let compiled: any;
  const planner = process.env.CUBEJS_TESSERACT_SQL_PLANNER;

  beforeAll(async () => {
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
      - { name: approx, sql: name, type: count_distinct_approx }
      - name: trailing
        sql: amount
        type: sum
        rolling_window: { trailing: 1 quarter }
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

  const sqlOf = (query: Record<string, unknown>) => new XcubeImpalaQuery(compiled, { timezone: 'America/Los_Angeles', ...query }).buildSqlAndParams();
  const query = {
    measures: ['f.total', 'f.approx'],
    dimensions: ['f.name'],
    timeDimensions: [{ dimension: 'f.at', granularity: 'quarter', dateRange: ['2026-01-01', '2026-12-31'] }],
    filters: [{ member: 'f.name', operator: 'contains', values: ['50%'] }],
    order: [{ id: 'f.name', desc: false }],
    rowLimit: 10,
    offset: 5,
  };

  for (const tesseract of ['true', 'false']) {
    test(`${tesseract === 'true' ? 'Tesseract' : 'the legacy planner'}: backticks, TRUNC to a quarter, the zone, NDV, ILIKE bound to the row, LIMIT and OFFSET`, () => {
      process.env.CUBEJS_TESSERACT_SQL_PLANNER = tesseract;
      const [sql, params] = sqlOf(query);
      expect(sql).not.toMatch(/"f"|\|\|/);
      expect(sql).toMatch(/FROM\s+default\.facts\s+AS `f`/);
      expect(sql).toContain('TRUNC(FROM_UTC_TIMESTAMP(`f`.ts, \'America/Los_Angeles\'), \'Q\')');
      expect(sql).toContain('NDV(`f`.name)');
      expect(sql).toMatch(/ILIKE CONCAT\(.*SUBSTR\(CAST\(`f`\.name AS STRING\), 1, 0\)\)/);
      expect(sql).toMatch(/LIMIT 10\s+OFFSET 5/);
      expect(params.some((p: unknown) => String(p).includes('50'))).toBe(true);
    });
  }

  test('every other granularity by DATE_TRUNC, and an unknown one refused', () => {
    const q = new XcubeImpalaQuery(compiled, { timezone: 'UTC' });
    for (const granularity of ['second', 'minute', 'hour', 'day', 'week', 'month', 'year']) {
      expect(q.timeGroupedColumn(granularity, 'x')).toBe(`DATE_TRUNC('${granularity}', x)`);
    }
    expect(() => q.timeGroupedColumn('fortnight', 'x')).toThrow(/no fortnight granularity/);
  });

  test('intervals one unit at a time, a quarter as three months', () => {
    const q = new XcubeImpalaQuery(compiled, { timezone: 'UTC' });
    expect(q.addInterval('d', '1 quarter')).toBe('(d + INTERVAL 3 MONTH)');
    expect(q.subtractInterval('d', '1 year 2 days')).toBe('((d - INTERVAL 1 YEAR) - INTERVAL 2 DAY)');
  });
});
