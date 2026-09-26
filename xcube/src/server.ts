import { CubejsServer, ServerContainer } from '@cubejs-backend/server';
import {
  CubejsServerCore,
  OrchestratorApi,
  type OrchestratorApiOptions,
} from '@cubejs-backend/server-core';
import type { ApiGatewayOptions } from '@cubejs-backend/api-gateway';
import type { DriverFactoryByDataSource } from '@cubejs-backend/query-orchestrator';

import { CatalogQueues } from './catalog/queue';
import { XcubeApiGateway } from './gateway';
import { DataSourceIntrospection } from './introspection';

/**
 * Cube's server core, serving the introspection routes with its API gateway.
 * Everything else is Cube's own.
 */
export class XcubeServerCore extends CubejsServerCore {
  /** Each orchestrator API's driver factory, as Cube built it. */
  protected readonly driverFactories = new WeakMap<OrchestratorApi, DriverFactoryByDataSource>();

  protected readonly catalogQueues = new CatalogQueues((msg, params) => this.logger(msg, params || {}));

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
}

export class XcubeServer extends CubejsServer {
  protected createCoreInstance(config: any, systemOptions?: any): CubejsServerCore {
    return new XcubeServerCore(config, systemOptions);
  }
}

/**
 * Cube's server container, as `cubejs server` runs it, with the introspection
 * server in place of Cube's.
 */
export class XcubeServerContainer extends ServerContainer {
  protected createServer(config: any, systemOptions?: any): CubejsServer {
    return new XcubeServer(config, systemOptions);
  }
}
