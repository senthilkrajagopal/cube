// Run inside the image by test/image/duckdb.sh, on a network with no way out
// and an S3 store at `store:9000` (minioadmin/minioadmin). It fails if:
// - one of the image's DuckDB extensions doesn't load from the image, or one
//   could be downloaded;
// - an S3 connection on s3://lake/sales/ doesn't read its own files, or reads
//   anything else: another prefix or bucket, a local file, a URL;
// - a run's refusal of a file outside the source isn't `outside_source`.

const fs = require('fs');
const path = require('path');

const X = '/cube/node_modules/xcube/dist/src';
const { DRIVERS } = require(`${X}/connections/drivers`);
const { makeDuckdbDriver, duckdbApi } = require(`${X}/connections/duckdb`);
const { SqlRuns } = require(`${X}/sql/runs`);
const { SqlRunError } = require(`${X}/sql/runner`);
const { S3Client, CreateBucketCommand } = require('/cube/node_modules/@aws-sdk/client-s3');

const KEY = 'minioadmin';
const ENDPOINT = 'store:9000';
const REFUSED = /^Permission Error: Cannot access file .* file system operations are disabled by configuration/s;

let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  failed = failed || !ok;
};
const attempt = async (f) => {
  try {
    return { value: await f() };
  } catch (e) {
    return { error: String(e.message) };
  }
};
const firstLine = (r) => (r.error ? r.error.split('\n')[0] : JSON.stringify(r.value));

(async () => {
  const { DuckDBInstance } = duckdbApi();
  const dir = process.env.XCUBE_DUCKDB_EXTENSION_DIRECTORY;
  const offline = (d) => ({ extension_directory: d, autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' });

  // AC-1037: the extensions are the image's, for its platform.
  {
    const db = await DuckDBInstance.create(':memory:', offline(dir));
    const c = await db.connect();
    const [[version, platform]] = (await c.runAndReadAll('SELECT version(), (SELECT platform FROM pragma_platform())')).getRows();
    console.log(`DuckDB ${version} ${platform}, extensions in ${dir}`);
    // motherduck is left out: its LOAD calls api.motherduck.com, which a MotherDuck source needs anyway.
    for (const name of ['httpfs', 'aws', 'iceberg', 'avro']) {
      const r = await attempt(() => c.run(`LOAD ${name}`));
      check(`LOAD ${name}, offline`, !r.error, firstLine(r));
    }
    check('motherduck is in the image', fs.existsSync(path.join(dir, version, platform, 'motherduck.duckdb_extension')), 'missing');
    const loaded = (await c.runAndReadAll('SELECT install_path FROM duckdb_extensions() WHERE loaded AND extension_name = \'iceberg\'')).getRows();
    check('iceberg from the image', loaded.length === 1 && String(loaded[0][0]).startsWith(`${dir}/`), JSON.stringify(loaded));
    const out = await attempt(() => fetch('https://extensions.duckdb.org/', { signal: AbortSignal.timeout(5000) }).then((res) => res.status));
    check('nothing to download from', Boolean(out.error), `extensions.duckdb.org answered ${out.value}`);
    c.closeSync();
    db.closeSync();
  }

  // The store: lake/sales, and what the connection mustn't read.
  const s3 = new S3Client({
    region: 'us-east-1', endpoint: `http://${ENDPOINT}`, forcePathStyle: true, credentials: { accessKeyId: KEY, secretAccessKey: KEY },
  });
  for (let i = 0; ; i += 1) {
    const r = await attempt(() => s3.send(new CreateBucketCommand({ Bucket: 'lake' })));
    if (!r.error || i === 30) {
      break;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  await s3.send(new CreateBucketCommand({ Bucket: 'other' }));
  {
    const db = await DuckDBInstance.create(':memory:', offline(dir));
    const c = await db.connect();
    await c.run('LOAD httpfs');
    await c.run(`CREATE SECRET s (TYPE s3, KEY_ID '${KEY}', SECRET '${KEY}', REGION 'us-east-1', ENDPOINT '${ENDPOINT}', URL_STYLE 'path', USE_SSL false)`);
    for (const [file, n] of [['s3://lake/sales/a.parquet', 3], ['s3://lake/private/b.parquet', 5], ['s3://other/x.parquet', 7], ['s3://lake/salesx/c.parquet', 11]]) {
      await c.run(`COPY (SELECT range AS n FROM range(${n})) TO '${file}'`);
    }
    c.closeSync();
    db.closeSync();
  }

  // AC-1038: an S3 connection on s3://lake/sales/.
  const config = () => DRIVERS.duckdb.config(
    { kind: 's3', s3Location: 's3://lake/sales/', region: 'us-east-1', endpoint: ENDPOINT, urlStyle: 'path', ssl: false, accessKeyId: KEY },
    'access-key',
    { secretAccessKey: KEY },
  );
  const driver = makeDuckdbDriver(config());
  const tested = await attempt(() => driver.testConnection());
  check('testConnection', !tested.error, firstLine(tested));
  const count = (sql) => attempt(() => driver.query(sql, []).then(([row]) => Number(row.n)));
  for (const [from, n] of [['read_parquet(\'s3://lake/sales/a.parquet\')', 3], ['read_parquet(\'s3://lake/sales/*.parquet\')', 3]]) {
    const r = await count(`SELECT count(*) AS n FROM ${from}`);
    check(`reads ${from}`, r.value === n, firstLine(r));
  }
  for (const from of [
    'read_parquet(\'s3://lake/private/b.parquet\')',
    'read_parquet(\'s3://other/x.parquet\')',
    'read_parquet(\'s3://lake/salesx/c.parquet\')',
    'glob(\'s3://lake/*\')',
    'read_text(\'/etc/passwd\')',
    'read_csv(\'https://extensions.duckdb.org/\')',
  ]) {
    const r = await count(`SELECT count(*) AS n FROM ${from}`);
    check(`refuses ${from}`, Boolean(r.error && REFUSED.test(r.error)), firstLine(r));
  }
  const settings = await attempt(() => driver.query(
    'SELECT current_setting(\'enable_external_access\') AS e, current_setting(\'autoinstall_known_extensions\') AS i, '
    + 'current_setting(\'extension_directory\') AS d, current_setting(\'lock_configuration\') AS l',
    [],
  ));
  const [s] = settings.value ?? [{}];
  check(
    'external access off, no autoinstall, the image\'s extensions, locked',
    String(s.e) === 'false' && String(s.i) === 'false' && s.d === dir && String(s.l) === 'true',
    firstLine(settings),
  );
  await driver.release();

  // A run's refusal of a file outside the source.
  const runs = new SqlRuns('here', () => null, () => undefined);
  const target = { dialect: 'duckdb', label: 'lake', build: async () => ({ driver: makeDuckdbDriver(config()), secrets: [KEY] }) };
  try {
    await runs.run('m', target, { sql: 'SELECT * FROM read_parquet(\'s3://other/x.parquet\')', runId: 'outside', maxRows: 10, timeoutMs: 30000, maxBytes: 1 << 20 });
    check('a run outside the source is query_failed, outside_source', false, 'it ran');
  } catch (e) {
    if (!(e instanceof SqlRunError)) {
      throw e;
    }
    check('a run outside the source is query_failed, outside_source', e.code === 'query_failed' && e.reason === 'outside_source', `${e.code} ${e.reason}`);
  }

  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
