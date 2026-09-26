import {
  BaseDriver,
  QueryKey,
  QueuePriority,
} from '@cubejs-backend/base-driver';
import {
  ContinueWaitError,
  QueryCache,
  QueryQueue,
} from '@cubejs-backend/query-orchestrator';

import { catalogView } from './views';

export type CatalogOperation = 'schemas' | 'tables' | 'columns' | 'tablesSchema';

export type CatalogRequest = {
  operation: CatalogOperation;
  params: Record<string, any>;
  dataSource: string;
  requestId?: string;
};

type Logger = (msg: string, params?: Record<string, any>) => void;

/**
 * Reads a data source's catalog through its driver, as the introspection
 * needs it: see `catalogView`.
 */
export function runCatalogOperation(driver: BaseDriver, { operation, params }: CatalogRequest): Promise<unknown> {
  const view = catalogView(driver);

  switch (operation) {
    case 'schemas':
      return view.getSchemas();
    case 'tables':
      return view.getTablesForSpecificSchemas(params.schemas);
    case 'columns':
      return view.getColumnsForSpecificTables(params.tables);
    case 'tablesSchema':
      return view.tablesSchema();
    default:
      throw new Error(`Unknown catalog operation: ${operation}`);
  }
}

/**
 * Reads `QueryCache`'s protected `cachePrefix` from a subclass, so the
 * compiler checks it against Cube's declarations on every upgrade. It is
 * never instantiated.
 */
class QueryCacheInternals extends QueryCache {
  public static prefixOf(queryCache: QueryCache): string {
    return (queryCache as QueryCacheInternals).cachePrefix;
  }
}

/**
 * A queue per data source for catalog reads, beside the one Cube keeps for
 * its queries and with that queue's driver, concurrency and wait timeout. A
 * read waits there like a query: the same read asked for twice runs once,
 * and one that outlasts the wait timeout answers `Continue wait`, to be asked
 * for again. Nothing is cached: each read answers from the catalog as it is.
 *
 * The queue is the package's own, not Cube's, because Cube's runs the SQL it
 * is given and this runs the driver's catalog methods. With Cube Store as the
 * queue, only processes running this package take its jobs.
 */
export class CatalogQueues {
  private readonly queues = new WeakMap<QueryCache, Map<string, Promise<QueryQueue>>>();

  public constructor(private readonly logger: Logger) {
  }

  public async run<T>(
    queryCache: QueryCache,
    driverFactory: () => Promise<BaseDriver> | BaseDriver,
    request: CatalogRequest,
  ): Promise<T> {
    const queue = await this.queueFor(queryCache, driverFactory, request.dataSource);
    const queryKey = [
      `INTROSPECTION:${request.operation}`,
      [JSON.stringify(request.params)],
    ] as QueryKey;

    try {
      return await queue.executeInQueue(
        'query',
        queryKey,
        { queryKey, ...request },
        QueuePriority.Interactive,
        { requestId: request.requestId as string },
      );
    } catch (e) {
      if (e instanceof ContinueWaitError) {
        // As OrchestratorApi says it for a query, for the gateway to answer
        // 200 and the client to ask again.
        // eslint-disable-next-line no-throw-literal
        throw { error: 'Continue wait' };
      }

      throw e;
    }
  }

  protected queueFor(
    queryCache: QueryCache,
    driverFactory: () => Promise<BaseDriver> | BaseDriver,
    dataSource: string,
  ): Promise<QueryQueue> {
    let byDataSource = this.queues.get(queryCache);
    if (!byDataSource) {
      byDataSource = new Map();
      this.queues.set(queryCache, byDataSource);
    }

    let queue = byDataSource.get(dataSource);
    if (!queue) {
      queue = this.createQueue(queryCache, driverFactory, dataSource);
      byDataSource.set(dataSource, queue);
      // A failure to build it isn't kept: the next read tries again.
      queue.catch(() => byDataSource?.delete(dataSource));
    }

    return queue;
  }

  protected async createQueue(
    queryCache: QueryCache,
    driverFactory: () => Promise<BaseDriver> | BaseDriver,
    dataSource: string,
  ): Promise<QueryQueue> {
    const { options } = queryCache;
    const queueOptions = options.queueOptions ? await options.queueOptions(dataSource) : {};
    // `cachePrefix` tells apart the orchestrators of different apps.
    const cachePrefix = QueryCacheInternals.prefixOf(queryCache) || 'STANDALONE';

    return QueryCache.createQueue(
      `INTROSPECTION_${cachePrefix}_${dataSource}`,
      driverFactory,
      (client, req) => {
        this.logger('Reading data source catalog', {
          operation: req.operation,
          dataSource: req.dataSource,
          requestId: req.requestId,
        });
        return runCatalogOperation(client, req);
      },
      {
        logger: this.logger,
        cacheAndQueueDriver: options.cacheAndQueueDriver,
        cubeStoreDriverFactory: options.cubeStoreDriverFactory,
        continueWaitTimeout: options.continueWaitTimeout,
        ...queueOptions,
      }
    );
  }
}
