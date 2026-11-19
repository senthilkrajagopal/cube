// Run inside the image: the JVM and xcube's JDBC session (wechart's db_support
// R1–R2), without a Db2 server. PostgreSQL's JDBC driver stands in for a
// vendor's, mounted where Db2's would be: it is on the classpath, and Db2
// stays unavailable, as no jar holds its driver class.
//
//   offline (R1 test 1, with --network none):
//     docker run --rm --network none -v "$PWD/test/image:/t:ro" --entrypoint node <image> /t/jdbc.js offline
//   against a Postgres (R1 tests 1–4, R2 tests 1–2; read-only root, user 1000, /tmp alone writable):
//     docker run --rm --read-only --tmpfs /tmp --user 1000 --network <net> -v "$PWD/test/image:/t:ro" \
//       -v <dir holding db2/postgresql-42.x.jar>:/jdbc:ro -e XCUBE_JDBC_DRIVERS_DIR=/jdbc \
//       -e PG_HOST=<host> -e PG_USER=test -e PG_PASSWORD=… -e PG_DATABASE=test \
//       -e XCUBE_JDBC_TRUST_STORE=/etc/ssl/certs/ca-certificates.crt --entrypoint node <image> /t/jdbc.js
const fs = require('fs');
const { spawnSync } = require('child_process');

const X = '/cube/node_modules/xcube/dist/src';
const offline = process.argv[2] === 'offline';
let failed = false;

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  failed = failed || !ok;
};

/** The names of this process's threads; a JVM's are its own. */
const jvmThreads = () => fs.readdirSync('/proc/self/task').map((t) => {
  try {
    return fs.readFileSync(`/proc/self/task/${t}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}).filter((n) => /^(VM Thread|GC Thread|C[12] CompilerThre|Reference Handl|Finalizer|Common-Cleaner|VM Periodic)/.test(n));

const elapsed = (from) => Date.now() - from;

(async () => {
  const version = spawnSync('java', ['-version'], { encoding: 'utf8' });
  check('java -version reports 21', version.status === 0 && /version "21\./.test(version.stderr), version.stderr.split('\n')[0]);
  const legal = fs.readdirSync('/usr/lib/jvm').flatMap((d) => (fs.existsSync(`/usr/lib/jvm/${d}/legal`) ? [`/usr/lib/jvm/${d}/legal`] : []));
  check('the JRE\'s licence files are in the image', legal.length > 0, legal.join(', '));
  check('hive-driver loads', typeof require('/cube/node_modules/xcube/node_modules/hive-driver').HiveClient === 'function');
  check('UV_THREADPOOL_SIZE is 16', process.env.UV_THREADPOOL_SIZE === '16', String(process.env.UV_THREADPOOL_SIZE));

  // No JVM until a JDBC connection: reading the drivers and answering what is available start none (R1 test 2).
  const drivers = require(`${X}/connections/drivers.js`);
  const jvmModule = require(`${X}/connections/jvm.js`);
  const jdbc = require(`${X}/connections/jdbc.js`);
  const availability = drivers.driverAvailability();
  check('no JVM thread before a JDBC connection', jvmThreads().length === 0, jvmThreads().join(', '));
  const db2 = availability.find((d) => d.type === 'db2');
  check('db2 is unavailable without its driver class, with a reason (R2 tests 1–2)', db2 && db2.available === false && /db2/.test(db2.reason), JSON.stringify(db2));
  let refused = null;
  try {
    await jdbc.JdbcConnection.open({ type: 'db2', url: 'jdbc:db2://h:1/D', properties: {} });
  } catch (e) {
    refused = e;
  }
  check('a Db2 connection is refused driver_unavailable, and no JVM starts for it', refused instanceof jvmModule.DriverUnavailableError
    && jvmThreads().length === 0, String(refused && refused.message));

  const java = await jvmModule.jvm();
  check('require(\'java\') loads and its JVM starts, version 21', /^21\./.test(java.callStaticMethodSync('xcube.jdbc.Jdbc', 'javaVersion')));
  check('the JVM runs in UTC', java.callStaticMethodSync('java.lang.System', 'getProperty', 'user.timezone') === 'UTC');
  check('JVM threads once it started', jvmThreads().length > 0);
  if (offline) {
    process.exit(failed ? 1 : 0);
  }

  const jars = jvmModule.jdbcDrivers().jars.map((j) => j.file.replace(/.*\//, ''));
  check('the mounted jar is on the classpath', java.callStaticMethodSync('xcube.jdbc.Jdbc', 'provides', 'org.postgresql.Driver'), jars.join(', '));
  check('the trust store was installed', Boolean(process.env.XCUBE_JDBC_TRUST_STORE));

  const url = `jdbc:postgresql://${process.env.PG_HOST}:5432/${process.env.PG_DATABASE ?? 'test'}`;
  const props = (name) => ({ user: process.env.PG_USER ?? 'test', password: process.env.PG_PASSWORD ?? '', ApplicationName: name });
  const strings = (values) => java.newArray('java.lang.String', values);
  const open = async (name = 'xcube-jdbc-check') => new jdbc.JdbcConnection(java, await jdbc.inTurn(() => java.callStaticMethodP(
    'xcube.jdbc.Jdbc', 'connect', 'org.postgresql.Driver', url, strings(Object.keys(props(name))), strings(Object.values(props(name))), true,
  )));
  // A connection read on Node's own thread, outside its pool: what still answers while the pool is held.
  const probe = java.callStaticMethodSync('xcube.jdbc.Jdbc', 'connect', 'org.postgresql.Driver', url,
    strings(Object.keys(props('xcube-jdbc-probe'))), strings(Object.values(props('xcube-jdbc-probe'))), true);
  const probed = (sql) => {
    const run = java.newInstanceSync('xcube.jdbc.Run', probe);
    run.executeSync(sql, strings([]), strings([]), 30, 100);
    const rows = JSON.parse(run.fetchSync(100, 1000000));
    run.closeSync();
    return rows;
  };

  const c = await open();
  // Each cell in the SQL runner's form: a decimal's digits, a big integer as a string, wall times as held.
  const cells = await c.all(`SELECT 12345678901234567890.123456789::numeric(31,9) AS d, 9007199254740993::bigint AS big, 42::bigint AS small,
    7::int AS i, 'NaN'::float8 AS nan, 1.5::float8 AS f, 0.1::float4 AS r, true AS t, DATE '0099-02-28' AS day,
    TIMESTAMP '2026-03-08 02:30:00.5' AS ts, TIMESTAMPTZ '2026-03-08 02:30:00.5+05:30' AS tz, TIME '13:14:15.25' AS tm,
    '\\x00ff'::bytea AS bytes, E'it''s "q" \\\\ \\n\\u2028' AS s, NULL::int AS n`, [], 30);
  const expected = ['12345678901234567890.123456789', '9007199254740993', 42, 7, 'NaN', 1.5, 0.1, true, '0099-02-28',
    '2026-03-08 02:30:00.500000', '2026-03-07 21:00:00.500000+00:00', '13:14:15.250000', '\\x00ff', 'it\'s "q" \\ \n\u2028', null];
  check('cells: decimals, big integers, NaN, dates and times as held, bytes, text, null', JSON.stringify(cells.rows) === JSON.stringify([expected]),
    JSON.stringify(cells.rows));

  // Binds: a boolean as one, the rest as text, the SQL casting each.
  const bound = await c.all('SELECT CAST(? AS numeric) + 1, CAST(? AS boolean), CAST(? AS text)', [
    { type: 'number', value: '-12.50' }, { type: 'boolean', value: false }, { type: 'text', value: '\'; DROP TABLE x; --' },
  ], 30);
  check('binds', JSON.stringify(bound.rows) === JSON.stringify([['-11.50', false, '\'; DROP TABLE x; --']]), JSON.stringify(bound.rows));

  // Rows a batch at a time, the last batch short, then done.
  const s = await c.execute('SELECT g FROM generate_series(1, 25000) g', [], 30, 10000);
  const sizes = [];
  while (!s.done) {
    sizes.push((await s.fetch(10000)).length);
  }
  await s.close();
  check('rows read a batch at a time', JSON.stringify(sizes) === '[10000,10000,5000]' || JSON.stringify(sizes) === '[10000,10000,5000,0]', JSON.stringify(sizes));

  // The database's own time limit (setQueryTimeout).
  let started = Date.now();
  let timedOut = null;
  try {
    await c.execute('SELECT pg_sleep(20)', [], 1);
  } catch (e) {
    timedOut = e;
  }
  check('the statement\'s time limit ends it on the database', timedOut instanceof jdbc.JdbcError && elapsed(started) < 5000,
    `${elapsed(started)} ms, ${timedOut && timedOut.sqlState}: ${timedOut && timedOut.message}`);

  // A failure's words, its SQLSTATE and the connection still usable.
  let missing = null;
  try {
    await c.all('SELECT * FROM no_such_table', [], 30);
  } catch (e) {
    missing = e;
  }
  check('a query\'s failure: the driver\'s words and SQLSTATE; the connection kept', missing instanceof jdbc.JdbcError
    && missing.sqlState === '42P01' && /no_such_table/.test(missing.message) && !c.broken, `${missing && missing.sqlState}: ${missing && missing.message}`);

  // R1 test 4: more statements blocked on the source than Node's thread pool has threads; a cancel of one is on the
  // database at once, and Node keeps threads of its own throughout.
  const count = Number(process.env.UV_THREADPOOL_SIZE) + 1;
  const blocked = [];
  for (let i = 0; i < count; i++) {
    blocked.push(await open(`xcube-jdbc-check-${i}`));
  }
  const runs = blocked.map((b) => b.execute('SELECT pg_sleep(60)', [], 0).then(() => 'done', (e) => e));
  await new Promise((resolve) => {
    setTimeout(resolve, 1500);
  });
  started = Date.now();
  blocked[0].running.cancel();
  const first = await runs[0];
  check(`a cancel with ${count} statements blocked is on the database within 5 s`, first instanceof jdbc.JdbcError && elapsed(started) < 5000,
    `${elapsed(started)} ms, ${first && first.sqlState}: ${first && first.message}`);
  const active = probed('SELECT application_name FROM pg_stat_activity WHERE application_name LIKE \'xcube-jdbc-check-%\' AND state = \'active\' ORDER BY 1')
    .map((r) => r[0]);
  check('the cancelled statement is no longer running; at most JDBC_THREADS run at once', !active.includes('xcube-jdbc-check-0')
    && active.length > 0 && active.length <= jdbc.JDBC_THREADS, `${active.length} running, JDBC_THREADS ${jdbc.JDBC_THREADS}`);
  started = Date.now();
  await new Promise((resolve, reject) => {
    fs.readFile('/etc/hostname', (e) => (e ? reject(e) : resolve()));
  });
  check('Node\'s own thread pool work runs while they are blocked', elapsed(started) < 1000, `${elapsed(started)} ms`);
  blocked.slice(1).forEach((b) => b.running && b.running.cancel());
  await Promise.all(runs);
  await Promise.all([...blocked, c].map((b) => b.close()));
  probe.closeSync();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log(`FAIL ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
