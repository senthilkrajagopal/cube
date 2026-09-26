import { CubejsServerCore } from '@cubejs-backend/server-core';

import { CredentialError, type CredentialKeys } from '../credentials/credentials';
import type { RevisionStore, StoredConnection } from '../store/revisions';
import { DRIVERS, isDriverType, type DriverType, type Fields } from './drivers';
import { SwitchableDriver } from './switchable';

/** A connection as the client pushes or tests it. */
export interface ConnectionInput {
  driver: string;
  authMethod: string;
  /** Its fields as the client's form holds them, secrets excepted: what secrets are bound to. */
  fields: Record<string, unknown>;
  /** Each secret field's envelope. */
  sealed: Record<string, unknown>;
}

export class ConnectionError extends Error {
  public constructor(
    message: string,
    public readonly problems: string[] = [],
    public readonly code: 'invalid_connection' | 'driver_change' = 'invalid_connection',
  ) {
    super(message);
  }
}

export interface Check {
  id: 'secrets' | 'config' | 'connect' | 'schemas';
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

const MAX_FIELD = 64 * 1024;

/** A secret and the parts of it that are secrets too: a JSON key's string values (BigQuery's `private_key`). */
function secretForms(secret: string): string[] {
  const values = [secret];
  try {
    const parsed = JSON.parse(secret);
    const walk = (v: unknown) => {
      if (typeof v === 'string' && v.length >= 8) {
        values.push(v);
      } else if (v && typeof v === 'object') {
        Object.values(v).forEach(walk);
      }
    };
    walk(parsed);
  } catch {
    // Not JSON: the secret alone.
  }
  return values.flatMap((v) => [
    v,
    JSON.stringify(v).slice(1, -1),
    encodeURIComponent(v),
    Buffer.from(v).toString('base64'),
    Buffer.from(v).toString('base64url'),
  ]);
}

/**
 * Error text with every secret it could hold taken out, in the forms a
 * driver could print it (Snowflake prints its whole config as JSON).
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  const forms = [...new Set(secrets.filter((s) => s.length >= 3).flatMap(secretForms))]
    .filter((f) => f.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const form of forms) {
    out = out.split(form).join('[redacted]');
  }
  return out.slice(0, 2000);
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** An envelope's shape: `{ v: 1, kid, enc, ct }`, `enc` 32 bytes, `ct` whole 256-byte buckets plus the tag. */
function envelopeProblem(field: string, value: unknown): string | undefined {
  const e = value as Record<string, unknown>;
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join() !== 'ct,enc,kid,v' || e.v !== 1) {
    return `${field} must be a sealed secret: { v: 1, kid, enc, ct }`;
  }
  if (typeof e.kid !== 'string' || !e.kid || e.kid.length > 128) {
    return `${field}: kid must be a key id`;
  }
  if (typeof e.enc !== 'string' || !B64URL.test(e.enc) || Buffer.from(e.enc, 'base64url').length !== 32) {
    return `${field}: enc must be 32 bytes, base64url`;
  }
  const ct = typeof e.ct === 'string' && B64URL.test(e.ct) ? Buffer.from(e.ct, 'base64url').length : -1;
  if (ct < 272 || ct > 64 * 1024 + 16 || (ct - 16) % 256 !== 0) {
    return `${field}: ct must be a padded ciphertext, base64url`;
  }
  return undefined;
}

interface LiveEntry {
  switchable: SwitchableDriver;
  version: number;
  preAggregations: boolean;
  /** Cube's driver type it was built as: a compiled model's dialect. */
  cubeType: string;
  /** The opened secrets of what it serves, only to redact its errors. */
  secrets: string[];
}

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
 * A model's data sources as xcube serves them to Cube: read from xcube's
 * store, each secret opened only to build its driver, and each driver behind
 * a stable one that a change swaps without a restart.
 */
export class Connections {
  protected readonly byModel = new Map<string, { connections: Map<string, StoredConnection>; readAt: number }>();

  protected readonly reads = new Map<string, Promise<Map<string, StoredConnection>>>();

  /** `<model>/<name>` → the stable drivers Cube holds for it, with the version each serves. */
  protected readonly live = new Map<string, Set<LiveEntry>>();

  /** One change of a connection at a time, in order. */
  protected readonly changes = new Map<string, Promise<void>>();

  protected refreshing: Promise<void> | null = null;

  public constructor(
    protected readonly store: () => RevisionStore,
    /** Set once they are loaded, at start. */
    public keys: CredentialKeys | null,
    protected readonly instanceId: string,
    protected readonly log: (message: string, params?: Record<string, unknown>) => void,
  ) {}

  /** A model's connections, as last read (again after 60 s, or when told they changed). */
  public async of(model: string): Promise<Map<string, StoredConnection>> {
    const known = this.byModel.get(model);
    if (known && Date.now() - known.readAt < 60000) {
      return known.connections;
    }
    let read = this.reads.get(model);
    if (!read) {
      read = this.store().connections(model).then((list) => {
        const connections = new Map(list.map((c) => [c.name, c]));
        this.byModel.set(model, { connections, readAt: Date.now() });
        return connections;
      }).finally(() => this.reads.delete(model));
      this.reads.set(model, read);
    }
    return read;
  }

  /** Cube's driver type of a model's data source, when it is a connection. */
  public async typeOf(model: string, name: string): Promise<string | undefined> {
    const connection = (await this.of(model)).get(name);
    return connection && isDriverType(connection.driver) ? DRIVERS[connection.driver].cubeType : undefined;
  }

  /** The fields of a connection's form: its connection fields and its auth method's. */
  public static validate(input: ConnectionInput): { driver: DriverType; fields: Fields; problems: string[] } {
    const problems: string[] = [];
    if (!isDriverType(input.driver)) {
      throw new ConnectionError(`Unknown driver "${String(input.driver).slice(0, 64)}"`, [`driver is one of ${Object.keys(DRIVERS).join(', ')}`]);
    }
    const spec = DRIVERS[input.driver];
    const auth = spec.auth[input.authMethod];
    if (!auth) {
      throw new ConnectionError(`Unknown auth method "${String(input.authMethod).slice(0, 64)}"`, [`authMethod for ${input.driver} is one of ${Object.keys(spec.auth).join(', ')}`]);
    }
    const plain = [...spec.connection, ...auth.filter((f) => !f.secret)];
    const secret = auth.filter((f) => f.secret);
    const fields: Fields = {};
    for (const [key, value] of Object.entries(input.fields ?? {})) {
      if (secret.some((f) => f.key === key)) {
        problems.push(`${key} is a secret: send it sealed, never in the fields`);
      } else if (!plain.some((f) => f.key === key)) {
        problems.push(`${key} is not a field of ${input.driver} with ${input.authMethod}`);
      } else if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        problems.push(`${key} must be a string, number or boolean`);
      } else if (typeof value === 'string' && value.length > MAX_FIELD) {
        problems.push(`${key} is too long`);
      } else {
        fields[key] = value as Fields[string];
      }
    }
    for (const f of plain.filter((p) => p.required)) {
      if (fields[f.key] === undefined || fields[f.key] === null || fields[f.key] === '') {
        problems.push(`${f.key} is required`);
      }
    }
    for (const [key, envelope] of Object.entries(input.sealed ?? {})) {
      if (!secret.some((f) => f.key === key)) {
        problems.push(`${key} is not a secret field of ${input.driver} with ${input.authMethod}`);
      } else {
        const problem = envelopeProblem(key, envelope);
        if (problem) {
          problems.push(problem);
        }
      }
    }
    for (const f of secret.filter((s) => s.required)) {
      if (!input.sealed?.[f.key]) {
        problems.push(`${f.key} is required, sealed`);
      }
    }
    return { driver: input.driver, fields, problems };
  }

  /** The connection's secrets, opened for its own target. */
  protected secretsOf(driver: DriverType, authMethod: string, fields: Fields, sealed: Record<string, unknown>): Record<string, string> {
    if (!this.keys) {
      throw new CredentialError('xcube holds no credential key (XCUBE_CREDENTIAL_KEY_IDS): it can\'t open secrets');
    }
    const secrets: Record<string, string> = {};
    for (const field of DRIVERS[driver].auth[authMethod].filter((f) => f.secret)) {
      if (sealed[field.key]) {
        const value = this.keys.open(sealed[field.key], driver, field.key, fields);
        if (value) {
          secrets[field.key] = value;
        } else if (field.required) {
          // An empty one would let the driver fall back to Cube's own (CUBEJS_DB_PASS).
          throw new CredentialError(`${field.key} is empty`);
        }
      }
    }
    return secrets;
  }

  /** A connection as stored, checked: its fields, and every secret opening for its target. Nothing connects. */
  public check(input: ConnectionInput): { driver: DriverType; fields: Fields } {
    const { driver, fields, problems } = Connections.validate(input);
    if (problems.length) {
      throw new ConnectionError('The connection can\'t be taken as it is', problems);
    }
    const secrets = this.secretsOf(driver, input.authMethod, fields, input.sealed ?? {});
    try {
      DRIVERS[driver].config(fields, input.authMethod, secrets);
    } catch (e: any) {
      throw new ConnectionError('The connection can\'t be taken as it is', [redact(e.message, Object.values(secrets))]);
    }
    return { driver, fields };
  }

  /** A driver of Cube's for a connection, not yet connected; an error has its secrets taken out. */
  protected create(connection: Pick<StoredConnection, 'name' | 'driver' | 'authMethod' | 'fields' | 'sealed'>, options: {
    preAggregations: boolean;
    maxPoolSize?: number;
  }): { driver: any; secrets: string[]; cubeType: string } {
    const driver = connection.driver as DriverType;
    if (!isDriverType(driver)) {
      throw new ConnectionError(`Connection "${connection.name}" has driver ${String(connection.driver).slice(0, 64)}, which xcube doesn't serve`);
    }
    const secrets = this.secretsOf(driver, connection.authMethod, connection.fields, connection.sealed);
    const values = Object.values(secrets);
    try {
      const config = DRIVERS[driver].config(connection.fields, connection.authMethod, secrets);
      return {
        driver: CubejsServerCore.createDriver(DRIVERS[driver].cubeType as any, {
          ...config,
          dataSource: connection.name,
          preAggregations: options.preAggregations,
          ...(options.maxPoolSize ? { maxPoolSize: options.maxPoolSize } : {}),
        } as any),
        secrets: values,
        cubeType: DRIVERS[driver].cubeType,
      };
    } catch (e: any) {
      throw new ConnectionError(redact(String(e?.message ?? e), values));
    }
  }

  protected report(model: string, name: string, version: number | null, state: string, error: string | null = null) {
    this.store().reportConnection(model, name, this.instanceId, version, state, error)
      .catch((e) => this.log('xcube: could not report a connection', { model, connection: name, error: e.message }));
  }

  /** Builds and tests a connection's driver; errors are redacted of its secrets. */
  protected async connect(connection: StoredConnection, preAggregations: boolean, maxPoolSize?: number) {
    const built = this.create(connection, { preAggregations, maxPoolSize });
    try {
      await withTimeout(Promise.resolve(built.driver.testConnection()), 30000, 'Connecting');
      return built;
    } catch (e: any) {
      await Promise.resolve(built.driver.release?.()).catch(() => undefined);
      throw new ConnectionError(redact(String(e?.message ?? e), built.secrets));
    }
  }

  /**
   * The stable driver Cube gets for a model's connection, once it connects;
   * `undefined` when the data source isn't one, for Cube's own drivers.
   */
  public async driverFor(model: string, name: string, options: { preAggregations: boolean; maxPoolSize?: number }): Promise<any> {
    const connection = (await this.of(model)).get(name);
    if (!connection) {
      return undefined;
    }
    let built: Awaited<ReturnType<Connections['connect']>>;
    try {
      built = await this.connect(connection, options.preAggregations, options.maxPoolSize);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      this.report(model, name, connection.version, 'failed', message);
      throw new Error(`Connection "${name}" can't be used: ${message}`);
    }
    const key = `${model}/${name}`;
    const entry: LiveEntry = {
      switchable: null as unknown as SwitchableDriver,
      version: connection.version,
      preAggregations: options.preAggregations,
      cubeType: built.cubeType,
      secrets: built.secrets,
    };
    entry.switchable = new SwitchableDriver(
      name,
      built.driver,
      () => this.live.get(key)?.delete(entry),
      (text) => redact(text, entry.secrets),
    );
    this.live.set(key, (this.live.get(key) ?? new Set()).add(entry));
    this.report(model, name, connection.version, 'live');
    return entry.switchable.proxy;
  }

  /**
   * A model's connection changed or went: read it again, and for every
   * driver Cube holds for it, build and test the new one before swapping to
   * it (a failure keeps the old one), refuse calls once it is gone, and serve
   * it again if it comes back. One change at a time, never to an older one.
   */
  public changed(model: string, name: string): Promise<void> {
    const key = `${model}/${name}`;
    const next = (this.changes.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.applyChange(model, name));
    this.changes.set(key, next);
    next.finally(() => {
      if (this.changes.get(key) === next) {
        this.changes.delete(key);
      }
    }).catch(() => undefined);
    return next;
  }

  protected async applyChange(model: string, name: string) {
    this.byModel.delete(model);
    const connection = (await this.of(model)).get(name);
    for (const entry of [...(this.live.get(`${model}/${name}`) ?? [])]) {
      if (!connection) {
        if (!entry.switchable.isRemoved) {
          entry.switchable.remove(`Connection "${name}" was removed`);
        }
      } else if ((entry.switchable.isRemoved || connection.version > entry.version)
        && (!isDriverType(connection.driver) || DRIVERS[connection.driver].cubeType !== entry.cubeType)) {
        // Compiled models keep the dialect they were compiled with.
        this.report(model, name, connection.version, 'failed', `its driver changed from ${entry.cubeType}; Cube must compile the model again`);
      } else if (entry.switchable.isRemoved || connection.version > entry.version) {
        try {
          const built = await this.connect(connection, entry.preAggregations);
          if (entry.switchable.isRemoved) {
            entry.switchable.restore(built.driver);
          } else {
            entry.switchable.swap(built.driver);
          }
          entry.version = connection.version;
          entry.secrets = built.secrets;
          this.report(model, name, connection.version, 'live');
          this.log('xcube: connection swapped', { model, connection: name, version: connection.version });
        } catch (e: any) {
          const message = String(e?.message ?? e);
          this.report(model, name, connection.version, 'failed', message);
          this.log('xcube: a changed connection failed; the previous one stays', {
            model, connection: name, error: message, warning: 'connection failed',
          });
        }
      }
    }
  }

  /**
   * Reads every model it knows again, and follows what changed, including
   * what a live driver serves against what is stored: the poll's part, one
   * run at a time, never awaited by the poll.
   */
  public refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        for (const model of [...this.byModel.keys()]) {
          this.byModel.delete(model);
          const stored = await this.of(model);
          const names = new Set([...stored.keys()]);
          for (const key of this.live.keys()) {
            if (key.startsWith(`${model}/`)) {
              names.add(key.slice(model.length + 1));
            }
          }
          for (const name of names) {
            const entries = [...(this.live.get(`${model}/${name}`) ?? [])];
            const current = stored.get(name);
            if (entries.some((e) => (current ? e.switchable.isRemoved || e.version !== current.version : !e.switchable.isRemoved))) {
              await this.changed(model, name);
            }
          }
        }
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /**
   * Tests a connection without storing it: opens its secrets, builds its
   * config, connects as Cube would, and reads its schemas. Every error is
   * redacted of its secrets.
   */
  public async test(input: ConnectionInput): Promise<{ ok: boolean; checks: Check[] }> {
    const checks: Check[] = [];
    const step = async (id: Check['id'], fn: () => Promise<void> | void, secrets: string[] = []) => {
      const started = Date.now();
      try {
        await fn();
        checks.push({ id, status: 'passed', durationMs: Date.now() - started });
        return true;
      } catch (e: any) {
        checks.push({ id, status: 'failed', durationMs: Date.now() - started, error: redact(String(e?.message ?? e), secrets) });
        return false;
      }
    };
    const skip = (...ids: Check['id'][]) => ids.forEach((id) => checks.push({ id, status: 'skipped', durationMs: 0 }));

    let validated: ReturnType<typeof Connections.validate> | undefined;
    let secrets: Record<string, string> = {};
    const opened = await step('secrets', () => {
      validated = Connections.validate(input);
      if (validated.problems.length) {
        throw new ConnectionError(validated.problems.join('; '));
      }
      secrets = this.secretsOf(validated.driver, input.authMethod, validated.fields, input.sealed ?? {});
    });
    if (!opened) {
      skip('config', 'connect', 'schemas');
      return { ok: false, checks };
    }
    const values = Object.values(secrets);
    let driver: any;
    const configured = await step('config', () => {
      const config = DRIVERS[validated!.driver].config(validated!.fields, input.authMethod, secrets);
      driver = CubejsServerCore.createDriver(DRIVERS[validated!.driver].cubeType as any, {
        ...config, dataSource: 'xcube_connection_test', maxPoolSize: 1,
      } as any);
    }, values);
    try {
      if (!configured) {
        skip('connect', 'schemas');
        return { ok: false, checks };
      }
      const connected = await step('connect', () => withTimeout(Promise.resolve(driver.testConnection()), 30000, 'Connecting'), values);
      if (!connected) {
        skip('schemas');
      } else if (typeof driver.getSchemas === 'function') {
        await step('schemas', () => withTimeout(Promise.resolve(driver.getSchemas()), 30000, 'Reading schemas'), values);
      } else {
        skip('schemas');
      }
      return { ok: checks.every((c) => c.status !== 'failed'), checks };
    } finally {
      await Promise.resolve(driver?.release?.()).catch(() => undefined);
      values.length = 0;
    }
  }
}
