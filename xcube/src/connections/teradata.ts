/**
 * Teradata Vantage as a data source: xcube's JDBC driver (`jdbc.ts`) with
 * Teradata's `com.teradata.jdbc.TeraDriver`, mounted (`jvm.ts`).
 *
 * Its URL is a list of parameters, `jdbc:teradata://host/NAME=value,…`,
 * built by xcube alone from its own names; every value a field gives is held
 * to a grammar that can't add one, and the user and password are properties,
 * never in the URL. `STRICT_NAMES=ON` makes the driver refuse a name it
 * doesn't know, so a parameter misspelled fails the connection rather than
 * being ignored.
 * - With TLS: `HTTPS_PORT`, `SSLMODE=VERIFY-FULL` (or `REQUIRE` with
 *   checking off), and the CA as `SSLCA`, a private file of its own.
 * - Without TLS: `DBS_PORT`, `SSLMODE=DISABLE` and `ENCRYPTDATA=ON`.
 * - Always `TMODE=ANSI`, `CHARSET=UTF8`, the logon mechanism (`TD2` or
 *   `LDAP`) and `LOGON_TIMEOUT`.
 *
 * Teradata has no read-only session (`setReadOnly` does nothing): the guard
 * is the SQL runner's check and an account that can only read.
 */
import { jdbcPlaceholders, lexedKinds } from '../sql/classify';
import {
  JDBC_CONNECT_MS, JdbcDriver, privateCaFile, type JdbcDialect, type JdbcTarget,
} from './jdbc';

export const TERADATA_LOGMECHS = ['TD2', 'LDAP'] as const;

export interface TeradataConfig {
  host: string;
  port: number;
  database?: string;
  logmech: (typeof TERADATA_LOGMECHS)[number];
  user?: string;
  password?: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
  connectTimeoutMs?: number;
  queryTimeout?: number;
  maxPoolSize?: number;
}

/** A file path xcube writes into the URL: its own temporary file's, which holds none of the URL's separators. */
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

/** The URL and properties a Teradata connection opens with, `caFile` the CA's file where TLS has one (R3 test 2). */
export function teradataTarget(config: TeradataConfig, caFile: string | null): Pick<JdbcTarget, 'type' | 'url' | 'properties'> {
  if (!TERADATA_LOGMECHS.includes(config.logmech)) {
    throw new Error(`logmech must be one of ${TERADATA_LOGMECHS.join(', ')}`);
  }
  if (caFile !== null && !SAFE_PATH.test(caFile)) {
    throw new Error('The CA\'s file has a path the URL can\'t hold');
  }
  const parameters = [
    ...(config.database ? [`DATABASE=${config.database}`] : []),
    `LOGMECH=${config.logmech}`,
    'TMODE=ANSI',
    'CHARSET=UTF8',
    `LOGON_TIMEOUT=${Math.max(1, Math.ceil((config.connectTimeoutMs ?? JDBC_CONNECT_MS) / 1000))}`,
    'STRICT_NAMES=ON',
    ...(config.ssl
      ? [`HTTPS_PORT=${config.port}`, `SSLMODE=${config.ssl.rejectUnauthorized ? 'VERIFY-FULL' : 'REQUIRE'}`, ...(caFile ? [`SSLCA=${caFile}`] : [])]
      : [`DBS_PORT=${config.port}`, 'SSLMODE=DISABLE', 'ENCRYPTDATA=ON']),
  ];
  const host = /:/.test(config.host) && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  return {
    type: 'teradata',
    url: `jdbc:teradata://${host}/${parameters.join(',')}`,
    properties: { user: config.user ?? '', password: config.password ?? '' },
  };
}

/** A value written into Teradata's SQL as its literal: a string's quote doubled (its strings have no other escape); a boolean as 1 or 0. */
export function teradataLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 0 ? `(${value})` : String(value);
  }
  if (typeof value === 'bigint') {
    return value < 0n ? `(${value})` : String(value);
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  const literal = `'${text.replace(/'/g, '\'\'')}'`;
  if (lexedKinds(literal, 'teradata')?.join() !== 'string') {
    throw new Error('A value doesn\'t read as one Teradata string');
  }
  return literal;
}

/** Cube's SQL with each `?` (as Teradata's lexer reads it) replaced by its value. */
export function teradataInline(sql: string, values: unknown[]): string {
  if (!values.length) {
    return sql;
  }
  const marks = jdbcPlaceholders(sql, 'teradata');
  if (marks.length !== values.length) {
    throw new Error(`The statement has ${marks.length} placeholders for ${values.length} values`);
  }
  let out = '';
  let at = 0;
  marks.forEach((mark, i) => {
    out += `${sql.slice(at, mark)}${teradataLiteral(values[i])}`;
    at = mark + 1;
  });
  return out + sql.slice(at);
}

/** The databases Teradata keeps for itself. */
const SYSTEM_DATABASES = ['DBC', 'SYSLIB', 'SYSBAR', 'SYSJDBC', 'SYSSPATIAL', 'SYSUDTLIB', 'SYSUIF', 'SystemFe', 'Sys_Calendar', 'SQLJ',
  'TDStats', 'TD_SYSFNLIB', 'TD_SYSXML', 'TD_SYSGPL', 'TDQCD', 'TDPUSER', 'TD_SERVER_DB', 'TD_ANALYTICS_DB', 'TDMaps', 'TDaaS_Maint',
  'dbcmngr', 'External_AP', 'LockLogShredder', 'PUBLIC', 'Crashdumps', 'console', 'tdwm', 'EXTUSER', 'All', 'Default'];

const notSystem = (column: string) => `${column} NOT IN (${SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ')})`;

/** Tables, views and tables without a primary index. */
const TABLE_KINDS = '(\'T\', \'V\', \'O\')';

/** DBC.ColumnsV's type codes, as the types' names. */
const COLUMN_TYPES: Record<string, string> = {
  CF: 'CHAR', CV: 'VARCHAR', CO: 'CLOB', D: 'DECIMAL', N: 'NUMBER', F: 'FLOAT', I1: 'BYTEINT', I2: 'SMALLINT', I: 'INTEGER', I8: 'BIGINT',
  DA: 'DATE', AT: 'TIME', TZ: 'TIME WITH TIME ZONE', TS: 'TIMESTAMP', SZ: 'TIMESTAMP WITH TIME ZONE', BF: 'BYTE', BV: 'VARBYTE', BO: 'BLOB',
  JN: 'JSON', XM: 'XML', PD: 'PERIOD(DATE)', PS: 'PERIOD(TIMESTAMP)', PT: 'PERIOD(TIME)',
};

const typeName = (column: string) => `CASE TRIM(${column}) ${Object.entries(COLUMN_TYPES).map(([code, name]) => `WHEN '${code}' THEN '${name}'`).join(' ')} `
  + `ELSE COALESCE(TRIM(${column}), 'UNKNOWN') END`;

export const TERADATA_DIALECT: JdbcDialect = {
  testSql: 'SELECT 1',
  inline: teradataInline,
  // The X views: only what the user may access.
  schemasSql: () => `SELECT DatabaseName FROM DBC.DatabasesVX WHERE ${notSystem('DatabaseName')} ORDER BY 1`,
  tablesSql: (schema) => `SELECT TableName, TableKind FROM DBC.TablesVX WHERE DatabaseName = ${teradataLiteral(schema)} AND TableKind IN ${TABLE_KINDS} ORDER BY 1`,
  columnsSql: (schema, table) => `SELECT ColumnName, ${typeName('ColumnType')} FROM DBC.ColumnsVX `
    + `WHERE DatabaseName = ${teradataLiteral(schema)} AND TableName = ${teradataLiteral(table)} ORDER BY ColumnId`,
  catalogSql: () => `SELECT c.DatabaseName, c.TableName, c.ColumnName, ${typeName('c.ColumnType')} FROM DBC.ColumnsVX c `
    + 'JOIN DBC.TablesVX t ON t.DatabaseName = c.DatabaseName AND t.TableName = c.TableName '
    + `WHERE t.TableKind IN ${TABLE_KINDS} AND ${notSystem('c.DatabaseName')} ORDER BY 1, 2, c.ColumnId`,
  genericType: (type) => ({
    byteint: 'int',
    smallint: 'int',
    integer: 'int',
    int: 'int',
    bigint: 'bigint',
    decimal: 'decimal',
    numeric: 'decimal',
    number: 'decimal',
    float: 'double',
    real: 'double',
    double: 'double',
    char: 'text',
    character: 'text',
    varchar: 'text',
    clob: 'text',
    json: 'text',
    date: 'date',
    time: 'time',
    timestamp: 'timestamp',
  } as Record<string, string>)[type],
};

/** A Teradata driver from a connection's config (`DRIVERS.teradata.config`). */
export function makeTeradataDriver(config: Record<string, unknown>): JdbcDriver {
  const c = config as unknown as TeradataConfig;
  const ca = c.ssl && c.ssl.ca ? privateCaFile(c.ssl.ca, 'xcube-teradata-') : null;
  try {
    const target: JdbcTarget = {
      ...teradataTarget(c, ca?.file ?? null),
      readOnly: false,
      files: ca ? [ca.file] : [],
      connectTimeoutMs: c.connectTimeoutMs,
      queryTimeoutS: c.queryTimeout,
      maxPoolSize: c.maxPoolSize,
    };
    return new JdbcDriver(target, TERADATA_DIALECT, () => ca?.remove());
  } catch (e) {
    ca?.remove();
    throw e;
  }
}
