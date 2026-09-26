/**
 * Slice 4 end to end, in one Cube process over Postgres and DuckDB: the
 * folder gate on Cube's own routes, RS256 tokens verified against pushed
 * keys, the service credential, and the admin routes that feed them. Runs
 * when XCUBE_TEST_DATABASE_URL names a Postgres.
 *
 * The tree is /A (fa) with /A/B (fab) and /A/C (fac) under it. Groups are
 * granted on /A (g_a), /A/B (g_ab) and /A/C (g_ac), and each folder's
 * allowed set is what wechart works out: its own grants, its ancestors' and
 * its descendants', plus the Super-Admin group (sa).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Client } from 'pg';
import { DuckDBDriver } from '@cubejs-backend/duckdb-driver';

import { createConfig, DEFAULT_TOKENS, XcubeRuntime, XcubeServerCore, type XcubeSettings } from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'security-test-secret';
const PLAYGROUND_SECRET = 'security-test-playground-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-security-1';

const service = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = (key: crypto.KeyObject, kid: string) => ({ ...key.export({ format: 'jwk' }), kid });
const pem = (key: crypto.KeyObject) => key.export({ format: 'pem', type: 'pkcs8' }) as string;
const now = () => Math.floor(Date.now() / 1000);

const cubeYaml = (name: string, extra = '') => `cubes:
  - name: ${name}
    sql_table: main.orders
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: region
        sql: region
        type: string
    measures:
      - name: count
        type: count
${extra}`;

const securedYaml = cubeYaml('secured', `    access_policy:
      - group: g_a
        row_level:
          filters:
            - member: region
              operator: equals
              values: ["eu"]
      - group: sa
`);

const viewYaml = `views:
  - name: v_sales
    cubes:
      - join_path: sales
        includes:
          - count
          - region
`;

const FOLDERS = [
  { id: 'froot', parentId: null, allowedGroups: ['g_a', 'g_ab', 'g_ac', 'sa'] },
  { id: 'fa', parentId: 'froot', allowedGroups: ['g_a', 'g_ab', 'g_ac', 'sa'] },
  { id: 'fab', parentId: 'fa', allowedGroups: ['g_a', 'g_ab', 'sa'] },
  { id: 'fac', parentId: 'fa', allowedGroups: ['g_a', 'g_ac', 'sa'] },
];

describeWithDatabase('the folder gate and RS256 tokens', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  let modelDir: string;
  let driver: DuckDBDriver;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;

  beforeAll(async () => {
    process.env.CUBEJS_DB_TYPE = 'duckdb';
    // Cube would take any context signed with it; xcube ignores it.
    process.env.CUBEJS_PLAYGROUND_AUTH_SECRET = PLAYGROUND_SECRET;
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-security-'));
    driver = new DuckDBDriver({
      initSql: [
        'CREATE TABLE main.orders (id INTEGER PRIMARY KEY, region VARCHAR)',
        "INSERT INTO main.orders VALUES (1, 'eu'), (2, 'us'), (3, 'eu')",
      ].join('; '),
    });
    const settings: XcubeSettings = {
      databaseUrl: DATABASE_URL!,
      schema,
      migrate: true,
      pollIntervalMs: 60000,
      pollIntervalDownMs: 1000,
      retireGraceMs: 60000,
      keepRevisions: 10,
      limits: { maxBytes: 1024 * 1024, maxFileBytes: 256 * 1024, maxFiles: 100, fileTypes: 'yaml' },
      compileQueue: 4,
      compileWaitMs: 60000,
      catchUpMs: 10000,
      adminTokens: [ADMIN_TOKEN],
      maxModels: 100,
      modules: { packMin: 1, packMax: 300 },
      tokens: { ...DEFAULT_TOKENS, serviceKeys: JSON.stringify({ keys: [publicJwk(service.publicKey, 'svc')] }) },
    };
    runtime = new XcubeRuntime(settings, { logger: () => undefined });
    await runtime.start();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    core = new XcubeServerCore(createConfig(runtime, { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' }, {
      apiSecret: API_SECRET,
      driverFactory: () => driver,
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: 'memory',
      devServer: false,
      telemetry: false,
      logger: () => undefined,
      // As wechart's cube.js: the defaults and jobs. xcube narrows them by role.
      contextToApiScopes: async (_securityContext: any, defaults: any) => [...defaults, 'jobs'],
    }) as any);
    process.env.NODE_ENV = nodeEnv;
    await runtime.attach(core);
    const app = express();
    app.use(bodyParser.json({ limit: '50mb' }));
    await core.initApp(app);
    server = app.listen(0);
  });

  afterAll(async () => {
    server?.close();
    await runtime?.stop();
    await core?.shutdown();
    await driver?.release();
    delete process.env.CUBEJS_DB_TYPE;
    delete process.env.CUBEJS_PLAYGROUND_AUTH_SECRET;
    fs.rmSync(modelDir, { recursive: true, force: true });
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  let revision = 0;
  const base = '/cubejs-api/v1/semantic/models/dev';
  const serviceToken = (claims: Record<string, unknown> = {}) => jwt.sign(
    { aud: 'xcube-admin', role: 'service', iat: now(), exp: now() + 120, ...claims },
    pem(service.privateKey),
    { algorithm: 'RS256', keyid: 'svc' },
  );
  const userToken = (groups: string[], claims: Record<string, unknown> = {}) => jwt.sign(
    { aud: 'xcube', role: 'user', iss: 'wechart-dev', groups, iat: now(), exp: now() + 120, wechartRevision: revision, ...claims },
    pem(signer.privateKey),
    { algorithm: 'RS256', keyid: 'user-1' },
  );
  const legacyToken = (claims: Record<string, unknown> = {}) => jwt.sign({ wechartModel: 'dev', ...claims }, API_SECRET);
  const admin = (method: 'put' | 'post' | 'get', url: string, body?: object, token = serviceToken()) => {
    const req = request(server)[method](`${base}${url}`).set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const load = (token: string, measure: string) => request(server).get('/cubejs-api/v1/load')
    .query({ query: JSON.stringify({ measures: [measure] }) })
    .set('Authorization', token);
  const countOf = async (token: string, measure: string) => {
    const res = await load(token, measure);
    expect(res.status).toBe(200);
    return Number(res.body.data[0][measure]);
  };
  const metaNames = async (token: string) => {
    const res = await request(server).get('/cubejs-api/v1/meta').set('Authorization', token).expect(200);
    return res.body.cubes.map((c: any) => c.name).sort();
  };

  test('the admin routes take the service credential or an admin token; never a user\'s token', async () => {
    const res = await admin('put', '/snapshot', {
      baseRevision: null,
      folders: FOLDERS,
      items: [
        { folderId: 'froot', name: 'orders', kind: 'cube', yaml: cubeYaml('orders') },
        { folderId: 'fa', name: 'sales', kind: 'cube', yaml: cubeYaml('sales') },
        { folderId: 'fa', name: 'secured', kind: 'cube', yaml: securedYaml },
        { folderId: 'fab', name: 'v_sales', kind: 'view', yaml: viewYaml },
      ],
    }).expect(201);
    revision = res.body.revision;
    await admin('get', '/revision', undefined, ADMIN_TOKEN).expect(200);
    await admin('get', '/revision', undefined, serviceToken({ aud: 'xcube' })).expect(401);
    await admin('get', '/revision', undefined, serviceToken({ role: 'user' })).expect(401);
    await admin('get', '/revision', undefined, serviceToken({ exp: now() - 3600, iat: now() - 3700 })).expect(401);
    await admin('get', '/revision', undefined, legacyToken()).expect(401);
    // A service token naming a model administers that model alone.
    await admin('get', '/revision', undefined, serviceToken({ wechartModel: 'dev' })).expect(200);
    const other = await admin('get', '/revision', undefined, serviceToken({ wechartModel: 'other' })).expect(403);
    expect(other.body).toEqual({ error: 'This service token is for model "other"', code: 'forbidden' });
  });

  test('with security off and no keys, a model reads as before: HS256 tokens, every cube', async () => {
    expect(await countOf(legacyToken(), 'fa__sales.count')).toBe(3);
    expect(await countOf(legacyToken(), 'fab__v_sales.count')).toBe(3);
    // Its own policies are Cube's, as ever: a context in none of their groups is refused.
    expect((await load(legacyToken(), 'fa__secured.count')).status).not.toBe(200);
    expect(await countOf(legacyToken({ groups: ['g_a'] }), 'fa__secured.count')).toBe(2);
    expect(await metaNames(legacyToken())).toEqual(['fa__sales', 'fab__v_sales', 'orders']);
    // Only xcube's verifier sets a role: one in an HS256 token grants nothing.
    await request(server).get('/cubejs-api/v1/introspection/data-sources')
      .set('Authorization', legacyToken({ xcubeRole: 'service' }))
      .expect(403);
  });

  test('keys are pushed as a whole set whose version only goes up', async () => {
    await admin('get', '/keys').expect(404);
    const set = { version: 1, issuer: 'wechart-dev', keys: [publicJwk(signer.publicKey, 'user-1')] };
    const first = await admin('put', '/keys', set).expect(200);
    expect(first.body).toEqual({ model: 'dev', version: 1, issuer: 'wechart-dev', kids: ['user-1'], applied: true });
    expect((await admin('put', '/keys', set).expect(200)).body.applied).toBe(false);
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const conflict = await admin('put', '/keys', { ...set, keys: [publicJwk(other.publicKey, 'user-2')] }).expect(409);
    expect(conflict.body.code).toBe('conflict');
    await admin('put', '/keys', { version: 2, issuer: 'wechart-dev', keys: [publicJwk(signer.publicKey, 'user-1'), publicJwk(other.publicKey, 'user-2')] }).expect(200);
    const stale = await admin('put', '/keys', set).expect(409);
    expect(stale.body).toMatchObject({ code: 'stale_keys', version: 2 });
    const stored = await admin('get', '/keys').expect(200);
    expect(stored.body.keys.map((k: any) => k.kid)).toEqual(['user-1', 'user-2']);
    expect(stored.body.keys[0]).toEqual({ kty: 'RSA', kid: 'user-1', n: expect.any(String), e: 'AQAB', alg: 'RS256', use: 'sig' });

    const refused = async (keys: object[], code: string, message: RegExp) => {
      const res = await admin('put', '/keys', { version: 9, keys }).expect(400);
      expect(res.body.code).toBe(code);
      expect(res.body.error).toMatch(message);
    };
    await refused([publicJwk(service.publicKey, 'svc')], 'service_kid', /service credential's/);
    await refused([{ ...signer.privateKey.export({ format: 'jwk' }), kid: 'leak' }], 'invalid_keys', /private key members/);
    const short = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    await refused([publicJwk(short.publicKey, 'short')], 'invalid_keys', /too short/);
  });

  test('a model with keys takes only RS256 tokens signed by them, for itself', async () => {
    const hs = await load(legacyToken(), 'fa__sales.count').expect(403);
    expect(hs.body.error).toMatch(/model "dev" takes RS256 tokens only/);
    // A token naming no model would read the disk model: not once any model has keys.
    await load(jwt.sign({}, API_SECRET), 'x.count').expect(403);
    expect(await countOf(userToken([]), 'fa__sales.count')).toBe(3);
    const elsewhere = await load(userToken([], { wechartModel: 'demo' }), 'fa__sales.count').expect(403);
    expect(elsewhere.body.error).toMatch(/not one of its model's/);
    await load(userToken([], { iss: 'someone' }), 'fa__sales.count').expect(403);
    await load(userToken([], { role: 'service' }), 'fa__sales.count').expect(403);
    // The playground secret is no way in, and its system routes aren't served.
    await load(jwt.sign({ wechartModel: 'dev', groups: ['sa'] }, PLAYGROUND_SECRET), 'fa__sales.count').expect(403);
    await request(server).get('/cubejs-system/v1/context').expect(404);
  });

  test('security on: a group granted on /A/B reads the /A cube its view uses (AC-320)', async () => {
    const res = await admin('put', '/folders', { folders: FOLDERS, security: true }).expect(200);
    expect(res.body).toMatchObject({ model: 'dev', security: true });
    expect(await countOf(userToken(['g_ab']), 'fa__sales.count')).toBe(3);
    expect(await countOf(userToken(['x', 'g_ab']), 'fab__v_sales.count')).toBe(3);
    expect(await metaNames(userToken(['g_ab']))).toEqual(['fa__sales', 'fab__v_sales', 'orders']);
  });

  test('a token no folder admits sees nothing: not in /v1/meta, refused by /v1/load, 1 = 0 in /v1/sql', async () => {
    const nobody = userToken(['nobody']);
    expect(await metaNames(nobody)).toEqual([]);
    expect(await metaNames(userToken([]))).toEqual([]);
    const refused = await load(nobody, 'fa__sales.count');
    expect(refused.status).not.toBe(200);
    expect(JSON.stringify(refused.body)).toMatch(/hidden member|fa__sales/);
    const sql = await request(server).get('/cubejs-api/v1/sql')
      .query({ query: JSON.stringify({ measures: ['fa__sales.count'] }) })
      .set('Authorization', nobody)
      .expect(200);
    expect(sql.body.sql.sql[0]).toMatch(/1 = 0/);
  });

  test('a view in /A/B is closed to a group admitted to /A but not /A/B, though the /A cube is open to it', async () => {
    const ac = userToken(['g_ac']);
    expect(await countOf(ac, 'fa__sales.count')).toBe(3);
    expect(await metaNames(ac)).toEqual(['fa__sales', 'orders']);
    expect((await load(ac, 'fab__v_sales.count')).status).not.toBe(200);
  });

  test('an authored row-level policy still applies within an admitted folder', async () => {
    expect(await countOf(userToken(['g_a']), 'fa__secured.count')).toBe(2);
    expect(await countOf(userToken(['sa']), 'fa__secured.count')).toBe(3);
    // Admitted to /A, but in no group the cube's own policies name.
    expect((await load(userToken(['g_ab']), 'fa__secured.count')).status).not.toBe(200);
  });

  test('a permission change applies at once on every compiled module, with no compile', async () => {
    const compiled = [...(core as any).compilerCache.keys()].sort();
    // g_ab's grant on /A/B revoked: gone from /A/B's set, and so from its ancestors'.
    const narrowed = FOLDERS.map((f) => ({ ...f, allowedGroups: f.allowedGroups.filter((g) => g !== 'g_ab') }));
    const res = await admin('put', '/folders', { folders: narrowed }).expect(200);
    expect(res.body.security).toBe(true);
    expect((await load(userToken(['g_ab']), 'fa__sales.count')).status).not.toBe(200);
    expect(await metaNames(userToken(['g_ab']))).toEqual([]);
    expect(await countOf(userToken(['g_a']), 'fa__sales.count')).toBe(3);
    // A tree sent without groups keeps them.
    await admin('put', '/folders', { folders: FOLDERS.map(({ id, parentId }) => ({ id, parentId })) }).expect(200);
    expect((await load(userToken(['g_ab']), 'fa__sales.count')).status).not.toBe(200);
    await admin('put', '/folders', { folders: FOLDERS }).expect(200);
    expect(await countOf(userToken(['g_ab']), 'fa__sales.count')).toBe(3);
    expect([...(core as any).compilerCache.keys()].sort()).toEqual(compiled);
  });

  test('scopes by role: jobs and introspection only with the service credential, which reads no data', async () => {
    const jobs = (token: string) => request(server).post('/cubejs-api/v1/pre-aggregations/jobs')
      .set('Authorization', token)
      .send({ action: 'post', selector: { contexts: [{ securityContext: { wechartModel: 'dev' } }], timezones: ['UTC'] } });
    const user = await jobs(userToken(['sa']));
    expect({ status: user.status, error: user.body.error }).toEqual({ status: 403, error: 'API scope is missing: jobs' });
    // Past the scope check: the model simply has no pre-aggregations to build.
    const svc = await jobs(serviceToken());
    expect({ status: svc.status, error: svc.body.error })
      .toEqual({ status: 400, error: 'A user\'s selector doesn\'t match any of the pre-aggregations defined in the data model.' });
    expect((await load(serviceToken({ wechartModel: 'dev' }), 'fa__sales.count')).body.error).toMatch(/scope is missing: data/);
    await request(server).get('/cubejs-api/v1/introspection/data-sources').set('Authorization', serviceToken()).expect(200);
    // A service token naming a model builds only that model's.
    const elsewhere = await jobs(serviceToken({ wechartModel: 'other' }));
    expect({ status: elsewhere.status, error: elsewhere.body.error })
      .toEqual({ status: 403, error: 'This service token is for model "other" and builds only its pre-aggregations' });
    expect((await jobs(serviceToken({ wechartModel: 'dev' }))).status).toBe(400);
    await request(server).get('/cubejs-api/v1/introspection/data-sources').set('Authorization', userToken(['sa'])).expect(403);
  });

  test('wechart reads the field list for itself from the admin routes, unfiltered', async () => {
    const meta = await admin('get', '/meta').expect(200);
    expect(meta.body.cubes.map((c: any) => c.name).sort()).toEqual(['fa__sales', 'fa__secured', 'fab__v_sales', 'orders']);
    expect(meta.body.compilerId).toMatch(/^[0-9a-f-]{36}$/);
    const extended = await admin('get', '/meta?extended=true').expect(200);
    const sales = extended.body.cubes.find((c: any) => c.name === 'fa__sales');
    expect(sales).toHaveProperty('preAggregations');
    expect(sales).toHaveProperty('joins');
    await admin('get', '/meta', undefined, userToken(['sa'])).expect(401);
  });

  test('xcube refuses what would weaken the gate', async () => {
    const named = await admin('post', '/changesets', {
      baseRevision: revision,
      upserts: [{ folderId: 'fa', name: 'sneaky', kind: 'cube', yaml: cubeYaml('sneaky', '    access_policy:\n      - group: xcube.folder-gate\n') }],
    }).expect(422);
    expect(named.body.errors[0].message).toMatch(/may not name the group xcube.folder-gate/);
    const files = await admin('put', '/snapshot', { baseRevision: revision, files: [{ path: 'x.yml', content: cubeYaml('x') }] }).expect(409);
    expect(files.body.code).toBe('mode');

    await request(server).put('/cubejs-api/v1/semantic/models/flat/snapshot')
      .set('Authorization', `Bearer ${serviceToken()}`)
      .send({ baseRevision: null, files: [{ path: 'x.yml', content: cubeYaml('x') }] })
      .expect(201);
    const flat = await request(server).put('/cubejs-api/v1/semantic/models/flat/folders')
      .set('Authorization', `Bearer ${serviceToken()}`)
      .send({ folders: [{ id: 'froot', parentId: null }], security: true })
      .expect(409);
    expect(flat.body.code).toBe('mode');
  });

  test('turning security on keeps code without the gate off this schema', async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const { rows } = await client.query(`SELECT min_reader FROM ${schema}.schema_migrations WHERE version = 4`);
    await client.end();
    expect(rows[0].min_reader).toBe(4);
  });
});
