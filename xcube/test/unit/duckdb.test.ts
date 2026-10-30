import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { DRIVERS } from '../../src/connections/drivers';
import {
  DuckdbPool, duckdbApi, duckdbPool, duckdbSettingsFromEnv, makeDuckdbDriver, readbackProblem, sizeInBytes, volumeFile,
  type PoolOwner, type XcubeDuckDBDriver,
} from '../../src/connections/duckdb';
import { bindParameters } from '../../src/sql/parameters';
import { openSession, RowCollector, type SqlCaps } from '../../src/sql/runner';
import { SqlRuns, type SqlTarget } from '../../src/sql/runs';

// Read once, at an instance's first set-up: before any here.
const root = path.join(os.tmpdir(), `xcube-duckdb-${process.pid}`);
const volume = path.join(root, 'volume');
const tempRoot = path.join(root, 'temp');
process.env.XCUBE_DUCKDB_TEMP_ROOT = tempRoot;
process.env.XCUBE_DUCKDB_VOLUMES = volume;
process.env.XCUBE_DUCKDB_MAX_OPEN = '2';

class Owner implements PoolOwner {
  public closed = 0;

  public isStale = false;

  public async closeInstance() {
    this.closed++;
  }

  public stale() {
    return this.isStale;
  }
}

describe('DuckDB settings', () => {
  test('sizes as DuckDB takes and shows them', () => {
    expect(sizeInBytes('2GiB')).toBe(2 ** 31);
    expect(sizeInBytes('1.8 GiB')).toBeCloseTo(1.8 * 2 ** 30);
    expect(sizeInBytes('2GB')).toBe(2e9);
    expect(sizeInBytes('512 mb')).toBe(512e6);
    expect(sizeInBytes('2 jigs')).toBeNull();
    expect(sizeInBytes('GiB')).toBeNull();
  });

  test('the defaults, and a value that isn\'t one refused', () => {
    expect(duckdbSettingsFromEnv({})).toEqual({
      memoryLimit: '2GiB', threads: 2, maxTempDirectorySize: '10GiB', tempRoot: '/tmp/xcube-duckdb', maxOpen: 4, volumes: [],
      extensionDirectory: null,
    });
    expect(duckdbSettingsFromEnv({ XCUBE_DUCKDB_MEMORY_LIMIT: '512 MB', XCUBE_DUCKDB_VOLUMES: '/data/a, /data/b/' }))
      .toMatchObject({ memoryLimit: '512MB', volumes: ['/data/a', '/data/b'] });
    const refused: [Record<string, string>, string][] = [
      [{ XCUBE_DUCKDB_MEMORY_LIMIT: '2 jigs' }, 'XCUBE_DUCKDB_MEMORY_LIMIT must be a size, such as 2GiB or 512MiB, not "2 jigs"'],
      [{ XCUBE_DUCKDB_MAX_TEMP_DIRECTORY_SIZE: '-1GB' }, 'XCUBE_DUCKDB_MAX_TEMP_DIRECTORY_SIZE must be a size'],
      [{ XCUBE_DUCKDB_THREADS: '0' }, 'XCUBE_DUCKDB_THREADS must be a whole number from 1 to 256, not "0"'],
      [{ XCUBE_DUCKDB_THREADS: '1.5' }, 'XCUBE_DUCKDB_THREADS must be a whole number'],
      [{ XCUBE_DUCKDB_MAX_OPEN: '1001' }, 'XCUBE_DUCKDB_MAX_OPEN must be a whole number from 1 to 1000'],
      [{ XCUBE_DUCKDB_TEMP_ROOT: 'tmp' }, 'XCUBE_DUCKDB_TEMP_ROOT must hold absolute directories, not "tmp"'],
      [{ XCUBE_DUCKDB_VOLUMES: '/a,b' }, 'XCUBE_DUCKDB_VOLUMES must hold absolute directories, not "b"'],
      [{ XCUBE_DUCKDB_VOLUMES: '/a\'b' }, 'XCUBE_DUCKDB_VOLUMES must hold absolute directories'],
      [{ XCUBE_DUCKDB_EXTENSION_DIRECTORY: 'ext' }, 'XCUBE_DUCKDB_EXTENSION_DIRECTORY must hold absolute directories, not "ext"'],
    ];
    for (const [env, message] of refused) {
      expect(() => duckdbSettingsFromEnv(env)).toThrow(message);
    }
  });

  test('the readback: sizes as DuckDB shows them, cut to one decimal; directories among those allowed', () => {
    const actual = new Map([
      ['memory_limit', '2.0 GiB'], ['max_temp_directory_size', '1.8 GiB'], ['threads', '2'], ['temp_directory', '/t/i-1'],
      ['allowed_directories', '["/t/i-1/","s3://lake/sales/"]'], ['lock_configuration', 'true'],
    ]);
    expect(readbackProblem(actual, {
      memory_limit: { bytes: 2 ** 31 },
      // 2GB, as DuckDB shows it.
      max_temp_directory_size: { bytes: 2e9 },
      threads: { is: '2' },
      temp_directory: { is: '/t/i-1/' },
      allowed_directories: { within: ['s3://lake/sales/', '/t/i-1/'] },
      lock_configuration: { is: 'true' },
    })).toBeNull();
    expect(readbackProblem(actual, { threads: { is: '4' } })).toBe('threads reads back as "2", not "4"');
    expect(readbackProblem(actual, { memory_limit: { bytes: 4 * 2 ** 30 } })).toBe(`memory_limit reads back as "2.0 GiB", not ${4 * 2 ** 30} bytes`);
    expect(readbackProblem(actual, { allowed_directories: { within: ['/t/i-1/'] } }))
      .toBe('allowed_directories holds s3://lake/sales/, which set-up didn\'t allow');
    expect(readbackProblem(actual, { access_mode: { is: 'read_only' } })).toBe('access_mode isn\'t among its settings');
  });
});

describe('the pod\'s DuckDB pool', () => {
  test('past its cap, the least recently used idle instance is closed for a new one', async () => {
    const pool = new DuckdbPool(2);
    const [a, b, c] = [new Owner(), new Owner(), new Owner()];
    (await pool.hold(a, 0))();
    (await pool.hold(b, 0))();
    const letC = await pool.hold(c, 0);
    expect([a.closed, b.closed, c.closed]).toEqual([1, 0, 0]);
    expect(pool.stats()).toEqual({ open: 2, max: 2, busy: 1, waiting: 0 });
    // Two holds of one owner share its instance.
    const letC2 = await pool.hold(c, 0);
    expect(pool.stats()).toMatchObject({ open: 2, busy: 1 });
    letC();
    letC2();
    // Letting go twice counts once.
    letC();
    expect(pool.stats()).toMatchObject({ open: 2, busy: 0 });
  });

  test('every instance busy: a hold waits for one to come free, as long as it was given', async () => {
    const pool = new DuckdbPool(1);
    const [a, b] = [new Owner(), new Owner()];
    const letA = await pool.hold(a, 0);
    await expect(pool.hold(b, 20)).rejects
      .toThrow('Every one of the pod\'s 1 DuckDB instances is in use (XCUBE_DUCKDB_MAX_OPEN), and none came free in 0 s');
    const waiting = pool.hold(b, 5000);
    expect(pool.stats()).toEqual({ open: 1, max: 1, busy: 1, waiting: 1 });
    letA();
    const letB = await waiting;
    expect(a.closed).toBe(1);
    expect(pool.stats()).toEqual({ open: 1, max: 1, busy: 1, waiting: 0 });
    letB();
  });

  test('a stale instance is closed before its next use; a released owner\'s waits fail', async () => {
    const pool = new DuckdbPool(1);
    const [a, b] = [new Owner(), new Owner()];
    (await pool.hold(a, 0))();
    a.isStale = true;
    const letA = await pool.hold(a, 0);
    expect(a.closed).toBe(1);
    const waiting = pool.hold(b, 5000);
    pool.forget(b);
    await expect(waiting).rejects.toThrow('The DuckDB data source was let go while it waited for an instance');
    pool.forget(a);
    expect(pool.stats()).toEqual({ open: 0, max: 1, busy: 0, waiting: 0 });
    letA();
  });
});

describe('a volume\'s file', () => {
  beforeAll(async () => {
    await mkdir(path.join(volume, 'sub'), { recursive: true });
    await mkdir(`${volume}-old`, { recursive: true });
    await writeFile(path.join(volume, 'sub', 'a.duckdb'), '');
    await writeFile(`${volume}-old/b.duckdb`, '');
    // A link out of the volume, to a file that is there.
    await symlink(`${volume}-old/b.duckdb`, path.join(volume, 'out.duckdb'));
  });

  test('must be a regular file under an allowed directory, after links are followed', async () => {
    const file = path.join(volume, 'sub', 'a.duckdb');
    await expect(volumeFile(file, [])).rejects.toThrow('no volume directory is allowed in this deployment');
    expect(await volumeFile(file, [volume])).toMatch(/\/sub\/a\.duckdb$/);
    await expect(volumeFile(`${volume}-old/b.duckdb`, [volume])).rejects.toThrow('isn\'t under a directory allowed for volumes (XCUBE_DUCKDB_VOLUMES)');
    await expect(volumeFile(path.join(volume, 'out.duckdb'), [volume])).rejects.toThrow('isn\'t under a directory allowed for volumes');
    await expect(volumeFile(path.join(volume, 'sub'), [volume])).rejects.toThrow('isn\'t a regular file');
    await expect(volumeFile(path.join(volume, 'none.duckdb'), [volume])).rejects.toThrow('doesn\'t exist, or can\'t be read');
  });
});

describe('xcube\'s DuckDB driver, in process', () => {
  const file = path.join(volume, 'shop.duckdb');
  let driver: XcubeDuckDBDriver;

  beforeAll(async () => {
    await mkdir(volume, { recursive: true });
    const { DuckDBInstance } = duckdbApi();
    const db = await DuckDBInstance.create(file);
    const c = await db.connect();
    await c.run('CREATE TABLE orders AS SELECT range AS id, range * 0.25 AS amount, DATE \'2024-01-01\' + range::INT AS day FROM range(10)');
    c.closeSync();
    db.closeSync();
    driver = makeDuckdbDriver(DRIVERS.duckdb.config({ kind: 'volume', path: file }, 'none', {}));
    for (const name of ['AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI']) {
      delete process.env[name];
    }
  });

  afterAll(async () => {
    await driver?.release();
    await rm(root, { recursive: true, force: true });
  });

  const fails = (sql: string) => expect(driver.query(sql, [])).rejects.toThrow();

  test('a volume: set up, its file read-only, the pod\'s files and its settings out of reach', async () => {
    await driver.testConnection();
    expect((await driver.query<any>('SELECT count(*) AS n FROM orders', [])).map((r) => String(r.n))).toEqual(['10']);
    // AC-1035: the pod's limits, as DuckDB shows them.
    const [limits] = await driver.query<any>('SELECT current_setting(\'memory_limit\') AS m, current_setting(\'max_temp_directory_size\') AS t, '
      + 'current_setting(\'threads\') AS n, current_setting(\'access_mode\') AS a', []);
    expect([limits.m, limits.t, String(limits.n), limits.a]).toEqual(['2.0 GiB', '10.0 GiB', '2', 'read_only']);
    await expect(driver.query('SELECT * FROM read_csv(\'/etc/hosts\')', [])).rejects.toThrow(/disabled by configuration|Permission Error/);
    await expect(driver.query('SELECT * FROM glob(\'/*\')', [])).rejects.toThrow(/disabled by configuration/);
    await fails('SET enable_external_access = true');
    await fails('SET memory_limit = \'8GiB\'');
    await fails(`ATTACH '${path.join(root, 'other.duckdb')}' AS other`);
    await fails('INSTALL httpfs');
    await fails('CREATE TABLE more (a INT)');
    await fails('INSERT INTO orders SELECT * FROM orders');
    await fails(`COPY (SELECT 1 AS a) TO '${path.join(root, 'out.csv')}'`);
    expect(duckdbPool().stats()).toMatchObject({ open: 1, busy: 0 });
  });

  test('what the lock leaves: a COPY into the instance\'s own temp directory, wiped when it closes', async () => {
    const [{ dir }] = await driver.query<any>('SELECT current_setting(\'temp_directory\') AS dir', []);
    expect(dir.startsWith(`${await realpath(tempRoot)}/i-`)).toBe(true);
    await driver.query(`COPY (SELECT 1 AS a) TO '${dir}/out.csv'`, []);
    expect(await readdir(dir)).toContain('out.csv');
    await driver.closeInstance();
    await expect(stat(dir)).rejects.toThrow(/ENOENT/);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test('a set-up that fails names its step, keeps no instance, and gives its place up', async () => {
    const outside = makeDuckdbDriver(DRIVERS.duckdb.config({ kind: 'volume', path: '/etc/hosts' }, 'none', {}));
    await expect(outside.testConnection()).rejects
      .toThrow('DuckDB set-up failed at volume: /etc/hosts isn\'t under a directory allowed for volumes (XCUBE_DUCKDB_VOLUMES)');
    const podRole = makeDuckdbDriver({
      kind: 's3', s3: { location: 's3://lake/sales/', region: 'eu-west-1', urlStyle: 'vhost', useSsl: true, podRole: true },
    });
    await expect(podRole.query('SELECT 1', [])).rejects.toThrow(/^DuckDB set-up failed at source: The Cube pods have no role of their own/);
    expect(duckdbPool().stats()).toMatchObject({ busy: 0, waiting: 0 });
    expect(await readdir(tempRoot)).toEqual([]);
    await outside.release();
    await podRole.release();
  });

  test('the SQL runner: its own connection, held in the pool; binds as $n; read to the row cap', async () => {
    const caps: SqlCaps = { maxRows: 3, timeoutMs: 30000, maxBytes: 1024 * 1024 };
    const session = await openSession('duckdb', driver, caps, (m: string): never => {
      throw new Error(m);
    });
    expect(duckdbPool().stats()).toMatchObject({ busy: 1 });
    const { sql, binds } = bindParameters(
      'SELECT id, amount, day, {{flag}} AS flag, {{who}} AS who FROM orders WHERE amount >= {{min}} AND day < {{before}} ORDER BY id',
      'duckdb',
      {
        flag: { type: 'boolean', value: true },
        who: { type: 'text', value: '\'); DROP TABLE orders; --' },
        min: { type: 'number', value: '0.50' },
        before: { type: 'date', value: '2024-01-09' },
      },
    );
    const rows = new RowCollector(caps.maxRows, caps.maxBytes);
    await session.run(sql, rows, binds);
    expect(rows.columns).toEqual([
      { name: 'id', type: 'BIGINT' }, { name: 'amount', type: 'DECIMAL(22,2)' }, { name: 'day', type: 'DATE' },
      { name: 'flag', type: 'BOOLEAN' }, { name: 'who', type: 'VARCHAR' },
    ]);
    // Big integers and decimals as strings, dates as their days.
    expect(rows.rows).toEqual([
      ['2', '0.50', '2024-01-03', true, '\'); DROP TABLE orders; --'],
      ['3', '0.75', '2024-01-04', true, '\'); DROP TABLE orders; --'],
      ['4', '1.00', '2024-01-05', true, '\'); DROP TABLE orders; --'],
    ]);
    expect(rows.truncated).toBe('rows');
    await session.close();
    expect(duckdbPool().stats()).toMatchObject({ busy: 0 });
  });

  test('the SQL runner: a cancel interrupts the query', async () => {
    const caps: SqlCaps = { maxRows: 10, timeoutMs: 30000, maxBytes: 1024 * 1024 };
    const session = await openSession('duckdb', driver, caps, (m: string): never => {
      throw new Error(m);
    });
    const running = session.run('SELECT sum(a.range * b.range) FROM range(100000) a, range(100000) b', new RowCollector(10, caps.maxBytes));
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    const started = Date.now();
    await session.cancel();
    await expect(running).rejects.toThrow(/Interrupted/);
    expect(Date.now() - started).toBeLessThan(5000);
    await session.close();
    expect(duckdbPool().stats()).toMatchObject({ busy: 0 });
  });

  test('the SQL runner: a file outside the source refused by DuckDB, as a query_failed with reason outside_source', async () => {
    const target: SqlTarget = {
      dialect: 'duckdb',
      label: 'shop',
      build: async () => ({ driver: makeDuckdbDriver(DRIVERS.duckdb.config({ kind: 'volume', path: file }, 'none', {})), secrets: [] }),
    };
    const runs = new SqlRuns('here', () => null, () => undefined);
    const request = (sql: string) => ({ sql, runId: 'r1', maxRows: 10, timeoutMs: 30000, maxBytes: 1024 * 1024 });
    for (const sql of ['SELECT * FROM read_csv(\'/etc/hosts\')', 'SELECT * FROM glob(\'/*\')', 'SELECT * FROM read_parquet(\'s3://lake/a.parquet\')']) {
      await expect(runs.run('m', target, request(sql))).rejects.toMatchObject({
        code: 'query_failed', reason: 'outside_source', refused: null, message: expect.stringMatching(/^Permission Error: Cannot access file .*disabled by configuration/),
      });
    }
    await expect(runs.run('m', target, request('SELECT * FROM missing'))).rejects.toMatchObject({ code: 'query_failed', reason: null });
    // The classifier's, before DuckDB: named.
    await expect(runs.run('m', target, request('SELECT * FROM enable_logging()'))).rejects.toMatchObject({
      code: 'not_read_only', refused: { kind: 'function', name: 'enable_logging' },
    });
    expect(duckdbPool().stats()).toMatchObject({ busy: 0 });
  });
});

describe('DuckDB\'s max_temp_directory_size, under xcube\'s lock (a known, accepted gap)', () => {
  test('bounds a spill, but not a COPY into the temp directory', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'xcube-cap-')));
    const { DuckDBInstance } = duckdbApi();
    const db = await DuckDBInstance.create(':memory:');
    const c = await db.connect();
    try {
      // As xcube sets an instance up, but with a cap of 1MiB.
      for (const sql of [
        'SET memory_limit = \'64MiB\'', 'SET threads = 1', `SET temp_directory = '${dir}'`, 'SET max_temp_directory_size = \'1MiB\'',
        'SET preserve_insertion_order = false', 'SET allowed_directories = []', 'SET enable_external_access = false', 'SET lock_configuration = true',
      ]) {
        await c.run(sql);
      }
      await c.run(`COPY (SELECT range AS a, md5(range::VARCHAR) AS b FROM range(100000)) TO '${dir}/big.csv'`);
      expect((await stat(path.join(dir, 'big.csv'))).size).toBeGreaterThan(2 * 2 ** 20);
      await expect(c.run('SELECT count(*) FROM (SELECT md5(range::VARCHAR) AS b FROM range(3000000) ORDER BY b)'))
        .rejects.toThrow(/^Out of Memory Error: .*max_temp_directory_size/s);
    } finally {
      c.closeSync();
      db.closeSync();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
