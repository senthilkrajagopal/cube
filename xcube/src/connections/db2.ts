/**
 * IBM Db2 (LUW; z/OS with the customer's licensed jar) as a data source:
 * xcube's JDBC driver (`jdbc.ts`) with IBM's `com.ibm.db2.jcc.DB2Driver`,
 * mounted (`jvm.ts`).
 *
 * The URL names the server and database alone; every other setting, the
 * user and password among them, is a property: a value can't add an option.
 * - With TLS: `sslConnection`, the CA (a private file of its own, removed
 *   when the driver is released) as `sslCertLocation`, and the host name
 *   checked (`sslClientHostnameValidation=BASIC`). IBM's driver has no
 *   setting that skips checking the chain: `sslRejectUnauthorized: false`
 *   turns off the host name's check only.
 * - Without TLS: the user and password encrypted (`securityMechanism=9`,
 *   AES), never sent in clear. A server that refuses encrypted credentials
 *   fails the connection test with the driver's words.
 * - Always `readOnly`, the server's own messages, and the login timeout.
 */
import { jdbcPlaceholders, lexedKinds } from '../sql/classify';
import {
  JDBC_CONNECT_MS, JDBC_QUERY_TIMEOUT_S, JdbcDriver, privateCaFile, type JdbcDialect, type JdbcTarget,
} from './jdbc';

export interface Db2Config {
  host: string;
  port: number;
  database: string;
  currentSchema?: string;
  user?: string;
  password?: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
  connectTimeoutMs?: number;
  queryTimeout?: number;
  maxPoolSize?: number;
}

/**
 * The URL and properties a Db2 connection opens with, `caFile` the CA's
 * file where TLS has one: compared whole by the tests (wechart's R3 test 2).
 */
export function db2Target(config: Db2Config, caFile: string | null): Pick<JdbcTarget, 'type' | 'url' | 'properties'> {
  const connectS = Math.max(1, Math.ceil((config.connectTimeoutMs ?? JDBC_CONNECT_MS) / 1000));
  const queryS = config.queryTimeout ?? JDBC_QUERY_TIMEOUT_S;
  const properties: Record<string, string> = {
    user: config.user ?? '',
    password: config.password ?? '',
    readOnly: 'true',
    // The server's own words for an error, not only its SQLCODE.
    retrieveMessagesFromServerOnGetMessage: 'true',
    loginTimeout: String(connectS),
    // A read that waits longer than any statement may run is a connection gone.
    blockingReadConnectionTimeout: String(queryS + 120),
  };
  if (config.ssl) {
    properties.sslConnection = 'true';
    properties.sslClientHostnameValidation = config.ssl.rejectUnauthorized ? 'BASIC' : 'OFF';
    if (caFile) {
      properties.sslCertLocation = caFile;
    }
  } else {
    // ENCRYPTED_USER_AND_PASSWORD_SECURITY, with AES (encryptionAlgorithm 2), which a JVM not IBM's needs.
    properties.securityMechanism = '9';
    properties.encryptionAlgorithm = '2';
  }
  if (config.currentSchema) {
    properties.currentSchema = config.currentSchema.toUpperCase();
  }
  const host = /:/.test(config.host) && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  return { type: 'db2', url: `jdbc:db2://${host}:${config.port}/${config.database}`, properties };
}

/** A value written into Db2's SQL as its literal: a string's quote doubled, no escape else (Db2's strings have none). */
export function db2Literal(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(value);
    return value < 0 ? `(${text})` : text;
  }
  if (typeof value === 'bigint') {
    return value < 0n ? `(${value})` : String(value);
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  const literal = `'${text.replace(/'/g, '\'\'')}'`;
  if (lexedKinds(literal, 'db2')?.join() !== 'string') {
    throw new Error('A value doesn\'t read as one Db2 string');
  }
  return literal;
}

/** Cube's SQL with each `?` (as Db2's lexer reads it: never one in a string, name or comment) replaced by its value. */
export function db2Inline(sql: string, values: unknown[]): string {
  if (!values.length) {
    return sql;
  }
  const marks = jdbcPlaceholders(sql, 'db2');
  if (marks.length !== values.length) {
    throw new Error(`The statement has ${marks.length} placeholders for ${values.length} values`);
  }
  let out = '';
  let at = 0;
  marks.forEach((mark, i) => {
    out += `${sql.slice(at, mark)}${db2Literal(values[i])}`;
    at = mark + 1;
  });
  return out + sql.slice(at);
}

/** The schemas Db2 keeps for itself: never a user's. */
const SYSTEM_SCHEMAS = 'NOT LIKE \'SYS%\' AND {} NOT IN (\'NULLID\', \'SQLJ\', \'IBM_RTMON\', \'DB2GSE\')';

const notSystem = (column: string) => `${column} ${SYSTEM_SCHEMAS.replace('{}', column)}`;

/** Tables, views, materialized query tables, nicknames, typed tables and views. */
const TABLE_KINDS = '(\'T\', \'V\', \'S\', \'N\', \'U\', \'W\')';

export const DB2_DIALECT: JdbcDialect = {
  testSql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1',
  inline: db2Inline,
  schemasSql: () => `SELECT SCHEMANAME FROM SYSCAT.SCHEMATA WHERE ${notSystem('SCHEMANAME')} ORDER BY SCHEMANAME`,
  tablesSql: (schema) => `SELECT TABNAME, TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA = ${db2Literal(schema)} AND TYPE IN ${TABLE_KINDS} ORDER BY TABNAME`,
  columnsSql: (schema, table) => `SELECT COLNAME, TYPENAME FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ${db2Literal(schema)} AND TABNAME = ${db2Literal(table)} ORDER BY COLNO`,
  catalogSql: () => 'SELECT c.TABSCHEMA, c.TABNAME, c.COLNAME, c.TYPENAME FROM SYSCAT.COLUMNS c '
    + 'JOIN SYSCAT.TABLES t ON t.TABSCHEMA = c.TABSCHEMA AND t.TABNAME = c.TABNAME '
    + `WHERE t.TYPE IN ${TABLE_KINDS} AND ${notSystem('c.TABSCHEMA')} ORDER BY c.TABSCHEMA, c.TABNAME, c.COLNO`,
  genericType: (type) => ({
    smallint: 'int',
    integer: 'int',
    int: 'int',
    bigint: 'bigint',
    decimal: 'decimal',
    numeric: 'decimal',
    decfloat: 'decimal',
    real: 'float',
    double: 'double',
    float: 'double',
    char: 'text',
    character: 'text',
    varchar: 'text',
    clob: 'text',
    graphic: 'text',
    vargraphic: 'text',
    dbclob: 'text',
    nchar: 'text',
    nvarchar: 'text',
    nclob: 'text',
    date: 'date',
    time: 'time',
    timestamp: 'timestamp',
    boolean: 'boolean',
  } as Record<string, string>)[type],
};

/** A Db2 driver from a connection's config (`DRIVERS.db2.config`). */
export function makeDb2Driver(config: Record<string, unknown>): JdbcDriver {
  const c = config as unknown as Db2Config;
  const ca = c.ssl && c.ssl.ca ? privateCaFile(c.ssl.ca, 'xcube-db2-') : null;
  try {
    const target: JdbcTarget = {
      ...db2Target(c, ca?.file ?? null),
      readOnly: true,
      files: ca ? [ca.file] : [],
      connectTimeoutMs: c.connectTimeoutMs,
      queryTimeoutS: c.queryTimeout,
      maxPoolSize: c.maxPoolSize,
    };
    return new JdbcDriver(target, DB2_DIALECT, () => ca?.remove());
  } catch (e) {
    ca?.remove();
    throw e;
  }
}
