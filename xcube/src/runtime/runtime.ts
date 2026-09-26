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
import { compileErrors } from '../model/errors';
import {
  FolderTree,
  fullNameOf,
  ROOT,
  type AuthoredItem,
  type Folder,
  type ItemError,
  type PublishedItem,
} from '../names/items';
import { filesOf, itemsHash, publish } from '../names/publish';
import { rollupsToStrip, withoutRollups } from '../overlays/rollups';
import { createListenClient, createPool, type Logger } from '../store/db';
import { migrate } from '../store/migrate';
import {
  channelOf,
  folderTreeHash,
  PgRevisionStore,
  type ModelHead,
  type ModelMode,
  type ModelStatus,
  type RevisionStore,
  type StoredModule,
  type StoredOverlay,
} from '../store/revisions';
import { COMMONS, groupModules } from '../modules/graph';
import { admits, type Permissions } from '../security/gate';
import { withGate } from '../security/marker';
import { KeyError, keySetOf, TokenError, tokenParts } from '../security/tokens';
import { ROLE_KEY, TokenVerifier } from '../security/verifier';
import { CompileLane, LaneBusyError, Priority } from './lane';
import { RevisionListener, type ListenClient, type Notice } from './listener';
import {
  DEFAULT_OVERLAYS,
  DEFAULT_TOKENS,
  type OverlaySettings,
  type TokenSettings,
  type XcubeSettings,
} from './settings';

/** What `config()` settles, with its defaults applied. */
export interface ServingOptions {
  /** The security-context claim naming the model a request reads. */
  modelClaim: string;
  /** The claim naming the oldest revision a request may be answered from. */
  revisionClaim: string;
  /** A context naming no model is served Cube's own data model directory (`disk`), or refused. */
  withoutModel: 'disk' | 'refuse';
  /** The claim naming the overlay a request previews. */
  overlayClaim?: string;
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

/** One compiled model: a module of a revision, or a revision served whole. */
export interface Resident {
  kind: 'revision';
  appId: string;
  model: string;
  generation: string;
  /** The revision it was first built for; an unchanged module is shared with later ones. */
  revision: number;
  moduleId: string;
  files: SnapshotFile[];
  compiled: boolean;
  /** For unions and the whole model: when a request last used it, for idle retirement. */
  lastUsed?: number;
}

/** A module of a revision, as stored. */
export type ModuleData = StoredModule;

/** A revision's files, and the modules it compiles in (none: served whole). */
export interface RevisionData {
  files: SnapshotFile[];
  modules: ModuleData[];
}

/**
 * A revision as this process serves it: one compiled model per module, and
 * where each cube and view is. A revision without modules is one module,
 * `all`, that every context is served.
 */
/** Where each cube and view is, by module: what choosing a query's module needs. */
export interface ModuleIndex {
  single: boolean;
  holders: Map<string, Set<string>>;
  owner: Map<string, string>;
  modules: Map<string, { files: SnapshotFile[] }>;
}

export interface ServedRevision {
  /** `appIdOf(head)`: what requests are pinned to. */
  key: string;
  model: string;
  generation: string;
  revision: number;
  contentHash: string;
  data: RevisionData;
  modules: Map<string, Resident>;
  /** Cube or view → the modules holding it (owned or copied). */
  holders: Map<string, Set<string>>;
  /** Cube or view → the module owning it. */
  owner: Map<string, string>;
  single: boolean;
  /** The whole model, compiled only for a context no module or union serves. */
  whole?: Resident;
  /** Unions of modules, compiled on first use for a query spanning them. */
  unions: Map<string, Resident>;
  state: 'activating' | 'active' | 'retiring';
  retireAfter?: number;
  /** Scheduled refresh runs using it; it is never retired while any do. */
  holds: number;
  mode?: ModelMode;
  /** An overlay applied to a published revision (`base`, its key): what previews of it are served. */
  overlay?: { id: string; version: number; base: string };
  /** For an overlay: when a request last used it, for idle retirement. */
  lastUsed?: number;
  /** For an overlay: its items as applied, to place compile errors on. */
  items?: PublishedItem[];
}

/** An overlay id: what the client names a workspace or a proposal by. */
export const OVERLAY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What pushing an overlay came to. */
export type OverlayOutcome =
  | { status: 'unknown' | 'mode' | 'too_many' }
  | { status: 'conflict'; current: number | null }
  | { status: 'invalid'; errors: ItemError[]; cubeMessage: string | null }
  | { status: 'created' | 'updated' | 'unchanged'; overlay: StoredOverlay; revision: number; items: ItemRef[] };

function gone(model: string, id: string): CubejsHandlerError {
  return new CubejsHandlerError(410, 'Gone', `Overlay "${id}" of model "${model}" is gone: it expired, or was dropped`);
}

function brokenOverlay(id: string, errors: ItemError[]): CubejsHandlerError {
  const first = errors.slice(0, 3).map((e) => `${e.folderId ?? '?'}/${e.name ?? '?'}: ${e.message}`).join('; ');
  return new CubejsHandlerError(409, 'Conflict', `Overlay "${id}" doesn't apply to what is published now: ${first}`);
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
  active?: ServedRevision;
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

/** The context key naming the module a request is served from. */
export const MODULE_KEY = 'xcubeModule';

/** A module key naming a union of modules: `u:<id>+<id>…`. */
export const UNION_PREFIX = 'u:';

/** The most unions one revision keeps compiled; the least recently used goes first. */
export const MAX_UNIONS = 16;

/** The cubes and views a Cube REST query names: the first segment of each member. */
export function cubesOfQuery(query: unknown): Set<string> {
  const cubes = new Set<string>();
  const member = (m: unknown) => {
    if (typeof m === 'string') {
      cubes.add(m.split('.')[0]);
    } else if (m && typeof m === 'object' && typeof (m as any).cubeName === 'string') {
      cubes.add((m as any).cubeName);
    }
  };
  const filter = (f: any) => {
    if (!f || typeof f !== 'object') {
      return;
    }
    member(f.member ?? f.dimension);
    (f.and ?? []).forEach(filter);
    (f.or ?? []).forEach(filter);
  };
  const one = (q: any) => {
    if (!q || typeof q !== 'object') {
      return;
    }
    (Array.isArray(q.measures) ? q.measures : []).forEach(member);
    (Array.isArray(q.dimensions) ? q.dimensions : []).forEach(member);
    (Array.isArray(q.segments) ? q.segments : []).forEach(member);
    (Array.isArray(q.timeDimensions) ? q.timeDimensions : []).forEach((t: any) => member(t?.dimension));
    (Array.isArray(q.filters) ? q.filters : []).forEach(filter);
    (Array.isArray(q.joinHints) ? q.joinHints : []).forEach((hint: unknown) => {
      (Array.isArray(hint) ? hint : [hint]).forEach((c) => typeof c === 'string' && cubes.add(c));
    });
    if (Array.isArray(q.order)) {
      q.order.forEach((o: any) => member(Array.isArray(o) ? o[0] : o?.id));
    } else if (q.order && typeof q.order === 'object') {
      Object.keys(q.order).forEach(member);
    }
  };
  (Array.isArray(query) ? query : [query]).forEach(one);
  return cubes;
}

/** A request's query, wherever Cube's routes carry it. */
function queryOf(req: any): unknown {
  const raw = req?.query?.query ?? req?.body?.query ?? req?.params?.query;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return raw;
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

/** A pushed key set that can't be taken. */
export class KeySetError extends Error {
  public constructor(message: string, public readonly code: 'invalid_keys' | 'service_kid') {
    super(message);
  }
}

/** Most keys one model's set may hold: the current key, the next, and a few being retired. */
export const MAX_MODEL_KEYS = 10;

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

  /** Compiled models by app id, shared by the revisions that use them. */
  protected readonly residents = new Map<string, Resident>();

  /** Revisions being activated, active, or replaced but in their grace period. */
  protected readonly served = new Map<string, ServedRevision>();

  protected readonly candidates = new Map<string, Candidate>();

  /** What revisions a core served before it was replaced, for the next core. */
  protected readonly detached = new Map<string, RevisionData>();

  /** Models the database was found not to have, until when. */
  protected readonly absent = new Map<string, number>();

  /** One resolution per context object, so every hook Cube calls for it agrees. */
  protected readonly resolutions = new WeakMap<object, Served>();

  protected readonly lane: CompileLane;

  /** Each model's permissions, as last read: what the folder gate admits. */
  protected readonly permissions = new Map<string, Permissions>();

  protected readonly permissionLoads = new Map<string, Promise<void>>();

  /** Models whose permissions changed again while being read. */
  protected readonly permissionsDirty = new Set<string>();

  protected readonly keyLoads = new Map<string, Promise<void>>();

  protected readonly keysDirty = new Set<string>();

  /** A re-read of every model's keys, for a token naming a kid not known here. */
  protected keysReread: Promise<void> | null = null;

  protected keysRereadAt = 0;

  /** Files as Cube compiles them (with the folder gate's policy), per resident's files. */
  protected readonly gatedFiles = new WeakMap<SnapshotFile[], SnapshotFile[]>();

  public readonly tokens: TokenSettings;

  public readonly verifier: TokenVerifier;

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
    this.tokens = settings.tokens ?? DEFAULT_TOKENS;
    this.verifier = new TokenVerifier(this.tokens, {
      modelClaim: () => this.options?.modelClaim ?? 'xcubeModel',
      revisionClaim: () => this.options?.revisionClaim ?? 'xcubeRevision',
      overlayClaim: () => this.options?.overlayClaim ?? 'xcubeOverlay',
      missingKid: () => this.rereadKeys(),
    });
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
    // Before anything else: keys that don't parse stop the process.
    try {
      this.verifier.loadServiceKeys();
    } catch (e: any) {
      throw new Error(`xcube: the service credential's keys (XCUBE_SERVICE_KEYS${this.tokens.serviceKeysFile ? '_FILE' : ''}) can't be read: ${e.message}`);
    }

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
        onNotify: (model, notice) => this.notified(model, notice),
        onConnect: () => {
          // Anything announced while the listener was down was missed.
          this.overlayRecords.clear();
          this.syncAllQuietly();
        },
        onDown: () => this.schedulePoll(),
        logger: (m, p) => this.log(m, p),
      });
      this.listener.start();
    }

    await this.readHeads();
    await this.refreshSecurity();
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
    this.detached.clear();
    this.readyResolve();
  }

  /** The core is shutting down (SIGUSR1 builds another); what it compiled goes with it. */
  public detach(core: ServingCore) {
    if (this.core !== core) {
      return;
    }
    this.core = null;
    for (const revision of this.served.values()) {
      this.detached.set(revision.key, revision.data);
    }
    this.served.clear();
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
      // Compiling a module: that module, or nothing.
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
    const revision = this.revisionFor(context, model);
    if (!revision) {
      throw this.notServable(model);
    }
    return this.moduleOf(revision, context);
  }

  /** The revision a context is served: the one it was pinned to while it is kept, else the active one. */
  protected revisionFor(context: any, model: string): ServedRevision | undefined {
    const pin: Pin | undefined = context?.xcubePin;
    if (pin && pin.model === model) {
      const pinned = this.served.get(pin.appId);
      if (pinned && pinned.model === model && pinned.state !== 'activating') {
        return pinned;
      }
      if (pin.appId.startsWith(`xcube:${model}:o:`)) {
        // Never the published model in an overlay's place.
        throw unavailable('The overlay this request was pinned to is no longer compiled here; try again');
      }
      this.warn('xcube: pinned revision retired; answering from the active one', { model, appId: pin.appId });
    }
    return this.models.get(model)?.active;
  }

  /** The module a context names (extendContext's choice, or the jobs' claim), else the whole model. */
  protected moduleOf(revision: ServedRevision, context: any): Resident {
    if (revision.single) {
      return revision.modules.values().next().value!;
    }
    const id = context?.[MODULE_KEY] ?? context?.securityContext?.[MODULE_KEY] ?? context?.authInfo?.[MODULE_KEY];
    if (typeof id === 'string' && id.startsWith(UNION_PREFIX)) {
      const union = this.unionOf(revision, id.slice(UNION_PREFIX.length).split('+'));
      if (union) {
        union.lastUsed = Date.now();
        return union;
      }
    }
    const module = typeof id === 'string' ? revision.modules.get(id) : undefined;
    if (module) {
      return module;
    }
    const whole = this.wholeOf(revision);
    whole.lastUsed = Date.now();
    return whole;
  }

  /**
   * The modules of a query spanning several, as one model: their files
   * together (shared cubes once), compiled on first use and kept with the
   * revision. Two facts joined through a shared cube are answered this way.
   */
  protected unionOf(revision: ServedRevision, ids: string[]): Resident | undefined {
    const parts = ids.map((id) => revision.modules.get(id));
    if (parts.some((p) => !p) || parts.length < 2) {
      return undefined;
    }
    const key = [...ids].sort().join('+');
    let union = revision.unions.get(key);
    if (!union) {
      const files = new Map<string, SnapshotFile>();
      parts.forEach((p) => p!.files.forEach((f) => files.set(f.path, f)));
      const appId = `xcube:${revision.model}:u:${contentHash([...files.values()]).slice(0, 12)}`;
      union = this.residents.get(appId) ?? {
        kind: 'revision',
        appId,
        model: revision.model,
        generation: revision.generation,
        revision: revision.revision,
        moduleId: `${UNION_PREFIX}${key}`,
        files: [...files.values()],
        compiled: false,
      };
      this.residents.set(appId, union);
      revision.unions.set(key, union);
      if (revision.unions.size > MAX_UNIONS) {
        const [oldest] = [...revision.unions].sort(([, a], [, b]) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0))[0];
        revision.unions.delete(oldest);
        this.retireUnused();
      }
      this.log('xcube: compiling a union of modules for a query spanning them', {
        model: revision.model, revision: revision.revision, modules: ids,
      });
    }
    return union;
  }

  /** The whole revision as one model, compiled on first use: for contexts no module serves (the SQL API, GraphQL). */
  protected wholeOf(revision: ServedRevision): Resident {
    if (!revision.whole) {
      const appId = `xcube:${revision.model}:all:${revision.contentHash.slice(0, 12)}`;
      const whole = this.residents.get(appId) ?? {
        kind: 'revision' as const,
        appId,
        model: revision.model,
        generation: revision.generation,
        revision: revision.revision,
        moduleId: 'all',
        files: revision.data.files,
        compiled: false,
      };
      this.residents.set(appId, whole);
      revision.whole = whole;
      this.warn('xcube: a request names no module; compiling the whole model for it', {
        model: revision.model, revision: revision.revision,
      });
    }
    return revision.whole;
  }

  /**
   * The modules to merge `/v1/meta` from: those of the revision a context is
   * served, when it has several and the context chose none.
   */
  public metaModules(context: any): string[] | null {
    if (!this.serving || context?.xcubeCandidate !== undefined || context?.xcubeActivate !== undefined) {
      return null;
    }
    let model: string | undefined;
    try {
      model = this.modelOf(context?.securityContext ?? context?.authInfo);
    } catch {
      return null;
    }
    const revision = model === undefined ? undefined : this.revisionFor(context, model);
    if (!revision || revision.single || context?.[MODULE_KEY] !== undefined
      || context?.securityContext?.[MODULE_KEY] !== undefined) {
      return null;
    }
    return [...revision.modules.keys()].sort();
  }

  /**
   * The modules a jobs context builds in: those owning the pre-aggregations
   * or cubes the selector names, or all of them. `null` when the model isn't
   * served in modules, or the context already names one.
   */
  public jobModules(securityContext: any, selector: { preAggregations?: string[]; cubes?: string[] }): string[] | null {
    if (!this.serving) {
      return null;
    }
    let model: string | undefined;
    try {
      model = this.modelOf(securityContext);
    } catch {
      return null;
    }
    const revision = model === undefined ? undefined : this.models.get(model)?.active;
    if (!revision || revision.single || typeof securityContext?.[MODULE_KEY] === 'string') {
      return null;
    }
    const cubes = [
      ...(Array.isArray(selector.preAggregations) ? selector.preAggregations : []).map((id) => String(id).split('.')[0]),
      ...(Array.isArray(selector.cubes) ? selector.cubes : []).map(String),
    ];
    const owners = [...new Set(cubes.map((c) => revision.owner.get(c)).filter((m): m is string => Boolean(m)))];
    return owners.length ? owners.sort() : [...revision.modules.keys()].sort();
  }

  /** The module of a model's active revision that owns a cube. */
  public moduleOfCube(model: string, cube: string): string | undefined {
    return this.models.get(model)?.active?.owner.get(cube);
  }

  /**
   * The module holding every cube a query names: its first cube's owner when
   * that holds them all, else commons, else the smallest that does. None
   * when no module holds them all (a blending query): the whole model.
   */
  public moduleForQuery(revision: ModuleIndex, query: unknown): string | undefined {
    const cubes = [...cubesOfQuery(query)];
    if (!cubes.length || revision.single) {
      return undefined;
    }
    let candidates: Set<string> | undefined;
    for (const cube of cubes) {
      const holders = revision.holders.get(cube);
      if (!holders) {
        // A name no module has: Cube answers it, from the first cube's module.
        return revision.owner.get(cubes[0]);
      }
      candidates = candidates ? new Set([...candidates].filter((m) => holders.has(m))) : new Set(holders);
    }
    if (!candidates?.size) {
      // No one module holds them all: the union of the modules owning them,
      // when they share a cube (two facts joined through it). Modules sharing
      // nothing can't be joined: the first cube's module, for Cube to say so.
      const owners = [...new Set(cubes.map((c) => revision.owner.get(c) ?? [...revision.holders.get(c)!][0]))].sort();
      const joinable = [...revision.holders.values()].some((holders) => owners.every((o) => holders.has(o)));
      return owners.length > 1 && joinable ? `${UNION_PREFIX}${owners.join('+')}` : revision.owner.get(cubes[0]);
    }
    const first = revision.owner.get(cubes[0]);
    if (first && candidates.has(first)) {
      return first;
    }
    if (candidates.has(COMMONS)) {
      return COMMONS;
    }
    return [...candidates].sort((a, b) => revision.modules.get(a)!.files.length - revision.modules.get(b)!.files.length
      || (a < b ? -1 : 1))[0];
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

  /**
   * The files Cube compiles for a context, bound to one immutable revision:
   * each published cube and view with the folder gate's policy added.
   */
  public filesOf(served: Resident | Candidate): SnapshotFile[] {
    let gated = this.gatedFiles.get(served.files);
    if (!gated) {
      gated = served.files.map(withGate);
      this.gatedFiles.set(served.files, gated);
    }
    return gated;
  }

  // ---------------------------------------------------------- permissions

  /** A model's permissions as this instance knows them; `undefined` until first read. */
  public permissionsOf(model: string): Permissions | undefined {
    return this.permissions.get(model);
  }

  /** The permissions the compiled model of `context` is gated by, read afresh on each call. */
  public permissionsSourceFor(context: any): () => Permissions | undefined {
    let model: string | undefined;
    try {
      const served = this.resolve(context);
      model = served.kind === 'disk' ? undefined : served.model;
    } catch {
      model = undefined;
    }
    return () => (model === undefined ? undefined : this.permissions.get(model));
  }

  /** Whether a context holding `groups` may read what `folderId` holds in `model`. */
  public admits(model: string, folderId: string, groups: Set<string>): boolean {
    return admits(this.permissions.get(model), folderId, groups);
  }

  /** Reads a model's permissions; one read at a time, again if they changed meanwhile. */
  public loadPermissions(model: string): Promise<void> {
    const running = this.permissionLoads.get(model);
    if (running) {
      this.permissionsDirty.add(model);
      return running;
    }
    const run = (async () => {
      do {
        this.permissionsDirty.delete(model);
        const stored = await this.requireStore().permissions(model);
        const known = this.permissions.get(model);
        if (!stored) {
          if (!known && this.permissions.size < this.settings.maxModels) {
            // No such model yet: nothing is secured in it.
            this.permissions.set(model, { version: 0, security: false, allowed: new Map() });
          }
        } else {
          // Reads are one at a time, so the last is the newest (even when the
          // version went back, the schema restored from a backup).
          this.permissions.set(model, {
            version: stored.version,
            security: stored.security,
            allowed: new Map(stored.folders.map((f) => [f.id, new Set(f.allowedGroups)])),
          });
          if (known && stored.version !== known.version) {
            this.log('xcube: permissions changed', { model, version: stored.version, security: stored.security });
          }
        }
      } while (this.permissionsDirty.has(model));
    })().finally(() => this.permissionLoads.delete(model));
    this.permissionLoads.set(model, run);
    return run;
  }

  /** Reads a model's pushed keys; one read at a time, again if they changed meanwhile. */
  public loadKeys(model: string): Promise<void> {
    const running = this.keyLoads.get(model);
    if (running) {
      this.keysDirty.add(model);
      return running;
    }
    const run = (async () => {
      do {
        this.keysDirty.delete(model);
        const stored = await this.requireStore().keys(model);
        const known = this.verifier.keysVersion(model);
        // The last read is the newest, as for permissions.
        const skipped = this.verifier.setModelKeys(model, stored);
        if (skipped.length) {
          this.warn('xcube: stored keys that do not parse were skipped', { model, kids: skipped });
        }
        if (stored && stored.version !== known) {
          this.log('xcube: keys changed', { model, version: stored.version, keys: stored.keys.length });
        }
      } while (this.keysDirty.has(model));
    })().finally(() => this.keyLoads.delete(model));
    this.keyLoads.set(model, run);
    return run;
  }

  /**
   * Re-reads what changed of every model's permissions and keys: after a
   * reconnect, on the poll, and at start. The service credential's key file
   * too, when it has one.
   */
  public async refreshSecurity(): Promise<void> {
    if (this.tokens.serviceKeysFile) {
      try {
        if (this.verifier.loadServiceKeys()) {
          this.log('xcube: the service credential\'s keys changed', {});
        }
      } catch (e: any) {
        this.warn('xcube: the service credential\'s key file can\'t be read; keeping the keys it had', { error: e.message });
      }
    }
    const versions = await this.requireStore().versions();
    await Promise.all(versions.map(async ({ model, permissions, keys }) => {
      if (!MODEL_ID.test(model)) {
        return;
      }
      const known = this.permissions.get(model);
      if (!known || known.version !== permissions) {
        await this.loadPermissions(model);
      }
      if (keys !== this.verifier.keysVersion(model)) {
        await this.loadKeys(model);
      }
    }));
  }

  /** For a token naming a kid no key has: every model's keys again, at most once a second. */
  protected rereadKeys(): Promise<void> {
    if (this.keysReread) {
      return this.keysReread;
    }
    if (Date.now() - this.keysRereadAt < 1000 || !this.store) {
      return Promise.resolve();
    }
    this.keysRereadAt = Date.now();
    this.keysReread = (async () => {
      try {
        const versions = await this.requireStore().versions();
        await Promise.all(versions
          .filter(({ model, keys }) => MODEL_ID.test(model) && keys !== this.verifier.keysVersion(model))
          .map(({ model }) => this.loadKeys(model)));
      } catch (e: any) {
        this.warn('xcube: could not read keys', { error: e.message });
      }
    })().finally(() => {
      this.keysReread = null;
    });
    return this.keysReread;
  }

  // ---------------------------------------------------------------- tokens

  /**
   * Cube's `checkAuth`, as xcube runs it: an RS256 token is verified against
   * the keys pushed for its model (a user's) or configured for the service
   * credential; any other goes to Cube's own check (`cubes`), and is taken
   * only for a model without keys, while `XCUBE_HS256` allows it.
   */
  public async checkAuth(
    req: any,
    authorization: string | undefined,
    cubes: (req: any, authorization?: string) => Promise<unknown>,
  ): Promise<void> {
    if (!authorization) {
      throw new CubejsHandlerError(403, 'Forbidden', 'Authorization header isn\'t set');
    }
    let alg: unknown;
    try {
      ({ alg } = tokenParts(authorization).header);
    } catch {
      alg = undefined;
    }
    let securityContext: Record<string, unknown>;
    if (alg === 'RS256') {
      try {
        ({ securityContext } = await this.verifier.verify(authorization));
      } catch (e: any) {
        if (e instanceof TokenError || e instanceof KeyError) {
          throw new CubejsHandlerError(403, 'Forbidden', `Invalid token: ${e.message}`);
        }
        throw e;
      }
    } else {
      await cubes(req, authorization);
      securityContext = this.unverified(req.securityContext);
    }
    req.securityContext = securityContext;
    req.authInfo = securityContext;
  }

  /**
   * A security context xcube's verifier didn't build (Cube's own check, the
   * SQL API's `checkSqlAuth`): without a role, and refused for a model that
   * takes RS256 tokens only.
   */
  public unverified(context: Record<string, unknown> | undefined): Record<string, unknown> {
    if (this.tokens.hs256 === 'off') {
      throw new CubejsHandlerError(403, 'Forbidden', 'Invalid token: only RS256 tokens are taken');
    }
    // Only xcube sets a role, and names the module a context is served from.
    const { [ROLE_KEY]: _role, [MODULE_KEY]: _module, ...rest } = context ?? {};
    const model = this.modelOf(rest);
    if (model !== undefined ? this.verifier.hasKeys(model) : this.verifier.anyKeys()) {
      throw new CubejsHandlerError(403, 'Forbidden', model !== undefined
        ? `Invalid token: model "${model}" takes RS256 tokens only`
        : 'Invalid token: only RS256 tokens are taken');
    }
    return rest;
  }

  /** Whether a context reads a model with security on. */
  public secured(securityContext: any): boolean {
    try {
      const model = this.modelOf(securityContext);
      return model !== undefined && this.permissions.get(model)?.security === true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------- overlays

  public get overlaySettings(): OverlaySettings {
    return this.settings.overlays ?? DEFAULT_OVERLAYS;
  }

  /** The overlay a security context previews: `undefined` when it names none. */
  public overlayOf(securityContext: any): string | undefined {
    const id = securityContext?.[this.servingOptions.overlayClaim ?? 'xcubeOverlay'];
    if (id === undefined || id === null) {
      return undefined;
    }
    if (typeof id !== 'string' || !OVERLAY_ID.test(id)) {
      throw forbidden('Invalid overlay id in the security context');
    }
    return id;
  }

  protected readonly overlayRecords = new Map<string, { record: StoredOverlay | null; readAt: number }>();

  protected readonly overlayReads = new Map<string, Promise<StoredOverlay | null>>();

  /** Bumped whenever an overlay changes or goes, so a read begun before is read again. */
  protected readonly overlayGenerations = new Map<string, number>();

  protected readonly overlayBuilds = new Map<string, Promise<ServedRevision>>();

  /**
   * Overlays that don't apply to a published revision, by the key they would
   * be served under: what the overlay's items make of it, never a passing
   * failure.
   */
  protected readonly brokenOverlays = new Map<string, { id: string; errors: ItemError[]; cubeMessage: string | null; at: number }>();

  /**
   * An overlay as last read: again after 30 s (2 s when there was none), and
   * at once when a notification says it changed.
   */
  protected async overlayRecord(model: string, id: string): Promise<StoredOverlay | null> {
    const key = `${model}/${id}`;
    const cached = this.overlayRecords.get(key);
    if (cached && Date.now() - cached.readAt < (cached.record ? 30000 : 2000)) {
      return cached.record && cached.record.expiresAt.getTime() > Date.now() ? cached.record : null;
    }
    let read = this.overlayReads.get(key);
    if (!read) {
      read = (async () => {
        for (;;) {
          const generation = this.overlayGenerations.get(key) ?? 0;
          const record = await this.requireStore().overlay(model, id);
          // Changed while it was read: what was read may be what changed.
          if ((this.overlayGenerations.get(key) ?? 0) === generation) {
            this.overlayRecords.set(key, { record, readAt: Date.now() });
            while (this.overlayRecords.size > 10000) {
              this.overlayRecords.delete(this.overlayRecords.keys().next().value!);
            }
            return record;
          }
        }
      })().finally(() => this.overlayReads.delete(key));
      this.overlayReads.set(key, read);
    }
    return read;
  }

  /**
   * An overlay changed (to `version`) or went: read it again, and let what
   * was compiled for another version of it go once in-flight requests end.
   */
  protected overlayChanged(model: string, id: string, version?: number) {
    const key = `${model}/${id}`;
    this.overlayGenerations.set(key, (this.overlayGenerations.get(key) ?? 0) + 1);
    this.overlayRecords.delete(key);
    for (const [served, broken] of [...this.brokenOverlays]) {
      if (broken.id === id && served.startsWith(`xcube:${model}:o:`)) {
        this.brokenOverlays.delete(served);
      }
    }
    for (const revision of this.served.values()) {
      if (revision.model === model && revision.overlay?.id === id && revision.overlay.version !== version
        && revision.state !== 'retiring') {
        revision.state = 'retiring';
        revision.retireAfter = Date.now() + this.settings.retireGraceMs;
      }
    }
  }

  /** The key an overlay is served under: its version, over a published revision, with the folder tree it resolved in. */
  protected overlayKey(base: ServedRevision, id: string, version: number): string {
    return `xcube:${base.model}:o:${id}:${version}:t${this.permissions.get(base.model)?.version ?? 0}@${base.key}`;
  }

  /**
   * An overlay applied to a published revision, as previews of it are
   * served: built on first use and kept while used. Only the modules the
   * overlay changes are compiled; the rest are the published ones.
   */
  protected async overlayRevision(base: ServedRevision, id: string): Promise<ServedRevision> {
    const record = await this.overlayRecord(base.model, id);
    if (!record) {
      throw gone(base.model, id);
    }
    const key = this.overlayKey(base, id, record.version);
    const known = this.served.get(key);
    if (known && known.state !== 'activating') {
      // Idle, or pushed again unchanged: the same version on the same revision, used again.
      known.state = 'active';
      known.retireAfter = undefined;
      known.lastUsed = Date.now();
      return known;
    }
    const broken = this.brokenOverlays.get(key);
    if (broken) {
      throw brokenOverlay(id, broken.errors);
    }
    // One build per key: requests arriving meanwhile wait for it.
    let build = this.overlayBuilds.get(key);
    if (!build) {
      build = this.buildOverlay(base, record, key).finally(() => this.overlayBuilds.delete(key));
      this.overlayBuilds.set(key, build);
    }
    return build;
  }

  protected async buildOverlay(base: ServedRevision, record: StoredOverlay, key: string): Promise<ServedRevision> {
    if (base.mode !== 'items') {
      throw new CubejsHandlerError(409, 'Conflict', `Model "${base.model}" holds a file set; overlays need items`);
    }
    let served = this.served.get(key);
    if (!served) {
      const head: ModelHead = {
        model: base.model, generation: base.generation, revision: base.revision, contentHash: base.contentHash, mode: 'items',
      };
      const tree = new FolderTree(await this.requireStore().folders(base.model));
      const applied = this.applyOverlay(tree, await this.itemsAt(head), record, base.data.modules);
      if ('errors' in applied) {
        this.brokenOverlays.set(key, { id: record.id, errors: applied.errors, cubeMessage: null, at: Date.now() });
        throw brokenOverlay(record.id, applied.errors);
      }
      this.makeRoomForOverlay();
      served = this.servedRevision(
        { ...head, contentHash: contentHash(applied.files) },
        { files: applied.files, modules: applied.modules },
        { key, id: record.id, version: record.version, base: base.key },
      );
      served.items = applied.items;
    }
    served.lastUsed = Date.now();
    try {
      for (const resident of served.modules.values()) {
        await this.ensureCompiled(resident);
      }
    } catch (e: any) {
      if (e instanceof LaneBusyError) {
        // What compiled stays: the next request carries on from there.
        throw e;
      }
      const message = String(e?.message ?? e);
      const placed = compileErrors(message, new Set(served.data.files.map((f) => f.path)));
      const items = served.items ?? [];
      this.served.delete(key);
      this.retireUnused();
      if (!placed.length) {
        // Not Cube refusing what the overlay makes of the model: nothing to remember.
        throw e;
      }
      const errors = XcubeRuntime.itemErrors({ valid: false, errors: placed, cubeMessage: message, probes: [] }, items);
      this.brokenOverlays.set(key, { id: record.id, errors, cubeMessage: message, at: Date.now() });
      throw brokenOverlay(record.id, errors);
    }
    if (served.state === 'activating') {
      // Unless it changed or went meanwhile: then it only answers those that waited for it.
      served.state = 'active';
    }
    served.lastUsed = Date.now();
    this.log('xcube: serving an overlay', {
      model: base.model,
      overlay: record.id,
      version: record.version,
      revision: base.revision,
      modules: served.modules.size,
      changedModules: [...served.modules.values()].filter((r) => base.modules.get(r.moduleId) !== r).length,
    });
    return served;
  }

  /** At most `XCUBE_MAX_ACTIVE_OVERLAYS` overlays stay compiled here: the least recently used makes room. */
  protected makeRoomForOverlay() {
    const kept = [...this.served.values()]
      .filter((r) => r.overlay && r.state === 'active')
      .sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0));
    for (const revision of kept.slice(0, Math.max(0, kept.length - this.overlaySettings.maxActive + 1))) {
      revision.state = 'retiring';
      revision.retireAfter = Date.now() + this.settings.retireGraceMs;
    }
  }

  /**
   * An overlay's items over published ones, as Cube compiles them: names
   * resolved in the overlay first, then along each item's folder path; the
   * pre-aggregations of every item its changes reach left out (and of their
   * ancestors, whose rollups they would inherit); modules kept from the
   * published revision's where unchanged.
   */
  protected applyOverlay(
    tree: FolderTree,
    current: PublishedItem[],
    overlay: { upserts: AuthoredItem[]; deletes: { folderId: string; name: string }[] },
    previous: StoredModule[],
  ): { items: PublishedItem[]; changed: string[]; files: SnapshotFile[]; modules: StoredModule[] } | { errors: ItemError[] } {
    const published = publish({
      tree, current, upserts: overlay.upserts, deletes: overlay.deletes, lenientDeletes: true, overlay: true,
    });
    if (published.errors.length) {
      return { errors: published.errors };
    }
    const byKey = new Map(published.items.map((item) => [`${item.folderId}/${item.name}`, item.fullName]));
    const changed = published.changed.map((key) => byKey.get(key)!);
    const stripped = rollupsToStrip(published.items, new Set(changed));
    const files = filesOf(published.items).map((f) => (stripped.has(f.path.slice(0, -'.yml'.length)) ? withoutRollups(f) : f));
    return {
      items: published.items,
      changed: published.changed,
      files,
      modules: this.moduleGroups(previous, tree, published.items, files),
    };
  }

  /**
   * Stores a workspace's or a proposal's items as an overlay, once they apply
   * to what is published now and every module they change compiles. A push
   * that doesn't keeps the overlay as it was. With `baseVersion`, only over
   * that version of it (`null`: only as a new one).
   */
  public async putOverlay(
    model: string,
    id: string,
    body: {
      upserts: AuthoredItem[];
      deletes: { folderId: string; name: string }[];
      ttlSeconds?: number;
      baseVersion?: number | null;
    },
  ): Promise<OverlayOutcome> {
    const store = this.requireStore();
    const head = await store.head(model);
    if (!head) {
      return { status: 'unknown' };
    }
    if (head.mode !== 'items') {
      return { status: 'mode' };
    }
    const settings = this.overlaySettings;
    const known = await store.overlay(model, id);
    if (body.baseVersion !== undefined && (known?.version ?? null) !== body.baseVersion) {
      return { status: 'conflict', current: known?.version ?? null };
    }
    if (!known && await store.overlayCount(model) >= settings.max) {
      return { status: 'too_many' };
    }
    const expiresAt = new Date(Date.now() + 1000 * Math.min(body.ttlSeconds ?? settings.ttlS, settings.maxTtlS));
    const hash = crypto.createHash('sha256')
      .update(JSON.stringify([itemsHash(body.upserts), [...body.deletes].map((d) => `${d.folderId}/${d.name}`).sort()]), 'utf8')
      .digest('hex');
    const folders = await store.folders(model);
    const treeHash = folderTreeHash(folders);
    const tree = new FolderTree(folders);
    const current = await this.itemsAt(head);
    const applied = this.applyOverlay(tree, current, body, await store.modules(model, head.revision));
    if ('errors' in applied) {
      return { status: 'invalid', errors: applied.errors, cubeMessage: null };
    }
    if (!(known && known.contentHash === hash && known.validatedRevision === head.revision && known.validatedTree === treeHash)) {
      const validation = await this.validateModules(
        model, head, checkedSnapshot(applied.files, this.settings.limits), applied.modules, Priority.DryRun, {}, [],
      );
      if (!validation.valid) {
        return { status: 'invalid', errors: XcubeRuntime.itemErrors(validation, applied.items), cubeMessage: validation.cubeMessage };
      }
    }
    const result = await store.putOverlay({
      model,
      id,
      upserts: body.upserts,
      deletes: body.deletes,
      contentHash: hash,
      validatedRevision: head.revision,
      validatedTree: treeHash,
      expiresAt,
    }, settings.max, body.baseVersion);
    if (result.outcome === 'too_many') {
      return { status: 'too_many' };
    }
    if (result.outcome === 'conflict') {
      return { status: 'conflict', current: result.overlay?.version ?? null };
    }
    this.overlayChanged(model, id, result.overlay!.version);
    return {
      status: result.outcome,
      overlay: result.overlay!,
      revision: head.revision,
      items: XcubeRuntime.refs(applied.items, new Set(applied.changed)),
    };
  }

  /** A stored overlay, and whether it applies to what this instance serves now. */
  public async overlayStatus(model: string, id: string) {
    const record = await this.requireStore().overlay(model, id);
    if (!record) {
      return null;
    }
    const active = this.models.get(model)?.active;
    const key = active ? this.overlayKey(active, id, record.version) : undefined;
    const broken = key ? this.brokenOverlays.get(key) : undefined;
    let instance: Record<string, unknown> = { state: 'idle' };
    if (broken) {
      instance = { state: 'broken', errors: broken.errors, cubeMessage: broken.cubeMessage };
    } else if (key && this.served.get(key)?.state === 'active') {
      instance = { state: 'serving' };
    }
    return {
      model,
      id,
      version: record.version,
      expiresAt: record.expiresAt.toISOString(),
      validatedRevision: record.validatedRevision,
      upserts: record.upserts.map(({ folderId, name, kind }) => ({ folderId, name, kind })),
      deletes: record.deletes,
      instance: { revision: active?.revision ?? null, ...instance },
    };
  }

  public async deleteOverlay(model: string, id: string): Promise<boolean> {
    const dropped = await this.requireStore().deleteOverlay(model, id);
    this.overlayChanged(model, id);
    return dropped;
  }

  /** A context for xcube's own reads of a model, pinned to its active revision. */
  public async adminContext(model: string): Promise<Record<string, any>> {
    const securityContext = { [this.servingOptions.modelClaim]: model };
    const pin = await this.pinFor({ securityContext });
    return { securityContext, requestId: `xcube-admin-${crypto.randomUUID()}`, ...pin };
  }

  /**
   * Behind `extendContext`: pins a request to the revision it is served,
   * after waiting, briefly, for this instance to reach the revision the
   * request asks for at least.
   */
  public async pinFor(req: any): Promise<{ xcubePin?: Pin; xcubeModule?: string }> {
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

    let revision: ServedRevision;
    try {
      revision = await this.servingRevision(model, this.revisionOf(securityContext));
    } catch (e: any) {
      if (e instanceof CubejsHandlerError && e.status === 503) {
        setHeader(res, 'Retry-After', '2');
      }
      throw e;
    }
    setHeader(res, 'x-xcube-revision', `${model}@${revision.revision}`);
    setHeader(res, 'x-xcube-generation', revision.generation);
    const overlayId = this.overlayOf(securityContext);
    if (overlayId !== undefined) {
      try {
        revision = await this.overlayRevision(revision, overlayId);
      } catch (e: any) {
        if (e instanceof LaneBusyError) {
          setHeader(res, 'Retry-After', String(Math.ceil(e.retryAfterMs / 1000)));
          throw unavailable('Cube is busy compiling; try again');
        }
        throw e;
      }
      setHeader(res, 'x-xcube-overlay', `${overlayId}@${revision.overlay!.version}`);
    }
    const module = this.moduleForQuery(revision, queryOf(req));
    if (!revision.single && module?.startsWith(UNION_PREFIX)) {
      // A union is compiled in the compile lane, not on the request path. (Requests without
      // a query, such as /v1/meta, are merged per module and never need the whole model.)
      const resident = this.moduleOf(revision, { [MODULE_KEY]: module });
      try {
        await this.ensureCompiled(resident);
      } catch (e: any) {
        if (e instanceof LaneBusyError) {
          setHeader(res, 'Retry-After', String(Math.ceil(e.retryAfterMs / 1000)));
          throw unavailable('Cube is busy compiling; try again');
        }
        throw e;
      }
    }
    return { xcubePin: { model, appId: revision.key }, ...(module ? { [MODULE_KEY]: module } : {}) };
  }

  protected readonly compiling = new Map<string, Promise<void>>();

  /** Compiles a resident once, in the compile lane. */
  protected async ensureCompiled(resident: Resident): Promise<void> {
    const { core } = this;
    if (resident.compiled || !core) {
      return;
    }
    let pending = this.compiling.get(resident.appId);
    if (!pending) {
      const { modelClaim } = this.servingOptions;
      const requestId = `xcube-compile-${resident.model}-${resident.moduleId}-${crypto.randomBytes(3).toString('hex')}`;
      pending = this.lane.run(Priority.Import, async () => {
        const compilerApi = await core.getCompilerApi({
          securityContext: { [modelClaim]: resident.model },
          authInfo: { [modelClaim]: resident.model },
          requestId,
          xcubeActivate: resident.appId,
        });
        await compilerApi.getCompilers({ requestId });
        resident.compiled = true;
      }).finally(() => this.compiling.delete(resident.appId));
      this.compiling.set(resident.appId, pending);
    }
    await pending;
  }

  /**
   * A `queryRewrite` in cube.js runs in the module the query was sent to: it
   * may not add cubes that module doesn't hold.
   */
  public checkRewritten(query: unknown, context: any) {
    const id = context?.[MODULE_KEY];
    if (typeof id !== 'string' || id.startsWith(UNION_PREFIX)) {
      return;
    }
    let model: string | undefined;
    try {
      model = this.modelOf(context?.securityContext ?? context?.authInfo);
    } catch {
      return;
    }
    const revision = model === undefined ? undefined : this.revisionFor(context, model);
    if (!revision || revision.single) {
      return;
    }
    const missing = [...cubesOfQuery(query)].filter((c) => !revision.holders.get(c)?.has(id));
    if (missing.length) {
      throw new CubejsHandlerError(400, 'User Error',
        `queryRewrite added ${missing.join(', ')}, which the query's own cubes don't reach; add them through access policies instead`);
    }
  }

  protected async servingRevision(model: string, atLeast?: number): Promise<ServedRevision> {
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
        && appIdOf(state.target) === active.key) {
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

  /**
   * Background contexts for the refresh scheduler, each pinned to its model's
   * active revision; one per module, which the context names, when it has
   * several.
   */
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
      const { xcubePin: _pin, xcubeCandidate: _candidate, xcubeActivate: _activate, ...context } = entry || {};
      let model: string | undefined;
      try {
        model = this.modelOf(context.securityContext ?? context.authInfo);
      } catch {
        return [];
      }
      if (model === undefined) {
        return withoutModel === 'disk' ? [context] : [];
      }
      const revision = this.models.get(model)?.active;
      if (!revision) {
        return [];
      }
      const pin = { model, appId: revision.key };
      const securityContext = context.securityContext ?? context.authInfo ?? {};
      if (revision.single || typeof securityContext[MODULE_KEY] === 'string') {
        return [{ ...context, xcubePin: pin }];
      }
      return [...revision.modules.keys()].sort().map((id) => ({
        ...context,
        securityContext: { ...securityContext, [MODULE_KEY]: id },
        xcubePin: pin,
      }));
    });
  }

  /** The module a query is served from, as a context key, when the revision has several. */
  protected moduleContext(revision: ServedRevision, query: unknown): Record<string, string> {
    const module = this.moduleForQuery(revision, query);
    return module ? { [MODULE_KEY]: module } : {};
  }

  /** The revision a background context is served, if any, without throwing. */
  public revisionOfContext(context: any): ServedRevision | undefined {
    try {
      const model = this.modelOf(context?.securityContext ?? context?.authInfo);
      return model === undefined ? undefined : this.revisionFor(context, model);
    } catch {
      return undefined;
    }
  }

  public hold(revision: ServedRevision) {
    revision.holds++;
  }

  public release(revision: ServedRevision) {
    revision.holds = Math.max(0, revision.holds - 1);
  }

  // ------------------------------------------------------------ following

  protected notified(model: string, notice: Notice = {}) {
    if (notice.overlay !== undefined) {
      if (MODEL_ID.test(model) && OVERLAY_ID.test(notice.overlay)) {
        this.overlayChanged(model, notice.overlay, notice.version);
      }
      return;
    }
    if (notice.permissions !== undefined || notice.keys !== undefined) {
      if (!MODEL_ID.test(model)) {
        this.warn('xcube: ignored a notification for an invalid model id', {});
        return;
      }
      if (notice.permissions !== undefined && notice.permissions !== this.permissions.get(model)?.version) {
        this.persistently('permissions', model, () => this.loadPermissions(model));
      }
      if (notice.keys !== undefined && notice.keys !== this.verifier.keysVersion(model)) {
        this.persistently('keys', model, () => this.loadKeys(model));
      }
      return;
    }
    if (!this.admit(model)) {
      this.warn('xcube: ignored a notification for an invalid model id', {});
      return;
    }
    this.absent.delete(model);
    this.sync(model).catch((e) => this.warn('xcube: sync failed', { model, error: e.message }));
  }

  /**
   * Runs a read a notification asked for, again after a failure (1, 2, 4, 8
   * and 16 s later): a revocation shouldn't wait for the poll.
   */
  protected persistently(what: string, model: string, read: () => Promise<void>, attempt = 0) {
    read().catch((e) => {
      this.warn(`xcube: could not read ${what}`, { model, error: e.message, attempt });
      if (attempt < 4 && !this.stopped) {
        setTimeout(() => this.persistently(what, model, read, attempt + 1), 1000 * 2 ** attempt).unref?.();
      }
    });
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
    await this.refreshSecurity().catch((e) => this.warn('xcube: could not read permissions and keys', { error: e.message }));
    const heads = await this.requireStore().heads();
    const seen = new Set<string>();
    const changed: Promise<void>[] = [];

    for (const head of heads) {
      seen.add(head.model);
      this.absent.delete(head.model);
      const state = this.admit(head.model);
      const appId = appIdOf(head);
      // Only the model's sync chain writes its target; this only asks it to run.
      if (state && (!state.active || state.active.key !== appId || !state.target || appIdOf(state.target) !== appId)) {
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
    if (!this.permissions.has(model)) {
      // Never served before its permissions are known: the gate would refuse everything.
      await this.loadPermissions(model);
    }
    if (!this.core) {
      return;
    }

    const appId = appIdOf(head);
    if (state.active?.key === appId) {
      return;
    }
    if (state.failed?.appId === appId && Date.now() < state.failed.retryAt) {
      return;
    }
    if (!await this.activateHead(head) && !state.active) {
      await this.fallBack(head, state);
    }
  }

  /** A revision's files and modules: from what this process holds, else the database. */
  protected async dataFor(head: ModelHead): Promise<RevisionData | null> {
    const key = appIdOf(head);
    const known = this.served.get(key)?.data ?? this.detached.get(key);
    if (known) {
      return known;
    }
    const store = this.requireStore();
    const files = await store.files(head.model, head.revision);
    if (!files) {
      return null;
    }
    if (contentHash(files) !== head.contentHash) {
      throw new CorruptRevisionError(`revision ${head.revision} of model "${head.model}" does not match its content hash`);
    }
    const modules = head.mode === 'items' ? await store.modules(head.model, head.revision) : [];
    return { files, modules };
  }

  /** How a revision is served: its modules' compiled models, shared with other revisions where unchanged. */
  protected servedRevision(
    head: ModelHead,
    data: RevisionData,
    overlay?: { key: string; id: string; version: number; base: string },
  ): ServedRevision {
    const key = overlay?.key ?? appIdOf(head);
    const existing = this.served.get(key);
    if (existing) {
      return existing;
    }
    const resident = (appId: string, moduleId: string, files: SnapshotFile[]): Resident => {
      const known = this.residents.get(appId);
      if (known) {
        return known;
      }
      const created: Resident = {
        kind: 'revision', appId, model: head.model, generation: head.generation, revision: head.revision, moduleId, files, compiled: false,
      };
      this.residents.set(appId, created);
      return created;
    };

    const modules = new Map<string, Resident>();
    const holders = new Map<string, Set<string>>();
    const owner = new Map<string, string>();
    if (!data.modules.length) {
      modules.set('all', resident(key, 'all', data.files));
    } else {
      const byPath = new Map(data.files.map((f) => [f.path, f]));
      for (const module of data.modules) {
        const names = [...module.members, ...module.copies];
        const files = names.map((n) => byPath.get(`${n}.yml`)).filter((f): f is SnapshotFile => Boolean(f));
        modules.set(module.id, resident(`xcube:${head.model}:m:${module.id}:${module.version.slice(0, 12)}`, module.id, files));
        names.forEach((n) => holders.set(n, (holders.get(n) ?? new Set()).add(module.id)));
        module.members.forEach((n) => owner.set(n, module.id));
      }
    }
    const revision: ServedRevision = {
      key,
      model: head.model,
      generation: head.generation,
      revision: head.revision,
      contentHash: head.contentHash,
      data,
      modules,
      holders,
      owner,
      single: modules.size === 1,
      unions: new Map(),
      state: 'activating',
      holds: 0,
      mode: head.mode,
      ...(overlay ? { overlay: { id: overlay.id, version: overlay.version, base: overlay.base }, lastUsed: Date.now() } : {}),
    };
    this.served.set(key, revision);
    return revision;
  }

  /**
   * Compiles `head` and switches its model to it; a failure keeps the
   * previous revision. A database error is thrown, for the next read to
   * retry: it says nothing about the revision.
   */
  protected async activateHead(head: ModelHead, fallback = false): Promise<boolean> {
    let data: RevisionData | null;
    try {
      data = await this.dataFor(head);
    } catch (e: any) {
      if (!(e instanceof CorruptRevisionError)) {
        throw e;
      }
      this.recordFailure(this.state(head.model), head, appIdOf(head), e);
      return false;
    }
    if (!data) {
      return false;
    }
    return this.activate(head, data, fallback);
  }

  /**
   * Compiles every module of a revision that isn't compiled yet (an
   * unchanged module already is), then switches to the revision if it is
   * still the model's current one, or, with `fallback`, if nothing serves
   * the model here. Runs only in the model's sync chain.
   */
  protected async activate(head: ModelHead, data: RevisionData, fallback = false): Promise<boolean> {
    const { core } = this;
    if (!core) {
      return false;
    }
    const { model } = head;
    const state = this.state(model);
    const key = appIdOf(head);
    if (state.active?.key === key) {
      return true;
    }

    const revision = this.servedRevision(head, data);
    const reused = revision.state === 'retiring';
    revision.retireAfter = undefined;
    const drop = () => {
      if (reused) {
        revision.retireAfter = Date.now() + this.settings.retireGraceMs;
      } else if (state.active !== revision) {
        this.served.delete(key);
        this.retireUnused();
      }
    };

    const { modelClaim } = this.servingOptions;
    const started = Date.now();
    let compiled = 0;
    try {
      const toCompile = [...revision.modules].sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, resident]) => resident).filter((resident) => !resident.compiled);
      for (const resident of toCompile) {
        const requestId = `xcube-activate-${model}-${head.revision}-${resident.moduleId}-${crypto.randomBytes(3).toString('hex')}`;
        const context = {
          securityContext: { [modelClaim]: model },
          authInfo: { [modelClaim]: model },
          requestId,
          xcubeActivate: resident.appId,
        };
        await this.lane.run(Priority.Activate, async () => {
          const compilerApi = await core.getCompilerApi(context);
          await compilerApi.getCompilers({ requestId });
        });
        resident.compiled = true;
        compiled++;
      }
    } catch (e: any) {
      drop();
      this.recordFailure(state, head, key, e);
      return false;
    }

    if (this.core !== core) {
      return false;
    }
    const current = state.target !== undefined && appIdOf(state.target) === key;
    if (!current && !(fallback && !state.active)) {
      // Superseded while it compiled: the next read switches to the newer one.
      drop();
      return false;
    }

    const previous = state.active;
    state.active = revision;
    revision.state = 'active';
    if (current || state.failed?.appId === key) {
      state.failed = undefined;
    }
    this.detached.delete(key);
    if (previous && previous !== revision) {
      previous.state = 'retiring';
      previous.retireAfter = Date.now() + this.settings.retireGraceMs;
    }
    this.log('xcube: serving revision', {
      model,
      revision: head.revision,
      previous: previous?.revision ?? null,
      modules: revision.modules.size,
      compiledModules: compiled,
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

  /** Replaced revisions leave once their grace period is over and no refresh run holds them. */
  protected retireDue() {
    const now = Date.now();
    const idle = (r?: Resident) => Boolean(r && (r.lastUsed ?? 0) + this.settings.retireGraceMs <= now);
    for (const revision of this.served.values()) {
      // An overlay no query has used for a while: compiled again when one does.
      if (revision.overlay && revision.state !== 'retiring' && !this.overlayBuilds.has(revision.key)
        && (revision.lastUsed ?? 0) + this.overlaySettings.idleMs <= now) {
        revision.state = 'retiring';
        revision.retireAfter = now;
      }
    }
    for (const [key, broken] of [...this.brokenOverlays]) {
      if (broken.at + this.overlaySettings.idleMs <= now) {
        this.brokenOverlays.delete(key);
      }
    }
    for (const revision of this.served.values()) {
      for (const [key, union] of [...revision.unions]) {
        if (idle(union)) {
          revision.unions.delete(key);
        }
      }
      if (revision.whole && idle(revision.whole)) {
        revision.whole = undefined;
      }
    }
    for (const revision of [...this.served.values()]) {
      if (revision.state === 'retiring' && (revision.retireAfter ?? Infinity) <= now && revision.holds === 0
        && this.models.get(revision.model)?.active !== revision) {
        this.served.delete(revision.key);
      }
    }
    this.retireUnused();
    for (const [model, until] of this.absent) {
      if (until <= now) {
        this.absent.delete(model);
      }
    }
    if (this.residents.size > 250) {
      this.warn('xcube: many compiled models are resident', { residents: this.residents.size });
    }
  }

  /** Compiled models no kept revision uses any more leave Cube's compiler cache. */
  protected retireUnused() {
    const { core } = this;
    const used = new Set<string>();
    for (const revision of this.served.values()) {
      revision.modules.forEach((r) => used.add(r.appId));
      revision.unions.forEach((r) => used.add(r.appId));
      if (revision.whole) {
        used.add(revision.whole.appId);
      }
    }
    for (const resident of [...this.residents.values()]) {
      if (!used.has(resident.appId)) {
        this.residents.delete(resident.appId);
        core?.retireAppId(resident.appId);
        this.log('xcube: retired compiled model', { model: resident.model, appId: resident.appId });
      }
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
      const current = state.target && appIdOf(state.target) === state.active.key;
      return { revision: state.active.revision, state: current || !state.target ? 'active' : 'activating' };
    }
    return { revision: null, state: state?.target ? 'activating' : 'none' };
  }

  public async status(model: string) {
    const store = this.requireStore();
    const status: ModelStatus | null = await store.status(model);
    if (!status) {
      return null;
    }
    const modules = status.mode === 'items' && status.current
      ? (await store.modules(model, status.current.revision)).map((m) => ({
        id: m.id, version: m.version, cubes: m.members.length, copies: m.copies.length,
      }))
      : undefined;
    return { ...status, ...(modules ? { modules } : {}), instance: this.instanceStatus(model) as InstanceModelStatus };
  }

  /**
   * Checks a snapshot by compiling it as a candidate: an app id of its own,
   * resolved by the same hooks as served revisions, so Cube compiles it
   * exactly as it would serve it. It is reachable only through the check,
   * and dropped from Cube's compiler cache when the check ends.
   */
  protected async validate(
    model: string,
    files: SnapshotFile[],
    priority: Priority,
    securityContext: Record<string, unknown>,
    probes: Probe[],
  ): Promise<ValidationResult> {
    const core = this.requireCore();
    const { modelClaim } = this.servingOptions;
    // Probes ask as the context given would, through the folder gate; only xcube's verifier sets a role.
    const { [ROLE_KEY]: _role, ...asked } = securityContext;
    const probeContext = { ...asked, [modelClaim]: model };
    if (!this.permissions.has(model)) {
      await this.loadPermissions(model);
    }

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
                      xcubePin: { model, appId: active.key },
                      ...this.moduleContext(active, probe.query),
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

  /**
   * Cube's errors, placed on the items whose resolved files they name.
   * Their lines are left out: Cube reads xcube's resolved rewrite of an item,
   * not what the author wrote. (YAML errors, with the author's lines, are
   * found before anything is resolved.)
   */
  protected static itemErrors(validation: ValidationResult, items: PublishedItem[]): ItemError[] {
    const byPath = new Map(items.map((item) => [`${item.fullName}.yml`, item]));
    return validation.errors.map(({ path, kind, message }) => {
      const item = path ? byPath.get(path) : undefined;
      return { folderId: item?.folderId ?? null, name: item?.name ?? null, kind, message };
    });
  }

  public async putFolders(model: string, folders: Folder[], security?: boolean) {
    const problems = FolderTree.check(folders);
    if (problems.length) {
      throw new FolderTreeError(problems);
    }
    const result = await this.requireStore().putFolders(model, folders, security);
    // This instance answers with them in force; the others follow the notification.
    await this.loadPermissions(model);
    return result;
  }

  /**
   * Stores a model's key set, when its version is newer than the stored
   * one's. Each key is checked: RSA of 2048 bits or more, for RS256, public
   * members only, and a kid that isn't the service credential's.
   */
  public async putKeys(model: string, set: { version: number; issuer?: string | null; keys: unknown[] }) {
    if (!set.keys.length || set.keys.length > MAX_MODEL_KEYS) {
      throw new KeySetError(`A key set holds 1 to ${MAX_MODEL_KEYS} keys`, 'invalid_keys');
    }
    let checked;
    try {
      checked = keySetOf(set.keys);
    } catch (e: any) {
      throw new KeySetError(e.message, 'invalid_keys');
    }
    const clash = checked.find(({ kid }) => this.verifier.isServiceKid(kid));
    if (clash) {
      throw new KeySetError(`Key "${clash.kid}" is the service credential's; a model's keys sign user tokens only`, 'service_kid');
    }
    const keys = checked.map(({ kid, key }) => {
      const { n, e } = key.export({ format: 'jwk' }) as { n: string; e: string };
      return { kty: 'RSA', kid, n, e, alg: 'RS256', use: 'sig' };
    });
    const result = await this.requireStore().putKeys(model, { version: set.version, issuer: set.issuer ?? null, keys });
    await this.loadKeys(model);
    return result;
  }

  public async keysOf(model: string) {
    return this.requireStore().keys(model);
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
    const modules = await this.modulesFor(head, input.tree, published.items);
    const validation = await this.validateModules(
      model,
      head,
      files,
      modules,
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
      modules,
    });
    if ('current' in result) {
      return { status: result.outcome, current: result.current };
    }
    this.announced(model, result.outcome);
    return { status: result.outcome, head: result.head, items: XcubeRuntime.refs(published.items, changed) };
  }

  /**
   * The modules items compile in: reference-closed groups (see
   * `groupModules`), keeping the previous revision's ids, each versioned by
   * the hash of its files.
   */
  protected async modulesFor(head: ModelHead | null, tree: FolderTree, items: PublishedItem[]): Promise<StoredModule[]> {
    const previous = head?.mode === 'items' ? await this.requireStore().modules(head.model, head.revision) : [];
    return this.moduleGroups(previous, tree, items, filesOf(items));
  }

  /** `modulesFor`, from the previous modules given, versioned by the files given (an overlay's differ). */
  protected moduleGroups(previous: StoredModule[], tree: FolderTree, items: PublishedItem[], files: SnapshotFile[]): StoredModule[] {
    const zoneOf = (folderId: string) => {
      const chain = tree.chain(folderId);
      return chain.length >= 2 ? chain[chain.length - 2] : ROOT;
    };
    const grouped = groupModules(items.map((item) => ({
      fullName: item.fullName,
      folderId: item.folderId,
      kind: item.kind,
      references: [...new Set(Object.values(item.bindings))].filter((n) => n !== item.fullName),
    })), zoneOf, previous, this.settings.modules);
    const byPath = new Map(files.map((f) => [f.path, f]));
    return grouped.map((m) => ({
      id: m.id,
      members: m.members,
      copies: m.copies,
      version: contentHash([...m.members, ...m.copies].map((n) => byPath.get(`${n}.yml`)!)),
    }));
  }

  /**
   * Checks the modules a publish changes, each compiled on its own as it
   * will be served; an unchanged module compiled before. Probes run in the
   * module holding their cubes.
   */
  protected async validateModules(
    model: string,
    head: ModelHead | null,
    files: SnapshotFile[],
    modules: StoredModule[],
    priority: Priority,
    securityContext: Record<string, unknown>,
    probes: Probe[],
  ): Promise<ValidationResult> {
    if (modules.length <= 1) {
      return this.validate(model, files, priority, securityContext, probes);
    }
    const byPath = new Map(files.map((f) => [f.path, f]));
    const filesOfModule = (m: StoredModule) => [...m.members, ...m.copies].map((n) => byPath.get(`${n}.yml`)!);
    const index: ModuleIndex = { single: false, holders: new Map(), owner: new Map(), modules: new Map() };
    for (const module of modules) {
      index.modules.set(module.id, { files: filesOfModule(module) });
      [...module.members, ...module.copies].forEach((n) => index.holders.set(n, (index.holders.get(n) ?? new Set()).add(module.id)));
      module.members.forEach((n) => index.owner.set(n, module.id));
    }

    const previous = new Set((head?.mode === 'items' ? await this.requireStore().modules(head.model, head.revision) : [])
      .map((m) => m.version));
    const probesOf = new Map<string, Probe[]>();
    probes.forEach((probe) => {
      const chosen = this.moduleForQuery(index, probe.query);
      // A probe spanning modules is asked of the whole model.
      const id = chosen && !chosen.startsWith(UNION_PREFIX) ? chosen : '';
      probesOf.set(id, [...(probesOf.get(id) ?? []), probe]);
    });

    const checks: { files: SnapshotFile[]; probes: Probe[] }[] = modules
      .filter((m) => !previous.has(m.version) || probesOf.has(m.id))
      .map((m) => ({ files: index.modules.get(m.id)!.files, probes: probesOf.get(m.id) ?? [] }));
    if (probesOf.has('')) {
      // Probes no module holds are asked of the whole model.
      checks.push({ files, probes: probesOf.get('')! });
    }

    const result: ValidationResult = { valid: true, errors: [], cubeMessage: null, probes: [] };
    const answers = new Map<string, ProbeResult>();
    const seen = new Set<string>();
    for (const one of checks) {
      const validation = await this.validate(model, one.files, priority, securityContext, one.probes);
      for (const error of validation.errors) {
        const key = `${error.path}\u0000${error.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.errors.push(error);
        }
      }
      if (!validation.valid) {
        result.valid = false;
        result.cubeMessage = result.cubeMessage ?? validation.cubeMessage;
      }
      validation.probes.forEach((p) => answers.set(p.id, p));
    }
    result.probes = result.valid ? probes.map((p) => answers.get(p.id)).filter((p): p is ProbeResult => Boolean(p)) : [];
    return result;
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

  /**
   * What short names mean from a folder, nearest-first, in the current
   * revision; with an overlay, in the overlay first (a workspace, AC-281).
   */
  public async resolveNames(model: string, folderId: string, names: string[], overlayId?: string) {
    const store = this.requireStore();
    const head = await store.head(model);
    const items = head ? await this.itemsAt(head) : [];
    const tree = new FolderTree(await store.folders(model));
    if (!tree.has(folderId)) {
      throw new FolderTreeError([`Folder ${folderId} is not in the folder tree`]);
    }
    const byKey = new Map(items.map((item) => [`${item.folderId}/${item.name}`, item.fullName]));
    const first = new Map<string, string>();
    if (overlayId !== undefined) {
      const overlay = await store.overlay(model, overlayId);
      if (!overlay) {
        throw gone(model, overlayId);
      }
      overlay.deletes.forEach(({ folderId: f, name }) => byKey.delete(`${f}/${name}`));
      for (const item of overlay.upserts) {
        byKey.set(`${item.folderId}/${item.name}`, fullNameOf(item.folderId, item.name));
        first.set(item.name, fullNameOf(item.folderId, item.name));
      }
    }
    const chain = tree.chain(folderId);
    const resolved: Record<string, string | null> = {};
    for (const name of names) {
      const folder = chain.find((f) => byKey.has(`${f}/${name}`));
      resolved[name] = first.get(name) ?? (folder ? byKey.get(`${folder}/${name}`)! : null);
    }
    return {
      model, revision: head?.revision ?? null, folderId, ...(overlayId !== undefined ? { overlay: overlayId } : {}), names: resolved,
    };
  }
}
