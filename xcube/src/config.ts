import path from 'path';
import { FileRepository } from '@cubejs-backend/server-core';
import { getEnv } from '@cubejs-backend/shared';

import { XcubeRuntime, type ServingOptions } from './runtime/runtime';

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
  };
  if (serving.withoutModel !== 'disk' && serving.withoutModel !== 'refuse') {
    throw new Error('xcube.config(): withoutModel is \'disk\' or \'refuse\'');
  }
  runtime.configure(serving);

  const schemaPath: string = cube.schemaPath ?? getEnv('schemaPath');
  const disk = new FileRepository(schemaPath);

  const contextToAppId = (context: any) => runtime.resolve(context).appId;
  RUNTIMES.set(contextToAppId, runtime);

  return {
    ...cube,
    contextToAppId,
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
    allowNodeRequire: cube.allowNodeRequire ?? false,
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
