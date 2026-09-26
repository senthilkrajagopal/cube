import { BaseDriver } from '@cubejs-backend/base-driver';
import { QueryOrchestrator } from '@cubejs-backend/query-orchestrator';

import { CatalogQueues } from '../../src';

/** A driver whose schemas the catalog lists, after `delay` milliseconds. */
class SlowDriver extends BaseDriver {
  public queries: string[] = [];

  public constructor(private readonly delay: number) {
    super();
  }

  public async query<R = unknown>(sql: string): Promise<R[]> {
    this.queries.push(sql);
    await new Promise(resolve => setTimeout(resolve, this.delay));
    return [{ schema_name: 'public' }] as R[];
  }

  public async testConnection() {
    return undefined;
  }

  public override readOnly() {
    return true;
  }
}

describe('CatalogQueues', () => {
  let orchestrator: QueryOrchestrator;
  let driver: SlowDriver;

  const setUp = (delay: number) => {
    driver = new SlowDriver(delay);
    orchestrator = new QueryOrchestrator('CATALOG_QUEUE_TEST', async () => driver, () => undefined, {
      cacheAndQueueDriver: 'memory',
      continueWaitTimeout: 1,
      queryCacheOptions: {
        queueOptions: async () => ({ concurrency: 2 }),
      },
      preAggregationsOptions: {
        queueOptions: async () => ({ concurrency: 2 }),
      },
    });
  };

  afterEach(async () => {
    await orchestrator.cleanup();
  });

  const read = (queues: CatalogQueues) => queues.run<{ schema_name: string }[]>(
    orchestrator.getQueryCache(),
    () => driver,
    { operation: 'schemas', params: {}, dataSource: 'default', requestId: 'request-1' },
  );

  test('reads the catalog through the driver\'s catalog methods', async () => {
    setUp(0);

    await expect(read(new CatalogQueues(() => undefined))).resolves.toEqual([{ schema_name: 'public' }]);
    expect(driver.queries).toHaveLength(1);
    expect(driver.queries[0]).toContain('information_schema.tables');
  });

  test('reads the catalog once for the same read asked for twice at once', async () => {
    setUp(200);
    const queues = new CatalogQueues(() => undefined);

    const [first, second] = await Promise.all([read(queues), read(queues)]);

    expect(first).toEqual(second);
    expect(driver.queries).toHaveLength(1);
  });

  test('answers a read the wait timeout outlasts with Continue wait, and its result when asked again', async () => {
    setUp(1500);
    const queues = new CatalogQueues(() => undefined);

    await expect(read(queues)).rejects.toEqual({ error: 'Continue wait' });
    await expect(read(queues)).resolves.toEqual([{ schema_name: 'public' }]);
    expect(driver.queries).toHaveLength(1);
  });
});
