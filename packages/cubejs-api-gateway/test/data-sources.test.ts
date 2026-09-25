// eslint-disable-next-line import/no-extraneous-dependencies
import express from 'express';
// eslint-disable-next-line import/no-extraneous-dependencies
import request from 'supertest';

import { ApiGateway, CubejsHandlerError, DataSourceIntrospectionApi, DataSourceTable } from '../src';
import { generateAuthToken } from './utils';

const API_SECRET = 'secret';

const TABLES: DataSourceTable[] = [
  { schema: 'public', name: 'customers', type: 'view', rawType: 'VIEW' },
  { schema: 'public', name: 'order_items', type: 'table', rawType: 'BASE TABLE' },
  { schema: 'public', name: 'orders', type: 'table', rawType: 'BASE TABLE' },
  { schema: 'public', name: 'orders_daily', type: 'materialized_view', rawType: 'MATERIALIZED VIEW' },
  { schema: 'public', name: 'unknown', type: null, rawType: null },
];

const introspectionMock = (): jest.Mocked<DataSourceIntrospectionApi> => ({
  schemas: jest.fn(async () => ['analytics', 'public', 'staging']),
  tables: jest.fn(async (_schemas: string[]) => TABLES),
  columns: jest.fn(async (tables) => tables.map(({ schema, table }) => ({
    schema,
    name: table,
    columns: [{ name: 'id', rawType: 'integer', type: 'number' as const, primaryKey: true, foreignKeys: [] }],
  }))),
  scaffold: jest.fn(async (tables, { format }) => tables.map(({ schema, table }) => ({
    cube: table,
    fileName: `${table}.${format === 'js' ? 'js' : 'yml'}`,
    content: `cubes:\n  - name: ${table}\n`,
    table: { schema, table },
    unmappedColumns: [],
  }))),
});

async function createGateway(
  { modelDataSources = [], modelError }: { modelDataSources?: string[], modelError?: Error } = {}
) {
  const introspection = introspectionMock();
  const adapterApi = {
    dataSourceIntrospection: jest.fn(() => introspection),
  };
  const compilerApi = {
    dataSources: jest.fn(async () => {
      if (modelError) {
        throw modelError;
      }
      return { dataSources: modelDataSources.map(dataSource => ({ dataSource, dbType: 'snowflake' })) };
    }),
    getDbType: jest.fn(async (dataSource: string) => (dataSource === 'default' ? 'postgres' : 'snowflake')),
  };

  const apiGateway = new ApiGateway(
    API_SECRET,
    async () => compilerApi,
    async () => adapterApi,
    () => undefined,
    {
      standalone: true,
      dataSourceStorage: {},
      basePath: '/cubejs-api',
      refreshScheduler: {},
      contextToApiScopes: async (securityContext, defaultScopes) => (
        securityContext?.introspect ? [...(defaultScopes || []), 'introspection'] : (defaultScopes || [])
      ),
    }
  );

  const app = express();
  apiGateway.initApp(app);

  return { app, adapterApi, compilerApi, introspection };
}

const token = generateAuthToken({ introspect: true }, {}, API_SECRET);
const tokenWithoutScope = generateAuthToken({}, {}, API_SECRET);

const get = (app: express.Application, url: string, auth = token) => request(app)
  .get(url)
  .set('Authorization', auth);

const post = (app: express.Application, url: string, body: unknown, auth = token) => request(app)
  .post(url)
  .set('Content-type', 'application/json')
  .set('Authorization', auth)
  .send(body as object);

describe('Data source introspection API', () => {
  const declared = process.env.CUBEJS_DATASOURCES;

  afterEach(() => {
    if (declared === undefined) {
      delete process.env.CUBEJS_DATASOURCES;
    } else {
      process.env.CUBEJS_DATASOURCES = declared;
    }
  });

  describe('scope', () => {
    test.each([
      ['get', '/cubejs-api/v1/introspection/data-sources'],
      ['get', '/cubejs-api/v1/introspection/data-sources/default/schemas'],
      ['get', '/cubejs-api/v1/introspection/data-sources/default/tables?schema=public'],
      ['post', '/cubejs-api/v1/introspection/data-sources/default/columns'],
      ['post', '/cubejs-api/v1/introspection/data-sources/default/scaffold'],
    ])('%s %s refuses a token without the introspection scope', async (method, url) => {
      const { app, adapterApi } = await createGateway();

      const res = method === 'get'
        ? await get(app, url, tokenWithoutScope).expect(403)
        : await post(app, url, { tables: [{ schema: 'public', table: 'orders' }] }, tokenWithoutScope).expect(403);

      expect(res.body.error).toEqual('API scope is missing: introspection');
      expect(adapterApi.dataSourceIntrospection).not.toHaveBeenCalled();
    });

    test('is not among the default scopes', async () => {
      const apiGateway = new ApiGateway(API_SECRET, async () => ({}), async () => ({}), () => undefined, {
        standalone: true, dataSourceStorage: {}, basePath: '/cubejs-api', refreshScheduler: {},
      });

      expect(await apiGateway.contextToApiScopesDefFn({}, [])).not.toContain('introspection');
    });
  });

  describe('GET /v1/introspection/data-sources', () => {
    test('lists the default data source when none are declared', async () => {
      delete process.env.CUBEJS_DATASOURCES;
      const { app } = await createGateway();

      const res = await get(app, '/cubejs-api/v1/introspection/data-sources').expect(200);

      expect(res.body).toEqual({ dataSources: [{ dataSource: 'default', dbType: 'postgres' }] });
    });

    test('lists the declared data sources and those the data model names, sorted', async () => {
      process.env.CUBEJS_DATASOURCES = 'default, warehouse';
      const { app } = await createGateway({ modelDataSources: ['lake', 'warehouse'] });

      const res = await get(app, '/cubejs-api/v1/introspection/data-sources').expect(200);

      expect(res.body).toEqual({
        dataSources: [
          { dataSource: 'default', dbType: 'postgres' },
          { dataSource: 'lake', dbType: 'snowflake' },
          { dataSource: 'warehouse', dbType: 'snowflake' },
        ],
      });
    });

    test('still lists the declared data sources when the data model doesn\'t compile', async () => {
      delete process.env.CUBEJS_DATASOURCES;
      const { app } = await createGateway({ modelError: new Error('Compile errors') });

      const res = await get(app, '/cubejs-api/v1/introspection/data-sources').expect(200);

      expect(res.body).toEqual({ dataSources: [{ dataSource: 'default', dbType: 'postgres' }] });
    });
  });

  describe('an unknown data source', () => {
    test.each([
      ['get', '/cubejs-api/v1/introspection/data-sources/nope/schemas'],
      ['get', '/cubejs-api/v1/introspection/data-sources/nope/tables?schema=public'],
      ['post', '/cubejs-api/v1/introspection/data-sources/nope/columns'],
      ['post', '/cubejs-api/v1/introspection/data-sources/nope/scaffold'],
    ])('%s %s answers 404', async (method, url) => {
      delete process.env.CUBEJS_DATASOURCES;
      const { app, adapterApi } = await createGateway();

      const res = method === 'get'
        ? await get(app, url).expect(404)
        : await post(app, url, { tables: [{ schema: 'public', table: 'orders' }] }).expect(404);

      expect(res.body.error).toEqual('Unknown data source: \'nope\'');
      expect(adapterApi.dataSourceIntrospection).not.toHaveBeenCalled();
    });
  });

  describe('GET /v1/introspection/data-sources/:dataSource/schemas', () => {
    test('lists the schemas of a data source the model names', async () => {
      const { app, adapterApi } = await createGateway({ modelDataSources: ['warehouse'] });

      const res = await get(app, '/cubejs-api/v1/introspection/data-sources/warehouse/schemas').expect(200);

      expect(res.body).toEqual({ schemas: [{ name: 'analytics' }, { name: 'public' }, { name: 'staging' }] });
      expect(adapterApi.dataSourceIntrospection).toHaveBeenCalledWith('warehouse', expect.any(String));
    });

    test('keeps the schemas whose name contains the search, ignoring case', async () => {
      const { app } = await createGateway();

      const res = await get(app, '/cubejs-api/v1/introspection/data-sources/default/schemas?search=PUB').expect(200);

      expect(res.body).toEqual({ schemas: [{ name: 'public' }] });
    });
  });

  describe('GET /v1/introspection/data-sources/:dataSource/tables', () => {
    test('requires a schema', async () => {
      const { app, introspection } = await createGateway();

      const res = await get(app, '/cubejs-api/v1/introspection/data-sources/default/tables').expect(400);

      expect(res.body.error).toEqual('Invalid request: "schema" is required');
      expect(introspection.tables).not.toHaveBeenCalled();
    });

    test('lists the tables of every schema named, with how many there are', async () => {
      const { app, introspection } = await createGateway();

      const res = await get(app, '/cubejs-api/v1/introspection/data-sources/default/tables?schema=public&schema=staging').expect(200);

      expect(res.body).toEqual({ tables: TABLES, total: 5 });
      expect(introspection.tables).toHaveBeenCalledWith(['public', 'staging']);
    });

    test('pages with any limit', async () => {
      const { app } = await createGateway();

      const res = await get(app, '/cubejs-api/v1/introspection/data-sources/default/tables?schema=public&limit=100000').expect(200);

      expect(res.body.total).toEqual(5);
      expect(res.body.tables).toHaveLength(5);
    });

    test('filters by search and type, then pages', async () => {
      const { app, introspection } = await createGateway();

      const res = await get(
        app,
        '/cubejs-api/v1/introspection/data-sources/default/tables?schema=public&search=ORDER&type=table&type=materialized_view&limit=2&offset=1'
      ).expect(200);

      expect(res.body).toEqual({
        tables: [TABLES[2], TABLES[3]],
        total: 3,
      });
      expect(introspection.tables).toHaveBeenCalledWith(['public']);
    });

    test.each([
      ['type=synonym', '"type" must be one of [table, view, materialized_view, external]'],
      ['limit=0', '"limit" must be greater than or equal to 1'],
      ['offset=-1', '"offset" must be greater than or equal to 0'],
      ['unexpected=1', '"unexpected" is not allowed'],
    ])('refuses %s', async (param, error) => {
      const { app } = await createGateway();

      const res = await get(app, `/cubejs-api/v1/introspection/data-sources/default/tables?schema=public&${param}`).expect(400);

      expect(res.body.error).toEqual(`Invalid request: ${error}`);
    });
  });

  describe('POST /v1/introspection/data-sources/:dataSource/columns', () => {
    test('gives the columns of each table named', async () => {
      const { app, introspection } = await createGateway();
      const tables = [{ schema: 'public', table: 'orders' }, { schema: '', table: 'events' }];

      const res = await post(app, '/cubejs-api/v1/introspection/data-sources/default/columns', { tables }).expect(200);

      expect(res.body.tables.map(({ schema, name }) => ({ schema, name }))).toEqual([
        { schema: 'public', name: 'orders' },
        { schema: '', name: 'events' },
      ]);
      expect(introspection.columns).toHaveBeenCalledWith(tables);
    });

    test.each([
      ['no tables', {}, '"tables" is required'],
      ['an empty list', { tables: [] }, '"tables" must contain at least 1 items'],
      ['a table without a name', { tables: [{ schema: 'public' }] }, '"tables[0].table" is required'],
      ['a table without a schema', { tables: [{ table: 'orders' }] }, '"tables[0].schema" is required'],
      [
        '101 tables',
        { tables: Array.from({ length: 101 }, (_, i) => ({ schema: 'public', table: `t${i}` })) },
        '"tables" must contain less than or equal to 100 items',
      ],
    ])('refuses %s', async (_, body, error) => {
      const { app, introspection } = await createGateway();

      const res = await post(app, '/cubejs-api/v1/introspection/data-sources/default/columns', body).expect(400);

      expect(res.body.error).toEqual(`Invalid request: ${error}`);
      expect(introspection.columns).not.toHaveBeenCalled();
    });

    test('takes as many tables as CUBEJS_INTROSPECTION_MAX_TABLES allows', async () => {
      const { app, introspection } = await createGateway();
      const tables = (n: number) => Array.from({ length: n }, (_, i) => ({ schema: 'public', table: `t${i}` }));
      process.env.CUBEJS_INTROSPECTION_MAX_TABLES = '2';

      try {
        await post(app, '/cubejs-api/v1/introspection/data-sources/default/columns', { tables: tables(2) }).expect(200);
        const res = await post(app, '/cubejs-api/v1/introspection/data-sources/default/columns', { tables: tables(3) })
          .expect(400);

        expect(res.body.error).toEqual('Invalid request: "tables" must contain less than or equal to 2 items');
        expect(introspection.columns).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.CUBEJS_INTROSPECTION_MAX_TABLES;
      }
    });

    test('answers a missing table with the introspection\'s 404', async () => {
      const { app, introspection } = await createGateway();
      introspection.columns.mockRejectedValueOnce(
        new CubejsHandlerError(404, 'Not Found', 'The \'default\' data source has no table public.nope')
      );

      const res = await post(app, '/cubejs-api/v1/introspection/data-sources/default/columns', {
        tables: [{ schema: 'public', table: 'nope' }],
      }).expect(404);

      expect(res.body.error).toEqual('The \'default\' data source has no table public.nope');
    });

    test('answers a query still running with Continue wait, as /v1/load does', async () => {
      const { app, introspection } = await createGateway();
      introspection.columns.mockRejectedValueOnce({ error: 'Continue wait' });

      const res = await post(app, '/cubejs-api/v1/introspection/data-sources/default/columns', {
        tables: [{ schema: 'public', table: 'orders' }],
      }).expect(200);

      expect(res.body.error).toEqual('Continue wait');
    });
  });

  describe('POST /v1/introspection/data-sources/:dataSource/scaffold', () => {
    test('generates YAML unless asked otherwise', async () => {
      const { app, introspection } = await createGateway();
      const tables = [{ schema: 'public', table: 'orders' }];

      const res = await post(app, '/cubejs-api/v1/introspection/data-sources/default/scaffold', { tables }).expect(200);

      expect(res.body).toEqual({
        cubes: [{
          cube: 'orders',
          fileName: 'orders.yml',
          content: 'cubes:\n  - name: orders\n',
          table: { schema: 'public', table: 'orders' },
          unmappedColumns: [],
        }],
      });
      expect(introspection.scaffold).toHaveBeenCalledWith(tables, { format: 'yaml' });
    });

    test('generates JavaScript when asked', async () => {
      const { app, introspection } = await createGateway();
      const tables = [{ schema: 'public', table: 'orders' }];

      await post(app, '/cubejs-api/v1/introspection/data-sources/default/scaffold', { tables, format: 'js' }).expect(200);

      expect(introspection.scaffold).toHaveBeenCalledWith(tables, { format: 'js' });
    });

    test('refuses a format it doesn\'t know', async () => {
      const { app } = await createGateway();

      const res = await post(app, '/cubejs-api/v1/introspection/data-sources/default/scaffold', {
        tables: [{ schema: 'public', table: 'orders' }],
        format: 'python',
      }).expect(400);

      expect(res.body.error).toEqual('Invalid request: "format" must be one of [yaml, js]');
    });
  });
});
