import crypto from 'crypto';
import cloneDeep from 'lodash/cloneDeep';

import { config, createConfig, runtimeOf, setGlobalRuntime, XcubeRuntime, XcubeServerCore } from '../../src';
import { orchestratorDefaults, QUEUE_HEART_BEAT_S } from '../../src/config';
import type { XcubeSettings } from '../../src';

const settings: XcubeSettings = {
  databaseUrl: 'postgres://unused',
  schema: 'xcube',
  migrate: true,
  pollIntervalMs: 60000,
  pollIntervalDownMs: 10000,
  retireGraceMs: 300000,
  keepRevisions: 50,
  limits: { maxBytes: 1048576, maxFileBytes: 1048576, maxFiles: 100, fileTypes: 'yaml' },
  compileQueue: 4,
  compileWaitMs: 60000,
  catchUpMs: 1000,
  adminTokens: [],
  maxModels: 100,
  modules: { packMin: 50, packMax: 300 },
};

const runtime = () => new XcubeRuntime(settings, { listenClient: null, logger: () => undefined });

describe('config', () => {
  afterEach(() => setGlobalRuntime(undefined));

  test('needs the xcube server\'s runtime', () => {
    expect(() => config()).toThrow(/needs the xcube server/);
  });

  test('uses the process\'s runtime', () => {
    const r = runtime();
    setGlobalRuntime(r);
    expect(runtimeOf(config())).toBe(r);
    expect(r.servingOptions).toEqual({
      modelClaim: 'xcubeModel', revisionClaim: 'xcubeRevision', withoutModel: 'disk', overlayClaim: 'xcubeOverlay',
    });
  });

  test('refuses the hooks xcube owns', () => {
    for (const key of ['contextToAppId', 'repositoryFactory', 'schemaVersion']) {
      expect(() => createConfig(runtime(), {}, { [key]: () => 'x' })).toThrow(`${key} belongs to xcube`);
    }
  });

  test('refuses an unknown withoutModel, and a second config() with other options', () => {
    expect(() => createConfig(runtime(), { withoutModel: 'maybe' as any })).toThrow(/withoutModel/);
    const r = runtime();
    createConfig(r, { modelClaim: 'a' });
    createConfig(r, { modelClaim: 'a' });
    expect(() => createConfig(r, { modelClaim: 'b' })).toThrow(/twice/);
  });

  test('keeps the rest of cube.js, and turns Node require off unless asked', () => {
    const options = createConfig(runtime(), {}, { telemetry: false });
    expect(options.telemetry).toBe(false);
    expect(options.allowNodeRequire).toBe(false);
    expect(options.schemaVersion).toBeUndefined();
    expect(createConfig(runtime(), {}, { allowNodeRequire: true }).allowNodeRequire).toBe(true);
  });

  test('composes contextToGroups: cube.js\'s, else the token\'s groups, never the gate\'s reserved group', async () => {
    const own = createConfig(runtime(), {}, { contextToGroups: async () => ['g', 'xcube.folder-gate', 7] });
    expect(await own.contextToGroups({ securityContext: { groups: ['ignored'] } })).toEqual(['g']);
    const verified = createConfig(runtime(), {});
    expect(await verified.contextToGroups({ securityContext: { groups: ['a', 'xcube.folder-gate', { x: 1 }] } })).toEqual(['a']);
    expect(await verified.contextToGroups({ securityContext: {} })).toEqual([]);
    expect(await verified.contextToGroups({})).toEqual([]);
  });

  test('the SQL API\'s checkSqlAuth: no role, and no model that takes RS256 tokens only', async () => {
    const r = runtime();
    const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    r.verifier.setModelKeys('keyed', { version: 1, issuer: null, keys: [{ ...key.export({ format: 'jwk' }), kid: 'k' }] });
    const options = createConfig(r, {}, {
      checkSqlAuth: async (_req: any, user: string) => ({ password: 'p', securityContext: { xcubeModel: user, xcubeRole: 'service', groups: ['g'] } }),
    });
    expect(await options.checkSqlAuth({}, 'open', 'p')).toEqual({ password: 'p', securityContext: { xcubeModel: 'open', groups: ['g'] } });
    await expect(options.checkSqlAuth({}, 'keyed', 'p')).rejects.toThrow(/model "keyed" takes RS256 tokens only/);
    expect(createConfig(runtime(), {}, {}).checkSqlAuth).toBeUndefined();
  });

  test('composes extendContext, and only xcube pins a context', async () => {
    const r = runtime();
    const options = createConfig(r, { modelClaim: 'm' }, {
      extendContext: async () => ({ tenant: 7, xcubePin: { model: 'x', appId: 'forged' }, xcubeCandidate: 'forged' }),
    });
    const headers: Record<string, string> = {};
    const extended = await options.extendContext({ securityContext: {}, res: { setHeader: (k: string, v: string) => { headers[k] = v; } } });
    expect(extended).toEqual({ tenant: 7 });
    expect(headers['x-xcube-revision']).toBe('disk');
  });

  test('Cube keeps the hooks, so a core finds its runtime', () => {
    const r = runtime();
    const options = createConfig(r, {}, {
      apiSecret: 'secret',
      dbType: 'postgres',
      devServer: false,
      telemetry: false,
      logger: () => undefined,
    });
    expect(runtimeOf(cloneDeep(options))).toBe(r);
    expect(runtimeOf({ ...options })).toBe(r);

    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.CUBEJS_DB_TYPE = 'postgres';
    try {
      const { dbType: _dbType, ...rest } = options;
      const core = new XcubeServerCore(rest as any);
      expect(core.xcube).toBe(r);
    } finally {
      process.env.NODE_ENV = nodeEnv;
      delete process.env.CUBEJS_DB_TYPE;
    }
  });

  test('the queues beat every few seconds, unless cube.js says otherwise', async () => {
    const own = orchestratorDefaults({
      redisPrefix: 'p',
      queryCacheOptions: { backgroundRenew: true, queueOptions: (ds: string) => ({ concurrency: ds === 'a' ? 1 : 2 }) },
      preAggregationsOptions: { queueOptions: { heartBeatInterval: 20 } },
    });
    expect(own.redisPrefix).toBe('p');
    expect(own.queryCacheOptions.backgroundRenew).toBe(true);
    expect(own.queryCacheOptions.queueOptions('a')).toEqual({ heartBeatInterval: QUEUE_HEART_BEAT_S, concurrency: 1 });
    expect(own.preAggregationsOptions.queueOptions('a')).toEqual({ heartBeatInterval: 20 });
    expect(orchestratorDefaults(undefined).queryCacheOptions.queueOptions('a')).toEqual({ heartBeatInterval: QUEUE_HEART_BEAT_S });
  });

  test('Cube\'s queues take the heartbeat', async () => {
    // Widens what Cube keeps protected, to read the options it builds a queue with.
    class TestCore extends XcubeServerCore {
      public async queueOptions(context: any, kind: 'queryCacheOptions' | 'preAggregationsOptions') {
        const options = this.optsHandler.getOrchestratorInitializedOptions(context, (await this.orchestratorOptions(context)) || {});
        return options[kind]!.queueOptions!('default');
      }
    }
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const options = createConfig(runtime(), {}, {
        apiSecret: 'secret',
        devServer: false,
        telemetry: false,
        logger: () => undefined,
        driverFactory: () => ({ type: 'postgres' }),
        orchestratorOptions: () => ({ queryCacheOptions: { queueOptions: { concurrency: 3 } }, preAggregationsOptions: { queueOptions: { concurrency: 1 } } }),
      });
      const core = new TestCore(options as any);
      const context = { securityContext: {}, requestId: 'r' };
      expect(await core.queueOptions(context, 'queryCacheOptions')).toMatchObject({ concurrency: 3, heartBeatInterval: QUEUE_HEART_BEAT_S });
      expect(await core.queueOptions(context, 'preAggregationsOptions')).toMatchObject({ concurrency: 1, heartBeatInterval: QUEUE_HEART_BEAT_S });
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });
});
