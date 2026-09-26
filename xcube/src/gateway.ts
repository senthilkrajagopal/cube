import crypto from 'crypto';
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
import { initAdminRoutes } from './admin/routes';
import { MODULE_KEY, type XcubeRuntime } from './runtime/runtime';

/** A UUID derived from text, for the compiler id of a merged meta (the SQL API wants a UUID). */
function uuidOf(text: string): string {
  const h = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const variant = '89ab'[parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

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
export class XcubeApiGateway extends ApiGateway {
  public constructor(
    apiSecret: string,
    compilerApi: (ctx: RequestContext) => Promise<any>,
    adapterApi: (ctx: RequestContext) => Promise<any>,
    logger: any,
    options: ApiGatewayOptions,
    protected readonly introspectionFor: IntrospectionFactory,
    protected readonly xcubeRuntime: () => XcubeRuntime | undefined = () => undefined,
  ) {
    super(apiSecret, compilerApi, adapterApi, logger, options);
  }

  public initApp(app: ExpressApplication) {
    // Before Cube's routes, so that Cube's error middleware, which it adds
    // last, also answers for these.
    this.initIntrospectionRoutes(app);
    const runtime = this.xcubeRuntime();
    if (runtime) {
      initAdminRoutes(app, this.basePath, runtime, (type, params) => this.log({ type, ...params }));
      // Before Cube's jobs route: each job's context names the module its pre-aggregations are in.
      app.post(`${this.basePath}/v1/pre-aggregations/jobs`, (req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => {
        this.fanOutJobs(runtime, req.body);
        next();
      });
    }
    super.initApp(app);
  }

  /**
   * A jobs `post` builds pre-aggregations for each context of its selector;
   * a model served in modules gets one context per module that holds them,
   * the module named in the security context, where jobs keep it.
   */
  protected fanOutJobs(runtime: XcubeRuntime, body: any) {
    const selector = body?.action === 'post' ? body.selector : undefined;
    if (!runtime.serving || !selector || !Array.isArray(selector.contexts)) {
      return;
    }
    selector.contexts = selector.contexts.flatMap((context: any) => {
      const modules = runtime.jobModules(context?.securityContext, selector);
      return modules
        ? modules.map((id) => ({ ...context, securityContext: { ...context.securityContext, [MODULE_KEY]: id } }))
        : [context];
    });
  }

  /** `/v1/meta` of a model served in modules: every module's own answer, merged. */
  public async meta(args: Parameters<ApiGateway['meta']>[0]) {
    const modules = this.xcubeRuntime()?.metaModules(args.context);
    if (!modules) {
      return super.meta(args);
    }
    return this.mergedMeta(modules, args.context, args.res, (context, res) => super.meta({ ...args, context, res }));
  }

  public async metaExtended(args: Parameters<ApiGateway['metaExtended']>[0]) {
    const modules = this.xcubeRuntime()?.metaModules(args.context);
    if (!modules) {
      return super.metaExtended(args);
    }
    return this.mergedMeta(modules, args.context, args.res, (context, res) => super.metaExtended({ ...args, context, res }));
  }

  /**
   * Asks each module, as Cube answers it (visibility is per cube, so the
   * union is what one model would answer), and merges: each cube and view
   * group once, join-graph components renumbered across modules, and a
   * compiler id derived from the modules'.
   */
  protected async mergedMeta(
    modules: string[],
    context: any,
    res: (body: any, options?: any) => any,
    ask: (context: any, res: (body: any, options?: any) => void) => Promise<void>,
  ) {
    const answers: any[] = [];
    for (const id of modules) {
      let body: any;
      let status = 200;
      await ask({ ...context, [MODULE_KEY]: id }, (b, options) => {
        body = b;
        status = options?.status ?? 200;
      });
      if (status !== 200) {
        return res(body, { status });
      }
      answers.push(body);
    }

    // A cube's join-graph component in every module holding it is one
    // component: joined through shared cubes, as one model's would be.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) {
        root = parent.get(root)!;
      }
      return root;
    };
    const nodesOf = new Map<string, string[]>();
    answers.forEach((answer, i) => (answer?.cubes ?? []).forEach((cube: any) => {
      if (typeof cube.connectedComponent === 'number') {
        const node = `${i}:${cube.connectedComponent}`;
        if (!parent.has(node)) {
          parent.set(node, node);
        }
        nodesOf.set(cube.name, [...(nodesOf.get(cube.name) ?? []), node]);
      }
    }));
    nodesOf.forEach((nodes) => nodes.slice(1).forEach((node) => {
      const a = find(nodes[0]);
      const b = find(node);
      if (a !== b) {
        parent.set(b, a);
      }
    }));

    const cubes: any[] = [];
    const seen = new Set<string>();
    const numbers = new Map<string, number>();
    for (const answer of answers) {
      const fresh = (answer?.cubes ?? []).filter((cube: any) => !seen.has(cube.name));
      for (const cube of fresh) {
        seen.add(cube.name);
        const nodes = nodesOf.get(cube.name);
        if (nodes) {
          const root = find(nodes[0]);
          if (!numbers.has(root)) {
            numbers.set(root, numbers.size + 1);
          }
          cubes.push({ ...cube, connectedComponent: numbers.get(root) });
        } else {
          cubes.push(cube);
        }
      }
    }
    const merged: any = { cubes };
    const groups = new Map<string, any>();
    answers.forEach((a) => (a?.viewGroups ?? []).forEach((g: any) => groups.set(g.name, groups.get(g.name) ?? g)));
    if (groups.size) {
      merged.viewGroups = [...groups.values()];
    }
    if (answers.some((a) => a?.compilerId)) {
      merged.compilerId = uuidOf(answers.map((a) => a?.compilerId ?? '').join(','));
    }
    return res(merged);
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
    // A model served in modules is asked module by module, never compiled whole.
    const modules = this.xcubeRuntime()?.metaModules(context);
    const contexts = modules ? modules.map((id) => ({ ...context, [MODULE_KEY]: id })) : [context];
    const compilerApi = await this.getCompilerApi(contexts[0] as RequestContext);
    const declared = getEnv('dataSources');
    const names = new Set<string>(declared.length ? declared : ['default']);

    try {
      for (const one of contexts) {
        const { dataSources } = await (await this.getCompilerApi(one as RequestContext))
          .dataSources(await this.getAdapterApi(one as RequestContext));
        dataSources.forEach(({ dataSource }) => names.add(dataSource));
      }
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
