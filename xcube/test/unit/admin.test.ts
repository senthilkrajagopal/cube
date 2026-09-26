import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { CubejsHandlerError } from '@cubejs-backend/api-gateway';

import { initAdminRoutes } from '../../src/admin/routes';
import { LaneBusyError } from '../../src/runtime/lane';
import { SnapshotError } from '../../src/model/snapshot';
import { DEFAULT_TOKENS, settingsFromEnv } from '../../src/runtime/settings';

const TOKEN = 'admin-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD_TOKEN = 'admin-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const head = { model: 'dev', generation: 'g', revision: 4, contentHash: 'c'.repeat(64) };

function app(runtime: any, tokens = [TOKEN, OLD_TOKEN]) {
  const a = express();
  const logs: any[] = [];
  initAdminRoutes(a, '/cubejs-api', { settings: { adminTokens: tokens }, tokens: DEFAULT_TOKENS, ...runtime }, (m, p) => logs.push([m, p]));
  return { app: a, logs };
}

const put = (a: express.Application, body: object, query = '', token = TOKEN) => request(a)
  .put(`/cubejs-api/v1/semantic/models/dev/snapshot${query}`)
  .set('Authorization', `Bearer ${token}`)
  .send(body);

describe('admin routes', () => {
  test('need a configured bearer token; a Cube JWT is not one', async () => {
    const { app: a } = app({ status: async () => ({ model: 'dev' }) });
    const url = '/cubejs-api/v1/semantic/models/dev/revision';

    const none = await request(a).get(url).expect(401);
    expect(none.headers['www-authenticate']).toBe('Bearer realm="xcube"');
    expect(none.body.code).toBe('unauthorized');
    await request(a).get(url).set('Authorization', 'Bearer wrong').expect(401);
    await request(a).get(url).set('Authorization', `Bearer ${jwt.sign({}, TOKEN)}`).expect(401);
    await request(a).get(url).set('Authorization', TOKEN).expect(401);
    await request(a).get(url).set('Authorization', `Bearer ${TOKEN}`).expect(200);
    await request(a).get(url).set('Authorization', `Bearer ${OLD_TOKEN}`).expect(200);
  });

  test('are off without tokens', async () => {
    const { app: a, logs } = app({}, []);
    await request(a).get('/cubejs-api/v1/semantic/models/dev/revision').expect(404);
    expect(logs[0][0]).toMatch(/admin routes are off/);
  });

  test('status: the model, or 404', async () => {
    const { app: a } = app({
      status: async (model: string) => (model === 'dev' ? { model, generation: 'g', current: null } : null),
    });
    const ok = await request(a).get('/cubejs-api/v1/semantic/models/dev/revision').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(ok.body).toEqual({ model: 'dev', generation: 'g', current: null });
    const missing = await request(a).get('/cubejs-api/v1/semantic/models/other/revision').set('Authorization', `Bearer ${TOKEN}`).expect(404);
    expect(missing.body.code).toBe('unknown_model');
    const bad = await request(a).get('/cubejs-api/v1/semantic/models/Bad!/revision').set('Authorization', `Bearer ${TOKEN}`).expect(400);
    expect(bad.body.code).toBe('invalid_model_id');
  });

  test('import answers each outcome', async () => {
    const outcomes: any[] = [
      { status: 'created', head },
      { status: 'unchanged', head },
      { status: 'conflict', current: head },
      { status: 'invalid', contentHash: 'h', validation: { errors: [{ path: 'a.yml', kind: 'yaml', message: 'x' }], cubeMessage: null } },
    ];
    const calls: any[] = [];
    const { app: a } = app({
      importSnapshot: async (...args: any[]) => {
        calls.push(args);
        return outcomes.shift();
      },
    });
    const body = { baseRevision: 3, files: [{ path: 'a.yml', content: '' }], source: { reason: 'publish' } };

    expect((await put(a, body).expect(201)).body).toEqual({
      model: 'dev', generation: 'g', revision: 4, created: true, contentHash: head.contentHash,
    });
    expect(calls[0]).toEqual(['dev', 3, body.files, { reason: 'publish' }]);
    expect((await put(a, body).expect(200)).body.created).toBe(false);
    expect((await put(a, body).expect(409)).body).toMatchObject({
      code: 'conflict', currentRevision: 4, currentContentHash: head.contentHash,
    });
    expect((await put(a, body).expect(422)).body).toMatchObject({
      code: 'invalid_snapshot', contentHash: 'h', errors: [{ path: 'a.yml' }], cubeMessage: null,
    });
  });

  test('import checks the request', async () => {
    const { app: a } = app({ importSnapshot: async () => ({ status: 'created', head }) });
    await put(a, { files: [] }).expect(400);
    await put(a, { baseRevision: 0, files: [] }).expect(400);
    await put(a, { baseRevision: null, files: [{ path: 'a.yml' }] }).expect(400);
    await put(a, { baseRevision: null, files: [], probes: [] }).expect(400);
    await put(a, { baseRevision: null, files: [], source: { big: 'x'.repeat(5000) } }).expect(400);
    await put(a, { baseRevision: null, files: [] }, '?dryRun=maybe').expect(400);
    await put(a, { baseRevision: null, files: [] }).expect(201);
  });

  test('maps errors: bad snapshots, a busy lane, an unavailable instance or database', async () => {
    const errors: any[] = [
      new SnapshotError(400, 'invalid_path', 'Invalid file path'),
      new SnapshotError(413, 'too_large', 'Too big'),
      new LaneBusyError(120000),
      new CubejsHandlerError(503, 'Service Unavailable', 'not serving'),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      new Error('something else'),
    ];
    const { app: a, logs } = app({
      importSnapshot: async () => {
        throw errors.shift();
      },
    });
    const body = { baseRevision: null, files: [] };
    expect((await put(a, body).expect(400)).body.code).toBe('invalid_path');
    expect((await put(a, body).expect(413)).body.code).toBe('too_large');
    const busy = await put(a, body).expect(503);
    expect(busy.body).toMatchObject({ code: 'busy', retryAfterMs: 120000 });
    expect(busy.headers['retry-after']).toBe('120');
    expect((await put(a, body).expect(503)).body.code).toBe('unavailable');
    expect((await put(a, body).expect(503)).body.code).toBe('unavailable');
    const internal = await put(a, body).expect(500);
    expect(internal.body).toEqual({ error: 'Internal error', code: 'internal' });
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  test('a dry run passes its security context and probes, and answers the check', async () => {
    const calls: any[] = [];
    const { app: a } = app({
      dryRun: async (...args: any[]) => {
        calls.push(args);
        return { model: 'dev', contentHash: 'h'.repeat(64), valid: true, errors: [], probes: [] };
      },
    });
    const res = await put(a, {
      files: [{ path: 'a.yml', content: 'cubes: []' }],
      securityContext: { tenant: 1 },
      probes: [{ id: 'p', query: { measures: ['a.count'] }, compare: true }],
    }, '?dryRun=true').expect(200);
    expect(res.body.valid).toBe(true);
    expect(calls[0]).toEqual(['dev', [{ path: 'a.yml', content: 'cubes: []' }], { tenant: 1 },
      [{ id: 'p', query: { measures: ['a.count'] }, compare: true }]]);
  });
});

describe('settingsFromEnv', () => {
  test('is null without a database', () => {
    expect(settingsFromEnv({})).toBeNull();
  });

  test('reads the defaults and the tokens', () => {
    const s = settingsFromEnv({ XCUBE_DATABASE_URL: 'postgres://x', XCUBE_ADMIN_TOKENS: `${TOKEN}, ${OLD_TOKEN}` })!;
    expect(s).toMatchObject({
      schema: 'xcube',
      migrate: true,
      pollIntervalMs: 60000,
      retireGraceMs: 300000,
      keepRevisions: 50,
      compileQueue: 4,
      catchUpMs: 10000,
      adminTokens: [TOKEN, OLD_TOKEN],
    });
  });

  test('refuses short tokens, the API secret, bad numbers and schema names', () => {
    const env = { XCUBE_DATABASE_URL: 'postgres://x' };
    expect(() => settingsFromEnv({ ...env, XCUBE_ADMIN_TOKENS: 'short' })).toThrow(/at least 32/);
    expect(() => settingsFromEnv({ ...env, XCUBE_ADMIN_TOKENS: TOKEN, CUBEJS_API_SECRET: TOKEN })).toThrow(/CUBEJS_API_SECRET/);
    expect(() => settingsFromEnv({ ...env, XCUBE_POLL_INTERVAL_MS: 'soon' })).toThrow(/whole number/);
    expect(() => settingsFromEnv({ ...env, XCUBE_DATABASE_SCHEMA: 'Bad-Name' })).toThrow(/schema name/);
    expect(settingsFromEnv({ ...env, XCUBE_MIGRATE: 'false' })!.migrate).toBe(false);
  });
});
