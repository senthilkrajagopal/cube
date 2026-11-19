/**
 * TIBCO Data Virtualization (Composite; Spotfire Data Virtualization from 8.9)
 * as a data source: xcube's JDBC driver (`jdbc.ts`) with TDV's
 * `cs.jdbc.driver.CompositeDriver`, its jar mounted from the customer's own
 * install (`jvm.ts`).
 *
 * Its URL, `jdbc:compositesw:dbapi@host:port?domain=…&dataSource=…&…`, is
 * built by xcube from its own list of properties alone: never a trace file,
 * another way of signing in, or a weaker TLS setting. The domain and the
 * published data source are held to a grammar that can't add one; the user
 * and password are properties, never in the URL.
 * - With TLS: `encrypt=true`, and the server's certificate and host name
 *   checked (`validateRemoteCert`, `validateRemoteHostname`, both off in
 *   TDV's driver unless asked). TDV's driver reads the JVM's trust store
 *   only: a TDV server's CA is the deployment's (`XCUBE_JDBC_TRUST_STORE`),
 *   not a field.
 * - `connectTimeout` (seconds) and `requestTimeout` (milliseconds), the
 *   statement's limit on the server: TDV documents no `setQueryTimeout`.
 *
 * TDV has no read-only session (`setReadOnly` throws): the guard is the SQL
 * runner's check and an account with Read and Select only. Its catalog is
 * the driver's DatabaseMetaData, a published catalog part of each schema's
 * name (`catalog.schema`).
 */
import { jdbcPlaceholders, lexedKinds } from '../sql/classify';
import { JDBC_CONNECT_MS, JDBC_QUERY_TIMEOUT_S, JdbcDriver, type JdbcDialect, type JdbcTarget } from './jdbc';

export interface TdvConfig {
  host: string;
  port: number;
  domain: string;
  /** The published data source (the connection's `dataSource` field: Cube sets `dataSource` in every config to its own name). */
  publishedDataSource: string;
  user?: string;
  password?: string;
  ssl: false | { rejectUnauthorized: boolean };
  connectTimeoutMs?: number;
  queryTimeout?: number;
  maxPoolSize?: number;
}

/** The URL and properties a TDV connection opens with (R3 test 2). */
export function tdvTarget(config: TdvConfig): Pick<JdbcTarget, 'type' | 'url' | 'properties'> {
  const verify = config.ssl ? config.ssl.rejectUnauthorized : false;
  const query = [
    ['domain', config.domain],
    ['dataSource', config.publishedDataSource],
    ['encrypt', String(Boolean(config.ssl))],
    ['validateRemoteCert', String(verify)],
    ['validateRemoteHostname', String(verify)],
    ['connectTimeout', String(Math.max(1, Math.ceil((config.connectTimeoutMs ?? JDBC_CONNECT_MS) / 1000)))],
    ['requestTimeout', String((config.queryTimeout ?? JDBC_QUERY_TIMEOUT_S) * 1000)],
  ].map(([k, v]) => `${k}=${v}`).join('&');
  const host = /:/.test(config.host) && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  return {
    type: 'tdv',
    url: `jdbc:compositesw:dbapi@${host}:${config.port}?${query}`,
    properties: { user: config.user ?? '', password: config.password ?? '' },
  };
}

/** A value written into TDV's SQL as its literal: a string's quote doubled. */
export function tdvLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 0 ? `(${value})` : String(value);
  }
  if (typeof value === 'bigint') {
    return value < 0n ? `(${value})` : String(value);
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  const literal = `'${text.replace(/'/g, '\'\'')}'`;
  if (lexedKinds(literal, 'tdv')?.join() !== 'string') {
    throw new Error('A value doesn\'t read as one TDV string');
  }
  return literal;
}

/** Cube's SQL with each `?` (as TDV's lexer reads it) replaced by its value. */
export function tdvInline(sql: string, values: unknown[]): string {
  if (!values.length) {
    return sql;
  }
  const marks = jdbcPlaceholders(sql, 'tdv');
  if (marks.length !== values.length) {
    throw new Error(`The statement has ${marks.length} placeholders for ${values.length} values`);
  }
  let out = '';
  let at = 0;
  marks.forEach((mark, i) => {
    out += `${sql.slice(at, mark)}${tdvLiteral(values[i])}`;
    at = mark + 1;
  });
  return out + sql.slice(at);
}

export const TDV_DIALECT: JdbcDialect = {
  metadata: true,
  testSql: 'SELECT 1',
  inline: tdvInline,
  genericType: (type) => ({
    tinyint: 'int',
    smallint: 'int',
    integer: 'int',
    int: 'int',
    bigint: 'bigint',
    decimal: 'decimal',
    numeric: 'decimal',
    float: 'double',
    real: 'float',
    double: 'double',
    char: 'text',
    varchar: 'text',
    longvarchar: 'text',
    clob: 'text',
    date: 'date',
    time: 'time',
    timestamp: 'timestamp',
    boolean: 'boolean',
    bit: 'boolean',
  } as Record<string, string>)[type],
};

/** A TDV driver from a connection's config (`DRIVERS.tdv.config`). */
export function makeTdvDriver(config: Record<string, unknown>): JdbcDriver {
  const c = config as unknown as TdvConfig;
  return new JdbcDriver({
    ...tdvTarget(c),
    readOnly: false,
    connectTimeoutMs: c.connectTimeoutMs,
    queryTimeoutS: c.queryTimeout,
    maxPoolSize: c.maxPoolSize,
  }, TDV_DIALECT);
}
