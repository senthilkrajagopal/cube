/**
 * Apache Hive (HiveServer2) and Spark's Thrift server, as a data source:
 * xcube's own driver over the `hive-driver` package's Thrift client, not
 * Cube's (deprecated) Hive driver. Binary transport only, with or without TLS;
 * SASL PLAIN, a user alone or with a password; NOSASL for Impala.
 *
 * The package is a thin Thrift client, and leaves to its caller what makes a
 * connection safe to serve with, all of which is here:
 * - every error of a connection is listened for before it connects: one
 *   unheard would end the process;
 * - connecting, the SASL handshake and each call have deadlines of their own,
 *   and each call is raced against the connection closing or failing: Thrift
 *   leaves a call unanswered when its socket goes, and the package never
 *   reconnects (no `max_attempts`), so a connection that failed is dropped;
 * - a statement runs asynchronously, its status polled at a pace that slows;
 * - rows are read from the raw column sets, BIGINT from its 64 bits and
 *   DECIMAL as the server's string, never through a JavaScript number;
 * - each data source has a pool of connections, each with a session of its
 *   own; nothing is shared between data sources.
 */
import net from 'net';

import { BaseDriver } from '@cubejs-backend/base-driver';

import { hivePlaceholders, hiveTrailingOffset } from '../sql/classify';

/* eslint-disable global-require, @typescript-eslint/no-var-requires */
const hive = require('hive-driver');
const thrift = require('thrift');
const TcpTransport = require('hive-driver/dist/connection/transports/TcpTransport').default;
const TlsTransport = require('hive-driver/dist/connection/transports/TlsTransport').default;
/* eslint-enable global-require, @typescript-eslint/no-var-requires */

const { TCLIService, TCLIService_types: T } = hive.thrift;

/** The protocol asked for, and the oldest taken: below V6, results come as rows, not columns. */
export const HIVE_PROTOCOL = T.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10;
const OLDEST_PROTOCOL = T.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V6;

/** What `username` sends as its password: HiveServer2 refuses an empty one, and a `NONE` server reads none. */
export const PLAIN_PLACEHOLDER = 'anonymous';

/** Connecting and the SASL handshake, together. */
export const HIVE_CONNECT_MS = 15000;

/** A call that answers at once: opening a session, a status, a cancel, a close, a catalog read. */
export const HIVE_CALL_MS = 60000;

/** A fetch, which may wait on the server producing its rows. */
export const HIVE_FETCH_MS = 300000;

/** Cube's own default for a query on the drivers that take one: ten minutes. */
export const HIVE_QUERY_TIMEOUT_S = 600;

/** How many rows a fetch asks for on Cube's path. */
const FETCH_ROWS = 10000;

export type HiveFlavour = 'hive' | 'impala';

export interface HiveTls {
  rejectUnauthorized: boolean;
  ca?: string;
  servername?: string;
}

export interface HiveConfig {
  flavour: HiveFlavour;
  host: string;
  port: number;
  database: string;
  /** `false` without TLS. */
  ssl: HiveTls | false;
  /** NOSASL (Impala only), or SASL PLAIN. */
  mechanism: 'nosasl' | 'plain';
  user?: string;
  password?: string;
  /** A query's time limit on the server, in seconds, unless a run gives its own. */
  queryTimeout?: number;
  maxPoolSize?: number;
  dataSource?: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  [key: string]: unknown;
}

/** The server's refusal, or the connection's failure, worded as the server or xcube says it. */
export class HiveError extends Error {
  public constructor(
    message: string,
    /** `timeout`, `cancelled`, `connect`, `closed`, `deadline`, `protocol`, or the server's own failure. */
    public readonly kind: 'timeout' | 'cancelled' | 'connect' | 'closed' | 'deadline' | 'protocol' | 'server',
    public readonly sqlState: string | null = null,
    public readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'HiveError';
  }
}

/** A column as the server describes it: its name, and its type as the server names it (`decimal(31,9)`). */
export interface HiveColumn {
  name: string;
  type: string;
  /** The type's id, for reading its cells. */
  typeId: number;
}

/** A status's failure, if it is one. */
function statusError(status: any): HiveError | null {
  const code = status?.statusCode;
  if (code === T.TStatusCode.SUCCESS_STATUS || code === T.TStatusCode.SUCCESS_WITH_INFO_STATUS || code === T.TStatusCode.STILL_EXECUTING_STATUS) {
    return null;
  }
  return new HiveError(
    String(status?.errorMessage || (code === T.TStatusCode.INVALID_HANDLE_STATUS ? 'The server no longer knows the operation' : 'The server refused the call')),
    'server',
    status?.sqlState ? String(status.sqlState) : null,
    typeof status?.errorCode === 'number' ? status.errorCode : null,
  );
}

const TYPE_NAMES: Record<number, string> = Object.fromEntries(Object.entries<number>(T.TTypeId).map(([name, id]) => [id, name.replace(/_TYPE$/, '').toLowerCase()]));

/** A column's type as the server names it, with its qualifiers: `decimal(31,9)`, `varchar(20)`. */
export function typeName(typeDesc: any): { name: string; typeId: number } {
  const entry = typeDesc?.types?.[0];
  if (entry?.primitiveEntry) {
    const { type, typeQualifiers } = entry.primitiveEntry;
    const q = typeQualifiers?.qualifiers ?? {};
    const int = (key: string) => (q[key]?.i32Value ?? null) as number | null;
    let name = TYPE_NAMES[type] ?? `type ${type}`;
    if (type === T.TTypeId.DECIMAL_TYPE && int('precision') !== null) {
      name = `decimal(${int('precision')},${int('scale') ?? 0})`;
    } else if ((type === T.TTypeId.VARCHAR_TYPE || type === T.TTypeId.CHAR_TYPE) && int('characterMaximumLength') !== null) {
      name = `${name}(${int('characterMaximumLength')})`;
    } else if (type === T.TTypeId.TIMESTAMPLOCALTZ_TYPE) {
      name = 'timestamp with local time zone';
    } else if (type === T.TTypeId.INTERVAL_YEAR_MONTH_TYPE) {
      name = 'interval_year_month';
    } else if (type === T.TTypeId.INTERVAL_DAY_TIME_TYPE) {
      name = 'interval_day_time';
    }
    return { name, typeId: type };
  }
  // Complex types come as JSON text.
  const complex = (['array', 'map', 'struct', 'union'] as const).find((kind) => entry?.[`${kind}Entry`]);
  return { name: complex === 'union' ? 'uniontype' : complex ?? 'string', typeId: T.TTypeId.STRING_TYPE };
}

/** The columns of a result set's schema. */
export function columnsOf(schema: any): HiveColumn[] {
  return (schema?.columns ?? []).map((c: any) => {
    const { name, typeId } = typeName(c.typeDesc);
    return { name: String(c.columnName), type: name, typeId };
  });
}

/** A 64-bit integer from Thrift's `Int64`, whole: a number where it is exact, else its digits. */
export function int64Cell(value: any): number | string {
  if (typeof value === 'number') {
    return value;
  }
  const buffer: Buffer | undefined = value?.buffer;
  if (!buffer) {
    return Number(value);
  }
  const big = buffer.readBigInt64BE(value.offset ?? 0);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
}

/** The offset of a zone at a wall-clock time, `±HH:MM`; `null` for a zone this runtime doesn't know. */
function offsetAt(wall: string, zone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(wall);
  if (!m) {
    return null;
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return null;
  }
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // The zone's offset at the instant, read twice: a wall time near a change settles on the second.
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(format.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    guess = asUtc - (shown - guess);
  }
  const minutes = Math.round((asUtc - guess) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * A TIMESTAMP WITH LOCAL TIME ZONE as Hive prints it, `2026-03-08 01:30:00.0 US/Pacific`:
 * its wall time with its offset, `2026-03-08 01:30:00-08:00`, as the engine's
 * loader reads a zoned timestamp. Left as it is where it can't be read.
 */
export function zonedCell(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(\.\d+)? (\S+)$/.exec(value);
  if (!m) {
    return value;
  }
  const fraction = m[2] && !/^\.0+$/.test(m[2]) ? m[2].replace(/0+$/, '') : '';
  const offset = m[3] === 'Z' || m[3] === 'UTC' ? '+00:00' : offsetAt(m[1], m[3]);
  return offset ? `${m[1]}${fraction}${offset}` : value;
}

/** Whether row `i` is NULL: bit `i % 8` of byte `i / 8` of the column's bitmap, the lowest bit first. */
const isNull = (nulls: Buffer | undefined, i: number) => {
  const byte = Math.floor(i / 8);
  return Boolean(nulls && nulls.length > byte && Math.floor(nulls[byte] / 2 ** (i % 8)) % 2 === 1);
};

/**
 * The rows of a column set, as arrays of cells: integers as numbers (a
 * BIGINT past 2^53 as its digits), DECIMAL, dates and timestamps as the
 * server's strings, a timestamp with a zone with its offset, binary as bytes.
 */
export function rowsOfColumns(columns: HiveColumn[], rowSet: any): unknown[][] {
  const sets: any[] = rowSet?.columns ?? [];
  if (!sets.length) {
    if ((rowSet?.rows ?? []).length) {
      throw new HiveError('The server answered rows, not columns: its protocol is older than V6', 'protocol');
    }
    return [];
  }
  const data = sets.map((set) => set.boolVal ?? set.byteVal ?? set.i16Val ?? set.i32Val ?? set.i64Val ?? set.doubleVal ?? set.stringVal ?? set.binaryVal);
  const count = Math.max(0, ...data.map((d) => d?.values?.length ?? 0));
  const rows: unknown[][] = [];
  for (let r = 0; r < count; r++) {
    const row: unknown[] = new Array(sets.length);
    for (let c = 0; c < sets.length; c++) {
      const d = data[c];
      if (!d || r >= d.values.length || isNull(d.nulls, r)) {
        row[c] = null;
      } else if (sets[c].i64Val) {
        row[c] = int64Cell(d.values[r]);
      } else if (columns[c]?.typeId === T.TTypeId.TIMESTAMPLOCALTZ_TYPE && typeof d.values[r] === 'string') {
        row[c] = zonedCell(d.values[r]);
      } else {
        row[c] = d.values[r];
      }
    }
    rows.push(row);
  }
  return rows;
}

/** A statement's state, as GetOperationStatus answers it, taken to its end. */
function endOf(status: any, flavour: HiveFlavour): HiveError | null | undefined {
  const state = status?.operationState;
  switch (state) {
    case T.TOperationState.FINISHED_STATE:
      return null;
    case T.TOperationState.CANCELED_STATE:
      return new HiveError('The statement was cancelled', 'cancelled');
    case T.TOperationState.TIMEDOUT_STATE:
      return new HiveError(status?.errorMessage || 'The statement ran past its time limit', 'timeout');
    case T.TOperationState.CLOSED_STATE:
      return new HiveError('The statement was closed', 'cancelled');
    case T.TOperationState.ERROR_STATE:
    case T.TOperationState.UKNOWN_STATE: {
      const message = String(status?.errorMessage || 'The statement failed');
      // Impala words its EXEC_TIME_LIMIT_S as an error; Hive's query timeout, on some versions, too.
      const timedOut = flavour === 'impala'
        ? /expired due to execution time limit/i.test(message)
        : /timed? ?out after \d+ seconds|query timed out/i.test(message);
      return new HiveError(message, timedOut ? 'timeout' : 'server', status?.sqlState ? String(status.sqlState) : null, status?.errorCode ?? null);
    }
    default:
      // Still running.
      return undefined;
  }
}

const sleep = (ms: number) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** A running statement on a connection. */
export interface HiveOperation {
  handle: any;
  hasResultSet: boolean;
  columns: HiveColumn[] | null;
}

/**
 * One connection to HiveServer2 (or Impala, or Spark's Thrift server), with
 * one session on it. Fails, and stays failed, once its socket errors or
 * closes, or a call outlives its deadline.
 */
export class HiveConnection {
  /** Why it can't be used any more, once it can't. */
  public broken: HiveError | null = null;

  protected client: any;

  protected session: any;

  protected socket: net.Socket | null = null;

  protected thriftConnection: any;

  protected readonly waiting = new Set<(e: HiveError) => void>();

  /** The protocol version the server answered with. */
  public protocol = 0;

  /** The statement `all` runs, for its cancel. */
  public running: HiveOperation | null = null;

  /** The server's name and version, as it says them (GetInfo): `Apache Hive` `3.1.3`, `Spark SQL` `4.3.0`. */
  public server: { name: string; version: string } = { name: '', version: '' };

  /**
   * Whether the server honours an OFFSET: Hive 4 and later, and Spark 3.4 and
   * later. Hive 3 ignores one after an ORDER BY (and miscounts it after a
   * subquery's), and Spark before 3.4 has none.
   */
  public get offsetWorks(): boolean {
    const [major, minor] = this.server.version.split('.').map((part) => Number.parseInt(part, 10));
    if (/spark/i.test(this.server.name)) {
      return major > 3 || (major === 3 && minor >= 4);
    }
    if (/hive/i.test(this.server.name)) {
      return major >= 4;
    }
    return false;
  }

  /**
   * A statement as this server runs it rightly: one ending in `LIMIT n OFFSET
   * m`, where the server doesn't honour the OFFSET, as `LIMIT n + m`, its
   * first `m` rows to be skipped by the reader.
   */
  public offsetPlan(sql: string): { sql: string; skip: number } {
    return (this.offsetWorks ? null : hiveTrailingOffset(sql)) ?? { sql, skip: 0 };
  }

  protected constructor(protected readonly config: HiveConfig) {}

  /** Connects, signs in and opens a session in the configured database, within the connect deadline. */
  public static async open(config: HiveConfig): Promise<HiveConnection> {
    const connection = new HiveConnection(config);
    await connection.connect();
    return connection;
  }

  protected get callMs() {
    return this.config.callTimeoutMs ?? HIVE_CALL_MS;
  }

  /** Marks it failed: every call waiting rejects, and its socket goes. */
  protected fail(e: HiveError) {
    if (!this.broken) {
      this.broken = e;
    }
    for (const reject of [...this.waiting]) {
      reject(this.broken);
    }
    this.waiting.clear();
    this.socket?.destroy();
  }

  protected async connect() {
    const { config } = this;
    const deadline = config.connectTimeoutMs ?? HIVE_CONNECT_MS;
    const transport = config.ssl
      ? new TlsTransport(config.host, config.port, {
        // The package's own default checks nothing: set here, always.
        rejectUnauthorized: config.ssl.rejectUnauthorized,
        ca: config.ssl.ca,
        servername: config.ssl.servername ?? (net.isIP(config.host) ? undefined : config.host),
      })
      : new TcpTransport(config.host, config.port);
    const auth = config.mechanism === 'nosasl'
      ? new hive.auth.NoSaslAuthentication()
      : new hive.auth.PlainTcpAuthentication({ username: config.user, password: config.password ?? PLAIN_PLACEHOLDER });
    // Its socket exists once it connects: its errors heard at once (`connect` is synchronous).
    const connectTransport = transport.connect.bind(transport);
    transport.connect = () => {
      connectTransport();
      this.socket = transport.getTransport();
      this.socket!.on('error', (e: Error) => this.fail(new HiveError(`${config.host}:${config.port}: ${e.message}`, 'connect')));
      this.socket!.on('close', () => this.fail(new HiveError('The server closed the connection', 'closed')));
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.waiting.add(reject);
        timer = setTimeout(() => this.fail(new HiveError(
          `${config.host}:${config.port} didn't complete ${config.mechanism === 'plain' ? 'the sign-in' : 'connecting'} within ${deadline} ms: is it HiveServer2's binary port${config.ssl ? ', with TLS' : ', without TLS'}?`,
          'connect',
        )), deadline);
        auth.authenticate(transport).then((authenticated: any) => {
          this.waiting.delete(reject);
          if (this.broken) {
            reject(this.broken);
            return;
          }
          this.thriftConnection = new thrift.Connection(authenticated.getTransport(), {
            transport: thrift.TFramedTransport,
            protocol: thrift.TBinaryProtocol,
            // Which event says it connected: `secureConnect` with TLS.
            ssl: Boolean(config.ssl),
            // NOSASL's buffered transport.
            ...authenticated.getOptions(),
          });
          // Thrift's own errors (a frame it can't read): the connection fails, nothing throws.
          this.thriftConnection.on('error', (e: Error) => this.fail(new HiveError(e.message, 'protocol')));
          this.thriftConnection.on('close', () => this.fail(new HiveError('The server closed the connection', 'closed')));
          // It connected (and signed in) before Thrift's connection was made over it: Thrift is told so.
          authenticated.emit('connect');
          this.client = thrift.createClient(TCLIService, this.thriftConnection);
          resolve();
        }, (e: Error) => {
          this.waiting.delete(reject);
          reject(this.broken ?? new HiveError(e.message, 'connect'));
        });
      });
      const opened = await this.call('OpenSession', new T.TOpenSessionReq({
        client_protocol: HIVE_PROTOCOL,
        username: config.mechanism === 'plain' ? config.user : undefined,
        password: config.mechanism === 'plain' ? (config.password ?? PLAIN_PLACEHOLDER) : undefined,
        configuration: {
          'use:database': config.database,
          // Hive's and Spark's: a column is named as selected, not `table.column` (Impala names it so),
          // and no `${env:…}`, `${system:…}` or other variable is substituted into a statement's text,
          // strings included, before it is parsed: it would read the server's environment.
          ...(config.flavour === 'hive' ? {
            'set:hiveconf:hive.resultset.use.unique.column.names': 'false',
            'set:hiveconf:hive.variable.substitute': 'false',
            'set:hiveconf:spark.sql.variable.substitute': 'false',
          } : {}),
        },
      }), deadline);
      this.protocol = Number(opened.serverProtocolVersion);
      if (!(this.protocol >= OLDEST_PROTOCOL)) {
        throw new HiveError(`The server speaks HiveServer2 protocol V${this.protocol + 1}: xcube reads V6 or later, whose results come as columns`, 'protocol');
      }
      this.session = opened.sessionHandle;
      this.server = await this.serverInfo(deadline);
    } catch (e) {
      clearTimeout(timer);
      this.fail(e instanceof HiveError ? e : new HiveError(String((e as Error)?.message ?? e), 'connect'));
      throw this.broken;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The server's name and version; empty where it doesn't say. */
  protected async serverInfo(ms: number): Promise<{ name: string; version: string }> {
    const info = async (type: number) => {
      try {
        const answer = await this.call('GetInfo', new T.TGetInfoReq({ sessionHandle: this.session, infoType: type }), ms);
        return String(answer?.infoValue?.stringValue ?? '');
      } catch (e) {
        if (this.broken) {
          throw e;
        }
        return '';
      }
    };
    return { name: await info(T.TGetInfoType.CLI_DBMS_NAME), version: await info(T.TGetInfoType.CLI_DBMS_VER) };
  }

  /**
   * One Thrift call: its answer once its status is a success, raced against
   * the connection failing and its own deadline, past which the connection is
   * dropped (its answer, if it came, would be read as the next call's).
   */
  protected call(method: string, request: any, ms = this.callMs): Promise<any> {
    if (this.broken) {
      return Promise.reject(this.broken);
    }
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      let onBroken: (e: HiveError) => void = () => undefined;
      const finish = (fn: () => void) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          this.waiting.delete(onBroken);
          fn();
        }
      };
      onBroken = (e: HiveError) => finish(() => reject(e));
      this.waiting.add(onBroken);
      timer = setTimeout(() => {
        const e = new HiveError(`The server didn't answer ${method} within ${ms} ms`, 'deadline');
        finish(() => reject(e));
        this.fail(e);
      }, ms);
      try {
        this.client[method](request, (err: any, response: any) => finish(() => {
          if (err) {
            reject(new HiveError(String(err?.message ?? err), 'protocol'));
            return;
          }
          const failed = statusError(response?.status);
          if (failed) {
            reject(failed);
            return;
          }
          resolve(response);
        }));
      } catch (e: any) {
        finish(() => reject(new HiveError(String(e?.message ?? e), 'protocol')));
      }
    });
  }

  /**
   * Starts a statement, asynchronously, with the server's own time limit:
   * Hive's `queryTimeout` (seconds), or Impala's `EXEC_TIME_LIMIT_S`.
   */
  public async execute(sql: string, timeoutS: number | null): Promise<HiveOperation> {
    const confOverlay: Record<string, string> = {};
    if (timeoutS !== null && this.config.flavour === 'impala') {
      confOverlay.EXEC_TIME_LIMIT_S = String(timeoutS);
    }
    const answer = await this.call('ExecuteStatement', new T.TExecuteStatementReq({
      sessionHandle: this.session,
      statement: sql,
      confOverlay,
      runAsync: true,
      ...(timeoutS !== null && this.config.flavour === 'hive' ? { queryTimeout: timeoutS } : {}),
    }));
    return { handle: answer.operationHandle, hasResultSet: Boolean(answer.operationHandle?.hasResultSet), columns: null };
  }

  /** Waits for a statement to finish, its status asked at a pace from 50 ms to 1 s; `stopped` ends the wait. */
  public async finish(op: HiveOperation, stopped: () => boolean = () => false): Promise<void> {
    let pause = 50;
    for (;;) {
      const status = await this.call('GetOperationStatus', new T.TGetOperationStatusReq({ operationHandle: op.handle, getProgressUpdate: false }));
      const end = endOf(status, this.config.flavour);
      if (end !== undefined) {
        if (typeof status.hasResultSet === 'boolean') {
          op.hasResultSet = status.hasResultSet;
        }
        if (end) {
          throw end;
        }
        return;
      }
      if (stopped()) {
        throw new HiveError('The statement was cancelled', 'cancelled');
      }
      await sleep(pause);
      pause = Math.min(1000, Math.round(pause * 1.5));
    }
  }

  /** A finished statement's columns. */
  public async columns(op: HiveOperation): Promise<HiveColumn[]> {
    if (!op.columns) {
      op.columns = op.hasResultSet
        ? columnsOf((await this.call('GetResultSetMetadata', new T.TGetResultSetMetadataReq({ operationHandle: op.handle }))).schema)
        : [];
    }
    return op.columns;
  }

  /** The next rows of a finished statement, at most `maxRows`: none once all are read. */
  public async fetch(op: HiveOperation, maxRows: number): Promise<unknown[][]> {
    const columns = await this.columns(op);
    if (!op.hasResultSet) {
      return [];
    }
    const answer = await this.call('FetchResults', new T.TFetchResultsReq({
      operationHandle: op.handle,
      orientation: T.TFetchOrientation.FETCH_NEXT,
      maxRows,
      fetchType: 0,
    }), HIVE_FETCH_MS);
    return rowsOfColumns(columns, answer.results);
  }

  /** Stops a statement on the server; never throws. */
  public async cancel(op: HiveOperation | null): Promise<void> {
    if (op && !this.broken) {
      await this.call('CancelOperation', new T.TCancelOperationReq({ operationHandle: op.handle })).catch(() => undefined);
    }
  }

  /** Lets a statement go on the server; never throws. */
  public async closeOperation(op: HiveOperation | null): Promise<void> {
    if (op && !this.broken) {
      await this.call('CloseOperation', new T.TCloseOperationReq({ operationHandle: op.handle })).catch(() => undefined);
    }
  }

  /** A catalog call's rows (GetSchemas, GetTables, GetColumns), by column name. */
  public async catalog(method: 'GetSchemas' | 'GetTables' | 'GetColumns', request: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const Req = T[`T${method}Req`];
    const answer = await this.call(method, new Req({ sessionHandle: this.session, ...request }));
    const op: HiveOperation = { handle: answer.operationHandle, hasResultSet: true, columns: null };
    try {
      await this.finish(op);
      const columns = await this.columns(op);
      const out: Record<string, unknown>[] = [];
      for (;;) {
        const rows = await this.fetch(op, FETCH_ROWS);
        if (!rows.length) {
          return out;
        }
        out.push(...rows.map((row) => Object.fromEntries(columns.map((c, i) => [c.name.toUpperCase(), row[i]]))));
      }
    } finally {
      await this.closeOperation(op);
    }
  }

  /** Runs a statement to its end and reads all its rows, its cancel stopping it on the server. */
  public async all(statement: string, timeoutS: number | null, stopped: () => boolean): Promise<{ columns: HiveColumn[]; rows: unknown[][] }> {
    const { sql, skip } = this.offsetPlan(statement);
    const op = await this.execute(sql, timeoutS);
    this.running = op;
    try {
      await this.finish(op, stopped);
      const columns = await this.columns(op);
      const rows: unknown[][] = [];
      for (;;) {
        if (stopped()) {
          throw new HiveError('The statement was cancelled', 'cancelled');
        }
        const batch = await this.fetch(op, FETCH_ROWS);
        if (!batch.length) {
          return { columns, rows: rows.slice(skip) };
        }
        rows.push(...batch);
      }
    } finally {
      this.running = null;
      await this.closeOperation(op);
    }
  }

  /** Closes its session and its socket; never throws. */
  public async close(): Promise<void> {
    if (this.session && !this.broken) {
      await this.call('CloseSession', new T.TCloseSessionReq({ sessionHandle: this.session }), 5000).catch(() => undefined);
    }
    this.fail(new HiveError('The connection was closed', 'closed'));
    try {
      this.thriftConnection?.end();
    } catch {
      // Gone already.
    }
  }
}

/** A value written into Hive's SQL as a literal: a string with its backslashes and quotes escaped. */
export function hiveLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HiveError(`${value} can't be written as a Hive literal`, 'server');
    }
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  // Hive's and Spark's strings take a backslash as an escape: both escaped, and no control character left raw.
  // A `$` as its escape, `\u0024`: a server whose variable substitution is on would read `${…}` in a string.
  return `'${text.replace(/[\\']/g, (c) => `\\${c}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0')
    .replace(/\$/g, '\\u0024')}'`;
}

/**
 * Cube's SQL with its `?` placeholders as literals. `marks` finds the
 * placeholders as Hive's lexer would, never a `?` in a string or comment.
 */
export function inlineValues(sql: string, values: unknown[], marks: (sql: string) => number[]): string {
  if (!values.length) {
    return sql;
  }
  const at = marks(sql);
  if (at.length !== values.length) {
    throw new HiveError(`The query has ${at.length} placeholders for ${values.length} values`, 'server');
  }
  let out = '';
  let from = 0;
  at.forEach((position, i) => {
    out += sql.slice(from, position) + hiveLiteral(values[i]);
    from = position + 1;
  });
  return out + sql.slice(from);
}

/** A promise Cube's queue can stop: it reads `cancel` off what `query` returns. */
type CancelablePromise<T> = Promise<T> & { cancel: () => Promise<void> };

/** How long an idle connection is kept. */
const IDLE_MS = 30000;

/** How long a statement waits for a connection while all of them are in use. */
const ACQUIRE_MS = 120000;

/**
 * A data source's connections: at most `max`, an idle one kept for
 * `IDLE_MS`. Unlike generic-pool (Cube's `Pool`), which retries a connection
 * that fails to open until its acquire timeout, an acquire that opens a
 * connection fails as that connection fails, with the driver's words, at
 * once; only one waiting for a connection in use waits, up to `ACQUIRE_MS`.
 */
export class HiveConnections {
  protected readonly idle: { connection: HiveConnection; timer: NodeJS.Timeout }[] = [];

  protected readonly waiting: { resolve: (c: HiveConnection) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  /** Open or opening, in use or idle. */
  protected size = 0;

  protected closed = false;

  public constructor(protected readonly open: () => Promise<HiveConnection>, protected readonly max: number) {}

  public async acquire(): Promise<HiveConnection> {
    if (this.closed) {
      throw new HiveError('The data source\'s driver was released', 'closed');
    }
    for (let next = this.idle.pop(); next; next = this.idle.pop()) {
      clearTimeout(next.timer);
      if (!next.connection.broken) {
        return next.connection;
      }
      this.size -= 1;
      await next.connection.close();
    }
    if (this.size < this.max) {
      return this.opened();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          reject(new HiveError(`No connection to the data source was free within ${ACQUIRE_MS} ms`, 'deadline'));
        }, ACQUIRE_MS),
      };
      this.waiting.push(waiter);
    });
  }

  protected async opened(): Promise<HiveConnection> {
    this.size += 1;
    try {
      return await this.open();
    } catch (e) {
      this.size -= 1;
      throw e;
    }
  }

  /** Gives a connection back: to a statement waiting, else kept idle; a failed one is closed. */
  public release(connection: HiveConnection) {
    if (connection.broken || this.closed) {
      this.size -= 1;
      connection.close().catch(() => undefined);
      // Its place is free: a statement waiting opens one of its own.
      const waiter = this.waiting.shift();
      if (waiter && !this.closed) {
        clearTimeout(waiter.timer);
        this.opened().then(waiter.resolve, waiter.reject);
      }
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(connection);
      return;
    }
    const entry = {
      connection,
      timer: setTimeout(() => {
        this.idle.splice(this.idle.indexOf(entry), 1);
        this.size -= 1;
        connection.close().catch(() => undefined);
      }, IDLE_MS),
    };
    entry.timer.unref?.();
    this.idle.push(entry);
  }

  /** Closes the idle connections and refuses statements waiting; those in use close as they come back. */
  public async close() {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new HiveError('The data source\'s driver was released', 'closed'));
    }
    const idle = this.idle.splice(0);
    this.size -= idle.length;
    await Promise.all(idle.map(({ connection, timer }) => {
      clearTimeout(timer);
      return connection.close();
    }));
  }
}

/** Cube's driver for a Hive (or Spark, or Impala) data source. */
export class HiveDriver extends BaseDriver {
  public readonly config: HiveConfig;

  protected readonly pool: HiveConnections;

  public constructor(config: HiveConfig) {
    super({ testConnectionTimeout: config.connectTimeoutMs ?? HIVE_CONNECT_MS });
    if (!config.host) {
      throw new HiveError('host is required', 'connect');
    }
    this.config = config;
    this.pool = new HiveConnections(() => HiveConnection.open(this.config), Number(config.maxPoolSize) > 0 ? Number(config.maxPoolSize) : 8);
  }

  /** A connection of the caller's own, outside the pool: the SQL runner's. */
  public openConnection(): Promise<HiveConnection> {
    return HiveConnection.open(this.config);
  }

  /** Runs a statement on a pooled connection; a connection that failed isn't given back. */
  protected async withConnection<R>(fn: (connection: HiveConnection) => Promise<R>): Promise<R> {
    const connection = await this.pool.acquire();
    try {
      return await fn(connection);
    } finally {
      this.pool.release(connection);
    }
  }

  public override query<R = unknown>(query: string, values?: unknown[]): Promise<R[]> {
    let stopped = false;
    let connection: HiveConnection | null = null;
    const sql = inlineValues(query, values ?? [], hivePlaceholders);
    const promise = this.withConnection(async (c) => {
      connection = c;
      const { columns, rows } = await c.all(sql, this.config.queryTimeout ?? HIVE_QUERY_TIMEOUT_S, () => stopped);
      return rows.map((row) => Object.fromEntries(columns.map((col, i) => [col.name, row[i]])) as R);
    }) as CancelablePromise<R[]>;
    promise.cancel = async () => {
      stopped = true;
      const c = connection as HiveConnection | null;
      await c?.cancel(c.running);
    };
    return promise;
  }

  /** It connects, signs in, opens a session and answers a statement. */
  public override async testConnection(): Promise<void> {
    await this.withConnection((c) => c.all('SELECT 1', 30, () => false));
  }

  public override readOnly() {
    return true;
  }

  public override capabilities() {
    return { incrementalSchemaLoading: true };
  }

  public override async getSchemas() {
    const rows = await this.withConnection((c) => c.catalog('GetSchemas', {}));
    return rows.map((r) => ({ schema_name: String(r.TABLE_SCHEM ?? r.TABLE_SCHEMA ?? '') })).filter((r) => r.schema_name);
  }

  public override async getTablesForSpecificSchemas(schemas: { schema_name: string }[]) {
    const out: { schema_name: string; table_name: string; table_type?: string }[] = [];
    await this.withConnection(async (c) => {
      for (const { schema_name: schema } of schemas) {
        const rows = await c.catalog('GetTables', { schemaName: schema, tableName: '%' });
        out.push(...rows.map((r) => ({
          schema_name: schema,
          table_name: String(r.TABLE_NAME),
          table_type: r.TABLE_TYPE == null ? undefined : String(r.TABLE_TYPE),
        })));
      }
    });
    return out;
  }

  public override async getColumnsForSpecificTables(tables: { schema_name: string; table_name: string }[]) {
    const out: any[] = [];
    await this.withConnection(async (c) => {
      for (const { schema_name: schema, table_name: table } of tables) {
        const rows = await c.catalog('GetColumns', { schemaName: schema, tableName: table, columnName: '%' });
        out.push(...rows
          .sort((a, b) => Number(a.ORDINAL_POSITION ?? 0) - Number(b.ORDINAL_POSITION ?? 0))
          .map((r) => ({
            schema_name: schema,
            table_name: table,
            column_name: String(r.COLUMN_NAME),
            data_type: String(r.TYPE_NAME ?? '').toLowerCase(),
            attributes: [],
          })));
      }
    });
    return out;
  }

  public override async tablesSchema() {
    const schemas = await this.getSchemas();
    const tables = await this.getTablesForSpecificSchemas(schemas);
    const columns = await this.getColumnsForSpecificTables(tables);
    const structure: Record<string, Record<string, { name: string; type: string; attributes: string[] }[]>> = {};
    for (const { schema_name: schema, table_name: table } of tables) {
      (structure[schema] ??= {})[table] ??= [];
    }
    for (const c of columns) {
      structure[c.schema_name][c.table_name].push({ name: c.column_name, type: c.data_type, attributes: [] });
    }
    return structure;
  }

  public override toGenericType(columnType: string): string {
    const type = columnType.toLowerCase().replace(/\(.*$/, '');
    const generic: Record<string, string> = {
      string: 'text', varchar: 'text', char: 'text', tinyint: 'int', smallint: 'int', int: 'int', integer: 'int', bigint: 'bigint',
      float: 'float', double: 'double', decimal: 'decimal', boolean: 'boolean', date: 'date', timestamp: 'timestamp',
    };
    return generic[type] ?? super.toGenericType(columnType);
  }

  public override async release() {
    await this.pool.close();
  }
}

/** A Hive driver from a connection's config (`DRIVERS.hive.config`). */
export function makeHiveDriver(config: Record<string, unknown>): HiveDriver {
  return new HiveDriver(config as HiveConfig);
}
