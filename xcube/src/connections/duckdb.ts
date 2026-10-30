/**
 * DuckDB in the Cube pods, fenced to one place a connection reads: an S3
 * location, a MotherDuck database, or a file on a volume the deployment
 * allows. Cube's driver reads its file, token, S3 keys, extensions and init
 * SQL from its environment, logs and carries on past a setting it can't
 * apply, and leaves DuckDB free to read and write the pod's files. Here
 * every instance is set up by xcube, in order, and any step that fails
 * closes it (`SETUP_STEPS`):
 *
 * 1. `volume`: a volume's path, realpath'd, must be a regular file under a
 *    directory of `XCUBE_DUCKDB_VOLUMES`;
 * 2. `open`: the instance, read-only on a volume's file, with nothing
 *    installed from the network;
 * 3. `limits`: memory, threads, and a temp directory of its own (wiped when
 *    it closes) capped in size;
 * 4. `source`: httpfs and an S3 secret scoped to the location, or MotherDuck;
 * 5. `extensions`: no extension installed or loaded from here on, no
 *    persistent secrets, none shown unredacted;
 * 6. `allowed_directories`: the S3 location alone (and the temp directory,
 *    which DuckDB adds itself);
 * 7. `external_access`: off, so no other file or URL is read or written;
 * 8. `lock`: the configuration locked, so SQL can't change any of it;
 * 9. `readback`: each setting read back from `duckdb_settings()`.
 *
 * At most `XCUBE_DUCKDB_MAX_OPEN` instances are open in a pod (`DuckdbPool`).
 */
import { mkdir, mkdtemp, realpath, rm, stat } from 'fs/promises';
import path from 'path';
import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBDriver as CubeDuckDBDriver } from '@cubejs-backend/duckdb-driver';
import { podRoleCredentials, type AwsCredentials } from './athena';
import { withoutEnv } from './env';

/** The steps of an instance's set-up, in order: the one that failed is named in its error. */
export const SETUP_STEPS = [
  'volume', 'open', 'limits', 'source', 'extensions', 'allowed_directories', 'external_access', 'lock', 'readback',
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/** The deployment's DuckDB settings, from `XCUBE_DUCKDB_*`. */
export interface DuckdbSettings {
  memoryLimit: string;
  threads: number;
  maxTempDirectorySize: string;
  /** Each instance's temp directory is a new one under it. */
  tempRoot: string;
  /** The most instances open in the pod at once: serving, a SQL run's, a connection test's, or closing. */
  maxOpen: number;
  /** The directories a volume's file may be under; none: no volume is read. */
  volumes: string[];
}

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40,
};

/** A size as DuckDB takes and shows it (`2GiB`, `1.8 GiB`), in bytes; `null` if it isn't one. */
export function sizeInBytes(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(text);
  const unit = m ? UNITS[m[2].toLowerCase()] : undefined;
  return m && unit ? Number(m[1]) * unit : null;
}

function size(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] || fallback;
  if (!sizeInBytes(value)) {
    throw new Error(`${name} must be a size, such as 2GiB or 512MiB, not ${JSON.stringify(value)}`);
  }
  return value.replace(/\s+/g, '');
}

function whole(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}, not ${JSON.stringify(raw)}`);
  }
  return value;
}

const absolute = (name: string, dir: string) => {
  if (!path.isAbsolute(dir) || /[\0\n\r']/.test(dir)) {
    throw new Error(`${name} must hold absolute directories, not ${JSON.stringify(dir)}`);
  }
  return path.resolve(dir);
};

/** The settings, checked: a value that isn't one fails xcube as it starts (`settingsFromEnv`), not at an instance's set-up. */
export function duckdbSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): DuckdbSettings {
  return {
    memoryLimit: size(env, 'XCUBE_DUCKDB_MEMORY_LIMIT', '2GiB'),
    threads: whole(env, 'XCUBE_DUCKDB_THREADS', 2, 256),
    maxTempDirectorySize: size(env, 'XCUBE_DUCKDB_MAX_TEMP_DIRECTORY_SIZE', '10GiB'),
    tempRoot: absolute('XCUBE_DUCKDB_TEMP_ROOT', env.XCUBE_DUCKDB_TEMP_ROOT || '/tmp/xcube-duckdb'),
    maxOpen: whole(env, 'XCUBE_DUCKDB_MAX_OPEN', 4, 1000),
    volumes: (env.XCUBE_DUCKDB_VOLUMES || '').split(',').map((d) => d.trim()).filter(Boolean)
      .map((d) => absolute('XCUBE_DUCKDB_VOLUMES', d)),
  };
}

let settings: DuckdbSettings | undefined;

/** The pod's settings, read once. */
export function duckdbSettings(): DuckdbSettings {
  settings ??= duckdbSettingsFromEnv();
  return settings;
}

/** What the pool asks of an instance's owner: to close it, and whether its credentials are near expiry. */
export interface PoolOwner {
  closeInstance(): Promise<void>;
  stale(): boolean;
}

interface PoolEntry {
  busy: number;
  lastUsed: number;
  closing: boolean;
}

interface Waiter {
  owner: PoolOwner;
  wake(): void;
  fail(e: Error): void;
}

/**
 * The pod's open DuckDB instances, at most `max`: an owner (a driver) holds
 * its instance while it queries, streams or runs. Past the cap, the least
 * recently used idle instance is closed for it; when every one is busy, it
 * waits, for as long as it was given.
 */
export class DuckdbPool {
  protected readonly entries = new Map<PoolOwner, PoolEntry>();

  protected waiters: Waiter[] = [];

  public constructor(public readonly max: number) {}

  /** Holds the owner's instance open, opening or freeing a place for it; the function it answers lets go. */
  public async hold(owner: PoolOwner, waitMs: number): Promise<() => void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const entry = this.entries.get(owner);
      if (entry && !entry.closing) {
        if (entry.busy === 0 && owner.stale()) {
          await this.close(owner, entry);
          continue;
        }
        entry.busy++;
        return this.letGo(owner, entry);
      }
      if (!entry && this.entries.size < this.max) {
        const added = { busy: 1, lastUsed: Date.now(), closing: false };
        this.entries.set(owner, added);
        return this.letGo(owner, added);
      }
      const idle = entry ? undefined : [...this.entries].filter(([, e]) => e.busy === 0 && !e.closing)
        .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
      if (idle) {
        await this.close(idle[0], idle[1]);
        continue;
      }
      await this.wait(owner, deadline - Date.now());
    }
  }

  /** Its place given up, without closing it: the owner closes it, or never opened it. */
  public drop(owner: PoolOwner) {
    if (this.entries.delete(owner)) {
      this.wakeAll();
    }
  }

  /** Its place given up, and whatever of the owner's waits for one failed: the owner is released. */
  public forget(owner: PoolOwner) {
    const mine = this.waiters.filter((w) => w.owner === owner);
    this.waiters = this.waiters.filter((w) => w.owner !== owner);
    for (const w of mine) {
      w.fail(new Error('The DuckDB data source was let go while it waited for an instance'));
    }
    this.drop(owner);
  }

  /** Instances open (closing ones too), the cap, those in use, and the holds waiting for a place (`GET /v1/duckdb`). */
  public stats() {
    const entries = [...this.entries.values()];
    return { open: entries.length, max: this.max, busy: entries.filter((e) => e.busy > 0).length, waiting: this.waiters.length };
  }

  protected letGo(owner: PoolOwner, entry: PoolEntry): () => void {
    let done = false;
    return () => {
      if (done) {
        return;
      }
      done = true;
      entry.lastUsed = Date.now();
      entry.busy = Math.max(0, entry.busy - 1);
      if (entry.busy === 0 && this.entries.get(owner) === entry) {
        this.wakeAll();
      }
    };
  }

  protected async close(owner: PoolOwner, entry: PoolEntry) {
    entry.closing = true;
    try {
      await owner.closeInstance();
    } finally {
      if (this.entries.get(owner) === entry) {
        this.entries.delete(owner);
      }
      this.wakeAll();
    }
  }

  protected wait(owner: PoolOwner, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        owner,
        wake: () => {
          clearTimeout(timer);
          resolve();
        },
        fail: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`Every one of the pod's ${this.max} DuckDB instances is in use (XCUBE_DUCKDB_MAX_OPEN), `
          + `and none came free in ${Math.round(Math.max(0, ms) / 1000)} s`));
      }, Math.max(0, ms));
      this.waiters.push(waiter);
    });
  }

  protected wakeAll() {
    const woken = this.waiters;
    this.waiters = [];
    for (const w of woken) {
      w.wake();
    }
  }
}

let pool: DuckdbPool | undefined;

/** The pod's pool, of `XCUBE_DUCKDB_MAX_OPEN`. */
export function duckdbPool(): DuckdbPool {
  pool ??= new DuckdbPool(duckdbSettings().maxOpen);
  return pool;
}

/** How long a query Cube serves waits for an instance when all are in use. */
const SERVE_WAIT_MS = 30000;

/** An instance whose pod-role credentials expire within this is reopened before its next use. */
const REFRESH_BEFORE_MS = 10 * 60 * 1000;

/** What a connection reads (`DRIVERS.duckdb.config`). */
export interface DuckdbSource {
  kind: 's3' | 'motherduck' | 'volume';
  s3?: {
    location: string;
    region: string;
    endpoint?: string;
    urlStyle: string;
    useSsl: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    podRole: boolean;
  };
  motherDuck?: { database: string; token: string };
  volume?: { path: string };
}

/** A SQL string literal: DuckDB doubles a quote, and takes a backslash as it is. */
export const literal = (value: string) => `'${value.replace(/'/g, '\'\'')}'`;

/** A prefix as allowed_directories and a secret's scope take it: ending in `/`, so `s3://b/sales` doesn't allow `s3://b/sales-old`. */
const asPrefix = (location: string) => (location.endsWith('/') ? location : `${location}/`);

/** A volume's file, realpath'd, if it is a regular file under one of the allowed directories. */
export async function volumeFile(file: string, volumes: string[]): Promise<string> {
  if (!volumes.length) {
    throw new Error('no volume directory is allowed in this deployment');
  }
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    throw new Error(`${file} doesn't exist, or can't be read`);
  }
  if (!(await stat(real)).isFile()) {
    throw new Error(`${file} isn't a regular file`);
  }
  for (const dir of volumes) {
    const allowed = await realpath(dir).catch(() => null);
    if (allowed && real.startsWith(asPrefix(allowed))) {
      return real;
    }
  }
  throw new Error(`${file} isn't under a directory allowed for volumes (XCUBE_DUCKDB_VOLUMES)`);
}

/** A message with the source's secrets out of it, and any token a URL carried. */
function scrub(message: string, secrets: (string | undefined)[]): string {
  let text = message;
  for (const s of secrets) {
    if (s && s.length >= 4) {
      text = text.split(s).join('[redacted]');
    }
  }
  return text.replace(/(motherduck_token=)[^&\s'"]*/gi, '$1[redacted]');
}

export class DuckdbSetupError extends Error {
  public constructor(public readonly step: SetupStep, message: string) {
    super(`DuckDB set-up failed at ${step}: ${message}`);
  }
}

/** What a setting must read back as: a value, a size near it, or directories among these. */
type Expected = { is: string } | { bytes: number } | { within: string[] };

/** Checks `duckdb_settings()` against what set-up set; the first that differs, or nothing. */
export function readbackProblem(actual: Map<string, string>, expected: Record<string, Expected>): string | null {
  for (const [name, want] of Object.entries(expected)) {
    const value = actual.get(name);
    if (value === undefined) {
      return `${name} isn't among its settings`;
    }
    // A directory may read back with a `/` at its end.
    const plain = (s: string) => s.toLowerCase().replace(/(.)\/+$/, '$1');
    if ('is' in want && plain(value) !== plain(want.is)) {
      return `${name} reads back as ${JSON.stringify(value)}, not ${JSON.stringify(want.is)}`;
    }
    if ('bytes' in want) {
      const bytes = sizeInBytes(value);
      // Shown to one decimal, cut not rounded, in the largest binary unit under it: 2GB as `1.8 GiB`.
      const unit = /([kmgt]i?b)\s*$/i.exec(value)?.[1].toLowerCase();
      const slack = unit ? 0.1 * UNITS[unit] : 1;
      if (bytes === null || Math.abs(bytes - want.bytes) > slack) {
        return `${name} reads back as ${JSON.stringify(value)}, not ${want.bytes} bytes`;
      }
    }
    if ('within' in want) {
      const dirs = value.replace(/^\[|\]$/g, '').split(/,\s*/).map((d) => d.trim()).filter(Boolean);
      const extra = dirs.find((d) => !want.within.includes(asPrefix(d)));
      if (extra) {
        return `${name} holds ${extra}, which set-up didn't allow`;
      }
    }
  }
  return null;
}

/** What a run holds: a connection of its own on the instance, and the hold to let go. */
export interface DuckdbLease {
  connection: DuckDBConnection;
  done(): void;
}

interface InitState {
  defaultConnection: DuckDBConnection;
  instance: DuckDBInstance;
}

/** The DuckDB client Cube's driver uses: one copy of its native module, wherever the image lays it. */
export function duckdbApi(): typeof import('@duckdb/node-api') {
  // eslint-disable-next-line global-require, import/no-dynamic-require, @typescript-eslint/no-var-requires
  return require(require.resolve('@duckdb/node-api', { paths: [path.dirname(require.resolve('@cubejs-backend/duckdb-driver'))] }));
}

let driverClass: (new (config: Record<string, unknown>) => XcubeDuckDBDriver) | undefined;

/** xcube's DuckDB driver: what the runner and the pool see of it. */
export interface XcubeDuckDBDriver extends CubeDuckDBDriver, PoolOwner {
  lease(waitMs: number): Promise<DuckdbLease>;
}

function duckdbDriverClass() {
  if (!driverClass) {
    // Loaded on first use, as Cube loads a driver: the image lays it beside Cube's own packages.
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { DuckDBDriver } = require('@cubejs-backend/duckdb-driver') as typeof import('@cubejs-backend/duckdb-driver');

    class Driver extends DuckDBDriver implements PoolOwner {
      protected readonly source: DuckdbSource;

      protected tempDir: string | undefined;

      protected expiresAt: number | undefined;

      public constructor(config: Record<string, any>) {
        super(config);
        this.source = config.source;
        // Cube's catalog queries keep to this catalog: MotherDuck's database; an S3 location's or a file's own otherwise.
        Reflect.set(this, 'schema', this.source.motherDuck?.database);
      }

      protected secrets() {
        return [this.source.s3?.secretAccessKey, this.source.motherDuck?.token];
      }

      /** The instance, set up step by step (`SETUP_STEPS`); closed, and its place given up, if any step fails. */
      protected override async init(): Promise<InitState> {
        const own = duckdbSettings();
        const { source } = this;
        const { DuckDBInstance } = duckdbApi();
        let step: SetupStep = 'volume';
        let instance: DuckDBInstance | undefined;
        let connection: DuckDBConnection | undefined;
        let sessionToken: string | undefined;
        try {
          const file = source.kind === 'volume' ? await volumeFile(String(source.volume?.path), own.volumes) : undefined;

          step = 'open';
          await mkdir(own.tempRoot, { recursive: true, mode: 0o700 });
          // mkdtemp makes it 0700; realpath'd, as DuckDB reads it back past a link (`/tmp` on macOS).
          this.tempDir = await realpath(await mkdtemp(path.join(own.tempRoot, 'i-')));
          const options: Record<string, string> = {
            autoinstall_known_extensions: 'false',
            // MotherDuck's extension loads as `md:` opens; nothing else does.
            autoload_known_extensions: source.kind === 'motherduck' ? 'true' : 'false',
          };
          if (file) {
            options.access_mode = 'READ_ONLY';
          }
          if (source.motherDuck) {
            Object.assign(options, {
              motherduck_token: source.motherDuck.token,
              // No local files or databases from MotherDuck's side, and its named database alone.
              motherduck_saas_mode: 'true',
              motherduck_attach_mode: 'single',
            });
          }
          instance = await DuckDBInstance.create(file ?? (source.motherDuck ? `md:${source.motherDuck.database}` : ':memory:'), options);
          connection = await instance.connect();
          const run = (sql: string) => connection!.run(sql);

          step = 'limits';
          await run(`SET memory_limit = ${literal(own.memoryLimit)}`);
          await run(`SET threads = ${own.threads}`);
          await run(`SET temp_directory = ${literal(this.tempDir)}`);
          await run(`SET max_temp_directory_size = ${literal(own.maxTempDirectorySize)}`);

          step = 'source';
          const allowed: string[] = [];
          if (source.s3) {
            const { s3 } = source;
            let key = { accessKeyId: String(s3.accessKeyId), secretAccessKey: String(s3.secretAccessKey) } as AwsCredentials;
            if (s3.podRole) {
              key = await podRoleCredentials(s3.region)();
              sessionToken = key.sessionToken;
              this.expiresAt = key.expiration?.getTime();
            }
            await run('LOAD httpfs');
            const location = asPrefix(s3.location);
            const fields = [
              'TYPE s3', 'PROVIDER config', `KEY_ID ${literal(key.accessKeyId)}`, `SECRET ${literal(key.secretAccessKey)}`,
              ...(key.sessionToken ? [`SESSION_TOKEN ${literal(key.sessionToken)}`] : []),
              `REGION ${literal(s3.region)}`, ...(s3.endpoint ? [`ENDPOINT ${literal(s3.endpoint)}`] : []),
              `URL_STYLE ${literal(s3.urlStyle)}`, `USE_SSL ${s3.useSsl}`, `SCOPE ${literal(location)}`,
            ];
            await run(`CREATE TEMPORARY SECRET xcube_s3 (${fields.join(', ')})`);
            allowed.push(location);
          }

          step = 'extensions';
          await run('SET autoinstall_known_extensions = false');
          await run('SET autoload_known_extensions = false');
          await run('SET allow_community_extensions = false');
          await run('SET allow_persistent_secrets = false');
          await run('SET allow_unredacted_secrets = false');

          step = 'allowed_directories';
          await run(`SET allowed_directories = [${allowed.map(literal).join(', ')}]`);

          step = 'external_access';
          await run('SET enable_external_access = false');

          step = 'lock';
          await run('SET lock_configuration = true');

          step = 'readback';
          const read = await connection.runAndReadAll('SELECT name, value FROM duckdb_settings()');
          const actual = new Map(read.getRowsJson().map(([name, value]) => [String(name), String(value)]));
          const problem = readbackProblem(actual, {
            memory_limit: { bytes: sizeInBytes(own.memoryLimit)! },
            threads: { is: String(own.threads) },
            temp_directory: { is: this.tempDir },
            max_temp_directory_size: { bytes: sizeInBytes(own.maxTempDirectorySize)! },
            autoinstall_known_extensions: { is: 'false' },
            autoload_known_extensions: { is: 'false' },
            allow_community_extensions: { is: 'false' },
            allow_persistent_secrets: { is: 'false' },
            allow_unredacted_secrets: { is: 'false' },
            allowed_directories: { within: [...allowed, asPrefix(this.tempDir)] },
            enable_external_access: { is: 'false' },
            lock_configuration: { is: 'true' },
            ...(file ? { access_mode: { is: 'read_only' } } : {}),
          });
          if (problem) {
            throw new Error(problem);
          }
          return { defaultConnection: connection, instance };
        } catch (e: any) {
          try {
            connection?.closeSync();
          } catch {
            // It goes with its instance.
          }
          try {
            instance?.closeSync();
          } catch {
            // Already closed.
          }
          await this.wipeTemp();
          duckdbPool().drop(this);
          throw new DuckdbSetupError(step, scrub(String(e?.message ?? e), [...this.secrets(), sessionToken]));
        }
      }

      public stale() {
        return this.expiresAt !== undefined && this.expiresAt - Date.now() < REFRESH_BEFORE_MS;
      }

      protected async wipeTemp() {
        const dir = this.tempDir;
        this.tempDir = undefined;
        if (dir) {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      /** Closes the instance and wipes its temp directory; set up again on its next use. */
      public async closeInstance() {
        const { initPromise } = this;
        this.initPromise = null;
        this.expiresAt = undefined;
        if (initPromise) {
          try {
            const { defaultConnection, instance } = await initPromise;
            try {
              defaultConnection.closeSync();
            } finally {
              instance.closeSync();
            }
          } catch {
            // Its set-up failed, and closed it.
          }
        }
        await this.wipeTemp();
      }

      protected async held<T>(waitMs: number, use: () => Promise<T>): Promise<T> {
        const done = await duckdbPool().hold(this, waitMs);
        try {
          return await use();
        } finally {
          done();
        }
      }

      public override async query<R = unknown>(query: string, values?: unknown[], options?: any): Promise<R[]> {
        return this.held(SERVE_WAIT_MS, () => super.query<R>(query, values, options));
      }

      public override async stream(query: string, values: unknown[], options: any) {
        const done = await duckdbPool().hold(this, SERVE_WAIT_MS);
        try {
          const { rowStream, release } = await super.stream(query, values, options);
          // Held until the stream ends, is destroyed or released.
          rowStream.once('close', done);
          return {
            rowStream,
            release: async () => {
              try {
                await release?.();
              } finally {
                done();
              }
            },
          };
        } catch (e) {
          done();
          throw e;
        }
      }

      /** A SQL run's connection of its own, the instance held until it is let go. */
      public async lease(waitMs: number): Promise<DuckdbLease> {
        const done = await duckdbPool().hold(this, waitMs);
        try {
          const { instance } = await this.getInitiatedState();
          const connection = await instance.connect();
          return {
            connection,
            done: () => {
              try {
                connection.closeSync();
              } finally {
                done();
              }
            },
          };
        } catch (e) {
          done();
          throw e;
        }
      }

      /**
       * The connection test's connect step (AC-1031): set-up and its readback,
       * a check that the pod's files are out of reach, then the source itself:
       * the S3 location listed, MotherDuck's database open, the file's tables.
       */
      public override async testConnection() {
        await this.held(SERVE_WAIT_MS, async () => {
          const { defaultConnection: c } = await this.getInitiatedState();
          let guarded = false;
          try {
            await c.run('SELECT count(*) FROM glob(\'/*\')');
          } catch (e: any) {
            guarded = /disabled by configuration/.test(String(e?.message));
          }
          if (!guarded) {
            throw new Error('DuckDB set-up failed at guard: it reads the pod\'s files with external access off');
          }
          const { s3, motherDuck } = this.source;
          if (s3) {
            await c.run(`SELECT count(*) FROM glob(${literal(`${asPrefix(s3.location)}*`)})`);
          } else if (motherDuck) {
            const name = String((await c.runAndReadAll('SELECT current_database()')).getRowsJson()[0]?.[0]);
            if (name !== motherDuck.database) {
              throw new Error(`MotherDuck opened ${name}, not ${motherDuck.database}`);
            }
          } else {
            await c.run('SELECT count(*) FROM information_schema.tables');
          }
        }).catch((e: any) => {
          throw Object.assign(e, { message: scrub(String(e?.message), this.secrets()) });
        });
      }

      public override readOnly() {
        return true;
      }

      public override async release() {
        duckdbPool().forget(this);
        await this.closeInstance();
      }
    }
    driverClass = Driver as any;
  }
  return driverClass!;
}

/** A DuckDB driver from a connection's config (`DRIVERS.duckdb.config`). */
export function makeDuckdbDriver(config: Record<string, unknown>): XcubeDuckDBDriver {
  const { s3, motherDuck, volume, kind } = config as any;
  const DriverClass = duckdbDriverClass();
  // Cube's constructor reads its schema from `CUBEJS_DB_DUCKDB_SCHEMA`; its init, which xcube's replaces, the rest.
  return withoutEnv(['CUBEJS_'], {}, () => new DriverClass({
    source: { kind, s3, motherDuck, volume },
    databasePath: undefined,
    motherDuckToken: undefined,
    initSql: undefined,
    schema: motherDuck?.database,
    duckdbS3UseCredentialChain: false,
  }));
}
