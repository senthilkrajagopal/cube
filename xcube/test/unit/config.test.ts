import cloneDeep from 'lodash/cloneDeep';

import { config, createConfig, runtimeOf, setGlobalRuntime, XcubeRuntime, XcubeServerCore } from '../../src';
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
    expect(r.servingOptions).toEqual({ modelClaim: 'xcubeModel', revisionClaim: 'xcubeRevision', withoutModel: 'disk' });
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
    const contextToGroups = () => ['g'];
    const options = createConfig(runtime(), {}, { contextToGroups, telemetry: false });
    expect(options.contextToGroups).toBe(contextToGroups);
    expect(options.telemetry).toBe(false);
    expect(options.allowNodeRequire).toBe(false);
    expect(options.schemaVersion).toBeUndefined();
    expect(createConfig(runtime(), {}, { allowNodeRequire: true }).allowNodeRequire).toBe(true);
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
});
