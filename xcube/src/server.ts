import type http from 'http';
import { CubejsServer, ServerContainer } from '@cubejs-backend/server';
import {
  CubejsServerCore,
  OrchestratorApi,
  type OrchestratorApiOptions,
} from '@cubejs-backend/server-core';
import type { ApiGatewayOptions } from '@cubejs-backend/api-gateway';
import type { DriverFactoryByDataSource } from '@cubejs-backend/query-orchestrator';

import { CatalogQueues } from './catalog/queue';
import { globalRuntime, runtimeOf } from './config';
import { XcubeApiGateway } from './gateway';
import { DataSourceIntrospection } from './introspection';
import type { ServingCore, XcubeRuntime } from './runtime/runtime';

/**
 * Cube's server core, serving the introspection routes, and models from
 * xcube when cube.js uses `require('xcube').config()`. Everything else is
 * Cube's own.
 */
export class XcubeServerCore extends CubejsServerCore implements ServingCore {
  /** Each orchestrator API's driver factory, as Cube built it. */
  protected readonly driverFactories = new WeakMap<OrchestratorApi, DriverFactoryByDataSource>();

  protected readonly catalogQueues = new CatalogQueues((msg, params) => this.logger(msg, params || {}));

  /**
   * The runtime serving this core: the one its options were configured for,
   * else the process's. Read lazily, as Cube's constructor sets the options.
   */
  public get xcube(): XcubeRuntime | undefined {
    return runtimeOf(this.options) ?? globalRuntime();
  }

  protected createOrchestratorApi(getDriver: DriverFactoryByDataSource, options: OrchestratorApiOptions): OrchestratorApi {
    const orchestratorApi = super.createOrchestratorApi(getDriver, options);
    this.driverFactories.set(orchestratorApi, getDriver);
    return orchestratorApi;
  }

  protected createApiGatewayInstance(
    apiSecret: string,
    getCompilerApi: (context: any) => Promise<any>,
    getOrchestratorApi: (context: any) => Promise<any>,
    logger: any,
    options: ApiGatewayOptions,
  ): XcubeApiGateway {
    return new XcubeApiGateway(
      apiSecret,
      getCompilerApi,
      getOrchestratorApi,
      logger,
      options,
      (orchestratorApi, dataSource, requestId) => this.introspectionFor(orchestratorApi, dataSource, requestId),
      () => this.xcube,
    );
  }

  protected introspectionFor(orchestratorApi: OrchestratorApi, dataSource: string, requestId?: string) {
    const getDriver = this.driverFactories.get(orchestratorApi);
    if (!getDriver) {
      throw new Error('The orchestrator API was not built by this server core');
    }

    const driverFactory = () => getDriver(dataSource);
    const queryCache = orchestratorApi.getQueryOrchestrator().getQueryCache();

    return new DataSourceIntrospection(
      (operation, params = {}) => this.catalogQueues.run(queryCache, driverFactory, {
        operation,
        params,
        dataSource,
        requestId,
      }),
      driverFactory,
      dataSource,
    );
  }

  public xcubeGateway(): XcubeApiGateway {
    return this.apiGateway() as XcubeApiGateway;
  }

  /** Drops a compiled model from Cube's compiler cache, which disposes it. */
  public retireAppId(appId: string) {
    this.compilerCache.delete(appId);
  }

  /** A refresh run keeps the compiled model it started with, so its revision stays compiled until it ends. */
  public async runScheduledRefresh(context: any, queryingOptions?: any) {
    const revision = context && this.xcube?.serving ? this.xcube.revisionOfContext(context) : undefined;
    if (!revision) {
      return super.runScheduledRefresh(context, queryingOptions);
    }
    this.xcube!.hold(revision);
    try {
      return await super.runScheduledRefresh(context, queryingOptions);
    } finally {
      this.xcube!.release(revision);
    }
  }
}

export class XcubeServer extends CubejsServer {
  protected createCoreInstance(config: any, systemOptions?: any): CubejsServerCore {
    return new XcubeServerCore(config, systemOptions);
  }

  protected get xcubeCore(): XcubeServerCore {
    return this.core as XcubeServerCore;
  }

  /** Compiles every model's current revision before Cube listens, so it is never ready on a cold model. */
  public async listen(options: http.ServerOptions = {}) {
    await this.xcubeCore.xcube?.attach(this.xcubeCore);
    return super.listen(options);
  }

  public async shutdown(signal: string, graceful: boolean = true) {
    const runtime = this.xcubeCore.xcube;
    // After Cube has drained its requests, which are served until then.
    const code = await super.shutdown(signal, graceful);
    runtime?.detach(this.xcubeCore);
    // SIGUSR1 is Cube's reload: it builds another server, which attaches to the same runtime.
    if (runtime && signal !== 'SIGUSR1') {
      await Promise.race([runtime.stop(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    return code;
  }
}

/**
 * Cube's server container, as `cubejs server` runs it, with xcube's server
 * in place of Cube's.
 */
export class XcubeServerContainer extends ServerContainer {
  protected createServer(config: any, systemOptions?: any): CubejsServer {
    return new XcubeServer(config, systemOptions);
  }
}
