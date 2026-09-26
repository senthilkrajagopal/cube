import os from 'os';
import crypto from 'crypto';
import { Pool } from 'pg';
import { CubejsHandlerError } from '@cubejs-backend/api-gateway';

import {
  checkedSnapshot,
  contentHash,
  MODEL_ID,
  type SnapshotFile,
} from '../model/snapshot';
import {
  validateSnapshot,
  type Probe,
  type ProbeResult,
  type ValidationResult,
} from '../model/validate';
import {
  FolderTree,
  ROOT,
  type AuthoredItem,
  type Folder,
  type ItemError,
  type PublishedItem,
} from '../names/items';
import { filesOf, itemsHash, publish } from '../names/publish';
import { createListenClient, createPool, type Logger } from '../store/db';
import { migrate } from '../store/migrate';
import {
  channelOf,
  PgRevisionStore,
  type ModelHead,
  type ModelStatus,
  type RevisionStore,
} from '../store/revisions';
import { CompileLane, Priority } from './lane';
import { RevisionListener, type ListenClient } from './listener';
import type { XcubeSettings } from './settings';

/** What `config()` settles, with its defaults applied. */
export interface ServingOptions {
  /** The security-context claim naming the model a request reads. */
  modelClaim: string;
  /** The claim naming the oldest revision a request may be answered from. */
  revisionClaim: string;
  /** A context naming no model is served Cube's own data model directory (`disk`), or refused. */
  withoutModel: 'disk' | 'refuse';
}

/** What xcube needs of Cube's server core. */
export interface ServingCore {
  getCompilerApi(context: any): Promise<{ getCompilers(options?: { requestId?: string }): Promise<unknown> }>;
  /** Drops a compiled model from Cube's compiler cache, which disposes it. */
  retireAppId(appId: string): void;
  /** Cube's API gateway, whose `sql()` answers probes. */
  xcubeGateway(): { sql(request: any): Promise<void> };
  logger: (message: string, params?: any) => void;
}

/** One revision of a model, compiled or being compiled. */
export interface Resident {
  kind: 'revision';
  appId: string;
  model: string;
  generation: string;
  revision: number;
  contentHash: string;
  files: SnapshotFile[];
  state: 'activating' | 'active' | 'retiring';
  retireAfter?: number;
  /** Scheduled refresh runs using it; it is never retired while any do. */
  holds: number;
}

/** A snapshot being checked, compiled once and never served. */
export interface Candidate {
  kind: 'candidate';
  appId: string;
  model: string;
  files: SnapshotFile[];
}

export interface Disk {
  kind: 'disk';
  appId: typeof DISK_APP_ID;
}

export type Served = Resident | Candidate | Disk;

export const DISK_APP_ID = 'xcube:disk';

const DISK: Disk = { kind: 'disk', appId: DISK_APP_ID };

/** Carried in a context: the revision it was resolved to. Set only by xcube. */
export interface Pin {
  model: string;
  appId: string;
}

interface ModelState {
  /** The current revision, as last read from the database. */
  target?: ModelHead;
  /** The revision new requests are served. */
  active?: Resident;
  failed?: { appId: string; revision: number; error: string; attempts: number; retryAt: number };
  syncing?: Promise<void>;
  dirty: boolean;
  /** Requests waiting for a read of the database that starts after they arrived. */
  waiting: { resolve: () => void; reject: (e: Error) => void }[];
  vanished?: boolean;
}

export type ImportOutcome =
  | { status: 'created' | 'unchanged'; head: ModelHead }
  | { status: 'conflict' | 'mode'; current: ModelHead | null }
  | { status: 'invalid'; contentHash: string; validation: ValidationResult };

/** An item as the admin API names it. */
export interface ItemRef {
  folderId: string;
  name: string;
  fullName: string;
}

export type ItemsOutcome =
  | { status: 'created' | 'unchanged'; head: ModelHead; items: ItemRef[] }
  | { status: 'conflict' | 'mode'; current: ModelHead | null }
  | { status: 'invalid'; errors: ItemError[]; cubeMessage: string | null };

export interface ItemsCheck {
  model: string;
  valid: boolean;
  errors: ItemError[];
  cubeMessage: string | null;
  probes: ProbeResult[];
  itemsHash: string | null;
  currentRevision: number | null;
  /** The items the changeset writes, with the full names they would have. */
  items: ItemRef[];
}

/** A folder tree that can't be taken as it is. */
export class FolderTreeError extends Error {
  public constructor(public readonly problems: string[]) {
    super(problems.join('; '));
  }
}

export interface InstanceModelStatus {
  revision: number | null;
  state: 'active' | 'activating' | 'failed' | 'none';
  error?: string;
}

export function appIdOf(head: ModelHead): string {
  return `xcube:${head.model}:${head.revision}:${head.contentHash.slice(0, 12)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function forbidden(message: string): CubejsHandlerError {
  return new CubejsHandlerError(403, 'Forbidden', message);
}

function unavailable(message: string): CubejsHandlerError {
  return new CubejsHandlerError(503, 'Service Unavailable', message);
}

function defaultLogger(message: string, params: Record<string, unknown> = {}) {
  console.log(`${message}: ${JSON.stringify(params)}`);
}

function setHeader(res: any, name: string, value: string) {
  if (res && typeof res.setHeader === 'function' && !res.headersSent) {
    res.setHeader(name, value);
  }
}

/** A query's SQL through Cube's own `/v1/sql` code: its scopes, rewrite, policies and errors. */
async function runProbe(core: ServingCore, query: unknown, context: any): Promise<{ status: number; error?: string }> {
  let answer: { status: number; error?: string } = { status: 500, error: 'No answer' };
  await core.xcubeGateway().sql({
    query,
    context,
    res: (body: any, options?: { status?: number }) => {
      const status = options?.status ?? 200;
      answer = status === 200 ? { status } : { status, error: body?.error };
    },
  });
  return answer;
}

/** A stored revision whose files don't match its hash: never compiled. */
class CorruptRevisionError extends Error {
}

export interface RuntimeDependencies {
  /** Defaults to Postgres at `settings.databaseUrl`. */
  store?: RevisionStore;
  /** Defaults to a `pg.Client` at `settings.databaseUrl`; `null` means no listener, the poll alone. */
  listenClient?: (() => ListenClient) | null;
  logger?: Logger;
}

/**
 * xcube inside one Cube process: it follows each model's current revision in
 * xcube's schema, compiles a revision before it switches to it, pins every
 * request to one compiled revision, and retires replaced ones after a grace
 * period. Nothing on the query path reads the database.
 */
export class XcubeRuntime {
  public readonly instanceId = `${os.hostname()}/${process.pid}/${crypto.randomBytes(3).toString('hex')}`;

  protected pool: Pool | null = null;

  protected store: RevisionStore | null;

  protected listener: RevisionListener | null = null;

  protected options: ServingOptions | null = null;

  protected core: ServingCore | null = null;

  protected readonly models = new Map<string, ModelState>();

  protected readonly residents = new Map<string, Resident>();

  protected readonly candidates = new Map<string, Candidate>();

  /** Files of revisions compiled into a core since detached, for the next core. */
  protected readonly detachedFiles = new Map<string, SnapshotFile[]>();

  /** Models the database was found not to have, until when. */
  protected readonly absent = new Map<string, number>();

  /** One resolution per context object, so every hook Cube calls for it agrees. */
  protected readonly resolutions = new WeakMap<object, Served>();

  protected readonly lane: CompileLane;

  protected started = false;

  protected stopped = false;

  protected pollTimer: NodeJS.Timeout | null = null;

  protected retireTimer: NodeJS.Timeout | null = null;

  protected readyResolve!: () => void;

  /** Resolves once a core is attached and every model's current revision was tried. */
  public readonly ready: Promise<void> = new Promise((resolve) => {
    this.readyResolve = resolve;
  });

  public constructor(public readonly settings: XcubeSettings, protected readonly deps: RuntimeDependencies = {}) {
    this.store = deps.store ?? null;
    this.lane = new CompileLane({ maxWaiting: settings.compileQueue, maxWaitMs: settings.compileWaitMs });
  }

  public get serving(): boolean {
    return this.options !== null;
  }

  public get servingOptions(): ServingOptions {
    if (!this.options) {
      throw new Error('xcube: cube.js does not use require(\'xcube\').config()');
    }
    return this.options;
  }

  public log(message: string, params: Record<string, unknown> = {}) {
    const logger = this.deps.logger ?? this.core?.logger ?? defaultLogger;
    logger(message, params);
  }

  /** Cube's production logger shows only warnings and errors by default. */
  public warn(message: string, params: Record<string, unknown> = {}) {
    this.log(message, { ...params, warning: message });
  }

  /** Called by `config()`, when Cube loads cube.js. */
  public configure(options: ServingOptions) {
    if (this.options && JSON.stringify(this.options) !== JSON.stringify(options)) {
      throw new Error('xcube: config() was called twice with different options');
    }
    this.options = options;
  }

  /**
   * Connects, migrates, starts following revisions and reads every model's
   * current revision. Retries the connection for as long as it takes: a
   * process without its database never listens, so it is never sent traffic.
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const { settings } = this;

    if (!this.store) {
      this.pool = createPool(settings.databaseUrl, this.instanceId, (m, p) => this.log(m, p));
      for (let attempt = 1, delay = 1000; ; attempt++, delay = Math.min(delay * 2, 30000)) {
        try {
          await migrate(this.pool, {
            schema: settings.schema,
            apply: settings.migrate,
            logger: (m, p) => this.log(m, p),
          });
          break;
        } catch (e: any) {
          if (/differs from the one applied|needs xcube schema version|is behind|may not create it/.test(e.message)) {
            throw e;
          }
          this.warn('xcube: database not reachable yet, retrying', { attempt, error: e.message });
          await sleep(Math.round(delay * (0.8 + Math.random() * 0.4)));
        }
      }
      this.store = new PgRevisionStore(this.pool, { schema: settings.schema, keepRevisions: settings.keepRevisions });
    }

    const listenClient = this.deps.listenClient === undefined
      ? () => createListenClient(settings.databaseUrl, this.instanceId)
      : this.deps.listenClient;
    if (listenClient) {
      // Listening starts before anything is read, so no announcement falls between.
      this.listener = new RevisionListener({
        channel: channelOf(settings.schema),
        createClient: listenClient,
        onNotify: (model) => this.notified(model),
        onConnect: () => this.syncAllQuietly(),
        onDown: () => this.schedulePoll(),
        logger: (m, p) => this.log(m, p),
      });
      this.listener.start();
    }

    await this.readHeads();
    this.schedulePoll();
    this.retireTimer = setInterval(() => this.retireDue(), 30000);
    this.retireTimer.unref?.();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    if (this.retireTimer) {
      clearInterval(this.retireTimer);
    }
    await this.listener?.stop();
    await this.pool?.end().catch(() => undefined);
  }

  /**
   * Serves through `core`: compiles every model's current revision into it,
   * before Cube listens, so no request meets a cold model.
   */
  public async attach(core: ServingCore): Promise<void> {
    if (!this.serving) {
      throw new Error(
        'xcube: XCUBE_DATABASE_URL is set, but cube.js does not use require(\'xcube\').config()'
      );
    }
    this.core = core;
    // Through each model's sync chain, as every activation goes, so nothing
    // compiles a model's revisions out of order.
    for (const [model, state] of [...this.models]) {
      if (state.target) {
        await this.sync(model).catch((e) => this.warn('xcube: could not serve model at start', { model, error: e.message }));
      }
    }
    // What a previous core compiled is either compiled again now, or not needed.
    this.detachedFiles.clear();
    this.readyResolve();
  }

  /** The core is shutting down (SIGUSR1 builds another); what it compiled goes with it. */
  public detach(core: ServingCore) {
    if (this.core !== core) {
      return;
    }
    this.core = null;
    for (const resident of this.residents.values()) {
      this.detachedFiles.set(resident.appId, resident.files);
    }
    this.residents.clear();
    for (const state of this.models.values()) {
      state.active = undefined;
      state.failed = undefined;
    }
  }

  protected state(model: string): ModelState {
    let state = this.models.get(model);
    if (!state) {
      state = { dirty: false, waiting: [] };
      this.models.set(model, state);
    }
    return state;
  }

  /**
   * The state of a model this process may follow: a valid id, within the
   * cap on models, so nothing outside (a notification anyone connected to
   * the database can send, a token) can grow it without bound.
   */
  protected admit(model: string): ModelState | undefined {
    if (typeof model !== 'string' || !MODEL_ID.test(model)) {
      return undefined;
    }
    if (!this.models.has(model) && this.models.size >= this.settings.maxModels) {
      this.warn('xcube: too many models; not following another', { maxModels: this.settings.maxModels });
      return undefined;
    }
    return this.state(model);
  }

  // ---------------------------------------------------------------- resolution

  /** The model a security context names: `undefined` when it names none. */
  public modelOf(securityContext: any): string | undefined {
    const model = securityContext?.[this.servingOptions.modelClaim];
    if (model === undefined || model === null) {
      return undefined;
    }
    if (typeof model !== 'string' || !MODEL_ID.test(model)) {
      throw forbidden('Invalid model id in the security context');
    }
    return model;
  }

  protected revisionOf(securityContext: any): number | undefined {
    const raw = securityContext?.[this.servingOptions.revisionClaim];
    if (raw === undefined || raw === null) {
      return undefined;
    }
    const revision = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw forbidden('Invalid revision in the security context');
    }
    return revision;
  }

  /**
   * What a context is served: behind `contextToAppId` and `repositoryFactory`.
   * A request carries the pin `extendContext` gave it; background contexts
   * (the refresh scheduler, stored jobs) carry theirs or get the active
   * revision.
   */
  public resolve(context: any): Served {
    const known = this.resolutions.get(context);
    if (known) {
      return known;
    }
    const served = this.resolveUncached(context);
    this.resolutions.set(context, served);
    return served;
  }

  protected resolveUncached(context: any): Served {
    if (context?.xcubeActivate !== undefined) {
      // Compiling a revision: that revision, or nothing.
      const resident = this.residents.get(context.xcubeActivate);
      if (!resident) {
        throw new Error('xcube: the revision being compiled is no longer resident');
      }
      return resident;
    }
    if (context?.xcubeCandidate !== undefined) {
      const candidate = this.candidates.get(context.xcubeCandidate);
      if (!candidate) {
        throw new CubejsHandlerError(410, 'Gone', 'This check has finished');
      }
      return candidate;
    }

    const model = this.modelOf(context?.securityContext ?? context?.authInfo);
    if (model === undefined) {
      if (this.servingOptions.withoutModel === 'disk') {
        return DISK;
      }
      throw forbidden('The security context names no model');
    }

    const pin: Pin | undefined = context?.xcubePin;
    if (pin && pin.model === model) {
      const resident = this.residents.get(pin.appId);
      if (resident?.model === model) {
        return resident;
      }
      this.warn('xcube: pinned revision retired; answering from the active one', { model, appId: pin.appId });
    }

    const active = this.models.get(model)?.active;
    if (active) {
      return active;
    }
    throw this.notServable(model);
  }

  protected notServable(model: string): CubejsHandlerError {
    const state = this.models.get(model);
    if (state?.target) {
      return unavailable(`Model "${model}" has no revision that compiles on this instance yet`);
    }
    if ((this.absent.get(model) ?? 0) > Date.now()) {
      return forbidden(`Unknown model "${model}"`);
    }
    return unavailable(`Model "${model}" is not loaded on this instance yet`);
  }

  /** The files Cube compiles for a context, bound to one immutable revision. */
  public filesOf(served: Resident | Candidate): SnapshotFile[] {
    return served.files;
  }

  /**
   * Behind `extendContext`: pins a request to the revision it is served,
   * after waiting, briefly, for this instance to reach the revision the
   * request asks for at least.
   */
  public async pinFor(req: any): Promise<{ xcubePin?: Pin }> {
    const securityContext = req?.securityContext;
    const model = this.modelOf(securityContext);
    const res = req?.res;

    if (model === undefined) {
      if (this.servingOptions.withoutModel !== 'disk') {
        throw forbidden('The security context names no model');
      }
      setHeader(res, 'x-xcube-revision', 'disk');
      return {};
    }

    let resident: Resident;
    try {
      resident = await this.servingResident(model, this.revisionOf(securityContext));
    } catch (e: any) {
      if (e instanceof CubejsHandlerError && e.status === 503) {
        setHeader(res, 'Retry-After', '2');
      }
      throw e;
    }
    setHeader(res, 'x-xcube-revision', `${model}@${resident.revision}`);
    setHeader(res, 'x-xcube-generation', resident.generation);
    return { xcubePin: { model, appId: resident.appId } };
  }

  protected async servingResident(model: string, atLeast?: number): Promise<Resident> {
    /** `fresh`: the database was read after the request arrived, so its current revision is known. */
    const satisfied = (fresh: boolean) => {
      const state = this.models.get(model);
      const active = state?.active;
      if (!active) {
        return undefined;
      }
      if (atLeast === undefined || active.revision >= atLeast) {
        return active;
      }
      // A revision the database doesn't have (its schema was recreated since
      // the client heard of it) can't be waited for: answer from the current one.
      if (fresh && state?.target && atLeast > state.target.revision
        && appIdOf(state.target) === active.appId) {
        return active;
      }
      return undefined;
    };

    const now = satisfied(false);
    if (now) {
      return now;
    }
    if ((this.absent.get(model) ?? 0) > Date.now()) {
      throw forbidden(`Unknown model "${model}"`);
    }

    const read = this.freshRead(model);
    if (!read) {
      throw unavailable(`Model "${model}" can't be followed on this instance`);
    }
    let timer: NodeJS.Timeout | undefined;
    const synced = await Promise.race([
      read.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.settings.catchUpMs);
      }),
    ]);
    clearTimeout(timer);

    const after = satisfied(synced);
    if (after) {
      return after;
    }
    const active = this.models.get(model)?.active;
    if (active && atLeast !== undefined) {
      throw unavailable(`Model "${model}" revision ${atLeast} is not active on this instance yet`);
    }
    throw this.notServable(model);
  }

  /** Background contexts for the refresh scheduler, each pinned to its model's active revision. */
  public async refreshContexts(user?: () => any[] | Promise<any[]>): Promise<any[]> {
    await this.ready;
    const { modelClaim, withoutModel } = this.servingOptions;
    const base: any[] = user
      ? await user()
      : [
        ...(withoutModel === 'disk' ? [{ securityContext: {} }] : []),
        ...[...this.models.entries()]
          .filter(([, state]) => state.active)
          .map(([model]) => ({ securityContext: { [modelClaim]: model } })),
      ];

    return base.flatMap((entry) => {
      const { xcubePin: _pin, xcubeCandidate: _candidate, ...context } = entry || {};
      let model: string | undefined;
      try {
        model = this.modelOf(context.securityContext ?? context.authInfo);
      } catch {
        return [];
      }
      if (model === undefined) {
        return withoutModel === 'disk' ? [context] : [];
      }
      const active = this.models.get(model)?.active;
      return active ? [{ ...context, xcubePin: { model, appId: active.appId } }] : [];
    });
  }

  /** The revision a background context is served, if any, without throwing. */
  public residentOf(context: any): Resident | undefined {
    try {
      const served = this.resolve(context);
      return served.kind === 'revision' ? served : undefined;
    } catch {
      return undefined;
    }
  }

  public hold(resident: Resident) {
    resident.holds++;
  }

  public release(resident: Resident) {
    resident.holds = Math.max(0, resident.holds - 1);
  }

  // ------------------------------------------------------------ following

  protected notified(model: string) {
    if (!this.admit(model)) {
      this.warn('xcube: ignored a notification for an invalid model id', {});
      return;
    }
    this.absent.delete(model);
    this.sync(model).catch((e) => this.warn('xcube: sync failed', { model, error: e.message }));
  }

  /**
   * Resolves once a read of the model's current revision that started after
   * the call has completed (and any switch it led to): a waiting request
   * waits for one read, however many others arrive meanwhile.
   */
  protected freshRead(model: string): Promise<void> | undefined {
    const state = this.admit(model);
    if (!state) {
      return undefined;
    }
    const read = new Promise<void>((resolve, reject) => {
      state.waiting.push({ resolve, reject });
    });
    this.sync(model).catch(() => undefined);
    return read;
  }

  protected schedulePoll() {
    if (this.stopped) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    const up = this.listener ? this.listener.up : false;
    const delay = up || !this.listener ? this.settings.pollIntervalMs : this.settings.pollIntervalDownMs;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      await this.syncAllQuietly(true);
      this.schedulePoll();
    }, delay);
    this.pollTimer.unref?.();
  }

  protected async readHeads() {
    const heads = await this.requireStore().heads();
    for (const head of heads) {
      this.state(head.model).target = head;
    }
  }

  protected async syncAllQuietly(fromPoll = false) {
    try {
      await this.syncAll(fromPoll);
    } catch (e: any) {
      this.warn('xcube: could not read revisions', { error: e.message });
    }
  }

  /** Re-reads every model's current revision, and follows each that changed. */
  public async syncAll(fromPoll = false): Promise<void> {
    const heads = await this.requireStore().heads();
    const seen = new Set<string>();
    const changed: Promise<void>[] = [];

    for (const head of heads) {
      seen.add(head.model);
      this.absent.delete(head.model);
      const state = this.admit(head.model);
      const appId = appIdOf(head);
      // Only the model's sync chain writes its target; this only asks it to run.
      if (state && (!state.active || state.active.appId !== appId || !state.target || appIdOf(state.target) !== appId)) {
        if (fromPoll && this.core && state.target && appIdOf(state.target) !== appId) {
          this.warn('xcube: poll found a revision no notification announced', { model: head.model, revision: head.revision });
        }
        changed.push(this.sync(head.model).catch((e) => {
          this.warn('xcube: sync failed', { model: head.model, error: e.message });
        }));
      }
    }

    for (const [model, state] of this.models) {
      if (!seen.has(model) && state.target && !state.vanished) {
        state.vanished = true;
        this.warn('xcube: model is gone from the database; still serving it from memory', { model });
      }
    }

    await Promise.all(changed);
  }

  /**
   * Follows one model's current revision: reads it, and compiles and switches
   * to it when it changed. One at a time per model; a call while one runs
   * makes it read again when it finishes, so the newest revision always wins.
   */
  public sync(model: string): Promise<void> {
    const state = this.admit(model);
    if (!state) {
      return Promise.reject(new Error(`xcube: not following model ${JSON.stringify(String(model).slice(0, 64))}`));
    }
    if (state.syncing) {
      state.dirty = true;
      return state.syncing;
    }
    const run = async () => {
      do {
        state.dirty = false;
        const waiters = state.waiting.splice(0);
        try {
          await this.syncOnce(model, state);
        } catch (e: any) {
          waiters.forEach((w) => w.reject(e));
          throw e;
        }
        waiters.forEach((w) => w.resolve());
      } while (state.dirty || state.waiting.length);
    };
    state.syncing = run().finally(() => {
      state.syncing = undefined;
      if (state.dirty || state.waiting.length) {
        // Asked for again after the last read began.
        this.sync(model).catch(() => undefined);
      } else if (!state.target && !state.active && this.models.get(model) === state) {
        // Nothing is known of it: keep no state for it.
        this.models.delete(model);
      }
    });
    return state.syncing;
  }

  protected async syncOnce(model: string, state: ModelState) {
    let head: ModelHead | null;
    try {
      head = await this.requireStore().head(model);
    } catch (e: any) {
      // Unreachable database: a model known here but not compiled into this
      // core (after a reload) is compiled from what is already known.
      if (!(this.core && state.target && !state.active)) {
        throw e;
      }
      this.warn('xcube: database unreachable; compiling the last revision known here', { model, error: e.message });
      head = state.target;
    }

    if (!head) {
      if (state.active || state.target) {
        if (!state.vanished) {
          state.vanished = true;
          this.warn('xcube: model is gone from the database; still serving it from memory', { model });
        }
      } else {
        this.absent.set(model, Date.now() + 60000);
        this.models.delete(model);
      }
      return;
    }

    this.absent.delete(model);
    state.target = head;
    state.vanished = false;
    if (!this.core) {
      return;
    }

    const appId = appIdOf(head);
    if (state.active?.appId === appId) {
      return;
    }
    if (state.failed?.appId === appId && Date.now() < state.failed.retryAt) {
      return;
    }
    if (!await this.activateHead(head) && !state.active) {
      await this.fallBack(head, state);
    }
  }

  protected async filesFor(head: ModelHead): Promise<SnapshotFile[] | null> {
    const appId = appIdOf(head);
    const known = this.residents.get(appId)?.files ?? this.detachedFiles.get(appId);
    if (known) {
      return known;
    }
    const files = await this.requireStore().files(head.model, head.revision);
    if (files && contentHash(files) !== head.contentHash) {
      throw new CorruptRevisionError(`revision ${head.revision} of model "${head.model}" does not match its content hash`);
    }
    return files;
  }

  /**
   * Compiles `head` and switches its model to it; a failure keeps the
   * previous revision. A database error is thrown, for the next read to
   * retry: it says nothing about the revision.
   */
  protected async activateHead(head: ModelHead, fallback = false): Promise<boolean> {
    let files: SnapshotFile[] | null;
    try {
      files = await this.filesFor(head);
    } catch (e: any) {
      if (!(e instanceof CorruptRevisionError)) {
        throw e;
      }
      this.recordFailure(this.state(head.model), head, appIdOf(head), e);
      return false;
    }
    if (!files) {
      return false;
    }
    return this.activate(head, files, fallback);
  }

  /**
   * Compiles one revision, then switches to it if it is still the model's
   * current revision, or, with `fallback`, if nothing serves the model here.
   * Runs only in the model's sync chain, one at a time per model.
   */
  protected async activate(head: ModelHead, files: SnapshotFile[], fallback = false): Promise<boolean> {
    const { core } = this;
    if (!core) {
      return false;
    }
    const { model } = head;
    const state = this.state(model);
    const appId = appIdOf(head);
    if (state.active?.appId === appId) {
      return true;
    }

    let resident = this.residents.get(appId);
    if (!resident) {
      resident = {
        kind: 'revision',
        appId,
        model,
        generation: head.generation,
        revision: head.revision,
        contentHash: head.contentHash,
        files,
        state: 'activating',
        holds: 0,
      };
      this.residents.set(appId, resident);
    }
    const reused = resident.state === 'retiring';
    resident.retireAfter = undefined;
    const drop = (r: Resident) => {
      if (reused) {
        // Still a replaced revision: it retires as it would have.
        r.retireAfter = Date.now() + this.settings.retireGraceMs;
      } else if (this.core === core && state.active !== r) {
        this.residents.delete(r.appId);
        core.retireAppId(r.appId);
      }
    };

    const requestId = `xcube-activate-${model}-${head.revision}-${crypto.randomBytes(3).toString('hex')}`;
    const { modelClaim } = this.servingOptions;
    const context = {
      securityContext: { [modelClaim]: model },
      authInfo: { [modelClaim]: model },
      requestId,
      xcubeActivate: appId,
    };
    const started = Date.now();

    try {
      await this.lane.run(Priority.Activate, async () => {
        const compilerApi = await core.getCompilerApi(context);
        await compilerApi.getCompilers({ requestId });
      });
    } catch (e: any) {
      drop(resident);
      this.recordFailure(state, head, appId, e);
      return false;
    }

    if (this.core !== core) {
      return false;
    }
    const current = state.target !== undefined && appIdOf(state.target) === appId;
    if (!current && !(fallback && !state.active)) {
      // Superseded while it compiled: the next read switches to the newer one.
      drop(resident);
      return false;
    }

    const previous = state.active;
    state.active = resident;
    resident.state = 'active';
    if (current || state.failed?.appId === appId) {
      state.failed = undefined;
    }
    this.detachedFiles.delete(appId);
    if (previous && previous !== resident) {
      previous.state = 'retiring';
      previous.retireAfter = Date.now() + this.settings.retireGraceMs;
    }
    this.log('xcube: serving revision', {
      model,
      revision: head.revision,
      previous: previous?.revision ?? null,
      compileMs: Date.now() - started,
    });
    return true;
  }

  protected recordFailure(state: ModelState, head: ModelHead, appId: string, e: any) {
    const attempts = state.failed?.appId === appId ? state.failed.attempts + 1 : 1;
    const backoff = Math.min(30000 * 4 ** (attempts - 1), 10 * 60 * 1000);
    state.failed = {
      appId,
      revision: head.revision,
      error: String(e?.message ?? e).slice(0, 2000),
      attempts,
      retryAt: Date.now() + backoff,
    };
    this.log('xcube: revision does not compile here; keeping the previous one', {
      model: head.model,
      revision: head.revision,
      serving: state.active?.revision ?? null,
      attempts,
      error: state.failed.error,
    });
  }

  /**
   * Nothing serves the model here and its current revision doesn't compile:
   * serve the newest of the three before it that does. What is reported, and
   * retried, stays the current revision's failure.
   */
  protected async fallBack(head: ModelHead, state: ModelState) {
    const failure = state.failed;
    try {
      const earlier = await this.requireStore().earlier(head.model, head.revision, 3);
      for (const older of earlier) {
        if (await this.activateHead(older, true)) {
          break;
        }
      }
    } catch (e: any) {
      this.warn('xcube: could not serve an earlier revision', { model: head.model, error: e.message });
    }
    state.failed = failure;
  }

  protected retireDue() {
    const { core } = this;
    if (!core) {
      return;
    }
    const now = Date.now();
    const due = [...this.residents.values()].filter((resident) => resident.state === 'retiring'
      && (resident.retireAfter ?? Infinity) <= now
      && resident.holds === 0
      && this.models.get(resident.model)?.active !== resident);
    for (const resident of due) {
      this.residents.delete(resident.appId);
      core.retireAppId(resident.appId);
      this.log('xcube: retired revision', { model: resident.model, revision: resident.revision });
    }
    for (const [model, until] of this.absent) {
      if (until <= now) {
        this.absent.delete(model);
      }
    }
    if (this.residents.size > 100) {
      this.warn('xcube: many compiled revisions are resident', { residents: this.residents.size });
    }
  }

  // ---------------------------------------------------------------- admin

  protected requireStore(): RevisionStore {
    if (!this.store) {
      throw unavailable('xcube has not connected to its database yet');
    }
    return this.store;
  }

  protected requireCore(): ServingCore {
    if (!this.core) {
      throw unavailable('This Cube instance is not serving yet');
    }
    return this.core;
  }

  public instanceStatus(model: string): InstanceModelStatus {
    const state = this.models.get(model);
    if (state?.failed && state.target && appIdOf(state.target) === state.failed.appId) {
      return { revision: state.active?.revision ?? null, state: 'failed', error: state.failed.error };
    }
    if (state?.active) {
      const current = state.target && appIdOf(state.target) === state.active.appId;
      return { revision: state.active.revision, state: current || !state.target ? 'active' : 'activating' };
    }
    return { revision: null, state: state?.target ? 'activating' : 'none' };
  }

  public async status(model: string): Promise<(ModelStatus & { instance: InstanceModelStatus }) | null> {
    const status = await this.requireStore().status(model);
    return status && { ...status, instance: this.instanceStatus(model) };
  }

  /**
   * Checks a snapshot by compiling it as a candidate: an app id of its own,
   * resolved by the same hooks as served revisions, so Cube compiles it
   * exactly as it would serve it. It is reachable only through the check,
   * and dropped from Cube's compiler cache when the check ends.
   */
  protected validate(
    model: string,
    files: SnapshotFile[],
    priority: Priority,
    securityContext: Record<string, unknown>,
    probes: Probe[],
  ): Promise<ValidationResult> {
    const core = this.requireCore();
    const { modelClaim } = this.servingOptions;
    const probeContext = { ...securityContext, [modelClaim]: model };

    return validateSnapshot({
      files,
      lane: this.lane,
      priority,
      probes,
      withCandidate: async (fn) => {
        const id = crypto.randomUUID();
        const candidate: Candidate = { kind: 'candidate', appId: `xcube:${model}:check:${id}`, model, files };
        this.candidates.set(id, candidate);
        const requestId = `xcube-check-${id}`;
        try {
          return await fn({
            compile: async () => {
              const compilerApi = await core.getCompilerApi({
                securityContext: { [modelClaim]: model },
                authInfo: { [modelClaim]: model },
                requestId,
                xcubeCandidate: id,
              });
              await compilerApi.getCompilers({ requestId });
            },
            probe: async (probe: Probe): Promise<ProbeResult> => {
              const answer = await runProbe(core, probe.query, {
                securityContext: probeContext,
                authInfo: probeContext,
                requestId,
                xcubeCandidate: id,
              });
              const result: ProbeResult = { id: probe.id, candidate: answer };
              if (probe.compare && answer.status !== 200) {
                // The revision active now, read at this point so every probe of a check asks the same one.
                const active = this.models.get(model)?.active;
                result.current = active
                  ? {
                    ...await runProbe(core, probe.query, {
                      securityContext: probeContext,
                      authInfo: probeContext,
                      requestId,
                      xcubePin: { model, appId: active.appId },
                    }),
                    revision: active.revision,
                  }
                  : { status: null, skipped: 'no_current_revision' };
              }
              return result;
            },
          });
        } finally {
          this.candidates.delete(id);
          core.retireAppId(candidate.appId);
        }
      },
    });
  }

  /** Checks a snapshot without storing it, and runs its probes against it. */
  public async dryRun(
    model: string,
    files: SnapshotFile[],
    securityContext: Record<string, unknown>,
    probes: Probe[],
  ) {
    const checked = checkedSnapshot(files, this.settings.limits);
    const hash = contentHash(checked);
    const active = this.models.get(model)?.active;
    const started = Date.now();
    const validation = await this.validate(model, checked, Priority.DryRun, securityContext, probes);
    return {
      model,
      contentHash: hash,
      currentRevision: active?.revision ?? null,
      sameAsCurrent: active?.contentHash === hash,
      ...validation,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Stores a snapshot as the model's new current revision, once it compiles,
   * and announces it. The same content as the current revision changes
   * nothing, whatever the base.
   */
  public async importSnapshot(
    model: string,
    baseRevision: number | null,
    files: SnapshotFile[],
    source: Record<string, unknown>,
  ): Promise<ImportOutcome> {
    const checked = checkedSnapshot(files, this.settings.limits);
    const hash = contentHash(checked);
    const store = this.requireStore();

    const head = await store.head(model);
    if (head?.mode === 'items') {
      return { status: 'mode', current: head };
    }
    if (head?.contentHash === hash) {
      return { status: 'unchanged', head };
    }
    if ((head?.revision ?? null) !== baseRevision) {
      return { status: 'conflict', current: head };
    }

    const validation = await this.validate(model, checked, Priority.Import, {}, []);
    if (!validation.valid) {
      return { status: 'invalid', contentHash: hash, validation };
    }

    const result = await store.import({ model, baseRevision, files: checked, source });
    if ('current' in result) {
      return { status: result.outcome, current: result.current };
    }
    this.announced(model, result.outcome);
    return { status: result.outcome, head: result.head };
  }

  protected announced(model: string, outcome: 'created' | 'unchanged') {
    if (outcome === 'created') {
      this.absent.delete(model);
      this.sync(model).catch((e) => this.warn('xcube: sync failed', { model, error: e.message }));
    }
  }

  // ---------------------------------------------------------------- items (slice 3)

  protected readonly itemsCache = new Map<string, PublishedItem[]>();

  /** A revision's items, kept for the last few revisions read. */
  protected async itemsAt(head: ModelHead): Promise<PublishedItem[]> {
    if (head.mode !== 'items') {
      return [];
    }
    const key = `${head.model}@${head.generation}@${head.revision}`;
    let items = this.itemsCache.get(key);
    if (!items) {
      items = await this.requireStore().items(head.model, head.revision);
      this.itemsCache.set(key, items);
      while (this.itemsCache.size > 8) {
        this.itemsCache.delete(this.itemsCache.keys().next().value!);
      }
    }
    return items;
  }

  protected static refs(items: PublishedItem[], keys?: Set<string>): ItemRef[] {
    return items
      .filter((item) => !keys || keys.has(`${item.folderId}/${item.name}`))
      .map(({ folderId, name, fullName }) => ({ folderId, name, fullName }));
  }

  /** Cube's errors, placed on the items whose resolved files they name. */
  protected static itemErrors(validation: ValidationResult, items: PublishedItem[]): ItemError[] {
    const byPath = new Map(items.map((item) => [`${item.fullName}.yml`, item]));
    return validation.errors.map(({ path, line, column, kind, message }) => {
      const item = path ? byPath.get(path) : undefined;
      return {
        folderId: item?.folderId ?? null,
        name: item?.name ?? null,
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
        kind,
        message,
      };
    });
  }

  public async putFolders(model: string, folders: Folder[]): Promise<{ hash: string }> {
    const problems = FolderTree.check(folders);
    if (problems.length) {
      throw new FolderTreeError(problems);
    }
    return { hash: await this.requireStore().putFolders(model, folders) };
  }

  /**
   * Applies a changeset to the model's current items: resolves the items it
   * changes, compiles the result as Cube would serve it, and stores it as a
   * new revision (or, with `dryRun`, only checks it and runs the probes).
   */
  public async applyChangeset(
    model: string,
    changeset: {
      baseRevision: number | null;
      upserts: AuthoredItem[];
      deletes: { folderId: string; name: string }[];
      source: Record<string, unknown>;
    },
    check?: { securityContext: Record<string, unknown>; probes: Probe[] },
  ): Promise<ItemsOutcome | ItemsCheck> {
    const store = this.requireStore();
    const head = await store.head(model);
    if (head && head.mode !== 'items') {
      return { status: 'mode', current: head };
    }
    const current = head ? await this.itemsAt(head) : [];
    const tree = new FolderTree(await store.folders(model));
    if (!tree.has(ROOT)) {
      throw new FolderTreeError([`Model "${model}" has no folder tree yet: put its folders first`]);
    }
    return this.publishItems(model, head, {
      tree, current, upserts: changeset.upserts, deletes: changeset.deletes,
    }, changeset, check);
  }

  /** Replaces the model's whole folder tree and item set: a first import, or a recovery. */
  public async importItemsSnapshot(
    model: string,
    snapshot: { baseRevision: number | null; folders: Folder[]; items: AuthoredItem[]; source: Record<string, unknown> },
  ): Promise<ItemsOutcome> {
    const problems = FolderTree.check(snapshot.folders);
    if (problems.length) {
      throw new FolderTreeError(problems);
    }
    const head = await this.requireStore().head(model);
    return this.publishItems(model, head, {
      tree: new FolderTree(snapshot.folders),
      current: [],
      upserts: snapshot.items,
      deletes: [],
      replaceAll: true,
    }, snapshot, undefined, snapshot.folders) as Promise<ItemsOutcome>;
  }

  protected async publishItems(
    model: string,
    head: ModelHead | null,
    input: Parameters<typeof publish>[0],
    request: { baseRevision: number | null; source: Record<string, unknown> },
    check?: { securityContext: Record<string, unknown>; probes: Probe[] },
    folders?: Folder[],
  ): Promise<ItemsOutcome | ItemsCheck> {
    const baseMatches = (head?.revision ?? null) === request.baseRevision;
    // A stale base is a conflict, unless the changes are already in (a retry).
    const published = publish({ ...input, lenientDeletes: Boolean(!check && !baseMatches && !input.replaceAll) });
    const hash = published.errors.length ? null : itemsHash(published.items);
    const changed = new Set(published.changed);
    const sameAsHead = () => Boolean(head && head.mode === 'items' && head.itemsHash === hash
      && head.contentHash === contentHash(filesOf(published.items)));

    if (!check) {
      if (!baseMatches && !(published.errors.length === 0 && sameAsHead())) {
        return { status: 'conflict', current: head };
      }
      if (published.errors.length) {
        return { status: 'invalid', errors: published.errors, cubeMessage: null };
      }
      if (sameAsHead() && !folders) {
        return { status: 'unchanged', head: head!, items: XcubeRuntime.refs(published.items, changed) };
      }
    }

    const base: ItemsCheck = {
      model,
      valid: false,
      errors: published.errors,
      cubeMessage: null,
      probes: [],
      itemsHash: hash,
      currentRevision: head?.revision ?? null,
      items: XcubeRuntime.refs(published.items, changed),
    };
    if (published.errors.length) {
      return base;
    }

    const files = checkedSnapshot(filesOf(published.items), this.settings.limits);
    if (!check && sameAsHead()) {
      // The same items with a new folder tree: stored without compiling again.
      const same = await this.requireStore().importItems({
        model, baseRevision: request.baseRevision, items: published.items, itemsHash: hash!, source: request.source, folders,
      });
      return 'current' in same
        ? { status: same.outcome, current: same.current }
        : { status: same.outcome, head: same.head, items: XcubeRuntime.refs(published.items, changed) };
    }
    const validation = await this.validate(
      model,
      files,
      check ? Priority.DryRun : Priority.Import,
      check?.securityContext ?? {},
      check?.probes ?? [],
    );
    if (!validation.valid) {
      const errors = XcubeRuntime.itemErrors(validation, published.items);
      return check
        ? { ...base, errors, cubeMessage: validation.cubeMessage }
        : { status: 'invalid', errors, cubeMessage: validation.cubeMessage };
    }
    if (check) {
      return { ...base, valid: true, probes: validation.probes };
    }

    const result = await this.requireStore().importItems({
      model,
      baseRevision: request.baseRevision,
      items: published.items,
      itemsHash: hash!,
      source: request.source,
      folders,
    });
    if ('current' in result) {
      return { status: result.outcome, current: result.current };
    }
    this.announced(model, result.outcome);
    return { status: result.outcome, head: result.head, items: XcubeRuntime.refs(published.items, changed) };
  }

  /** The current revision's items: full names, and what each short name they use is bound to. */
  public async itemsOf(model: string) {
    const head = await this.requireStore().head(model);
    if (!head) {
      return null;
    }
    const items = await this.itemsAt(head);
    return {
      model,
      revision: head.revision,
      mode: head.mode ?? 'files',
      items: items.map(({ folderId, name, kind, fullName, bindings }) => ({ folderId, name, kind, fullName, bindings })),
    };
  }

  /** What short names mean from a folder, nearest-first, in the current revision. */
  public async resolveNames(model: string, folderId: string, names: string[]) {
    const store = this.requireStore();
    const head = await store.head(model);
    const items = head ? await this.itemsAt(head) : [];
    const tree = new FolderTree(await store.folders(model));
    if (!tree.has(folderId)) {
      throw new FolderTreeError([`Folder ${folderId} is not in the folder tree`]);
    }
    const byKey = new Map(items.map((item) => [`${item.folderId}/${item.name}`, item.fullName]));
    const chain = tree.chain(folderId);
    const resolved: Record<string, string | null> = {};
    for (const name of names) {
      const folder = chain.find((f) => byKey.has(`${f}/${name}`));
      resolved[name] = folder ? byKey.get(`${folder}/${name}`)! : null;
    }
    return { model, revision: head?.revision ?? null, folderId, names: resolved };
  }
}
