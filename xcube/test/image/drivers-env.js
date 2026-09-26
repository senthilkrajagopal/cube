// Run inside the image (every Cube driver is installed there): builds each
// driver of a connection under a poisoned Cube and libpq environment. It
// fails if any poisoned value reached the driver's config, or if any of the
// connection's own fields and secrets didn't. A connection's driver must use
// its own fields and secrets, never Cube's environment, and the option names
// xcube passes them under are the driver's, which a Cube upgrade can change.
//
//   docker run --rm -v "$PWD/test/image:/t:ro" --entrypoint node <image> /t/drivers-env.js

const POISON = {
  CUBEJS_DB_HOST: 'poison-host',
  CUBEJS_DB_PORT: '1',
  CUBEJS_DB_NAME: 'poison-db',
  CUBEJS_DB_USER: 'poison-user',
  CUBEJS_DB_PASS: 'poison-pass',
  CUBEJS_DB_URL: 'https://poison-url',
  CUBEJS_DB_DOMAIN: 'poison-domain',
  CUBEJS_DB_SSL: 'true',
  CUBEJS_DB_EXPORT_BUCKET: 'poison-bucket',
  CUBEJS_DB_EXPORT_BUCKET_TYPE: 's3',
  CUBEJS_DB_EXPORT_BUCKET_AWS_KEY: 'poison-aws-key',
  CUBEJS_DB_EXPORT_BUCKET_AWS_SECRET: 'poison-aws-secret',
  CUBEJS_DB_EXPORT_BUCKET_AWS_REGION: 'us-east-1',
  CUBEJS_DB_BQ_PROJECT_ID: 'poison-project',
  CUBEJS_DB_BQ_KEY_FILE: '/poison-key-file',
  CUBEJS_DB_BQ_CREDENTIALS: Buffer.from(JSON.stringify({ type: 'service_account', client_email: 'poison@x', private_key: 'poison-key' })).toString('base64'),
  CUBEJS_DB_SNOWFLAKE_ACCOUNT: 'poison-account',
  CUBEJS_DB_SNOWFLAKE_PRIVATE_KEY_PATH: '/poison-private-key',
  CUBEJS_DB_SNOWFLAKE_OAUTH_TOKEN_PATH: '/poison-oauth-path',
  CUBEJS_DB_SNOWFLAKE_OAUTH_TOKEN: 'poison-oauth-token',
  CUBEJS_DB_SNOWFLAKE_AUTHENTICATOR: 'poison-authenticator',
  CUBEJS_DB_DREMIO_AUTH_TOKEN: 'poison-dremio-token',
  CUBEJS_DB_REDSHIFT_CLUSTER_IDENTIFIER: 'poison-cluster',
  CUBEJS_DB_REDSHIFT_AWS_REGION: 'us-east-1',
  PGPASSWORD: 'poison-pgpassword',
  PGHOST: 'poison-pghost',
};
Object.assign(process.env, POISON);
process.on('unhandledRejection', () => undefined); // SQL Server's driver connects in its constructor.

// The image's own modules: this script runs inside it.
// eslint-disable-next-line import/no-absolute-path
const { CubejsServerCore } = require('/cube/node_modules/@cubejs-backend/server-core');
// eslint-disable-next-line import/no-absolute-path
const { DRIVERS } = require('/cube/node_modules/xcube/dist/src/connections/drivers');

const SA = JSON.stringify({ type: 'service_account', client_email: 'xc-sa@example.iam', private_key: 'xc-sa-private-key', private_key_id: 'xc-sa-key-id', project_id: 'xc-project' });
const cases = {
  postgres: [{ host: 'xc-host', port: 5432, database: 'xc-db', user: 'xc-user', ssl: false }, 'password', { password: 'xc-password' }],
  'postgres (certificate)': [{ host: 'xc-host', port: 5432, database: 'xc-db', user: 'xc-user', sslCert: 'xc-cert' }, 'client-certificate', { sslKey: 'xc-ssl-key' }, 'postgres'],
  redshift: [{ host: 'xc-host', port: 5439, database: 'xc-db', user: 'xc-user' }, 'password', { password: 'xc-password' }],
  mysql: [{ host: 'xc-host', port: 3306, database: 'xc-db', user: 'xc-user' }, 'password', { password: 'xc-password' }],
  snowflake: [{ account: 'xc-account', warehouse: 'xc-warehouse', database: 'xc-db', username: 'xc-user' }, 'key-pair', { privateKey: 'xc-private-key' }],
  'snowflake (oauth)': [{ account: 'xc-account', warehouse: 'xc-warehouse', database: 'xc-db' }, 'oauth', { oauthToken: 'xc-oauth-token' }, 'snowflake'],
  bigquery: [{ projectId: 'xc-project' }, 'service-account', { credentials: SA }],
  mssql: [{ host: 'xc-host', port: 1433, database: 'xc-db', user: 'xc-user' }, 'sql-login', { password: 'xc-password' }],
  'mssql (ntlm)': [{ host: 'xc-host', port: 1433, database: 'xc-db', user: 'xc-user', domain: 'xc-domain' }, 'ntlm', { password: 'xc-password' }, 'mssql'],
  oracle: [{ host: 'xc-host', port: 1521, database: 'xc-db', user: 'xc-user' }, 'password', { password: 'xc-password' }],
  dremio: [{ host: 'xc-host', port: 9047, user: 'xc-user' }, 'password', { password: 'xc-password' }],
  'dremio (cloud)': [{ url: 'https://xc-dremio.example/v0/projects/p' }, 'token', { token: 'xc-token' }, 'dremio'],
};

// Each value the connection gives, as the driver would hold it: a JSON secret by its values.
const given = (fields, secrets) => [...Object.values(fields), ...Object.values(secrets)]
  .flatMap((v) => {
    try {
      const parsed = typeof v === 'string' ? JSON.parse(v) : null;
      return parsed && typeof parsed === 'object' ? Object.values(parsed) : [v];
    } catch {
      return [v];
    }
  })
  .filter((v) => typeof v === 'string' && v.includes('xc-'));

// Which of `values` appear in any string within `value`.
const seen = (value, values) => {
  const found = new Set();
  const walk = (v, depth) => {
    if (depth > 6 || v === null || v === undefined) {
      return;
    }
    if (typeof v === 'string') {
      values.filter((p) => v.includes(p)).forEach((p) => found.add(p));
    } else if (typeof v === 'object') {
      Object.values(v).forEach((x) => walk(x, depth + 1));
    }
  };
  walk(value, 0);
  return [...found];
};
const POISONED = Object.values(POISON).filter((p) => p.length > 3);

(async () => {
  let failed = false;
  for (const [name, [fields, auth, secrets, type]] of Object.entries(cases)) {
    const driverType = type || name;
    const spec = DRIVERS[driverType];
    // BigQuery's constructor refuses an export bucket type it can't use: poison it with one it can.
    process.env.CUBEJS_DB_EXPORT_BUCKET_TYPE = driverType === 'bigquery' ? 'gcp' : POISON.CUBEJS_DB_EXPORT_BUCKET_TYPE;
    try {
      const driver = CubejsServerCore.createDriver(spec.cubeType, { ...spec.config(fields, auth, secrets), dataSource: 'conn_x', maxPoolSize: 1 });
      const parts = [driver.config, driver.options, driver.poolConfig];
      if (driver.credentials && typeof driver.credentials.getCredentials === 'function') {
        parts.push(await driver.credentials.getCredentials());
        parts.push({ provider: driver.credentials.constructor.name });
      }
      const leaked = seen(parts, POISONED);
      if (driverType === 'redshift' && driver.credentials?.constructor.name !== 'RedshiftPlainCredentialsProvider') {
        leaked.push(`credentials from ${driver.credentials?.constructor.name}`);
      }
      const expected = given(fields, secrets);
      const reached = seen(parts, expected);
      const dropped = expected.filter((v) => !reached.includes(v));
      const problems = [
        ...(leaked.length ? [`took ${leaked.join(', ')}`] : []),
        ...(dropped.length ? [`dropped ${dropped.join(', ')}`] : []),
      ];
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
      failed = failed || problems.length > 0;
      await Promise.resolve(driver.release && driver.release()).catch(() => undefined);
    } catch (e) {
      console.log(`FAIL ${name}: ${e.message}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
})();
