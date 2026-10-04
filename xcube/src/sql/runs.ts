import { redact } from '../connections/connections';
import {
  classifySql, SqlRefusal, withRowCap, type SqlDialect,
} from './classify';
import {
  isTimeout, openSession, RowCollector, SqlRunError, type SessionDialect, type SqlAnswer, type SqlCaps, type SqlRows, type SqlSession,
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
  /** Notes a run as stopped but run on by the database (Cube Store), until `endsBy` at the latest. */
  stopSqlRun(runId: string, instance: string, endsBy: Date): Promise<void>;
  /** A model's run while it runs, or runs on stopped: `null` once it has ended. */
  sqlRunState(runId: string, model: string): Promise<{ stopped: boolean; endsBy: Date | null } | null>;
}

/** Where a run is: running, stopped but run on by the database until `endsBy` at the latest, or ended. */
export interface SqlRunState {
  state: 'running' | 'stopping' | 'ended';
  endsBy?: string;
}

/** Connecting has its own limit, as the connection test's. */
const CONNECT_MS = 30000;

/** xcube's clock fires this long after the database's own timeout should have. */
const CLOCK_GRACE_MS = 2000;

/** How long a cancelled statement may take to stop before its connection is dropped. */
const CANCEL_GRACE_MS = 5000;

/** How long letting a run's connection go may take before the answer goes without it. */
const CLOSE_MS = 10000;

/** How long past its expected end a stopped Cube Store run is waited on. */
const ENDS_GRACE_MS = 5000;

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

  /** Runs answered as stopped that Cube Store runs on, until each ends: by run id. */
  protected readonly stopping = new Map<string, { model: string; endsBy: Date }>();

  public constructor(
    protected readonly instanceId: string,
    protected readonly registry: () => SqlRunRegistry | null,
    protected readonly log: (message: string, params?: Record<string, unknown>) => void,
    /** Cube Store's own query timeout (`CUBESTORE_QUERY_TIMEOUT`): when a query it runs on ends at the latest. */
    protected readonly cubeStoreTimeoutMs: number = 120000,
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
    const fail = (
      code: SqlRunError['code'],
      message: string,
      durationMs: number | null = null,
      partial: SqlRows | null = null,
      endsBy: Date | null = null,
    ) => new SqlRunError(code, message, redactedSql, statement, durationMs, partial, endsBy);
    // Stopped before anything ran: no rows, and no columns.
    const none: SqlRows = { columns: [], rows: [], rowCount: 0, truncated: 'stopped' };

    if (this.local.has(request.runId) || this.stopping.has(request.runId)) {
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
    // Cube Store runs a stopped query on: the run answers at once, and its connection waits for the end.
    let runsOn: Date | null = null;
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
      // A statement that won't stop is left to its connection's end; one nothing stops, at once.
      setTimeout(abandon, session?.ended ? 0 : CANCEL_GRACE_MS).unref?.();
    };
    this.local.set(request.runId, { model, cancel: () => stop('cancelled') });
    // A stopped run answers the rows it read before the stop, marked `stopped`; on Cube Store,
    // which runs the query on, when it ends at the latest.
    const stopped = (ranAt: number | null, read: SqlRows): SqlRunError => {
      const took = ranAt === null ? null : Date.now() - ranAt;
      if (ranAt !== null && session?.ended) {
        runsOn = new Date(ranAt + this.cubeStoreTimeoutMs);
      }
      const onward = runsOn ? `; Cube Store can't stop a query, and runs it on until it ends, by ${runsOn.toISOString()} at the latest` : '';
      return reason === 'timeout'
        ? fail('timeout', `The statement ran past ${elapsed(request.timeoutMs)} and was stopped${onward}`, took, read, runsOn)
        : fail('cancelled', `The run was cancelled${onward}`, took, read, runsOn);
    };

    let built: { driver: any; secrets: string[] } | null = null;
    try {
      try {
        built = await target.build(caps);
        session = await withTimeout(openSession(dialect, built.driver, caps, (type) => {
          throw fail('not_read_only', `BigQuery's dry run reads the statement as ${type}: only a SELECT runs here`);
        }), CONNECT_MS, 'Connecting');
      } catch (e: any) {
        if (reason) {
          throw stopped(null, none);
        }
        throw fail('connect_failed', redact(String(e?.message ?? e), built?.secrets ?? []));
      }
      if (reason) {
        throw stopped(null, none);
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
          throw stopped(ranAt, rows.stopped());
        }
        if (isTimeout(dialect, e)) {
          throw fail('timeout', `The statement ran past ${elapsed(request.timeoutMs)} and was stopped`, Date.now() - ranAt, rows.stopped());
        }
        throw fail('query_failed', redact(String(e?.message ?? e), built.secrets), Date.now() - ranAt);
      } finally {
        clearTimeout(clock);
      }
      if (reason) {
        throw stopped(ranAt, rows.stopped());
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
      if (runsOn && session?.ended) {
        // Noted as stopping before the answer, for every instance; let go only once Cube Store has ended it.
        await this.runOn(model, request.runId, session, built, runsOn);
      } else {
        await this.letGo(request.runId, session, built);
      }
    }
  }

  /** Closes a run's connection, lets its driver go, and notes its end. */
  protected async letGo(runId: string, session: SqlSession | null, built: { driver: any; secrets: string[] } | null) {
    // A connection that won't let go never holds the answer.
    await withTimeout(Promise.resolve(session?.close()), CLOSE_MS, 'Closing').catch(() => undefined);
    await withTimeout(Promise.resolve(built?.driver?.release?.()), CLOSE_MS, 'Releasing').catch(() => undefined);
    if (built) {
      built.secrets.length = 0;
    }
    const registry = this.registry();
    if (registry) {
      await registry.endSqlRun(runId, this.instanceId)
        .catch((e) => this.log('xcube: could not note a SQL run\'s end', { runId, error: e.message }));
    }
  }

  /**
   * A stopped run the database runs on: noted as stopping, here and in the
   * store, until the database answers it, or a little past when it should
   * have at the latest. Its connection stays open to hear that answer.
   */
  protected async runOn(model: string, runId: string, session: SqlSession, built: { driver: any; secrets: string[] } | null, endsBy: Date) {
    this.stopping.set(runId, { model, endsBy });
    await this.registry()?.stopSqlRun(runId, this.instanceId, endsBy)
      .catch((e) => this.log('xcube: could not note a SQL run as stopping', { runId, error: e.message }));
    (async () => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        session.ended!(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(0, endsBy.getTime() + ENDS_GRACE_MS - Date.now()));
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      this.stopping.delete(runId);
      await this.letGo(runId, session, built);
      this.log('xcube: SQL run ended in the database', { model, runId });
    })().catch((e) => this.log('xcube: a stopped SQL run could not be followed to its end', { runId, error: e.message }));
  }

  /** Where a model's run is: running, stopped but run on by the database, or ended (or never was). */
  public async state(model: string, runId: string): Promise<SqlRunState> {
    const here = this.local.get(runId);
    if (here) {
      return here.model === model ? { state: 'running' } : { state: 'ended' };
    }
    const onward = this.stopping.get(runId);
    if (onward) {
      return onward.model === model ? { state: 'stopping', endsBy: onward.endsBy.toISOString() } : { state: 'ended' };
    }
    const found = await this.registry()?.sqlRunState(runId, model);
    if (!found) {
      return { state: 'ended' };
    }
    return found.stopped ? { state: 'stopping', ...(found.endsBy ? { endsBy: found.endsBy.toISOString() } : {}) } : { state: 'running' };
  }

  /**
   * Cancels a model's run, here or, through the store, on the instance
   * running it: whether it was found running. The run itself answers
   * `cancelled`.
   */
  public async cancel(model: string, runId: string): Promise<{ found: boolean }> {
    if (this.stopping.get(runId)?.model === model) {
      // Stopped already; Cube Store runs it on, and nothing more stops it.
      return { found: true };
    }
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
