import { redact } from '../connections/connections';
import {
  classifySql, SqlRefusal, withRowCap, type SqlDialect,
} from './classify';
import {
  isTimeout, openSession, RowCollector, SqlRunError, type SessionDialect, type SqlAnswer, type SqlCaps, type SqlSession,
} from './runner';

/** What a run runs on: its dialect, and its own driver, built for it. */
export interface SqlTarget {
  dialect: SessionDialect;
  /** For logs: the connection's name, an overlay's, or Cube Store. */
  label: string;
  /** A driver of the run's own, not yet connected, with the opened secrets its errors are redacted of. */
  build(caps: SqlCaps): Promise<{ driver: any; secrets: string[] }>;
}

export interface SqlRunRequest extends SqlCaps {
  sql: string;
  runId: string;
}

/** Where runs are noted while they run, so that a cancel reaches the instance running one. */
export interface SqlRunRegistry {
  /** Notes a run as running here; `false` when a run of that id still runs. */
  startSqlRun(runId: string, model: string, instance: string, target: string, expiresAt: Date): Promise<boolean>;
  endSqlRun(runId: string, instance: string): Promise<void>;
  /** The instance running a model's run, while it runs. */
  sqlRunInstance(runId: string, model: string): Promise<string | null>;
  /** Tells the instance running a run to cancel it. */
  announceSqlCancel(model: string, runId: string, instance: string): Promise<void>;
}

/** Connecting has its own limit, as the connection test's. */
const CONNECT_MS = 30000;

/** xcube's clock fires this long after the database's own timeout should have. */
const CLOCK_GRACE_MS = 2000;

/** How long a cancelled statement may take to stop before its connection is dropped. */
const CANCEL_GRACE_MS = 5000;

/** How long letting a run's connection go may take before the answer goes without it. */
const CLOSE_MS = 10000;

/** At most this many runs at once on one instance: each holds up to its byte cap of rows, beside the queries it serves. */
export const MAX_RUNS = 16;

const elapsed = (ms: number) => `${Math.round(ms / 100) / 10} s`;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The runs on this instance: each checked, noted while it runs, connected on
 * its own driver, run under its caps, and let go; and cancels, here or on
 * the instance running one.
 */
export class SqlRuns {
  protected readonly local = new Map<string, { model: string; cancel: () => void }>();

  public constructor(
    protected readonly instanceId: string,
    protected readonly registry: () => SqlRunRegistry | null,
    protected readonly log: (message: string, params?: Record<string, unknown>) => void,
  ) {}

  public get running(): number {
    return this.local.size;
  }

  public async run(model: string, target: SqlTarget, request: SqlRunRequest): Promise<SqlAnswer> {
    const { dialect } = target;
    const caps: SqlCaps = {
      maxRows: request.maxRows, timeoutMs: request.timeoutMs, maxBytes: request.maxBytes, maxBytesBilled: request.maxBytesBilled,
    };
    let classified: ReturnType<typeof classifySql>;
    let sql: string;
    try {
      classified = classifySql(request.sql, dialect as SqlDialect);
      // Cube Store answers every row at once: asked for one more than the cap.
      sql = dialect === 'cubestore' && classified.statement === 'select'
        ? withRowCap(classified.sql, 'cubestore', request.maxRows + 1)
        : classified.sql;
    } catch (e) {
      if (e instanceof SqlRefusal) {
        throw new SqlRunError(e.code, e.message, e.redactedSql, e.statement);
      }
      throw e;
    }
    const { statement, redactedSql } = classified;
    const fail = (code: SqlRunError['code'], message: string, durationMs: number | null = null) => new SqlRunError(code, message, redactedSql, statement, durationMs);

    if (this.local.has(request.runId)) {
      throw fail('run_in_progress', `Run ${request.runId} is running`);
    }
    if (this.local.size >= MAX_RUNS) {
      throw fail('busy', `This instance runs ${MAX_RUNS} statements already; try again`);
    }
    const registry = this.registry();
    const expiresAt = new Date(Date.now() + CONNECT_MS + request.timeoutMs + CANCEL_GRACE_MS + 60000);
    if (registry && !(await registry.startSqlRun(request.runId, model, this.instanceId, target.label, expiresAt))) {
      throw fail('run_in_progress', `Run ${request.runId} is running`);
    }

    let reason: 'timeout' | 'cancelled' | null = null;
    let session: SqlSession | null = null;
    let abandon: () => void = () => undefined;
    const abandoned = new Promise<'abandoned'>((resolve) => {
      abandon = () => resolve('abandoned');
    });
    const stop = (why: 'timeout' | 'cancelled') => {
      if (reason) {
        return;
      }
      reason = why;
      session?.cancel().catch(() => undefined);
      // A statement that won't stop is left to its connection's end.
      setTimeout(abandon, CANCEL_GRACE_MS).unref?.();
    };
    this.local.set(request.runId, { model, cancel: () => stop('cancelled') });
    const stopped = (ranAt: number | null): SqlRunError => (reason === 'timeout'
      ? fail('timeout', `The statement ran past ${elapsed(request.timeoutMs)} and was stopped${dialect === 'cubestore' ? ' (Cube Store stops it at its own query timeout)' : ''}`, ranAt === null ? null : Date.now() - ranAt)
      : fail('cancelled', 'The run was cancelled', ranAt === null ? null : Date.now() - ranAt));

    let built: { driver: any; secrets: string[] } | null = null;
    try {
      try {
        built = await target.build(caps);
        session = await withTimeout(openSession(dialect, built.driver, caps, (type) => {
          throw fail('not_read_only', `BigQuery's dry run reads the statement as ${type}: only a SELECT runs here`);
        }), CONNECT_MS, 'Connecting');
      } catch (e: any) {
        if (reason) {
          throw stopped(null);
        }
        throw fail('connect_failed', redact(String(e?.message ?? e), built?.secrets ?? []));
      }
      if (reason) {
        throw stopped(null);
      }

      const ranAt = Date.now();
      const clock = setTimeout(() => stop('timeout'), request.timeoutMs + CLOCK_GRACE_MS);
      clock.unref?.();
      const rows = new RowCollector(request.maxRows, request.maxBytes);
      try {
        await Promise.race([session.run(sql, rows), abandoned]);
      } catch (e: any) {
        if (e instanceof SqlRunError) {
          throw e;
        }
        if (reason) {
          throw stopped(ranAt);
        }
        if (isTimeout(dialect, e)) {
          throw fail('timeout', `The statement ran past ${elapsed(request.timeoutMs)} and was stopped`, Date.now() - ranAt);
        }
        throw fail('query_failed', redact(String(e?.message ?? e), built.secrets), Date.now() - ranAt);
      } finally {
        clearTimeout(clock);
      }
      if (reason) {
        throw stopped(ranAt);
      }
      return {
        columns: rows.columns,
        rows: rows.rows,
        rowCount: rows.rows.length,
        truncated: rows.truncated,
        durationMs: Date.now() - ranAt,
        statement,
        redactedSql,
      };
    } finally {
      this.local.delete(request.runId);
      // A connection that won't let go never holds the answer.
      await withTimeout(Promise.resolve(session?.close()), CLOSE_MS, 'Closing').catch(() => undefined);
      await withTimeout(Promise.resolve(built?.driver?.release?.()), CLOSE_MS, 'Releasing').catch(() => undefined);
      if (built) {
        built.secrets.length = 0;
      }
      if (registry) {
        await registry.endSqlRun(request.runId, this.instanceId)
          .catch((e) => this.log('xcube: could not note a SQL run\'s end', { runId: request.runId, error: e.message }));
      }
    }
  }

  /**
   * Cancels a model's run, here or, through the store, on the instance
   * running it: whether it was found running. The run itself answers
   * `cancelled`.
   */
  public async cancel(model: string, runId: string): Promise<{ found: boolean }> {
    const here = this.local.get(runId);
    if (here) {
      if (here.model !== model) {
        return { found: false };
      }
      here.cancel();
      return { found: true };
    }
    const registry = this.registry();
    const instance = registry ? await registry.sqlRunInstance(runId, model) : null;
    if (!registry || !instance || instance === this.instanceId) {
      return { found: false };
    }
    await registry.announceSqlCancel(model, runId, instance);
    return { found: true };
  }

  /** Another instance asked this one to cancel a run. */
  public cancelHere(runId: string) {
    this.local.get(runId)?.cancel();
  }
}
