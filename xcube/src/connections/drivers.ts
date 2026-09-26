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

export const DRIVER_TYPES = ['postgres', 'redshift', 'mysql', 'snowflake', 'bigquery', 'mssql', 'oracle', 'dremio'] as const;

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
};

export function isDriverType(type: unknown): type is DriverType {
  return typeof type === 'string' && (DRIVER_TYPES as readonly string[]).includes(type);
}
