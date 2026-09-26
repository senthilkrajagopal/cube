import path from 'path';
import { FileRepository } from '@cubejs-backend/server-core';
import crypto from 'crypto';
import { assertDataSource, getEnv } from '@cubejs-backend/shared';

import { XcubeRuntime, type ServingOptions } from './runtime/runtime';
import { GATE_GROUP } from './security/marker';

export interface XcubeConfigOptions {
  /** The security-context claim naming the model a request reads. Default `xcubeModel`. */
  modelClaim?: string;
  /**
   * The claim naming the oldest revision a request may be answered from, so a
   * client that just imported revision N is never answered from an older
   * one. Default `xcubeRevision`.
   */
  revisionClaim?: string;
  /** A context naming no model: Cube's own data model directory (`disk`, the default), or 403. */
  withoutModel?: 'disk' | 'refuse';
  /**
   * The claim naming the workspace or proposal overlay a request previews,
   * signed into the token by the client for those it allows. Default
   * `xcubeOverlay`.
   */
  overlayClaim?: string;
}

/**
 * A model's own pre-aggregation schema: `<base>_<model>_<hash>`, the hash of
 * the model id as it is, so two models never share one (`a-b` and `a_b`),
 * within Postgres's 63 bytes.
 */
export function modelSchema(base: string, model: string): string {
  const hash = crypto.createHash('sha256').update(model).digest('hex').slice(0, 12);
  return `${base.slice(0, 29)}_${model.replace(/[^a-z0-9_]/g, '_').slice(0, 20)}_${hash}`;
}

/** Cube options xcube sets itself; cube.js must not. */
const OWNED = ['contextToAppId', 'repositoryFactory', 'schemaVersion'] as const;

const GLOBAL_RUNTIME = Symbol.for('xcube.runtime');

/** Which runtime each configuration belongs to, by its `contextToAppId`, whose identity Cube keeps. */
const RUNTIMES = new WeakMap<object, XcubeRuntime>();

/** The process's runtime, started by the xcube entry point when `XCUBE_DATABASE_URL` is set. */
export function globalRuntime(): XcubeRuntime | undefined {
  return (globalThis as any)[GLOBAL_RUNTIME];
}

export function setGlobalRuntime(runtime: XcubeRuntime | undefined) {
  (globalThis as any)[GLOBAL_RUNTIME] = runtime;
}

/** The runtime a Cube options object was configured for, if `config()` made it. */
export function runtimeOf(options: { contextToAppId?: unknown } | undefined): XcubeRuntime | undefined {
  const fn = options?.contextToAppId;
  return typeof fn === 'function' ? RUNTIMES.get(fn) : undefined;
}

/** `config()` bound to a given runtime: for tests, and for several cores in one process. */
export function createConfig(
  runtime: XcubeRuntime,
  options: XcubeConfigOptions = {},
  cube: Record<string, any> = {},
): Record<string, any> {
  for (const key of OWNED) {
    if (cube[key] !== undefined) {
      throw new Error(`xcube.config(): ${key} belongs to xcube; remove it from cube.js`);
    }
  }

  const serving: ServingOptions = {
    modelClaim: options.modelClaim ?? 'xcubeModel',
    revisionClaim: options.revisionClaim ?? 'xcubeRevision',
    withoutModel: options.withoutModel ?? 'disk',
    overlayClaim: options.overlayClaim ?? 'xcubeOverlay',
  };
  if (serving.withoutModel !== 'disk' && serving.withoutModel !== 'refuse') {
    throw new Error('xcube.config(): withoutModel is \'disk\' or \'refuse\'');
  }
  runtime.configure(serving);

  const schemaPath: string = cube.schemaPath ?? getEnv('schemaPath');
  const disk = new FileRepository(schemaPath);

  const contextToAppId = (context: any) => runtime.resolve(context).appId;
  // The groups policies match: cube.js's, else a verified token's `groups`;
  // never the folder gate's reserved group, which must match nobody.
  const userGroups = cube.contextToGroups;
  const contextToGroups = async (context: any) => {
    const groups = userGroups ? await userGroups(context) : context?.securityContext?.groups;
    return Array.isArray(groups) ? groups.filter((g: unknown) => typeof g === 'string' && g !== GATE_GROUP) : [];
  };
  RUNTIMES.set(contextToAppId, runtime);
  const userRewrite = cube.queryRewrite;

  return {
    ...cube,
    contextToAppId,
    contextToGroups,
    repositoryFactory: (context: any) => {
      const served = runtime.resolve(context);
      if (served.kind === 'disk') {
        return disk;
      }
      const files = runtime.filesOf(served);
      return {
        localPath: () => path.join(process.cwd(), schemaPath),
        dataSchemaFiles: async () => files.map(({ path: fileName, content }) => ({ fileName, content })),
      };
    },
    extendContext: async (req: any) => {
      const extensions = cube.extendContext ? await cube.extendContext(req) : {};
      // Only xcube may pin a context.
      const { xcubePin: _pin, xcubeCandidate: _candidate, ...rest } = extensions || {};
      return { ...rest, ...await runtime.pinFor(req) };
    },
    scheduledRefreshContexts: () => runtime.refreshContexts(cube.scheduledRefreshContexts),
    // A model with connections has data sources of its own: its own
    // orchestrator (drivers, queues, caches). Every model has its own
    // pre-aggregation schema, fixed whatever its connections, as a compiled
    // model keeps the schema it was compiled with.
    contextToOrchestratorId: async (context: any) => {
      const base = cube.contextToOrchestratorId ? await cube.contextToOrchestratorId(context) : 'STANDALONE';
      const model = runtime.modelOfContext(context);
      return model && (await runtime.connections.of(model)).size ? `${base}_${model}` : base;
    },
    preAggregationsSchema: async (context: any) => {
      const configured = typeof cube.preAggregationsSchema === 'function'
        ? await cube.preAggregationsSchema(context)
        : cube.preAggregationsSchema;
      const base = configured
        ?? getEnv('preAggregationsSchema')
        ?? ((cube.devServer ?? getEnv('devMode')) ? 'dev_pre_aggregations' : 'prod_pre_aggregations');
      const model = runtime.modelOfContext(context);
      return model ? modelSchema(base, model) : base;
    },
    // A model's connection names its driver type; any other data source is
    // cube.js's, or Cube's from its environment. Only `{ type }`: xcube hands
    // Cube the driver itself (XcubeServerCore.resolveDriver).
    driverFactory: async (context: any) => {
      const model = runtime.modelOfContext(context);
      const connections = model ? await runtime.connections.of(model) : undefined;
      const dataSource = context?.dataSource ?? 'default';
      const type = connections ? await runtime.connections.typeOf(model!, dataSource) : undefined;
      if (type) {
        return { type };
      }
      if (connections?.size && dataSource !== 'default') {
        // A model with connections reads its own data sources: only its default may be Cube's.
        throw new Error(`Data source "${dataSource}" of model "${model}" has no connection`);
      }
      if (cube.driverFactory) {
        return cube.driverFactory(context);
      }
      const envType = getEnv('dbType', { dataSource: assertDataSource(dataSource), preAggregations: context?.preAggregations });
      if (!envType) {
        throw new Error(model
          ? `Data source "${dataSource}" of model "${model}" has no connection, and Cube's environment names none`
          : `Data source "${dataSource}" has no CUBEJS_DB_TYPE`);
      }
      return { type: envType };
    },
    allowNodeRequire: cube.allowNodeRequire ?? false,
    // xcube retires compiled models itself; Cube's cache must not evict them first.
    compilerCacheSize: cube.compilerCacheSize ?? 2000,
    // The SQL API's contexts obey the rules HS256 tokens do: no role, and no model that has keys.
    ...(cube.checkSqlAuth ? {
      checkSqlAuth: async (req: any, user: string | null, password: string | null) => {
        const result = await cube.checkSqlAuth(req, user, password);
        return { ...result, securityContext: runtime.unverified(result?.securityContext) };
      },
    } : {}),
    ...(userRewrite ? {
      queryRewrite: async (query: any, context: any) => {
        const rewritten = await userRewrite(query, context);
        runtime.checkRewritten(rewritten, context);
        return rewritten;
      },
    } : {}),
  };
}

/**
 * Cube options that serve models from xcube, composed with the rest of a
 * cube.js:
 *
 * ```js
 * module.exports = require('xcube').config({ modelClaim: 'wechartModel' }, {
 *   contextToGroups: …, contextToApiScopes: …,
 * });
 * ```
 */
export function config(options: XcubeConfigOptions = {}, cube: Record<string, any> = {}): Record<string, any> {
  const runtime = globalRuntime();
  if (!runtime) {
    throw new Error(
      'require(\'xcube\').config() needs the xcube server, started with XCUBE_DATABASE_URL set'
    );
  }
  return createConfig(runtime, options, cube);
}
