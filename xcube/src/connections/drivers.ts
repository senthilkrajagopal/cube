/**
 * The data-source drivers a connection may use, their fields as the client's
 * form names them, and each one's config for Cube's own driver.
 *
 * Every config is complete: each key the driver would otherwise read from
 * Cube's environment (`CUBEJS_DB_*`, which a data-source name maps onto when
 * `CUBEJS_DATASOURCES` is unset) is set, `undefined` where the connection
 * leaves it empty. A driver spreads its config over those defaults, so none
 * of them reaches a connection.
 */
import { CubejsServerCore } from '@cubejs-backend/server-core';
import { keyByDataSource } from '@cubejs-backend/shared';

import { makeAthenaDriver } from './athena';
import { makeClickHouseDriver } from './clickhouse';
import { makeDuckdbDriver } from './duckdb';
import { withoutEnv } from './env';
import { makeTrinoDriver } from './trino';

export const DRIVER_TYPES = [
  'postgres', 'redshift', 'mysql', 'snowflake', 'bigquery', 'mssql', 'oracle', 'dremio', 'duckdb', 'clickhouse', 'trino', 'athena',
] as const;

export type DriverType = (typeof DRIVER_TYPES)[number];

export interface FieldSpec {
  key: string;
  kind: 'text' | 'number' | 'boolean' | 'multiline';
  required?: boolean;
  /** Sealed by the client, opened only here. */
  secret?: boolean;
}

export interface DriverSpec {
  /** Cube's driver type (`lookupDriverClass`). */
  cubeType: string;
  connection: FieldSpec[];
  auth: Record<string, FieldSpec[]>;
  /**
   * The fields that say where it connects and how it checks the server: what
   * a sealed secret is bound to (scheme v1: frozen per driver, `credentials.ts`).
   */
  target: string[];
  /** Cube's driver config from the connection's fields and opened secrets. */
  config(fields: Fields, authMethod: string, secrets: Record<string, string>): Record<string, unknown>;
  /** What is wrong with the fields beyond a required one missing: each problem, worded for the form. */
  check?(fields: Fields, authMethod: string): string[];
  /** Builds the driver from its config, where it isn't Cube's own as `createDriver` makes it. */
  make?(config: Record<string, unknown>): any;
}

export type Fields = Record<string, string | number | boolean | null | undefined>;

const text = (key: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, kind: 'text', ...extra });
const secret = (key: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, kind: 'text', required: true, secret: true, ...extra });

const str = (value: unknown): string | undefined => (value === undefined || value === null || value === '' ? undefined : String(value));
const num = (value: unknown, fallback: number): number => {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`port must be a number from 1 to 65535, not ${JSON.stringify(value)}`);
  }
  return n;
};
const bool = (value: unknown, fallback: boolean): boolean => (value === undefined || value === null || value === '' ? fallback : value === true || value === 'true');

/** A TLS config from the Postgres-family fields: `false` when TLS is off. */
function tls(fields: Fields, secrets: Record<string, string>, clientCert: boolean, byDefault: boolean) {
  if (!bool(fields.ssl, byDefault)) {
    return false;
  }
  return {
    rejectUnauthorized: bool(fields.sslRejectUnauthorized, true),
    ca: str(fields.sslCa),
    cert: clientCert ? str(fields.sslCert) : undefined,
    key: clientCert ? str(secrets.sslKey) : undefined,
    passphrase: clientCert ? str(secrets.sslPassphrase) : undefined,
    servername: undefined,
    ciphers: undefined,
  };
}

/**
 * TLS settings a secret is sealed to, as its host is: changing one needs the
 * secret entered again, so an editor can't turn verification off and leave
 * the password usable against an attacker in between (wechart's decision).
 */
const TLS_TARGET = ['ssl', 'sslRejectUnauthorized', 'sslCa'];

/**
 * Cube's TLS settings, a data source's too (`CUBEJS_DB_SSL`, `_CA`, `_CERT`,
 * `_KEY`, `_CIPHERS`, `_PASSPHRASE`, `_SERVERNAME`, `_REJECT_UNAUTHORIZED`;
 * `CUBEJS_DS_<name>_[PRE_AGGREGATIONS_]DB_SSL…`).
 */
const CUBE_TLS = /^CUBEJS_(DS_.+_)?DB_SSL/;

/**
 * Builds Cube's own driver with Cube's TLS settings out of sight: its
 * constructor reads them (`getSslOptions`) before the config's `ssl` replaces
 * them, and reads, or fails on, the files they name.
 */
const withoutCubeTls = (
  cubeType: string,
  standIns: (config: Record<string, unknown>) => Record<string, string> = () => ({}),
) => (config: Record<string, unknown>) => {
  const env = standIns(config);
  return withoutEnv(
    [CUBE_TLS, ...Object.keys(env).map(key => new RegExp(`^${key}$`))],
    env,
    () => CubejsServerCore.createDriver(cubeType as any, config as any),
  );
};

/**
 * Cube's Redshift driver names its database in SHOW SCHEMAS, SHOW TABLES and
 * SHOW COLUMNS from its environment only (`CUBEJS_DB_NAME`, under the data
 * source's name): the connection's, in its place.
 */
const redshiftDatabase = (config: Record<string, unknown>) => ({
  [keyByDataSource('CUBEJS_DB_NAME', config.dataSource as string | undefined, Boolean(config.preAggregations))]: String(config.database),
});

const tlsFields = [
  text('ssl', { kind: 'boolean' }),
  text('sslRejectUnauthorized', { kind: 'boolean' }),
  text('sslCa', { kind: 'multiline' }),
];

const clientCertificate = [
  text('user', { required: true }),
  text('sslCert', { kind: 'multiline', required: true }),
  secret('sslKey', { kind: 'multiline' }),
  secret('sslPassphrase', { required: false }),
];

/**
 * What the DuckDB, ClickHouse, Trino and Athena drivers write unescaped into
 * the SQL that reads their catalogs: a name holding a quote, `;`, a backslash,
 * whitespace, or the start of a comment is refused.
 */
const UNSAFE_NAME = /['"`;\\\s]|--|\/\*/;

const unsafeNames = (fields: Fields, keys: string[]) => keys
  .filter((key) => typeof fields[key] === 'string' && UNSAFE_NAME.test(fields[key] as string))
  .map((key) => `${key} can't hold a quote, a semicolon, a backslash, whitespace, -- or /*`);

/**
 * A host alone, a name or an address: the ClickHouse and Trino clients make a
 * URL of it, and read settings, credentials and paths out of one.
 */
function hostProblems(fields: Fields): string[] {
  const host = str(fields.host);
  return host === undefined || /^\[[0-9A-Fa-f:.]+\]$/.test(host) || !/[/@?#:%\\\s]/.test(host)
    ? []
    : ['host must be a host name or address alone, with no scheme, port, path, user or query'];
}

const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const S3_URI = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](\/[^\s'"\\*?[\]{}]*)?$/;
const DOT_SEGMENT = /\/\.\.?(\/|$)/;

const s3Problems = (fields: Fields, key: string, what: string) => {
  const value = str(fields[key]);
  return value === undefined || (S3_URI.test(value) && !DOT_SEGMENT.test(value.slice(5)))
    ? []
    : [`${key} must be ${what}`];
};

/** Whether this deployment lets a data source sign in as the Cube pods' own AWS role (`XCUBE_ALLOW_POD_ROLE`). */
export const podRoleAllowed = () => process.env.XCUBE_ALLOW_POD_ROLE === 'true';

const podRoleProblems = (auth: string) => (auth === 'pod-role' && !podRoleAllowed()
  ? ['Signing in as the Cube pods\' role isn\'t allowed in this deployment (XCUBE_ALLOW_POD_ROLE)']
  : []);

/**
 * The config, once its fields pass the driver's own check: a stored
 * connection is checked again when it is built, as the deployment may have
 * turned off what it allowed.
 */
function checked(spec: Pick<DriverSpec, 'check'>, fields: Fields, authMethod: string) {
  const problems = spec.check?.(fields, authMethod) ?? [];
  if (problems.length) {
    throw new Error(problems.join('; '));
  }
}

/** Where a DuckDB data source reads from: its fields, and the sign-ins each takes. */
const DUCKDB_KINDS: Record<string, { fields: string[]; required: string[]; auth: string[] }> = {
  s3: { fields: ['s3Location', 'region', 'endpoint', 'urlStyle', 'ssl'], required: ['s3Location', 'region'], auth: ['access-key', 'pod-role'] },
  motherduck: { fields: ['database'], required: ['database'], auth: ['token'] },
  volume: { fields: ['path'], required: ['path'], auth: ['none'] },
};

const awsAccessKey = [text('accessKeyId', { required: true }), secret('secretAccessKey')];

const clickhouseCheck = (f: Fields) => [...hostProblems(f), ...unsafeNames(f, ['database'])];

const trinoCheck = (f: Fields) => [...hostProblems(f), ...unsafeNames(f, ['catalog', 'schema'])];

function athenaCheck(f: Fields, auth: string): string[] {
  const problems = [...podRoleProblems(auth), ...unsafeNames(f, ['catalog', 'database', 'workGroup'])];
  if (str(f.region) !== undefined && !AWS_REGION.test(String(f.region))) {
    problems.push('region must be an AWS region, such as eu-west-1');
  }
  if (str(f.workGroup) !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(String(f.workGroup))) {
    problems.push('workGroup must be a workgroup\'s name: letters, digits, ., _ and -');
  }
  if (auth === 'access-key' && str(f.accessKeyId) !== undefined && !/^[A-Z0-9]{16,128}$/.test(String(f.accessKeyId))) {
    problems.push('accessKeyId must be an AWS access key ID');
  }
  return [...problems, ...s3Problems(f, 's3OutputLocation', 'an s3:// URI, such as s3://bucket/results/')];
}

function duckdbCheck(f: Fields, auth: string): string[] {
  const kind = DUCKDB_KINDS[String(f.kind)];
  if (!kind) {
    return [`kind must be one of ${Object.keys(DUCKDB_KINDS).join(', ')}`];
  }
  const problems: string[] = [];
  for (const key of Object.keys(f).filter((k) => k !== 'kind' && k !== 'accessKeyId' && f[k] !== undefined && f[k] !== null)) {
    if (!kind.fields.includes(key)) {
      problems.push(`${key} is not a field of DuckDB reading from ${f.kind}`);
    }
  }
  for (const key of kind.required) {
    if (str(f[key]) === undefined) {
      problems.push(`${key} is required`);
    }
  }
  if (!kind.auth.includes(auth)) {
    problems.push(`authMethod for DuckDB reading from ${f.kind} is one of ${kind.auth.join(', ')}`);
  }
  problems.push(...podRoleProblems(auth));
  problems.push(...unsafeNames(f, ['database']), ...s3Problems(f, 's3Location', 'an s3:// URI of a bucket and an optional prefix, such as s3://bucket/sales/'));
  if (str(f.region) !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(f.region))) {
    problems.push('region must be a region\'s name, such as eu-west-1');
  }
  if (str(f.endpoint) !== undefined && !/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/.test(String(f.endpoint))) {
    problems.push('endpoint must be a host and an optional port, with no scheme or path');
  }
  if (str(f.urlStyle) !== undefined && !['vhost', 'path'].includes(String(f.urlStyle))) {
    problems.push('urlStyle must be vhost or path');
  }
  if (str(f.path) !== undefined && (!String(f.path).startsWith('/') || /[\0\n\r]/.test(String(f.path)))) {
    problems.push('path must be an absolute path');
  }
  return problems;
}

export const DRIVERS: Record<DriverType, DriverSpec> = {
  postgres: {
    cubeType: 'postgres',
    connection: [text('host', { required: true }), text('port', { kind: 'number' }), text('database', { required: true }), ...tlsFields],
    auth: {
      password: [text('user', { required: true }), secret('password')],
      'client-certificate': clientCertificate,
    },
    target: ['host', 'port', ...TLS_TARGET],
    config: (f, auth, s) => ({
      host: str(f.host),
      port: num(f.port, 5432),
      database: str(f.database),
      user: str(f.user),
      // pg reads PGPASSWORD (and ~/.pgpass) for an empty password: with a certificate, an empty one of our own.
      password: auth === 'password' ? s.password : () => '',
      ssl: tls(f, s, auth === 'client-certificate', true),
    }),
    make: withoutCubeTls('postgres'),
  },
  redshift: {
    cubeType: 'redshift',
    connection: [text('host', { required: true }), text('port', { kind: 'number' }), text('database', { required: true }), ...tlsFields],
    // Cube's Redshift driver reads IAM authentication from its environment only: a password here.
    auth: { password: [text('user', { required: true }), secret('password')] },
    target: ['host', 'port', ...TLS_TARGET],
    config: (f, _auth, s) => ({
      host: str(f.host),
      port: num(f.port, 5439),
      database: str(f.database),
      user: str(f.user),
      password: s.password,
      ssl: tls(f, s, false, true),
      // Its export bucket is the environment's, with AWS keys it would send to this host in an UNLOAD.
      exportBucket: undefined,
    }),
    make: withoutCubeTls('redshift', redshiftDatabase),
  },
  mysql: {
    cubeType: 'mysql',
    connection: [text('host', { required: true }), text('port', { kind: 'number' }), text('database', { required: true }), ...tlsFields],
    auth: {
      password: [text('user', { required: true }), secret('password')],
      'client-certificate': clientCertificate,
    },
    target: ['host', 'port', ...TLS_TARGET],
    config: (f, auth, s) => {
      const ssl = tls(f, s, auth === 'client-certificate', false);
      return {
        host: str(f.host),
        port: num(f.port, 3306),
        database: str(f.database),
        user: str(f.user),
        password: auth === 'password' ? s.password : undefined,
        socketPath: undefined,
        ssl: ssl || undefined,
      };
    },
    make: withoutCubeTls('mysql'),
  },
  snowflake: {
    cubeType: 'snowflake',
    connection: [
      text('account', { required: true }), text('region'), text('warehouse', { required: true }), text('role'),
      text('database', { required: true }),
    ],
    auth: {
      'key-pair': [text('username', { required: true }), secret('privateKey', { kind: 'multiline' }), secret('privateKeyPass', { required: false })],
      oauth: [secret('oauthToken')],
      password: [text('username', { required: true }), secret('password')],
    },
    target: ['account', 'region', 'warehouse'],
    config: (f, auth, s) => ({
      host: undefined,
      account: str(f.account),
      region: str(f.region),
      warehouse: str(f.warehouse),
      role: str(f.role),
      database: str(f.database),
      clientSessionKeepAlive: true,
      username: auth === 'oauth' ? undefined : str(f.username),
      authenticator: { 'key-pair': 'SNOWFLAKE_JWT', oauth: 'OAUTH', password: 'SNOWFLAKE' }[auth],
      password: auth === 'password' ? s.password : undefined,
      privateKey: auth === 'key-pair' ? s.privateKey : undefined,
      privateKeyPass: auth === 'key-pair' ? str(s.privateKeyPass) : undefined,
      privateKeyPath: undefined,
      oauthToken: auth === 'oauth' ? s.oauthToken : undefined,
      oauthTokenPath: undefined,
      exportBucket: undefined,
    }),
  },
  bigquery: {
    cubeType: 'bigquery',
    connection: [text('projectId', { required: true }), text('location')],
    auth: { 'service-account': [secret('credentials', { kind: 'multiline' })] },
    target: ['projectId'],
    config: (f, _auth, s) => {
      let key: any;
      try {
        key = JSON.parse(s.credentials);
      } catch {
        throw new Error('credentials must be a service-account key as JSON');
      }
      // A service-account key only: Google's other credential types read files, call URLs of
      // their own, or fall back to the process's own credentials.
      if (key?.type !== 'service_account' || typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
        throw new Error('credentials must be a service-account key (type service_account, with client_email and private_key)');
      }
      const credentials = {
        type: 'service_account',
        client_email: key.client_email,
        private_key: key.private_key,
        ...(typeof key.private_key_id === 'string' ? { private_key_id: key.private_key_id } : {}),
        ...(typeof key.project_id === 'string' ? { project_id: key.project_id } : {}),
      };
      return {
        projectId: str(f.projectId),
        location: str(f.location),
        credentials,
        keyFilename: undefined,
        exportBucket: undefined,
      };
    },
  },
  mssql: {
    cubeType: 'mssql',
    connection: [
      text('host', { required: true }), text('port', { kind: 'number' }), text('database', { required: true }),
      text('encrypt', { kind: 'boolean' }), text('trustServerCertificate', { kind: 'boolean' }),
    ],
    auth: {
      'sql-login': [text('user', { required: true }), secret('password')],
      ntlm: [text('domain', { required: true }), text('user', { required: true }), secret('password')],
      'entra-service-principal': [text('tenantId', { required: true }), text('clientId', { required: true }), secret('clientSecret')],
    },
    target: ['host', 'port', 'encrypt', 'trustServerCertificate'],
    config: (f, auth, s) => ({
      server: str(f.host),
      port: num(f.port, 1433),
      database: str(f.database),
      user: auth === 'entra-service-principal' ? undefined : str(f.user),
      password: auth === 'entra-service-principal' ? undefined : s.password,
      domain: auth === 'ntlm' ? str(f.domain) : undefined,
      ...(auth === 'entra-service-principal' ? {
        authentication: {
          type: 'azure-active-directory-service-principal-secret',
          options: { tenantId: str(f.tenantId), clientId: str(f.clientId), clientSecret: s.clientSecret },
        },
      } : {}),
      options: {
        encrypt: bool(f.encrypt, false),
        trustServerCertificate: bool(f.trustServerCertificate, false),
        useUTC: true,
      },
    }),
  },
  oracle: {
    cubeType: 'oracle',
    connection: [text('connectString'), text('host'), text('port', { kind: 'number' }), text('database')],
    auth: { password: [text('user', { required: true }), secret('password')] },
    target: ['connectString', 'database', 'host', 'port'],
    config: (f, _auth, s) => {
      const connectString = str(f.connectString);
      if (!connectString && !(str(f.host) && str(f.database))) {
        throw new Error('connectString, or host and database, is required');
      }
      return {
        user: str(f.user),
        password: s.password,
        connectionString: connectString ?? `${str(f.host)}:${num(f.port, 1521)}/${str(f.database)}`,
        db: undefined,
        host: undefined,
        port: undefined,
      };
    },
  },
  /** Dremio Cloud (a project's API URL, with a token) or Dremio Software (host and port). */
  dremio: {
    cubeType: 'dremio',
    connection: [text('url'), text('host'), text('port', { kind: 'number' }), text('ssl', { kind: 'boolean' }), text('database')],
    auth: {
      token: [secret('token')],
      password: [text('user', { required: true }), secret('password')],
    },
    target: ['host', 'port', 'url', 'ssl'],
    config: (f, auth, s) => {
      const url = str(f.url);
      if (!url && !str(f.host)) {
        throw new Error('url (Dremio Cloud) or host (Dremio Software) is required');
      }
      if (url && auth !== 'token') {
        throw new Error('Dremio Cloud takes a personal access token');
      }
      return {
        dbUrl: url,
        host: url ? undefined : str(f.host),
        port: url ? undefined : num(f.port, 9047),
        ssl: bool(f.ssl, false),
        database: str(f.database),
        dremioAuthToken: auth === 'token' ? s.token : undefined,
        user: auth === 'password' ? str(f.user) : undefined,
        password: auth === 'password' ? s.password : undefined,
      };
    },
  },
  /** DuckDB in the Cube pods, reading one place: an S3 location, a MotherDuck database, or a file on an allowed volume. */
  duckdb: {
    cubeType: 'duckdb',
    connection: [
      text('kind', { required: true }), text('s3Location'), text('region'), text('endpoint'), text('urlStyle'),
      text('ssl', { kind: 'boolean' }), text('database'), text('path'),
    ],
    auth: {
      'access-key': awsAccessKey,
      'pod-role': [],
      token: [secret('token')],
      none: [],
    },
    target: ['kind', 's3Location', 'region', 'endpoint', 'ssl', 'database', 'path'],
    check: duckdbCheck,
    config(f, auth, s) {
      checked(this, f, auth);
      const kind = String(f.kind);
      return {
        kind,
        s3: kind === 's3' ? {
          location: str(f.s3Location),
          region: str(f.region),
          endpoint: str(f.endpoint),
          urlStyle: str(f.urlStyle) ?? 'vhost',
          useSsl: bool(f.ssl, true),
          accessKeyId: auth === 'access-key' ? str(f.accessKeyId) : undefined,
          secretAccessKey: auth === 'access-key' ? s.secretAccessKey : undefined,
          podRole: auth === 'pod-role',
        } : undefined,
        motherDuck: kind === 'motherduck' ? { database: str(f.database), token: s.token } : undefined,
        volume: kind === 'volume' ? { path: str(f.path) } : undefined,
        // Cube's driver reads these from its environment otherwise.
        databasePath: undefined,
        motherDuckToken: undefined,
        initSql: undefined,
        schema: undefined,
      };
    },
    make: makeDuckdbDriver,
  },
  /** Self-hosted ClickHouse or ClickHouse Cloud, over HTTP(S). */
  clickhouse: {
    cubeType: 'clickhouse',
    connection: [text('host', { required: true }), text('port', { kind: 'number' }), text('ssl', { kind: 'boolean' }), text('database', { required: true })],
    auth: { password: [text('user', { required: true }), secret('password')] },
    target: ['host', 'port', 'ssl'],
    check: clickhouseCheck,
    config(f, auth, s) {
      checked(this, f, auth);
      const ssl = bool(f.ssl, true);
      return {
        host: str(f.host),
        port: String(num(f.port, ssl ? 8443 : 8123)),
        protocol: ssl ? 'https:' : 'http:',
        database: str(f.database),
        username: str(f.user),
        password: s.password,
        readOnly: true,
      };
    },
    make: makeClickHouseDriver,
  },
  /** Trino over HTTPS, always: a user, with a password or a JWT. */
  trino: {
    cubeType: 'trino',
    connection: [
      text('host', { required: true }), text('port', { kind: 'number' }), text('sslRejectUnauthorized', { kind: 'boolean' }),
      text('sslCa', { kind: 'multiline' }), text('catalog', { required: true }), text('schema'),
    ],
    auth: {
      password: [text('user', { required: true }), secret('password')],
      jwt: [text('user', { required: true }), secret('token')],
    },
    target: ['host', 'port', 'sslRejectUnauthorized', 'sslCa'],
    check: trinoCheck,
    config(f, auth, s) {
      checked(this, f, auth);
      if (auth === 'jwt' && !/^[A-Za-z0-9_.-]+$/.test(s.token ?? '')) {
        throw new Error('token must be a JWT');
      }
      return {
        host: str(f.host),
        port: String(num(f.port, 443)),
        catalog: str(f.catalog),
        schema: str(f.schema),
        user: str(f.user),
        basic_auth: auth === 'password' ? { user: str(f.user), password: s.password } : undefined,
        custom_auth: auth === 'jwt' ? `Bearer ${s.token}` : undefined,
        ssl: { rejectUnauthorized: bool(f.sslRejectUnauthorized, true), ca: str(f.sslCa) },
        useSelectTestConnection: true,
        queryTimeout: undefined,
        bucketType: undefined,
        exportBucket: undefined,
        accessKeyId: undefined,
        secretAccessKey: undefined,
        exportBucketRegion: undefined,
        credentials: undefined,
      };
    },
    make: makeTrinoDriver,
  },
  /** Amazon Athena: an access key of the data source's own, or the Cube pods' role where the deployment allows it. */
  athena: {
    cubeType: 'athena',
    connection: [
      text('region', { required: true }), text('workGroup', { required: true }), text('s3OutputLocation', { required: true }),
      text('catalog', { required: true }), text('database'),
    ],
    auth: { 'access-key': awsAccessKey, 'pod-role': [] },
    target: ['region', 'workGroup'],
    check: athenaCheck,
    config(f, auth, s) {
      checked(this, f, auth);
      return {
        region: str(f.region),
        workGroup: str(f.workGroup),
        S3OutputLocation: str(f.s3OutputLocation),
        catalog: str(f.catalog),
        database: str(f.database),
        accessKeyId: auth === 'access-key' ? str(f.accessKeyId) : undefined,
        secretAccessKey: auth === 'access-key' ? s.secretAccessKey : undefined,
        podRole: auth === 'pod-role',
        athenaAwsAssumeRoleArn: undefined,
        athenaAwsAssumeRoleExternalId: undefined,
        exportBucket: undefined,
        readOnly: true,
      };
    },
    make: makeAthenaDriver,
  },
};

export function isDriverType(type: unknown): type is DriverType {
  return typeof type === 'string' && (DRIVER_TYPES as readonly string[]).includes(type);
}
