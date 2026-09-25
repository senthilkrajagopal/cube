import bodyParser from 'body-parser';
import type {
  Application as ExpressApplication,
  NextFunction,
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
} from 'express';
import type Joi from 'joi';
import { getEnv } from '@cubejs-backend/shared';
import {
  ApiGateway,
  ApiGatewayOptions,
  ContextToApiScopesFn,
  CubejsHandlerError,
  Request,
  RequestContext,
  UserError,
} from '@cubejs-backend/api-gateway';

import {
  dataSourceColumnsRequestSchema,
  DataSourceScaffoldRequest,
  dataSourceScaffoldRequestSchema,
  dataSourceSchemasRequestSchema,
  DataSourceTableRefsRequest,
  DataSourceTablesRequest,
  dataSourceTablesRequestSchema,
  matchesSearch,
  pageOfTables,
} from './requests';
import type { DataSourceDescription, DataSourceIntrospectionApi } from './types';

/** The API scope the introspection routes are in. */
export const INTROSPECTION_SCOPE = 'introspection';

/**
 * The introspection of one data source, for one request, from the
 * orchestrator API Cube serves the request's context with.
 */
export type IntrospectionFactory = (
  orchestratorApi: any,
  dataSource: string,
  requestId?: string,
) => DataSourceIntrospectionApi;

type Handler = (req: Request, res: ExpressResponse) => Promise<void>;

function asyncHandler(handler: Handler): RequestHandler {
  return (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    handler(req as Request, res).catch(next);
  };
}

/**
 * Cube's API gateway with the data source introspection routes added, under
 * `{basePath}/v1/introspection/data-sources`, in the `introspection` API
 * scope. Every other route is Cube's own, unchanged.
 */
export class IntrospectionApiGateway extends ApiGateway {
  public constructor(
    apiSecret: string,
    compilerApi: (ctx: RequestContext) => Promise<any>,
    adapterApi: (ctx: RequestContext) => Promise<any>,
    logger: any,
    options: ApiGatewayOptions,
    protected readonly introspectionFor: IntrospectionFactory,
  ) {
    super(apiSecret, compilerApi, adapterApi, logger, options);
  }

  public initApp(app: ExpressApplication) {
    // Before Cube's routes, so that Cube's error middleware, which it adds
    // last, also answers for these.
    this.initIntrospectionRoutes(app);
    super.initApp(app);
  }

  /**
   * Cube's, and `introspection` besides: upstream refuses a scope it doesn't
   * know, so it is taken out of what `contextToApiScopes` grants before
   * Cube checks the rest, and put back after.
   */
  protected createContextToApiScopesFn(options: ApiGatewayOptions): ContextToApiScopesFn {
    const { contextToApiScopes } = options;
    if (!contextToApiScopes) {
      return super.createContextToApiScopesFn(options);
    }

    return async (securityContext, defaultApiScopes) => {
      let granted = false;
      const upstream = super.createContextToApiScopesFn({
        ...options,
        contextToApiScopes: async (context, defaults) => {
          const scopes: any = await contextToApiScopes(context, defaults);
          if (!Array.isArray(scopes) || !scopes.includes(INTROSPECTION_SCOPE as any)) {
            return scopes;
          }

          granted = true;
          return scopes.filter(scope => scope !== INTROSPECTION_SCOPE as any);
        },
      });

      const scopes = await upstream(securityContext, defaultApiScopes);
      return granted ? [...scopes, INTROSPECTION_SCOPE as any] : scopes;
    };
  }

  protected initIntrospectionRoutes(app: ExpressApplication) {
    const userMiddlewares: RequestHandler[] = [
      this.checkAuth,
      this.requestContextMiddleware,
      this.contextRejectionMiddleware,
      this.logNetworkUsage,
      this.requestLoggerMiddleware,
    ];
    const jsonParser = bodyParser.json({ limit: getEnv('maxRequestSize') });
    const path = `${this.basePath}/v1/introspection/data-sources`;

    app.get(
      path,
      userMiddlewares,
      asyncHandler(async (req, res) => {
        await this.introspect(req, res, async (context) => ({
          dataSources: await this.dataSourceDescriptions(context),
        }));
      })
    );

    app.get(
      `${path}/:dataSource/schemas`,
      userMiddlewares,
      asyncHandler(async (req, res) => {
        await this.introspect(req, res, async (context) => {
          const { search } = this.validRequest<{ search?: string }>(dataSourceSchemasRequestSchema, req.query);
          const introspection = await this.dataSourceIntrospection(context, req.params.dataSource);
          const schemas = await introspection.schemas();
          return {
            schemas: schemas.filter(name => matchesSearch(name, search)).map(name => ({ name })),
          };
        });
      })
    );

    app.get(
      `${path}/:dataSource/tables`,
      userMiddlewares,
      asyncHandler(async (req, res) => {
        await this.introspect(req, res, async (context) => {
          const { schema, ...page } = this.validRequest<DataSourceTablesRequest>(
            dataSourceTablesRequestSchema,
            req.query,
          );
          const introspection = await this.dataSourceIntrospection(context, req.params.dataSource);
          return pageOfTables(await introspection.tables(schema), page);
        });
      })
    );

    app.post(
      `${path}/:dataSource/columns`,
      jsonParser,
      userMiddlewares,
      asyncHandler(async (req, res) => {
        await this.introspect(req, res, async (context) => {
          const { tables } = this.validRequest<DataSourceTableRefsRequest>(
            dataSourceColumnsRequestSchema(),
            req.body,
          );
          const introspection = await this.dataSourceIntrospection(context, req.params.dataSource);
          return { tables: await introspection.columns(tables) };
        });
      })
    );

    app.post(
      `${path}/:dataSource/scaffold`,
      jsonParser,
      userMiddlewares,
      asyncHandler(async (req, res) => {
        await this.introspect(req, res, async (context) => {
          const { tables, format } = this.validRequest<DataSourceScaffoldRequest>(
            dataSourceScaffoldRequestSchema(),
            req.body,
          );
          const introspection = await this.dataSourceIntrospection(context, req.params.dataSource);
          return { cubes: await introspection.scaffold(tables, { format }) };
        });
      })
    );
  }

  /**
   * Answers an introspection request with what `handler` returns, once the
   * context holds the `introspection` scope, and answers any error as every
   * other endpoint does.
   */
  protected async introspect(
    req: Request,
    res: ExpressResponse,
    handler: (context: RequestContext) => Promise<unknown>,
  ) {
    const response = this.resToResultFn(res);
    const requestStarted = new Date();
    const context = <RequestContext>req.context;

    try {
      await this.assertApiScope(INTROSPECTION_SCOPE as any, context?.securityContext);
      response(await handler(context), { status: 200 });
    } catch (e: any) {
      this.handleError({
        e,
        context,
        query: { dataSource: req.params?.dataSource, ...req.query, ...req.body },
        res: response,
        requestStarted,
      });
    }
  }

  protected validRequest<T>(schema: Joi.ObjectSchema, input: unknown): T {
    const { error, value } = schema.validate(input || {});
    if (error) {
      throw new UserError(`Invalid request: ${error.message || error.toString()}`);
    }

    return value;
  }

  /**
   * The data sources a client may browse: those declared in
   * `CUBEJS_DATASOURCES` (or just `default` when none are), and those the
   * data model names. The data model's are skipped when it doesn't compile,
   * so a broken model doesn't stop anyone browsing tables to fix it.
   */
  protected async dataSourceDescriptions(context: RequestContext): Promise<DataSourceDescription[]> {
    const compilerApi = await this.getCompilerApi(context);
    const declared = getEnv('dataSources');
    const names = new Set<string>(declared.length ? declared : ['default']);

    try {
      const { dataSources } = await compilerApi.dataSources(await this.getAdapterApi(context));
      dataSources.forEach(({ dataSource }) => names.add(dataSource));
    } catch (e: any) {
      this.log({
        type: 'Data sources of the data model skipped',
        error: (e.stack || e).toString(),
      }, context);
    }

    return Promise.all([...names].sort().map(async (dataSource) => ({
      dataSource,
      dbType: await compilerApi.getDbType(dataSource),
    })));
  }

  /**
   * @throws CubejsHandlerError 404 when the data source isn't one the client may browse
   */
  protected async dataSourceIntrospection(
    context: RequestContext,
    dataSource: string,
  ): Promise<DataSourceIntrospectionApi> {
    const known = await this.dataSourceDescriptions(context);
    if (!known.some(description => description.dataSource === dataSource)) {
      throw new CubejsHandlerError(404, 'Not Found', `Unknown data source: '${dataSource}'`);
    }

    return this.introspectionFor(await this.getAdapterApi(context), dataSource, context.requestId);
  }
}
