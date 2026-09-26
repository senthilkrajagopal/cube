// Run inside the image (every Cube driver is installed there): builds each
// driver of a connection under a poisoned Cube and libpq environment, and
// fails if any poisoned value reached the driver's config. A connection's
// driver must use its own fields and secrets, never Cube's environment.
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

const cases = {
  postgres: [{ host: 'h', port: 5432, database: 'd', user: 'u', ssl: false }, 'password', { password: 'pw' }],
  'postgres (certificate)': [{ host: 'h', port: 5432, database: 'd', user: 'u', sslCert: 'c' }, 'client-certificate', { sslKey: 'k' }, 'postgres'],
  redshift: [{ host: 'h', port: 5439, database: 'd', user: 'u' }, 'password', { password: 'pw' }],
  mysql: [{ host: 'h', port: 3306, database: 'd', user: 'u' }, 'password', { password: 'pw' }],
  snowflake: [{ account: 'a', warehouse: 'w', database: 'd', username: 'u' }, 'key-pair', { privateKey: 'pk' }],
  'snowflake (oauth)': [{ account: 'a', warehouse: 'w', database: 'd' }, 'oauth', { oauthToken: 'tok' }, 'snowflake'],
  bigquery: [{ projectId: 'p' }, 'service-account', { credentials: JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: 'k' }) }],
  mssql: [{ host: 'h', port: 1433, database: 'd', user: 'u' }, 'sql-login', { password: 'pw' }],
  'mssql (ntlm)': [{ host: 'h', port: 1433, database: 'd', user: 'u', domain: 'dom' }, 'ntlm', { password: 'pw' }, 'mssql'],
  oracle: [{ host: 'h', port: 1521, database: 'd', user: 'u' }, 'password', { password: 'pw' }],
  dremio: [{ host: 'h', port: 9047, user: 'u' }, 'password', { password: 'pw' }],
  'dremio (cloud)': [{ url: 'https://api.dremio.cloud/v0/projects/p' }, 'token', { token: 'tok' }, 'dremio'],
};

const seen = (value) => {
  const found = new Set();
  const walk = (v, depth) => {
    if (depth > 6 || v === null || v === undefined) {
      return;
    }
    if (typeof v === 'string') {
      Object.values(POISON).filter((p) => p.length > 3 && v.includes(p)).forEach((p) => found.add(p));
    } else if (typeof v === 'object') {
      Object.values(v).forEach((x) => walk(x, depth + 1));
    }
  };
  walk(value, 0);
  return [...found];
};

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
      const leaked = seen(parts);
      if (driverType === 'redshift' && driver.credentials?.constructor.name !== 'RedshiftPlainCredentialsProvider') {
        leaked.push(`credentials from ${driver.credentials?.constructor.name}`);
      }
      console.log(`${leaked.length ? 'LEAK' : 'ok  '} ${name}${leaked.length ? `: ${leaked.join(', ')}` : ''}`);
      failed = failed || leaked.length > 0;
      await Promise.resolve(driver.release && driver.release()).catch(() => undefined);
    } catch (e) {
      console.log(`FAIL ${name}: ${e.message}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
})();
