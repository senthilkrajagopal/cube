import { contentHash, type SnapshotFile } from '../../src/model/snapshot';
import { appIdOf, XcubeRuntime, type ServingCore } from '../../src/runtime/runtime';
import type { XcubeSettings } from '../../src/runtime/settings';
import type {
  ImportRequest,
  ImportResult,
  ModelHead,
  ModelStatus,
  RevisionStore,
} from '../../src/store/revisions';

/** Revisions in memory, as the Postgres store keeps them. */
class MemoryStore implements RevisionStore {
  public revisions = new Map<string, { head: ModelHead; files: SnapshotFile[] }[]>();

  public generation = '00000000-0000-4000-8000-000000000001';

  public put(model: string, files: SnapshotFile[], hash = contentHash(files)): ModelHead {
    const list = this.revisions.get(model) ?? [];
    const head = { model, generation: this.generation, revision: list.length + 1, contentHash: hash };
    list.push({ head, files });
    this.revisions.set(model, list);
    return head;
  }

  public async heads() {
    return [...this.revisions.values()].map((list) => list[list.length - 1].head);
  }

  public down = false;

  public async head(model: string) {
    if (this.down) {
      throw new Error('connect ECONNREFUSED');
    }
    const list = this.revisions.get(model);
    return list ? list[list.length - 1].head : null;
  }

  public async status(): Promise<ModelStatus | null> {
    return null;
  }

  public async files(model: string, revision: number) {
    return this.revisions.get(model)?.[revision - 1]?.files ?? null;
  }

  public async earlier(model: string, revision: number, limit: number) {
    return (this.revisions.get(model) ?? []).map(({ head }) => head)
      .filter((head) => head.revision < revision).reverse().slice(0, limit);
  }

  public async import(_request: ImportRequest): Promise<ImportResult> {
    throw new Error('not used');
  }

  public async importItems(): Promise<ImportResult> {
    throw new Error('not used');
  }

  public async folders() {
    return [];
  }

  public async putFolders(): Promise<string> {
    throw new Error('not used');
  }

  public async items() {
    return [];
  }
}

/** A core whose compiles finish when a test says, or fail for content it is told to fail. */
class FakeCore implements ServingCore {
  public compiled = new Map<string, SnapshotFile[]>();

  public retired: string[] = [];

  public gates = new Map<string, Promise<void>>();

  public failing = new Set<string>();

  public constructor(public runtime: XcubeRuntime) {
  }

  public logger = () => undefined;

  public async getCompilerApi(context: any) {
    const served = this.runtime.resolve(context);
    const { appId } = served;
    return {
      getCompilers: async () => {
        await this.gates.get(appId);
        const files = served.kind === 'disk' ? [] : this.runtime.filesOf(served);
        if (files.some(({ content }) => this.failing.has(content))) {
          throw new Error('Compile errors:\nErrors:\nbroken\n');
        }
        this.compiled.set(appId, files);
      },
    };
  }

  public retireAppId(appId: string) {
    this.retired.push(appId);
    this.compiled.delete(appId);
  }

  public xcubeGateway(): any {
    throw new Error('not used');
  }
}

const settings = (extra: Partial<XcubeSettings> = {}): XcubeSettings => ({
  databaseUrl: 'postgres://unused',
  schema: 'xcube',
  migrate: true,
  pollIntervalMs: 3600000,
  pollIntervalDownMs: 3600000,
  retireGraceMs: 1000,
  keepRevisions: 50,
  limits: { maxBytes: 1048576, maxFileBytes: 1048576, maxFiles: 100, fileTypes: 'yaml' },
  compileQueue: 4,
  compileWaitMs: 60000,
  catchUpMs: 200,
  adminTokens: [],
  maxModels: 100,
  ...extra,
});

const files = (content: string): SnapshotFile[] => [{ path: 'model.yml', content }];

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function setup(extra: Partial<XcubeSettings> = {}) {
  const store = new MemoryStore();
  const runtime = new XcubeRuntime(settings(extra), { store, listenClient: null, logger: () => undefined });
  runtime.configure({ modelClaim: 'wechartModel', revisionClaim: 'wechartRevision', withoutModel: 'disk' });
  const core = new FakeCore(runtime);
  return { store, runtime, core };
}

const ctx = (claims: object, extra: object = {}) => ({ securityContext: claims, authInfo: claims, ...extra });

describe('XcubeRuntime', () => {
  let runtime: XcubeRuntime;

  afterEach(async () => {
    await runtime?.stop();
  });

  test('compiles every current revision before it is ready, and serves it', async () => {
    const s = await setup();
    runtime = s.runtime;
    const head = s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);

    expect(s.core.compiled.get(appIdOf(head))).toEqual(files('v1'));
    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(head));
    expect(runtime.resolve(ctx({})).appId).toBe('xcube:disk');
  });

  test('switches only once the new revision compiled, and a pinned request keeps its revision', async () => {
    const s = await setup();
    runtime = s.runtime;
    const v1 = s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);
    const pinned = await runtime.pinFor({ securityContext: { wechartModel: 'dev' } });

    const v2 = s.store.put('dev', files('v2'));
    const held = gate();
    s.core.gates.set(appIdOf(v2), held.opened);
    const syncing = runtime.sync('dev');
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v1));
    expect(runtime.instanceStatus('dev')).toEqual({ revision: 1, state: 'activating' });

    held.open();
    await syncing;
    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v2));
    // The request pinned before the switch is still served its revision, in its grace period.
    expect(runtime.resolve(ctx({ wechartModel: 'dev' }, pinned)).appId).toBe(appIdOf(v1));
    expect(runtime.instanceStatus('dev')).toEqual({ revision: 2, state: 'active' });
  });

  test('keeps the previous revision when the new one does not compile, and retries it later', async () => {
    const s = await setup();
    runtime = s.runtime;
    const v1 = s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);

    s.core.failing.add('v2');
    const v2 = s.store.put('dev', files('v2'));
    await runtime.sync('dev');

    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v1));
    expect(runtime.instanceStatus('dev')).toMatchObject({ revision: 1, state: 'failed' });
    expect(s.core.retired).toContain(appIdOf(v2));

    // Within the backoff nothing is tried; after it, the revision is.
    s.core.failing.clear();
    await runtime.sync('dev');
    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v1));
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 31000);
    try {
      await runtime.sync('dev');
    } finally {
      spy.mockRestore();
    }
    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v2));
  });

  test('refuses a revision whose files do not match its hash', async () => {
    const s = await setup();
    runtime = s.runtime;
    const v1 = s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);

    s.store.put('dev', files('v2'), 'f'.repeat(64));
    await runtime.sync('dev');
    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v1));
    expect(runtime.instanceStatus('dev')).toMatchObject({ state: 'failed', error: expect.stringMatching(/content hash/) });
  });

  test('at start, falls back to the newest earlier revision that compiles', async () => {
    const s = await setup();
    runtime = s.runtime;
    const v1 = s.store.put('dev', files('v1'));
    s.store.put('dev', files('v2'));
    s.store.put('dev', files('v3'));
    s.core.failing.add('v2');
    s.core.failing.add('v3');
    await runtime.start();
    await runtime.attach(s.core);

    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v1));
    expect(runtime.instanceStatus('dev')).toMatchObject({ revision: 1, state: 'failed' });
  });

  test('retires a replaced revision after its grace period, and not while a refresh run holds it', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const s = await setup({ retireGraceMs: 1000 });
      runtime = s.runtime;
      const v1 = s.store.put('dev', files('v1'));
      await runtime.start();
      await runtime.attach(s.core);
      const background = runtime.residentOf(ctx({ wechartModel: 'dev' }))!;
      runtime.hold(background);

      s.store.put('dev', files('v2'));
      await runtime.sync('dev');

      jest.advanceTimersByTime(30000);
      expect(s.core.retired).not.toContain(appIdOf(v1));

      runtime.release(background);
      jest.advanceTimersByTime(30000);
      expect(s.core.retired).toContain(appIdOf(v1));
      // A request pinned to it now gets the active revision.
      expect(runtime.resolve(ctx({ wechartModel: 'dev' }, { xcubePin: { model: 'dev', appId: appIdOf(v1) } })).appId)
        .not.toBe(appIdOf(v1));
    } finally {
      jest.useRealTimers();
    }
  });

  test('a request naming a newer revision waits for it, or is told to retry', async () => {
    const s = await setup({ catchUpMs: 100 });
    runtime = s.runtime;
    s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);

    const v2 = s.store.put('dev', files('v2'));
    const pinned = await runtime.pinFor({ securityContext: { wechartModel: 'dev', wechartRevision: 2 } });
    expect(pinned).toEqual({ xcubePin: { model: 'dev', appId: appIdOf(v2) } });

    const v3 = s.store.put('dev', files('v3'));
    const held = gate();
    s.core.gates.set(appIdOf(v3), held.opened);
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => { headers[name] = value; } };
    await expect(runtime.pinFor({ securityContext: { wechartModel: 'dev', wechartRevision: '3' }, res }))
      .rejects.toMatchObject({ status: 503 });
    expect(headers['Retry-After']).toBe('2');

    held.open();
    await runtime.sync('dev');
    expect(await runtime.pinFor({ securityContext: { wechartModel: 'dev', wechartRevision: 3 }, res }))
      .toEqual({ xcubePin: { model: 'dev', appId: appIdOf(v3) } });
    expect(headers['x-xcube-revision']).toBe('dev@3');
  });

  test('models: unknown is refused once the database says so; invalid ids and revisions are refused', async () => {
    const s = await setup();
    runtime = s.runtime;
    await runtime.start();
    await runtime.attach(s.core);

    await expect(runtime.pinFor({ securityContext: { wechartModel: 'nobody' } })).rejects.toMatchObject({ status: 403 });
    expect(() => runtime.resolve(ctx({ wechartModel: 'nobody' }))).toThrow(/Unknown model/);
    await expect(runtime.pinFor({ securityContext: { wechartModel: 'NO' } })).rejects.toMatchObject({ status: 403 });
    await expect(runtime.pinFor({ securityContext: { wechartModel: 'dev', wechartRevision: 0 } }))
      .rejects.toMatchObject({ status: 403 });

    // Once it exists, it is served.
    const v1 = s.store.put('nobody', files('v1'));
    (runtime as any).notified('nobody');
    await runtime.sync('nobody');
    expect(runtime.resolve(ctx({ wechartModel: 'nobody' })).appId).toBe(appIdOf(v1));
  });

  test('without a model: disk, or refused', async () => {
    const s = await setup();
    runtime = s.runtime;
    await runtime.start();
    (runtime as any).options = { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision', withoutModel: 'refuse' };
    await runtime.attach(s.core);
    expect(() => runtime.resolve(ctx({}))).toThrow(/names no model/);
    await expect(runtime.pinFor({ securityContext: {} })).rejects.toMatchObject({ status: 403 });
    expect(await runtime.refreshContexts()).toEqual([]);
  });

  test('refresh contexts: disk, and each model pinned to its active revision; the user\'s list pinned the same way', async () => {
    const s = await setup();
    runtime = s.runtime;
    const dev = s.store.put('dev', files('dev'));
    s.core.failing.add('demo');
    s.store.put('demo', files('demo'));
    await runtime.start();
    await runtime.attach(s.core);

    expect(await runtime.refreshContexts()).toEqual([
      { securityContext: {} },
      { securityContext: { wechartModel: 'dev' }, xcubePin: { model: 'dev', appId: appIdOf(dev) } },
    ]);
    expect(await runtime.refreshContexts(async () => [
      { securityContext: { wechartModel: 'dev', tenant: 1 }, xcubePin: { model: 'x', appId: 'forged' } },
      { securityContext: { wechartModel: 'demo' } },
      { securityContext: { wechartModel: 'BAD' } },
      { authInfo: {} },
    ])).toEqual([
      { securityContext: { wechartModel: 'dev', tenant: 1 }, xcubePin: { model: 'dev', appId: appIdOf(dev) } },
      { authInfo: {} },
    ]);
  });

  test('after the core is replaced (SIGUSR1), the new one is compiled without the database', async () => {
    const s = await setup();
    runtime = s.runtime;
    const v1 = s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);

    runtime.detach(s.core);
    const next = new FakeCore(runtime);
    s.store.files = async () => {
      throw new Error('database down');
    };
    await runtime.attach(next);
    expect(next.compiled.get(appIdOf(v1))).toEqual(files('v1'));
  });

  test('a pin forged for another model is ignored', async () => {
    const s = await setup();
    runtime = s.runtime;
    const dev = s.store.put('dev', files('dev'));
    const demo = s.store.put('demo', files('demo'));
    await runtime.start();
    await runtime.attach(s.core);
    expect(runtime.resolve(ctx({ wechartModel: 'demo' }, { xcubePin: { model: 'dev', appId: appIdOf(dev) } })).appId)
      .toBe(appIdOf(demo));
  });

  test('switches only forward: a newer revision arriving mid-compile is served next', async () => {
    const s = await setup();
    runtime = s.runtime;
    s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);

    const v2 = s.store.put('dev', files('v2'));
    const held = gate();
    s.core.gates.set(appIdOf(v2), held.opened);
    const first = runtime.sync('dev');
    await new Promise((resolve) => setImmediate(resolve));
    const v3 = s.store.put('dev', files('v3'));
    const second = runtime.sync('dev');
    held.open();
    await Promise.all([first, second]);

    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v3));
    expect((runtime as any).residents.get(appIdOf(v2)).state).toBe('retiring');
  });

  test('at start, an earlier revision served as a fallback never replaces a newer one that arrives meanwhile', async () => {
    const s = await setup();
    runtime = s.runtime;
    const v1 = s.store.put('dev', files('v1'));
    s.store.put('dev', files('v2'));
    s.core.failing.add('v2');
    await runtime.start();

    const held = gate();
    s.core.gates.set(appIdOf(v1), held.opened);
    const attaching = runtime.attach(s.core);
    await new Promise((resolve) => setImmediate(resolve));
    const v3 = s.store.put('dev', files('v3'));
    const notified = runtime.sync('dev');
    held.open();
    await Promise.all([attaching, notified]);

    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v3));
    expect(runtime.instanceStatus('dev')).toEqual({ revision: 3, state: 'active' });
  });

  test('compiling a revision resolves to that revision or fails, never to another', async () => {
    const s = await setup();
    runtime = s.runtime;
    s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);
    expect(() => runtime.resolve(ctx({ wechartModel: 'dev' }, { xcubeActivate: 'xcube:dev:9:gone' })))
      .toThrow(/no longer resident/);
  });

  test('a database error is not a compile failure: the next read retries at once', async () => {
    const s = await setup();
    runtime = s.runtime;
    s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);

    const v2 = s.store.put('dev', files('v2'));
    const files0 = s.store.files.bind(s.store);
    s.store.files = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await expect(runtime.sync('dev')).rejects.toThrow(/ECONNREFUSED/);
    expect(runtime.instanceStatus('dev')).toEqual({ revision: 1, state: 'activating' });

    s.store.files = files0;
    await runtime.sync('dev');
    expect(runtime.resolve(ctx({ wechartModel: 'dev' })).appId).toBe(appIdOf(v2));
  });

  test('a request for a revision that failed here is refused at once, not after the wait', async () => {
    const s = await setup({ catchUpMs: 5000 });
    runtime = s.runtime;
    s.store.put('dev', files('v1'));
    await runtime.start();
    await runtime.attach(s.core);
    s.core.failing.add('v2');
    s.store.put('dev', files('v2'));
    await runtime.sync('dev');

    const started = Date.now();
    await expect(runtime.pinFor({ securityContext: { wechartModel: 'dev', wechartRevision: 2 } }))
      .rejects.toMatchObject({ status: 503 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('keeps no state for invalid, unknown or unreachable models, and at most maxModels', async () => {
    const s = await setup({ maxModels: 2 });
    runtime = s.runtime;
    s.store.put('dev', files('dev'));
    await runtime.start();
    await runtime.attach(s.core);
    const models = () => (runtime as any).models as Map<string, unknown>;

    (runtime as any).notified('\u0000bad');
    (runtime as any).notified('x'.repeat(100));
    await expect(runtime.sync('Not Valid')).rejects.toThrow(/not following/);
    expect([...models().keys()]).toEqual(['dev']);

    s.store.down = true;
    await expect(runtime.sync('ghost')).rejects.toThrow(/ECONNREFUSED/);
    await new Promise((resolve) => setImmediate(resolve));
    expect([...models().keys()]).toEqual(['dev']);
    s.store.down = false;

    s.store.put('two', files('two'));
    await runtime.sync('two');
    await expect(runtime.sync('three')).rejects.toThrow(/not following/);
    expect([...models().keys()].sort()).toEqual(['dev', 'two']);
  });

  test('attach refuses when cube.js does not use config()', async () => {
    const store = new MemoryStore();
    runtime = new XcubeRuntime(settings(), { store, listenClient: null, logger: () => undefined });
    await runtime.start();
    await expect(runtime.attach(new FakeCore(runtime))).rejects.toThrow(/does not use require\('xcube'\)\.config\(\)/);
  });
});
