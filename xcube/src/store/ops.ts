import type { Pool } from 'pg';

import type { CalcKind, CalcSpec } from '../calcs/companions';
import { channelOf } from './revisions';

/** A jobs request's build: the token Cube gave it, and the version of a table it builds. */
export interface BuildJob {
  model: string;
  token: string;
  requestId: string | null;
  targetTable: string;
}

/** The refresh runs of one module of a model on one refresh worker, since last written: the last, and the last of each end. */
export interface RefreshTick {
  model: string;
  instance: string;
  /** The module refreshed, `all` for a model served whole. */
  module: string;
  revision: number;
  servedKey: string;
  at: Date;
  /** Whether the last run finished, rather than left builds running for the next run to wait on. */
  finished: boolean;
  /** When a run last ended without an error. */
  okAt: Date | null;
  /** The last run's error that failed, and when. */
  error: string | null;
  errorAt: Date | null;
}

/** A refresh worker's view of one model: the last run of each module. */
export interface RefreshWorkerStatus {
  instance: string;
  revision: number;
  servedKey: string;
  lastTickAt: Date;
  modules: {
    module: string;
    revision: number;
    lastTickAt: Date;
    finished: boolean;
    lastOkAt: Date | null;
    lastError: { message: string; at: Date } | null;
  }[];
}

/** How long a jobs request's tokens name its builds: Cube keeps a job for a day. */
const JOB_DAYS = 2;

/** How long a refresh worker that stopped is still reported. */
const TICK_DAYS = 1;

/** What xcube keeps of Cube's operations: jobs requests' tokens, and refresh workers' runs. */
export class PgOpsStore {
  public constructor(protected readonly pool: Pool, protected readonly s: string) {
  }

  public async recordJobs(jobs: BuildJob[]): Promise<void> {
    if (jobs.length) {
      await this.pool.query(
        `INSERT INTO ${this.s}.build_jobs (model, token, request_id, target_table)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
         ON CONFLICT (model, token) DO NOTHING`,
        [jobs.map((j) => j.model), jobs.map((j) => j.token), jobs.map((j) => j.requestId), jobs.map((j) => j.targetTable)]
      );
    }
    await this.pool.query(`DELETE FROM ${this.s}.build_jobs WHERE posted_at < now() - interval '${JOB_DAYS} days'`);
  }

  /** The newest job of each version of a table, among `targets`: `<target table>` → its token and request. */
  public async jobsFor(model: string, targets: string[]): Promise<Map<string, { token: string; requestId: string | null }[]>> {
    const found = new Map<string, { token: string; requestId: string | null }[]>();
    if (!targets.length) {
      return found;
    }
    const { rows } = await this.pool.query(
      `SELECT token, request_id, target_table FROM ${this.s}.build_jobs
        WHERE model = $1 AND target_table = ANY($2::text[]) ORDER BY posted_at DESC`,
      [model, targets]
    );
    for (const row of rows) {
      found.set(row.target_table, [...(found.get(row.target_table) ?? []), { token: row.token, requestId: row.request_id }]);
    }
    return found;
  }

  /** Records refresh runs: each module's last, its last success, and its last error. */
  public async recordTicks(ticks: RefreshTick[]): Promise<void> {
    if (!ticks.length) {
      return;
    }
    const column = <K extends keyof RefreshTick>(key: K) => ticks.map((t) => t[key]);
    await this.pool.query(
      `INSERT INTO ${this.s}.refresh_ticks AS r (model, instance, module, revision, served_key, last_tick_at, last_finished,
         last_ok_at, last_error, last_error_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::integer[], $5::text[], $6::timestamptz[], $7::boolean[],
         $8::timestamptz[], $9::text[], $10::timestamptz[])
       ON CONFLICT (model, instance, module) DO UPDATE SET
         revision = EXCLUDED.revision, served_key = EXCLUDED.served_key, last_tick_at = EXCLUDED.last_tick_at,
         last_finished = EXCLUDED.last_finished,
         last_ok_at = COALESCE(EXCLUDED.last_ok_at, r.last_ok_at),
         last_error = COALESCE(EXCLUDED.last_error, r.last_error),
         last_error_at = COALESCE(EXCLUDED.last_error_at, r.last_error_at)`,
      [
        column('model'), column('instance'), column('module'), column('revision'), column('servedKey'), column('at'),
        column('finished'), column('okAt'), column('error'), column('errorAt'),
      ]
    );
    await this.pool.query(`DELETE FROM ${this.s}.refresh_ticks WHERE last_tick_at < now() - interval '${TICK_DAYS} days'`);
  }

  /** The calculations a model has been asked for. */
  public async calculations(model: string): Promise<CalcSpec[]> {
    const { rows } = await this.pool.query(
      `SELECT cube, measure, kind, granularity, periods FROM ${this.s}.calculations WHERE model = $1`,
      [model]
    );
    return rows.map((row) => ({
      cube: row.cube, measure: row.measure, kind: row.kind as CalcKind, granularity: row.granularity, periods: row.periods,
    }));
  }

  /** Records calculations a model is asked for, announcing any new: every instance serves them from then on. */
  public async addCalculations(model: string, specs: CalcSpec[]): Promise<number> {
    if (!specs.length) {
      return 0;
    }
    const { rowCount } = await this.pool.query(
      `INSERT INTO ${this.s}.calculations (model, cube, measure, kind, granularity, periods)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::integer[])
       ON CONFLICT DO NOTHING`,
      [model, specs.map((s) => s.cube), specs.map((s) => s.measure), specs.map((s) => s.kind), specs.map((s) => s.granularity), specs.map((s) => s.periods)]
    );
    if (rowCount) {
      await this.pool.query('SELECT pg_notify($1, $2)', [channelOf(this.s), JSON.stringify({ model, calculations: true })]);
    }
    return rowCount ?? 0;
  }

  /** Forgets calculations a model couldn't be served with, announcing it: every instance serves it without them. */
  public async removeCalculations(model: string, specs: CalcSpec[]): Promise<void> {
    if (!specs.length) {
      return;
    }
    await this.pool.query(
      `DELETE FROM ${this.s}.calculations c
        USING unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::integer[]) AS t (cube, measure, kind, granularity, periods)
        WHERE c.model = $1 AND c.cube = t.cube AND c.measure = t.measure AND c.kind = t.kind
          AND c.granularity = t.granularity AND c.periods = t.periods`,
      [model, specs.map((s) => s.cube), specs.map((s) => s.measure), specs.map((s) => s.kind), specs.map((s) => s.granularity), specs.map((s) => s.periods)]
    );
    await this.pool.query('SELECT pg_notify($1, $2)', [channelOf(this.s), JSON.stringify({ model, calculations: true })]);
  }

  /** Each refresh worker's last runs of a model, the most recent first. */
  public async refreshWorkers(model: string): Promise<RefreshWorkerStatus[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.s}.refresh_ticks WHERE model = $1 ORDER BY instance, module COLLATE "C"`,
      [model]
    );
    const byInstance = new Map<string, RefreshWorkerStatus>();
    for (const row of rows) {
      const lastTickAt = new Date(row.last_tick_at);
      const known = byInstance.get(row.instance);
      const worker: RefreshWorkerStatus = known ?? {
        instance: row.instance, revision: row.revision, servedKey: row.served_key, lastTickAt, modules: [],
      };
      if (lastTickAt > worker.lastTickAt) {
        Object.assign(worker, { revision: row.revision, servedKey: row.served_key, lastTickAt });
      }
      worker.modules.push({
        module: row.module,
        revision: row.revision,
        lastTickAt,
        finished: row.last_finished,
        lastOkAt: row.last_ok_at ? new Date(row.last_ok_at) : null,
        lastError: row.last_error ? { message: row.last_error, at: new Date(row.last_error_at) } : null,
      });
      byInstance.set(row.instance, worker);
    }
    // A module of a revision the worker has since moved past is gone from what it refreshes.
    byInstance.forEach((worker) => {
      worker.modules = worker.modules.filter((m) => m.revision === worker.revision);
    });
    return [...byInstance.values()].sort((a, b) => b.lastTickAt.getTime() - a.lastTickAt.getTime());
  }

  /** Notes a SQL run as running on an instance; `false` while a run of that id still runs. */
  public async startSqlRun(runId: string, model: string, instance: string, target: string, expiresAt: Date): Promise<boolean> {
    await this.pool.query(`DELETE FROM ${this.s}.sql_runs WHERE expires_at < now()`);
    const { rowCount } = await this.pool.query(
      `INSERT INTO ${this.s}.sql_runs (run_id, model, instance, target, expires_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (run_id) DO NOTHING`,
      [runId, model, instance, target, expiresAt],
    );
    return rowCount === 1;
  }

  public async endSqlRun(runId: string, instance: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.s}.sql_runs WHERE run_id = $1 AND instance = $2`, [runId, instance]);
  }

  /** The instance running a model's SQL run, while it runs. */
  public async sqlRunInstance(runId: string, model: string): Promise<string | null> {
    const { rows: [row] } = await this.pool.query(
      `SELECT instance FROM ${this.s}.sql_runs WHERE run_id = $1 AND model = $2 AND expires_at > now()`,
      [runId, model],
    );
    return row?.instance ?? null;
  }

  /** Tells the instance running a SQL run to cancel it. */
  public async announceSqlCancel(model: string, runId: string, instance: string): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [channelOf(this.s), JSON.stringify({ model, sqlCancel: runId, instance })]);
  }
}
