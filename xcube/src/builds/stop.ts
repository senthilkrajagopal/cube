/**
 * Stopping a rollup build that the queue's cancel took out while it was
 * building. Cube's queue then calls the build's cancel at its next heartbeat
 * (`QueueOptions.heartBeatInterval`, xcube's 8 s), which cancels only the
 * driver calls whose promise has a `cancel`. Cube's PostgreSQL driver gives
 * none, so the build ran on, and its table was committed.
 *
 * These wrappers, on every driver Cube's orchestrators get, make a build's
 * calls cancellable:
 * - on the source, each call that runs the build's query
 *   (`downloadQueryResults`, `loadPreAggregationIntoTable`,
 *   `unloadFromQuery`): its driver's own cancel where it has one, and, on
 *   PostgreSQL, the query cancelled on the server (`pg_cancel_backend`); a
 *   stream already handed over is cut;
 * - on Cube Store, no table of a stopped build is committed: its upload is
 *   refused, or, done as the cancel came, its table dropped. A table a
 *   stopped build made in the source is dropped too.
 *
 * The build then fails with `STOPPED`, which Cube's jobs API reports as
 * `failure: …`.
 */

/** What a stopped build fails with. */
export const STOPPED = 'xcube stopped this build: it was cancelled while building, and none of it is kept';

export class BuildStopped extends Error {
  public constructor() {
    super(STOPPED);
  }
}

/** Target tables of builds stopped in this process: none of them is committed. */
const stoppedTables = new Map<string, number>();

const KEEP_MS = 24 * 60 * 60 * 1000;

function noteStopped(table: string) {
  const now = Date.now();
  stoppedTables.set(table, now);
  for (const [name, at] of stoppedTables) {
    if (stoppedTables.size <= 10000 && now - at < KEEP_MS) {
      break;
    }
    stoppedTables.delete(name);
  }
}

export function isStopped(table: unknown): boolean {
  return typeof table === 'string' && stoppedTables.has(table);
}

const quietly = async (fn: () => unknown) => {
  try {
    await fn();
  } catch {
    // Best effort: the build fails as stopped anyway.
  }
};

/**
 * Cancels a statement on PostgreSQL by its text, from a connection of its
 * own: the build's backend, of the same user and database. A text longer
 * than the server keeps (`track_activity_query_size`) matches on what it kept.
 */
async function cancelOnPostgres(driver: any, sql: unknown) {
  if (typeof sql !== 'string' || driver?.constructor?.name !== 'PostgresDriver' || !driver.pool?._factory) {
    return;
  }
  const client = await driver.pool._factory.create();
  try {
    await client.query(
      `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND usename = current_user AND datname = current_database() AND state <> 'idle'
         AND (query = $1 OR (length(query) >= 1000 AND left($1, length(query)) = query))`,
      [sql],
    );
  } finally {
    await quietly(() => driver.pool._factory.destroy(client));
  }
}

/** The calls that run a build's query on its source: the SQL and options each takes. */
const SOURCE_CALLS: Record<string, (args: any[]) => { sql: unknown; table: unknown }> = {
  downloadQueryResults: ([sql, , options]) => ({ sql, table: options?.targetTableName }),
  loadPreAggregationIntoTable: ([table, sql]) => ({ sql, table }),
  unloadFromQuery: ([sql, , options]) => ({ sql, table: options?.targetTableName }),
};

function stoppableCall(driver: any, name: string, fn: (...args: any[]) => any, args: any[], log: (m: string, p?: object) => void) {
  const { sql, table } = SOURCE_CALLS[name](args);
  let cancelled = false;
  let handed: any;
  const call = fn.apply(driver, args);
  const promise: any = Promise.resolve(call).then(async (value) => {
    handed = value;
    if (cancelled) {
      // It ended as the cancel came: nothing of it lands.
      await quietly(() => value?.release?.());
      if (name === 'loadPreAggregationIntoTable' && typeof table === 'string') {
        await quietly(() => driver.dropTable(table));
      }
      throw new BuildStopped();
    }
    return value;
  }, (e) => {
    throw cancelled ? new BuildStopped() : e;
  });
  promise.cancel = async () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    if (typeof table === 'string') {
      noteStopped(table);
    }
    log('xcube: stopping a build cancelled while building', { table: typeof table === 'string' ? table : null, call: name });
    await Promise.all([
      quietly(() => call?.cancel?.()),
      quietly(() => cancelOnPostgres(driver, sql)),
      // Handed over already: its rows stop, and its upload fails.
      quietly(() => handed?.rowStream?.destroy?.(new BuildStopped())),
    ]);
  };
  return promise;
}

/** A source driver whose build calls the queue's cancel can stop. */
export function stoppableSource(driver: any, log: (m: string, p?: object) => void): any {
  if (!driver || typeof driver !== 'object') {
    return driver;
  }
  return new Proxy(driver, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver);
      // Its own keys only: `constructor` and the like are every object's.
      if (typeof prop !== 'string' || !Object.prototype.hasOwnProperty.call(SOURCE_CALLS, prop) || typeof value !== 'function') {
        return value;
      }
      return (...args: any[]) => stoppableCall(receiver, prop, value, args, log);
    },
  });
}

/** Cube Store's upload of a build's table: refused for a stopped build, and its table dropped if the stop came as it ended. */
export function stoppableExternal(driver: any): any {
  if (!driver || typeof driver !== 'object' || typeof driver.uploadTableWithIndexes !== 'function') {
    return driver;
  }
  return new Proxy(driver, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'uploadTableWithIndexes' || typeof value !== 'function') {
        return value;
      }
      return async (table: string, ...rest: any[]) => {
        if (isStopped(table)) {
          throw new BuildStopped();
        }
        try {
          await Reflect.apply(value, receiver, [table, ...rest]);
        } catch (e) {
          throw isStopped(table) ? new BuildStopped() : e;
        }
        if (isStopped(table)) {
          await quietly(() => receiver.dropTable(table));
          throw new BuildStopped();
        }
      };
    },
  });
}
