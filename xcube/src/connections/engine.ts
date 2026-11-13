/**
 * wechart's in-memory engine, as a data source: a service of its own,
 * reached over HTTP(S), that runs one DuckDB-dialect statement per call. Cube
 * compiles for it with its DuckDB dialect (the connection's `cubeType`); this
 * driver only carries the statement and its values there and the rows back.
 *
 * The engine's routes, under the connection's `baseUrl`, each with the
 * connection's service token as `Authorization: Bearer …`:
 * - `POST /v1/query` `{ sql, params, queryId, timeoutMs, requestId?, maxRows? }`
 *   → `{ columns: [{ name, type }], rows: [[…], …] }`, its cells as Cube's
 *   DuckDB driver gives them (`Transform.ts`); otherwise non-2xx `{ error, code }`.
 *   `maxRows` is sent by the SQL runner alone.
 * - `DELETE /v1/query/{queryId}` stops a query.
 * - `GET /v1/health` answers 2xx when it serves; it takes no token.
 *
 * The request's Cube request id goes as `X-Request-Id` too.
 */
import crypto from 'crypto';
import http from 'http';
import https from 'https';

import { BaseDriver } from '@cubejs-backend/base-driver';

/** Cube's own default for a query on the drivers that take one: ten minutes. */
export const ENGINE_QUERY_TIMEOUT_MS = 600000;

/** How long past its own timeout a query's answer is waited for, before xcube stops it on the engine. */
const ANSWER_GRACE_MS = 5000;

/** The most an answer may hold: past it the request is dropped and the query stopped. */
export const ENGINE_MAX_ANSWER_BYTES = 512 * 1024 * 1024;

/** A health check's or a cancel's own time cap. */
const SHORT_CALL_MS = 10000;

export interface EngineConfig {
  baseUrl: string;
  token: string;
  sslRejectUnauthorized?: boolean;
  sslCa?: string;
  /** A query's time cap on the engine (`timeoutMs`), unless the call sets its own. */
  queryTimeoutMs?: number;
  maxPoolSize?: number;
  [key: string]: unknown;
}

export interface EngineColumn {
  name: string;
  type: string;
}

export interface EngineAnswer {
  columns: EngineColumn[];
  rows: unknown[][];
}

/** The engine's refusal of a call, or xcube's own of its answer. */
export class EngineError extends Error {
  public constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
    this.name = 'EngineError';
  }
}

/**
 * How an engine error's code rides on its message through Cube's query
 * queue, which keeps an error's message alone (`QueryQueue`): appended by
 * the driver on Cube's path (`query`), and taken off again by xcube's gateway
 * as the answer's `engineCode` (`engineCodeOf`).
 */
const CODE_TAG = /\s\[engine code: ([a-z][a-z0-9_]*)\]$/;

/** A message, its engine code tagged on. */
export const withEngineCode = (message: string, code: string) => `${message} [engine code: ${code}]`;

/** An error message's engine code, and the message without it: `undefined` code when it has none. */
export function engineCodeOf(message: string): { message: string; code?: string } {
  const match = CODE_TAG.exec(message);
  return match ? { message: message.slice(0, match.index), code: match[1] } : { message };
}

/** A promise Cube's queue can stop: it reads `cancel` off what `query` returns. */
export type CancelablePromise<T> = Promise<T> & { cancel: () => Promise<void> };

/** A value as JSON can carry it to the engine: Cube's are strings, numbers, booleans, null and dates. */
export function engineParam(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    throw new EngineError('A binary value can\'t be sent to the engine', 'unsupported_parameter');
  }
  return value;
}

/** An answer, once its shape is the contract's: columns with names, rows as wide as them. */
export function checkedAnswer(answer: unknown): EngineAnswer {
  const a = answer as Partial<EngineAnswer> | null;
  if (!a || typeof a !== 'object' || !Array.isArray(a.columns) || !Array.isArray(a.rows)) {
    throw new EngineError('The engine\'s answer has no columns and rows', 'bad_answer');
  }
  for (const column of a.columns) {
    if (!column || typeof column !== 'object' || typeof column.name !== 'string') {
      throw new EngineError('The engine\'s answer has a column with no name', 'bad_answer');
    }
  }
  for (const row of a.rows) {
    if (!Array.isArray(row) || row.length !== a.columns.length) {
      throw new EngineError(`The engine's answer has a row that isn't ${a.columns.length} cells wide`, 'bad_answer');
    }
  }
  return { columns: a.columns.map((c) => ({ name: c.name, type: String(c.type ?? '') })), rows: a.rows };
}

/** The rows of an answer, as objects by column name: what Cube's drivers give. */
export function rowsOf(answer: unknown): Record<string, unknown>[] {
  const { columns, rows } = checkedAnswer(answer);
  const names = columns.map((c) => c.name);
  return rows.map((row) => {
    const object: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) {
      object[names[i]] = row[i];
    }
    return object;
  });
}

/** Whether a deployment lets an engine be reached over plain HTTP, its token in the clear (`XCUBE_ENGINE_ALLOW_HTTP`). */
export const engineHttpAllowed = () => process.env.XCUBE_ENGINE_ALLOW_HTTP === 'true';

/** What is wrong with an engine's base URL: an http(s) origin and an optional path, with nothing else in it. */
export function baseUrlProblems(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') {
    return [];
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return ['baseUrl must be a URL, such as https://engine.example:8443'];
  }
  const problems: string[] = [];
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push('baseUrl must be an https:// URL');
  } else if (url.protocol === 'http:' && !engineHttpAllowed()) {
    problems.push('baseUrl must be https://: plain HTTP isn\'t allowed in this deployment (XCUBE_ENGINE_ALLOW_HTTP)');
  }
  if (url.username || url.password) {
    problems.push('baseUrl can\'t hold a user or password: the token signs in');
  }
  if (url.search || url.hash || value.includes('?') || value.includes('#')) {
    problems.push('baseUrl can\'t hold a query or fragment');
  }
  return problems;
}

interface Call {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  requestId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The engine's error, from its `{ error, code }`, or the status alone. */
function answerError(status: number, text: string): EngineError {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
      return new EngineError(parsed.error, typeof parsed.code === 'string' ? parsed.code : undefined, status);
    }
  } catch {
    // Not JSON: its status speaks.
  }
  return new EngineError(`The engine answered ${status}${text ? `: ${text.slice(0, 200)}` : ''}`, undefined, status);
}

export class EngineDriver extends BaseDriver {
  public readonly config: EngineConfig;

  protected readonly base: URL;

  protected readonly agent: http.Agent;

  /** Queries running, by id: each stops with its controller. */
  protected readonly running = new Map<string, AbortController>();

  public constructor(config: EngineConfig) {
    super({ testConnectionTimeout: SHORT_CALL_MS });
    const problems = [...(config.baseUrl ? [] : ['baseUrl is required']), ...baseUrlProblems(config.baseUrl)];
    if (!config.token) {
      problems.push('token is required');
    }
    if (problems.length) {
      throw new EngineError(problems.join('; '), 'bad_config');
    }
    this.config = config;
    this.base = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`);
    const maxSockets = Number(config.maxPoolSize) > 0 ? Number(config.maxPoolSize) : 10;
    this.agent = this.base.protocol === 'https:'
      ? new https.Agent({
        keepAlive: true,
        maxSockets,
        rejectUnauthorized: config.sslRejectUnauthorized !== false,
        ...(config.sslCa ? { ca: config.sslCa } : {}),
      })
      : new http.Agent({ keepAlive: true, maxSockets });
  }

  /** One call to the engine: its JSON answer, or its error. */
  protected call(call: Call): Promise<unknown> {
    const url = new URL(call.path.replace(/^\//, ''), this.base);
    const payload = call.body === undefined ? undefined : Buffer.from(JSON.stringify(call.body));
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let req: http.ClientRequest | undefined;
      let unlisten = () => undefined as void;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          unlisten();
          fn();
        }
      };
      const onAbort = () => {
        req?.destroy();
        settle(() => reject(new EngineError('The query was cancelled', 'cancelled')));
      };
      req = transport.request(url, {
        method: call.method,
        agent: this.agent,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(call.requestId ? { 'x-request-id': call.requestId } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > ENGINE_MAX_ANSWER_BYTES) {
            req?.destroy();
            settle(() => reject(new EngineError(`The engine's answer is over ${ENGINE_MAX_ANSWER_BYTES} bytes`, 'answer_too_large')));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (e) => settle(() => reject(e)));
        res.on('end', () => settle(() => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(answerError(status, text));
            return;
          }
          if (!text) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new EngineError('The engine\'s answer isn\'t JSON', 'bad_answer', status));
          }
        }));
      });
      timer = setTimeout(() => {
        req?.destroy();
        settle(() => reject(new EngineError(`The engine didn't answer within ${call.timeoutMs} ms`, 'timeout')));
      }, call.timeoutMs);
      if (call.signal?.aborted) {
        onAbort();
        return;
      }
      call.signal?.addEventListener('abort', onAbort);
      unlisten = () => call.signal?.removeEventListener('abort', onAbort);
      req.on('error', (e) => settle(() => reject(e)));
      req.end(payload);
    });
  }

  /**
   * Runs one statement on the engine: its answer as the engine gave it. Its
   * `cancel` stops it there, as does the query's own time cap.
   */
  public run(
    sql: string,
    values: unknown[] = [],
    options: { requestId?: string; timeoutMs?: number; maxRows?: number; queryId?: string } = {},
  ): CancelablePromise<EngineAnswer> {
    const queryId = options.queryId ?? crypto.randomUUID();
    const timeoutMs = options.timeoutMs ?? this.config.queryTimeoutMs ?? ENGINE_QUERY_TIMEOUT_MS;
    const controller = new AbortController();
    this.running.set(queryId, controller);
    let stopped = false;
    const stop = async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      controller.abort();
      await this.call({ method: 'DELETE', path: `v1/query/${encodeURIComponent(queryId)}`, requestId: options.requestId, timeoutMs: SHORT_CALL_MS })
        .catch(() => undefined);
    };
    const promise = (async () => {
      try {
        const answer = await this.call({
          method: 'POST',
          path: 'v1/query',
          body: {
            sql,
            params: (values ?? []).map(engineParam),
            queryId,
            ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
            timeoutMs,
            ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
          },
          requestId: options.requestId,
          timeoutMs: timeoutMs + ANSWER_GRACE_MS,
          signal: controller.signal,
        });
        return checkedAnswer(answer);
      } catch (e: any) {
        if (e instanceof EngineError && e.code === 'timeout') {
          // Our clock ran out before the engine's: it may still be running it.
          await stop();
        }
        throw e;
      } finally {
        this.running.delete(queryId);
      }
    })() as CancelablePromise<EngineAnswer>;
    promise.cancel = stop;
    return promise;
  }

  public override query<R = unknown>(query: string, values?: unknown[], options?: any): Promise<R[]> {
    const running = this.run(query, values ?? [], { requestId: options?.requestId });
    const rows = running.then((answer) => rowsOf(answer) as R[], (e: unknown) => {
      // Cube's queue keeps the message alone: the code rides on it, to the client (`engineCodeOf`).
      if (e instanceof EngineError && e.code) {
        throw new EngineError(withEngineCode(e.message, e.code), e.code, e.status);
      }
      throw e;
    }) as CancelablePromise<R[]>;
    rows.cancel = running.cancel;
    return rows;
  }

  /**
   * The engine says it serves (`/v1/health`, which takes no token), and takes
   * the token: a statement of its own, answered.
   */
  public override async testConnection(): Promise<void> {
    await this.call({ method: 'GET', path: 'v1/health', timeoutMs: SHORT_CALL_MS });
    await this.run('SELECT 1 AS ok', [], { timeoutMs: SHORT_CALL_MS });
  }

  public override readOnly() {
    return true;
  }

  /** Stops what still runs, and lets go of its sockets. */
  public override async release() {
    for (const controller of this.running.values()) {
      controller.abort();
    }
    this.running.clear();
    this.agent.destroy();
  }
}

/** An engine driver from a connection's config (`DRIVERS.engine.config`). */
export function makeEngineDriver(config: Record<string, unknown>): EngineDriver {
  return new EngineDriver(config as EngineConfig);
}
