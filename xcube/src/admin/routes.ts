import bodyParser from 'body-parser';
import Joi from 'joi';
import type {
  Application as ExpressApplication,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import { getEnv } from '@cubejs-backend/shared';
import { CubejsHandlerError } from '@cubejs-backend/api-gateway';

import { LaneBusyError } from '../runtime/lane';
import { FolderTreeError, type ItemsOutcome, type XcubeRuntime } from '../runtime/runtime';
import { FolderInUseError } from '../store/revisions';
import { MODEL_ID, SnapshotError } from '../model/snapshot';
import { adminAuth } from './auth';

const file = Joi.object({
  path: Joi.string().required(),
  content: Joi.string().allow('').required(),
});

/** A JSON object of at most `maxBytes` bytes. */
function jsonObject(maxBytes: number) {
  return Joi.object()
    .unknown(true)
    .custom((value, helpers) => (
      Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes
        ? helpers.message({ custom: `must be at most ${maxBytes} bytes of JSON` })
        : value
    ));
}

const importSchema = Joi.object({
  baseRevision: Joi.number()
    .integer()
    .min(1)
    .allow(null)
    .required(),
  files: Joi.array().items(file).required(),
  source: jsonObject(4096).default({}),
});

const dryRunSchema = Joi.object({
  baseRevision: Joi.number()
    .integer()
    .min(1)
    .allow(null),
  files: Joi.array().items(file).required(),
  source: jsonObject(4096),
  securityContext: jsonObject(16384).default({}),
  probes: Joi.array().max(1000).items(Joi.object({
    id: Joi.string().max(512).required(),
    query: jsonObject(16384).required(),
    compare: Joi.boolean().default(false),
  })).default([]),
});

const folderSchema = Joi.object({
  id: Joi.string().max(64).required(),
  parentId: Joi.string().max(64).allow(null).required(),
});

const itemSchema = Joi.object({
  folderId: Joi.string().max(64).required(),
  name: Joi.string().max(64).required(),
  kind: Joi.string().valid('cube', 'view').required(),
  yaml: Joi.string().allow('').required(),
});

const itemRefSchema = Joi.object({
  folderId: Joi.string().max(64).required(),
  name: Joi.string().max(64).required(),
});

const foldersSchema = Joi.object({
  folders: Joi.array().max(100000).items(folderSchema).required(),
});

const itemsSnapshotSchema = Joi.object({
  baseRevision: Joi.number()
    .integer()
    .min(1)
    .allow(null)
    .required(),
  folders: Joi.array().max(100000).items(folderSchema).required(),
  items: Joi.array().max(20000).items(itemSchema).required(),
  source: jsonObject(4096).default({}),
});

const changesetSchema = Joi.object({
  baseRevision: Joi.number()
    .integer()
    .min(1)
    .allow(null)
    .required(),
  upserts: Joi.array().max(20000).items(itemSchema).default([]),
  deletes: Joi.array().max(20000).items(itemRefSchema).default([]),
  source: jsonObject(4096).default({}),
});

const changesetCheckSchema = changesetSchema.keys({
  baseRevision: Joi.number()
    .integer()
    .min(1)
    .allow(null),
  securityContext: jsonObject(16384).default({}),
  probes: Joi.array().max(1000).items(Joi.object({
    id: Joi.string().max(512).required(),
    query: jsonObject(16384).required(),
    compare: Joi.boolean().default(false),
  })).default([]),
});

const resolveSchema = Joi.object({
  folderId: Joi.string().max(64).required(),
  names: Joi.array().max(1000).items(Joi.string().max(64)).required(),
});

class AdminError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function valid<T>(schema: Joi.ObjectSchema, input: unknown): T {
  const { error, value } = schema.validate(input ?? {}, { abortEarly: true });
  if (error) {
    throw new AdminError(400, 'bad_request', `Invalid request: ${error.message}`);
  }
  return value;
}

function modelOf(req: Request): string {
  const { model } = req.params;
  if (!MODEL_ID.test(model)) {
    throw new AdminError(400, 'invalid_model_id', 'A model id is 1 to 63 of a-z, 0-9, _ and -, starting with a letter or digit');
  }
  return model;
}

/** Answers an items import or changeset as the snapshot import answers. */
function answerItems(res: Response, model: string, outcome: ItemsOutcome, what: 'snapshot' | 'changeset') {
  switch (outcome.status) {
    case 'mode':
      throw new AdminError(409, 'mode', `Model "${model}" holds a file set; send an items snapshot first`);
    case 'conflict':
      throw new AdminError(409, 'conflict', `The model changed since the ${what}'s base revision`, {
        currentRevision: outcome.current?.revision ?? null,
        currentItemsHash: outcome.current?.itemsHash ?? null,
      });
    case 'invalid':
      throw new AdminError(422, 'invalid_items', `The ${what} can't be published`, {
        errors: outcome.errors,
        cubeMessage: outcome.cubeMessage,
      });
    default: {
      const { head } = outcome;
      res.status(outcome.status === 'created' ? 201 : 200).json({
        model,
        generation: head.generation,
        revision: head.revision,
        created: outcome.status === 'created',
        contentHash: head.contentHash,
        itemsHash: head.itemsHash ?? null,
        items: outcome.items,
      });
    }
  }
}

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * xcube's admin routes, for wechart's server alone:
 *
 * - `PUT {basePath}/v1/semantic/models/:model/snapshot` imports the whole
 *   model as its new current revision; with `?dryRun=true` it only checks it
 *   and runs its probes, and stores nothing.
 * - `GET {basePath}/v1/semantic/models/:model/revision` is the model's
 *   current revision.
 *
 * They have their own authentication; Cube's `checkAuth` and API scopes
 * don't apply.
 */
export function initAdminRoutes(
  app: ExpressApplication,
  basePath: string,
  runtime: XcubeRuntime,
  logger: (message: string, params?: Record<string, unknown>) => void,
) {
  const { adminTokens } = runtime.settings;
  if (!adminTokens.length) {
    logger('xcube: admin routes are off, as XCUBE_ADMIN_TOKENS is unset', {});
    return;
  }

  const auth = adminAuth(adminTokens);
  const json = bodyParser.json({ limit: getEnv('maxRequestSize') });
  const base = `${basePath}/v1/semantic/models/:model`;

  const handle = (name: string, handler: Handler): RequestHandler => (req: Request, res: Response, _next: NextFunction) => {
    const started = Date.now();
    handler(req, res).catch((e: any) => {
      let status = 500;
      let body: Record<string, unknown>;
      if (e instanceof AdminError) {
        status = e.status;
        body = { error: e.message, code: e.code, ...e.details };
      } else if (e instanceof SnapshotError) {
        status = e.status;
        body = { error: e.message, code: e.code };
      } else if (e instanceof FolderTreeError) {
        status = 400;
        body = { error: 'The folder tree can\'t be taken as it is', code: 'invalid_folders', problems: e.problems };
      } else if (e instanceof FolderInUseError) {
        status = 409;
        body = { error: e.message, code: 'folder_in_use', folders: e.folders };
      } else if (e instanceof LaneBusyError) {
        status = 503;
        res.set('Retry-After', String(Math.ceil(e.retryAfterMs / 1000)));
        body = { error: e.message, code: 'busy', retryAfterMs: e.retryAfterMs };
      } else if (e instanceof CubejsHandlerError) {
        status = e.status;
        body = { error: e.message, code: status === 503 ? 'unavailable' : 'error' };
      } else if (e?.code && /^(08|57P|53)/.test(String(e.code)) || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection terminated/.test(String(e?.message))) {
        status = 503;
        body = { error: 'xcube\'s database is not reachable', code: 'unavailable' };
      } else {
        body = { error: 'Internal error', code: 'internal' };
      }
      logger('xcube: admin request failed', {
        route: name, model: req.params.model, status, error: String(e?.message ?? e), durationMs: Date.now() - started,
      });
      if (!res.headersSent) {
        res.status(status).json(body);
      }
    });
  };

  app.get(`${base}/revision`, auth, handle('revision', async (req, res) => {
    const model = modelOf(req);
    const status = await runtime.status(model);
    if (!status) {
      throw new AdminError(404, 'unknown_model', `Unknown model "${model}"`);
    }
    res.json(status);
  }));

  app.put(`${base}/snapshot`, auth, json, handle('snapshot', async (req, res) => {
    const model = modelOf(req);
    const started = Date.now();

    if (req.body && Array.isArray(req.body.items)) {
      if (req.query.dryRun !== undefined) {
        throw new AdminError(400, 'bad_request', 'An items snapshot has no dry run; check a changeset instead');
      }
      const body = valid<any>(itemsSnapshotSchema, req.body);
      const outcome = await runtime.importItemsSnapshot(model, body);
      logger('xcube: imported an items snapshot', {
        model, items: body.items.length, folders: body.folders.length, status: outcome.status, durationMs: Date.now() - started,
      });
      answerItems(res, model, outcome, 'snapshot');
      return;
    }

    if (req.query.dryRun === 'true') {
      const body = valid<any>(dryRunSchema, req.body);
      const result = await runtime.dryRun(model, body.files, body.securityContext, body.probes);
      logger('xcube: checked a snapshot', {
        model,
        files: body.files.length,
        probes: body.probes.length,
        valid: result.valid,
        contentHash: result.contentHash.slice(0, 12),
        durationMs: Date.now() - started,
      });
      res.json(result);
      return;
    }
    if (req.query.dryRun !== undefined && req.query.dryRun !== 'false') {
      throw new AdminError(400, 'bad_request', 'dryRun is true or false');
    }

    const body = valid<any>(importSchema, req.body);
    const outcome = await runtime.importSnapshot(model, body.baseRevision, body.files, body.source);
    const logged = { model, files: body.files.length, durationMs: Date.now() - started };

    switch (outcome.status) {
      case 'mode':
        throw new AdminError(409, 'mode', `Model "${model}" holds items; send changesets or an items snapshot`);
      case 'conflict':
        logger('xcube: refused a snapshot on a stale base', { ...logged, baseRevision: body.baseRevision });
        throw new AdminError(409, 'conflict', 'The model changed since the snapshot\'s base revision', {
          currentRevision: outcome.current?.revision ?? null,
          currentContentHash: outcome.current?.contentHash ?? null,
        });
      case 'invalid':
        logger('xcube: refused a snapshot that does not compile', { ...logged, errors: outcome.validation.errors.length });
        throw new AdminError(422, 'invalid_snapshot', 'The model does not compile', {
          contentHash: outcome.contentHash,
          errors: outcome.validation.errors,
          cubeMessage: outcome.validation.cubeMessage,
        });
      default: {
        const { head } = outcome;
        logger('xcube: imported a snapshot', {
          ...logged,
          revision: head.revision,
          created: outcome.status === 'created',
          contentHash: head.contentHash.slice(0, 12),
        });
        res.status(outcome.status === 'created' ? 201 : 200).json({
          model,
          generation: head.generation,
          revision: head.revision,
          created: outcome.status === 'created',
          contentHash: head.contentHash,
        });
      }
    }
  }));

  app.put(`${base}/folders`, auth, json, handle('folders', async (req, res) => {
    const model = modelOf(req);
    const body = valid<any>(foldersSchema, req.body);
    const result = await runtime.putFolders(model, body.folders);
    logger('xcube: replaced the folder tree', { model, folders: body.folders.length });
    res.json({ model, ...result });
  }));

  app.post(`${base}/changesets`, auth, json, handle('changesets', async (req, res) => {
    const model = modelOf(req);
    const started = Date.now();
    if (req.query.dryRun === 'true') {
      const body = valid<any>(changesetCheckSchema, req.body);
      const result = await runtime.applyChangeset(model, { ...body, baseRevision: body.baseRevision ?? null }, {
        securityContext: body.securityContext,
        probes: body.probes,
      });
      if ('status' in result) {
        answerItems(res, model, result, 'changeset');
        return;
      }
      logger('xcube: checked a changeset', {
        model, upserts: body.upserts.length, deletes: body.deletes.length, valid: result.valid, durationMs: Date.now() - started,
      });
      res.json(result);
      return;
    }
    if (req.query.dryRun !== undefined && req.query.dryRun !== 'false') {
      throw new AdminError(400, 'bad_request', 'dryRun is true or false');
    }
    const body = valid<any>(changesetSchema, req.body);
    const outcome = await runtime.applyChangeset(model, body) as ItemsOutcome;
    logger('xcube: applied a changeset', {
      model, upserts: body.upserts.length, deletes: body.deletes.length, status: outcome.status, durationMs: Date.now() - started,
    });
    answerItems(res, model, outcome, 'changeset');
  }));

  app.get(`${base}/items`, auth, handle('items', async (req, res) => {
    const model = modelOf(req);
    const items = await runtime.itemsOf(model);
    if (!items) {
      throw new AdminError(404, 'unknown_model', `Unknown model "${model}"`);
    }
    res.json(items);
  }));

  app.post(`${base}/resolve`, auth, json, handle('resolve', async (req, res) => {
    const model = modelOf(req);
    const body = valid<any>(resolveSchema, req.body);
    res.json(await runtime.resolveNames(model, body.folderId, body.names));
  }));
}
