/**
 * Db2 as a data source, without a server or a JVM (wechart's db_support
 * R1–R2 with db2): the mounted jars and which types they make available,
 * the URL and properties a connection opens with (R3), the SQL runner's
 * check for its dialect (R6), its parameters and session (R5, R7), its type
 * as Cube resolves it, and the SQL xcube's Db2 dialect compiles (R8). No
 * test here connects: the user's decision is that none runs against a Db2
 * server until there is one to name; the JVM's own tests run in the image
 * (`test/image/jdbc.js`).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { prepareCompiler } from '@cubejs-backend/schema-compiler';
import { CubejsServerCore } from '@cubejs-backend/server-core';

import { db2Inline, db2Literal, db2Target, DB2_DIALECT } from '../../src/connections/db2';
import { DRIVERS, driverAvailability } from '../../src/connections/drivers';
import { JdbcError } from '../../src/connections/jdbc';
import {
  assertJdbcAvailable, DriverUnavailableError, jvmOptions, readJdbcDrivers, resetJdbcDrivers, zipEntries,
} from '../../src/connections/jvm';
import { XcubeDb2Query } from '../../src/model/db2-dialect';
import { dialectFactory } from '../../src/model/dialects';
import {
  classifySql, jdbcPlaceholders, ParameterError, SqlRefusal,
} from '../../src/sql/classify';
import { exportStatement } from '../../src/sql/export';
import { bindParameters, DIALECT_NAMES, LITERAL_DIALECTS, MAX_BOUND } from '../../src/sql/parameters';
import { isTimeout, openSession, RowCollector } from '../../src/sql/runner';

/** A zip holding these entries, stored: what a jar is, as far as xcube reads one. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const n = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const DB2_CLASS = 'com/ibm/db2/jcc/DB2Driver.class';

describe('the mounted JDBC drivers (R2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-jdbc-drivers-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resetJdbcDrivers();
  });

  test('a jar\'s entries are read from its central directory', () => {
    expect(zipEntries(zip({ 'META-INF/MANIFEST.MF': 'x', [DB2_CLASS]: 'y' }))).toEqual(['META-INF/MANIFEST.MF', DB2_CLASS]);
    expect(zipEntries(Buffer.from('not a zip at all'))).toBeNull();
  });

  test('with the directory unset, Db2 is unavailable, and so says the drivers route and every use of it (R2 test 1)', () => {
    resetJdbcDrivers(readJdbcDrivers(undefined));
    expect(driverAvailability()).toContainEqual({
      type: 'db2', available: false, reason: 'No driver jar is mounted for db2: this deployment sets no XCUBE_JDBC_DRIVERS_DIR',
    });
    expect(() => assertJdbcAvailable('db2')).toThrow(DriverUnavailableError);
    // Every other type is untouched.
    expect(() => assertJdbcAvailable('postgres')).not.toThrow();
  });

  test('with db2/ holding the driver\'s jar, Db2 is available; its size and SHA-256 are read (R2 test 2)', () => {
    fs.mkdirSync(path.join(dir, 'db2'));
    const jar = zip({ [DB2_CLASS]: 'class' });
    fs.writeFileSync(path.join(dir, 'db2', 'jcc-12.1.5.0.jar'), jar);
    const read = readJdbcDrivers(dir);
    expect(read.unavailable.db2).toBeUndefined();
    expect(Object.keys(read.unavailable)).toEqual(['teradata', 'tdv']);
    expect(read.jars).toEqual([{
      type: 'db2',
      file: path.join(dir, 'db2', 'jcc-12.1.5.0.jar'),
      size: jar.length,
      sha256: crypto.createHash('sha256').update(jar).digest('hex'),
      provides: true,
    }]);
    resetJdbcDrivers(read);
    expect(driverAvailability()).toContainEqual({ type: 'db2', available: true });
  });

  test('a file that isn\'t a jar, or a jar without the class, leaves Db2 unavailable with a reason, never a failure (R2 test 4)', () => {
    fs.mkdirSync(path.join(dir, 'db2'));
    fs.writeFileSync(path.join(dir, 'db2', 'README.txt'), 'not a jar');
    expect(readJdbcDrivers(dir).unavailable.db2).toBe(`No driver jar is mounted for db2: ${path.join(dir, 'db2')} holds no .jar`);
    fs.writeFileSync(path.join(dir, 'db2', 'other.jar'), zip({ 'org/other/Driver.class': 'x' }));
    fs.writeFileSync(path.join(dir, 'db2', 'broken.jar'), 'not a zip');
    const read = readJdbcDrivers(dir);
    expect(read.unavailable.db2).toBe(`No jar in ${path.join(dir, 'db2')} holds com.ibm.db2.jcc.DB2Driver, the db2 driver`);
    expect(read.jars.map((j) => [path.basename(j.file), j.provides])).toEqual([['broken.jar', false], ['other.jar', false]]);
  });

  test('a reason names the type and the directory, never what is in it', () => {
    fs.mkdirSync(path.join(dir, 'db2'));
    fs.writeFileSync(path.join(dir, 'db2', 'secret-name.jar'), zip({ 'x.class': 'x' }));
    expect(readJdbcDrivers(dir).unavailable.db2).not.toContain('secret-name');
  });

  test('the JVM\'s options are xcube\'s: its heap from XCUBE_JDBC_MAX_HEAP_MB, UTC, no signal handlers, no perf file', () => {
    expect(jvmOptions({})).toEqual([
      '-Xmx512m', '-Xrs', '-Duser.timezone=UTC', '-Dfile.encoding=UTF8', '-Djava.awt.headless=true', `-Djava.io.tmpdir=${os.tmpdir()}`, '-XX:-UsePerfData',
    ]);
    expect(jvmOptions({ XCUBE_JDBC_MAX_HEAP_MB: '2048' })[0]).toBe('-Xmx2048m');
    expect(() => jvmOptions({ XCUBE_JDBC_MAX_HEAP_MB: '1g' })).toThrow(/XCUBE_JDBC_MAX_HEAP_MB/);
  });
});

describe('Db2\'s connection (R3)', () => {
  const spec = DRIVERS.db2;
  const pem = '-----BEGIN CERTIFICATE-----\nMIIx\n-----END CERTIFICATE-----';

  test('its fields, method and target', () => {
    expect(spec.cubeType).toBe('db2');
    expect(spec.connection.map((f) => f.key)).toEqual(['host', 'port', 'database', 'currentSchema', 'ssl', 'sslRejectUnauthorized', 'sslCa']);
    expect(Object.keys(spec.auth)).toEqual(['password']);
    expect(spec.auth.password.filter((f) => f.secret).map((f) => f.key)).toEqual(['password']);
    expect(spec.target).toEqual(['host', 'port', 'ssl', 'sslRejectUnauthorized', 'sslCa']);
  });

  test('its config: port 50000, TLS checked by default, every key given', () => {
    expect(spec.config({ host: 'db2.example', database: 'SAMPLE', user: 'ana' }, 'password', { password: 'p' })).toEqual({
      host: 'db2.example',
      port: 50000,
      database: 'SAMPLE',
      currentSchema: undefined,
      user: 'ana',
      password: 'p',
      ssl: { rejectUnauthorized: true, ca: undefined },
      readOnly: true,
    });
  });

  test('the URL names the server and database alone; every setting, the password among them, is a property (R3 test 2)', () => {
    const base = { host: 'db2.example', port: 50001, database: 'SALES', user: 'ana', password: 'p;w' };
    expect(db2Target({ ...base, ssl: { rejectUnauthorized: true, ca: pem }, currentSchema: 'mart' }, '/tmp/xcube-db2-x/ca.pem')).toEqual({
      type: 'db2',
      url: 'jdbc:db2://db2.example:50001/SALES',
      properties: {
        user: 'ana',
        password: 'p;w',
        readOnly: 'true',
        retrieveMessagesFromServerOnGetMessage: 'true',
        loginTimeout: '30',
        blockingReadConnectionTimeout: '720',
        sslConnection: 'true',
        sslClientHostnameValidation: 'BASIC',
        sslCertLocation: '/tmp/xcube-db2-x/ca.pem',
        currentSchema: 'MART',
      },
    });
    // Checking off: the host name's check only (IBM's driver always checks the chain).
    expect(db2Target({ ...base, ssl: { rejectUnauthorized: false } }, null).properties).toMatchObject({
      sslConnection: 'true', sslClientHostnameValidation: 'OFF',
    });
    expect(db2Target({ ...base, ssl: { rejectUnauthorized: false } }, null).properties.sslCertLocation).toBeUndefined();
    // Without TLS the user and password are encrypted, never sent in clear.
    expect(db2Target({ ...base, ssl: false, queryTimeout: 30 }, null)).toEqual({
      type: 'db2',
      url: 'jdbc:db2://db2.example:50001/SALES',
      properties: {
        user: 'ana',
        password: 'p;w',
        readOnly: 'true',
        retrieveMessagesFromServerOnGetMessage: 'true',
        loginTimeout: '30',
        blockingReadConnectionTimeout: '150',
        securityMechanism: '9',
        encryptionAlgorithm: '2',
      },
    });
    expect(db2Target({ ...base, host: '::1', ssl: false }, null).url).toBe('jdbc:db2://[::1]:50001/SALES');
  });

  test('a database, schema or host that could add an option is refused before anything connects (R3 test 3)', () => {
    for (const database of ['x;AuthMech=0', 'x,LOGMECH=JWT', 'x:traceFile=/tmp/a;', 'a b', 'a"b', 'a--b', 'a/*b']) {
      expect(() => spec.config({ host: 'h', database, user: 'u' }, 'password', { password: 'p' })).toThrow(/database can't hold/);
    }
    expect(() => spec.config({ host: 'h', database: 'd', currentSchema: 's;x=1', user: 'u' }, 'password', { password: 'p' })).toThrow(/currentSchema can't hold/);
    expect(() => spec.config({ host: 'h:50000', database: 'd', user: 'u' }, 'password', { password: 'p' })).toThrow(/host must be/);
    expect(() => spec.config({ host: 'h/x?y', database: 'd', user: 'u' }, 'password', { password: 'p' })).toThrow(/host must be/);
  });

  test('Cube\'s environment is never read (R2 test 5)', () => {
    const poison = {
      CUBEJS_JDBC_URL: 'jdbc:db2://evil:1/X', CUBEJS_JDBC_DRIVER: 'evil', CUBEJS_DB_TYPE: 'db2', CUBEJS_DB_HOST: 'evil', CUBEJS_DB_USER: 'evil',
      CUBEJS_DB_PASS: 'evil', CUBEJS_DB_NAME: 'evil', CUBEJS_DB_PORT: '1', CUBEJS_DB_SSL: 'false',
    };
    const saved = Object.fromEntries(Object.keys(poison).map((k) => [k, process.env[k]]));
    Object.assign(process.env, poison);
    try {
      const config = spec.config({ host: 'db2.example', database: 'SAMPLE', user: 'ana' }, 'password', { password: 'p' }) as any;
      const target = db2Target(config, null);
      expect(JSON.stringify([config, target])).not.toContain('evil');
      expect(target.url).toBe('jdbc:db2://db2.example:50000/SAMPLE');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });
});

describe('Db2\'s values in Cube\'s SQL', () => {
  test('each `?` outside a string, name or comment takes its value as a literal', () => {
    expect(jdbcPlaceholders('SELECT \'?\', "a?" FROM t -- ?\nWHERE a = ? /* ? */ AND b IN (?, ?)', 'db2')).toHaveLength(3);
    expect(db2Inline('SELECT * FROM t WHERE a = ? AND b > ? AND c = ? AND d IS ? AND e = ?', ['it\'s', -2.5, true, null, 12n]))
      .toBe('SELECT * FROM t WHERE a = \'it\'\'s\' AND b > (-2.5) AND c = TRUE AND d IS NULL AND e = 12');
    expect(db2Literal('back\\slash\'; DROP TABLE t; --')).toBe('\'back\\slash\'\'; DROP TABLE t; --\'');
    expect(db2Literal(new Date('2026-03-08T10:00:00.000Z'))).toBe('\'2026-03-08T10:00:00.000Z\'');
    expect(() => db2Inline('SELECT ?', [1, 2])).toThrow(/1 placeholders for 2 values/);
  });

  test('the catalog\'s statements name a schema or table as a literal, the system\'s schemas left out', () => {
    expect(DB2_DIALECT.tablesSql!('O\'Brien')).toContain('TABSCHEMA = \'O\'\'Brien\'');
    expect(DB2_DIALECT.catalogSql!()).toMatch(/c\.TABSCHEMA NOT LIKE 'SYS%' AND c\.TABSCHEMA NOT IN \('NULLID', 'SQLJ', 'IBM_RTMON', 'DB2GSE'\)/);
    expect(DB2_DIALECT.genericType('decfloat')).toBe('decimal');
  });
});

/** The refusal's code, its statement kind and what it named, or `ok` and the kind. */
function verdict(sql: string): string {
  try {
    return `ok:${classifySql(sql, 'db2').statement}`;
  } catch (e) {
    if (e instanceof SqlRefusal) {
      return `${e.code}:${e.statement ?? '-'}${e.refused ? `:${e.refused.kind}:${e.refused.name}` : ''}`;
    }
    throw e;
  }
}

describe('the SQL runner\'s check: Db2 (R6)', () => {
  test('reads, whatever their strings, names and comments hold', () => {
    for (const sql of [
      'SELECT 1 FROM SYSIBM.SYSDUMMY1',
      'SELECT "a", "b""c" FROM "S"."T"',
      'SELECT \'it\'\'s; DELETE FROM t\' FROM SYSIBM.SYSDUMMY1',
      'SELECT X\'00FF\', N\'n\', U&\'\\0041\' FROM SYSIBM.SYSDUMMY1',
      'WITH q (a) AS (SELECT 1 FROM SYSIBM.SYSDUMMY1) SELECT a FROM q',
      'SELECT 1 FROM SYSIBM.SYSDUMMY1 /* a comment */ -- another',
      'SELECT 1 FROM SYSIBM.SYSDUMMY1 WITH UR',
      'SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH FIRST 10 ROWS ONLY',
      'SELECT \'FINAL TABLE\', \'NEXT VALUE\' FROM SYSIBM.SYSDUMMY1',
      'SELECT a FROM t FOR READ ONLY',
      'SELECT 1 FROM SYSIBM.SYSDUMMY1;',
      'VALUES 1',
      'VALUES (1, \'a\'), (2, \'b\')',
    ]) {
      expect([sql, verdict(sql)]).toEqual([sql, 'ok:select']);
    }
  });

  test('R6\'s statements, each refused for its reason', () => {
    for (const [sql, expected] of [
      ['SELECT * FROM FINAL TABLE (INSERT INTO t VALUES 1)', 'not_read_only:select'],
      ['WITH a AS (SELECT * FROM OLD TABLE (DELETE FROM t)) SELECT 1 FROM SYSIBM.SYSDUMMY1', 'not_read_only:select'],
      ['SELECT * FROM NEW TABLE (UPDATE t SET a = 1)', 'not_read_only:select'],
      ['SELECT NEXT VALUE FOR s FROM SYSIBM.SYSDUMMY1', 'not_read_only:select:clause:NEXT VALUE'],
      ['SELECT PREVIOUS VALUE FOR s FROM SYSIBM.SYSDUMMY1', 'not_read_only:select:clause:PREVIOUS VALUE'],
      ['SELECT s.NEXTVAL FROM SYSIBM.SYSDUMMY1', 'not_read_only:select:clause:NEXT VALUE'],
      ['SELECT * FROM EXTERNAL \'/tmp/x.csv\' USING (DELIMITER \',\')', 'not_read_only:select'],
      ['SELECT * FROM t WITH RS USE AND KEEP EXCLUSIVE LOCKS', 'not_read_only:select'],
      ['SELECT * FROM t FOR UPDATE', 'not_read_only:select'],
      ['SELECT a INTO :x FROM t', 'not_read_only:select'],
      ['SELECT SYSTOOLS.HTTPGETCLOB(\'http://x\', \'\') FROM SYSIBM.SYSDUMMY1', 'not_read_only:select:function:httpgetclob'],
      ['SELECT UTL_FILE.FOPEN(\'d\', \'f\', \'w\') FROM SYSIBM.SYSDUMMY1', 'not_read_only:select'],
      ['EXPLAIN PLAN FOR SELECT 1 FROM SYSIBM.SYSDUMMY1', 'not_read_only:explain'],
      ['CALL SYSPROC.ADMIN_CMD(\'REORG TABLE t\')', 'not_read_only:call'],
      ['SELECT 1 FROM SYSIBM.SYSDUMMY1; DELETE FROM t', 'several_statements:-'],
      ['INSERT INTO t VALUES (1)', 'not_read_only:insert'],
      ['SET SCHEMA x', 'not_read_only:set'],
    ]) {
      expect([sql, verdict(sql)]).toEqual([sql, expected]);
    }
  });

  test('a comment is read nested and not: a statement must pass both', () => {
    expect(verdict('SELECT 1 FROM SYSIBM.SYSDUMMY1 /* a /* b */')).toMatch(/^not_read_only/);
  });

  test('its name, and its values bound, never written in (R7)', () => {
    expect(DIALECT_NAMES.db2).toBe('Db2');
    expect(LITERAL_DIALECTS.has('db2')).toBe(false);
    expect(MAX_BOUND.db2).toEqual({ total: 32767, list: 32767 });
  });
});

describe('Db2\'s parameters (R5 test 6, R7)', () => {
  test('a text, a number, a date, a date and time, a boolean and a list, each `?` typed in the SQL', () => {
    const { sql, binds } = bindParameters(
      'SELECT {{t}}, {{n}}, {{d}}, {{at}}, {{b}} FROM t WHERE id IN ({{ids}}) AND t = {{t}}',
      'db2',
      {
        t: { type: 'text', value: 'it\'s \\ here' },
        n: { type: 'number', value: '-12.50' },
        d: { type: 'date', value: '0099-02-28' },
        at: { type: 'datetime', value: '2026-03-08T02:30:00.5' },
        b: { type: 'boolean', value: true },
        ids: { type: 'number', value: ['1', '2'] },
      },
      { lists: true },
    );
    expect(sql).toBe('SELECT  CAST(? AS VARCHAR(32672)) ,  CAST(? AS DECIMAL(31, 2)) ,  CAST(? AS DATE) ,  CAST(? AS TIMESTAMP(6)) ,  CAST(? AS BOOLEAN)  '
      + 'FROM t WHERE id IN ( CAST(? AS DECIMAL(31, 0)) , CAST(? AS DECIMAL(31, 0)) ) AND t =  CAST(? AS VARCHAR(32672)) ');
    expect(binds.map((b) => [b.type, b.value])).toEqual([
      ['text', 'it\'s \\ here'], ['number', '-12.50'], ['date', '0099-02-28'], ['datetime', '2026-03-08 02:30:00.500000'], ['boolean', true],
      ['number', '1'], ['number', '2'], ['text', 'it\'s \\ here'],
    ]);
  });

  test('a number of more than 31 digits is refused, and a `?` written by hand', () => {
    expect(() => bindParameters('SELECT {{n}} FROM t', 'db2', { n: { type: 'number', value: '1'.repeat(32) } })).toThrow(/at most 31 digits/);
    expect(() => bindParameters('SELECT {{n}}, ? FROM t', 'db2', { n: { type: 'number', value: '1' } })).toThrow(ParameterError);
  });
});

describe('Db2\'s SQL runner session (R5)', () => {
  /** A JDBC driver's stand-in: what the session calls, in order. */
  function fakeDriver(rows: unknown[][][], fail?: Error) {
    const calls: unknown[][] = [];
    const statement = {
      columns: [{ name: 'A', type: 'DECIMAL(31,9)' }],
      done: false,
      async fetch(n: number) {
        calls.push(['fetch', n]);
        const next = rows.shift() ?? [];
        this.done = rows.length === 0;
        return next;
      },
      cancel() {
        calls.push(['cancel']);
      },
      async close() {
        calls.push(['statement.close']);
      },
    };
    const connection = {
      running: null as any,
      async execute(sql: string, binds: unknown[], seconds: number, fetchRows: number) {
        calls.push(['execute', sql, binds, seconds, fetchRows]);
        if (fail) {
          throw fail;
        }
        this.running = statement;
        return statement;
      },
      async close() {
        calls.push(['connection.close']);
      },
    };
    const driver = {
      async openConnection() {
        calls.push(['open']);
        return connection;
      },
      async release() {
        calls.push(['release']);
      },
    };
    return { driver, calls, statement };
  }

  const caps = { maxRows: 3, timeoutMs: 2500, maxBytes: 1024 * 1024 };
  const refuse = (message: string) => {
    throw new Error(message);
  };

  test('runs its statement with its binds and its time limit, reads to the cap, and lets everything go', async () => {
    const { driver, calls } = fakeDriver([[['1.000000000'], ['2.5']], [['3'], ['4']]]);
    const session = await openSession('db2', driver, caps, refuse);
    const rows = new RowCollector(caps.maxRows, caps.maxBytes);
    await session.run('SELECT A FROM T WHERE B = CAST(? AS VARCHAR(32672))', rows, [{ id: '1', type: 'text', value: 'x' }]);
    expect(rows.columns).toEqual([{ name: 'A', type: 'DECIMAL(31,9)' }]);
    expect(rows.rows).toEqual([['1.000000000'], ['2.5'], ['3']]);
    expect(rows.truncated).toBe('rows');
    await session.close();
    expect(calls).toEqual([
      ['open'],
      ['execute', 'SELECT A FROM T WHERE B = CAST(? AS VARCHAR(32672))', [{ type: 'text', value: 'x' }], 3, 4],
      ['fetch', 4],
      ['fetch', 2],
      ['statement.close'],
      ['connection.close'],
      ['release'],
    ]);
  });

  test('a cancel stops the statement on the database, without waiting', async () => {
    const { driver, calls } = fakeDriver([[['1']], [['2']]]);
    const session = await openSession('db2', driver, caps, refuse);
    await session.run('SELECT 1 FROM SYSIBM.SYSDUMMY1', new RowCollector(1, 1024), []);
    await session.cancel();
    expect(calls).toContainEqual(['cancel']);
  });

  test('its timeout: the driver\'s SQLTimeoutException, or SQLCODE -952 at the time limit (a cancel before it is a cancel)', () => {
    expect(isTimeout('db2', new JdbcError('timed out', 'timeout', '57014', -952))).toBe(true);
    const interrupted = new JdbcError('Processing was cancelled due to an interrupt', 'query', '57014', -952);
    expect(isTimeout('db2', interrupted, { ms: 9500, timeoutMs: 10000 })).toBe(true);
    expect(isTimeout('db2', interrupted, { ms: 3000, timeoutMs: 10000 })).toBe(false);
    expect(isTimeout('db2', new JdbcError('SQL0204N', 'query', '42704', -204), { ms: 10000, timeoutMs: 10000 })).toBe(false);
    expect(new JdbcError('x', 'query', '42704', -204).code).toBe('42704');
  });
});

describe('Db2\'s type, as Cube resolves it, and its export names (R7)', () => {
  test('Cube finds `db2`, and its dialect is xcube\'s', () => {
    const Found = CubejsServerCore.lookupDriverClass('db2' as any) as any;
    expect(Found.dialectClass()).toBe(XcubeDb2Query);
    expect(() => new Found()).toThrow(/made from its connection/);
    expect(dialectFactory()({ dbType: 'db2' })).toBe(XcubeDb2Query);
  });

  test('double quotes, the name exactly as the catalog gave it, and a name that can\'t be quoted refused', () => {
    expect(exportStatement('db2', { schema: 'Sales', table: 'my Table', columns: ['ID'] })).toBe('SELECT "ID" FROM "Sales"."my Table"');
    expect(() => exportStatement('db2', { table: 'a"b' })).toThrow(/can't be a name/);
  });
});

describe('xcube\'s Db2 dialect (R8)', () => {
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
    order: [{ id: 'f.name', desc: false }],
    rowLimit: 10,
    offset: 5,
  };

  test.each([['Tesseract', 'true'], ['the legacy planner', 'false']])('%s: quotes, TRUNC_TIMESTAMP to a quarter in the zone, GROUP BY expressions, LIKE lowered, OFFSET and FETCH FIRST', (_planner, tesseract) => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = tesseract;
    const [sql, params] = new XcubeDb2Query(compiled, { timezone: 'America/Los_Angeles', ...query }).buildSqlAndParams();
    expect(sql).toMatch(/FROM\s+SALES\.FACTS\s+AS "f"/);
    expect(sql).toContain('TRUNC_TIMESTAMP(CAST(FROM_UTC_TIMESTAMP("f".TS, \'America/Los_Angeles\') AS TIMESTAMP), \'Q\')');
    expect(sql).toMatch(/LOWER\("f"\.NAME\) LIKE LOWER\(.*\) ESCAPE '\\'/);
    expect(sql).not.toMatch(/GROUP BY\s+\d/);
    expect(sql).not.toMatch(/\bLIMIT\b|ILIKE/);
    expect(sql).toMatch(/OFFSET 5 ROWS\s+FETCH FIRST 10 ROWS ONLY/);
    expect(sql).toContain('CAST(REPLACE(REPLACE(?, \'T\', \' \'), \'Z\', \'\') AS TIMESTAMP)');
    expect(params.some((p: unknown) => String(p).includes('50'))).toBe(true);
    // Its values written in, as the driver does: a statement Db2's lexer reads whole.
    expect(classifySql(db2Inline(sql, params), 'db2').statement).toBe('select');
  });

  test('each granularity by TRUNC_TIMESTAMP, a week from Monday, an unknown one refused', () => {
    const q = new XcubeDb2Query(compiled, { timezone: 'UTC' });
    expect(['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'].map((g) => q.timeGroupedColumn(g, 'x')))
      .toEqual(['SS', 'MI', 'HH', 'DD', 'IW', 'MM', 'Q', 'YYYY'].map((f) => `TRUNC_TIMESTAMP(CAST(x AS TIMESTAMP), '${f}')`));
    expect(() => q.timeGroupedColumn('fortnight', 'x')).toThrow(/no fortnight granularity/);
  });

  test('a zone Db2 would leave unconverted is refused; UTC converts nothing', () => {
    expect(new XcubeDb2Query(compiled, { timezone: 'UTC' }).convertTz('x')).toBe('x');
    expect(new XcubeDb2Query(compiled, { timezone: 'Europe/Paris' }).convertTz('x')).toBe('FROM_UTC_TIMESTAMP(x, \'Europe/Paris\')');
    const q = new XcubeDb2Query(compiled, { timezone: 'UTC' });
    (q as any).timezone = 'Mars/Olympus_Mons';
    expect(() => q.convertTz('x')).toThrow(/IANA time zone/);
  });

  test('labeled durations a unit at a time, a quarter as three months, a week as seven days', () => {
    const q = new XcubeDb2Query(compiled, { timezone: 'UTC' });
    expect(q.addInterval('d', '1 quarter')).toBe('(d + 3 MONTHS)');
    expect(q.subtractInterval('d', '1 year 2 weeks')).toBe('((d - 1 YEARS) - 14 DAYS)');
  });
});
