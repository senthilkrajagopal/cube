/**
 * Permissions and keys across instances, on a real Postgres: what the store
 * keeps, and how every instance learns of a change, by notification, by the
 * poll, or on a token naming a kid it doesn't know yet. Runs when
 * XCUBE_TEST_DATABASE_URL names a Postgres.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Client, Pool } from 'pg';

import {
  DEFAULT_TOKENS,
  OlderInstancesError,
  PermissionsError,
  PgRevisionStore,
  XcubeRuntime,
  type XcubeSettings,
} from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60 * 1000);

const signer = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = (key: crypto.KeyObject, kid: string) => ({ ...key.export({ format: 'jwk' }), kid });

async function eventually(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) {
      throw new Error('not in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeWithDatabase('permissions and keys across instances', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  const settings = (extra: Partial<XcubeSettings> = {}): XcubeSettings => ({
    databaseUrl: DATABASE_URL!,
    schema,
    migrate: true,
    pollIntervalMs: 60000,
    pollIntervalDownMs: 60000,
    retireGraceMs: 60000,
    keepRevisions: 10,
    limits: { maxBytes: 1024 * 1024, maxFileBytes: 256 * 1024, maxFiles: 100, fileTypes: 'yaml' },
    compileQueue: 4,
    compileWaitMs: 60000,
    catchUpMs: 10000,
    adminTokens: [],
    maxModels: 100,
    modules: { packMin: 50, packMax: 300 },
    tokens: DEFAULT_TOKENS,
    ...extra,
  });
  let a: XcubeRuntime;
  let b: XcubeRuntime;
  let polled: XcubeRuntime;
  let pool: Pool;
  let store: PgRevisionStore;

  beforeAll(async () => {
    a = new XcubeRuntime(settings(), { logger: () => undefined });
    await a.start();
    b = new XcubeRuntime(settings(), { logger: () => undefined });
    await b.start();
    // No listener: it learns of changes by its poll alone.
    polled = new XcubeRuntime(settings({ pollIntervalMs: 200 }), { logger: () => undefined, listenClient: null });
    await polled.start();
    pool = new Pool({ connectionString: DATABASE_URL });
    store = new PgRevisionStore(pool, { schema, keepRevisions: 10 });
  });

  afterAll(async () => {
    await Promise.all([a, b, polled].map((r) => r?.stop()));
    await pool?.end();
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  const tree = (groups: Record<string, string[] | undefined>) => Object.entries(groups).map(([id, allowedGroups]) => ({
    id, parentId: id === 'froot' ? null : 'froot', ...(allowedGroups ? { allowedGroups } : {}),
  }));

  test('the store keeps each folder\'s groups, sorted once each, and counts changes only', async () => {
    const first = await a.putFolders('dev', tree({ froot: ['sa', 'g1', 'g1'], fa: ['g2'] }));
    expect(first.security).toBe(false);
    expect(await store.permissions('dev')).toEqual({
      version: first.permissionsVersion,
      security: false,
      folders: [{ id: 'fa', allowedGroups: ['g2'] }, { id: 'froot', allowedGroups: ['g1', 'sa'] }],
    });
    // The same again, and the tree without groups: nothing changed.
    expect((await a.putFolders('dev', tree({ froot: ['g1', 'sa'], fa: ['g2'] }))).permissionsVersion).toBe(first.permissionsVersion);
    expect((await a.putFolders('dev', tree({ froot: undefined, fa: undefined }))).permissionsVersion).toBe(first.permissionsVersion);
    // A new folder has none; a removed one takes its groups with it.
    const grown = await a.putFolders('dev', tree({ froot: undefined, fb: undefined }));
    expect(grown.permissionsVersion).toBe(first.permissionsVersion + 1);
    expect((await store.permissions('dev'))!.folders).toEqual([{ id: 'fb', allowedGroups: [] }, { id: 'froot', allowedGroups: ['g1', 'sa'] }]);
    expect(await store.permissions('nobody')).toBeNull();
  });

  test('a folder that moved without its groups sent loses them; groups outlive a tree rewritten by older code', async () => {
    await a.putFolders('dev', [
      { id: 'froot', parentId: null, allowedGroups: ['g1', 'g3'] },
      { id: 'fb', parentId: 'froot', allowedGroups: ['g3'] },
      { id: 'fc', parentId: 'froot', allowedGroups: ['g1'] },
    ]);
    await a.putFolders('dev', [{ id: 'froot', parentId: null }, { id: 'fc', parentId: 'froot' }, { id: 'fb', parentId: 'fc' }]);
    expect((await store.permissions('dev'))!.folders).toEqual([
      { id: 'fb', allowedGroups: [] }, { id: 'fc', allowedGroups: ['g1'] }, { id: 'froot', allowedGroups: ['g1', 'g3'] },
    ]);
    // Code before version 4 replaces a tree by deleting and inserting its folders.
    await pool.query(`DELETE FROM ${schema}.folders WHERE model = 'dev'`);
    await pool.query(`INSERT INTO ${schema}.folders (model, id, parent_id) VALUES ('dev', 'froot', NULL), ('dev', 'fc', 'froot'), ('dev', 'fb', 'fc')`);
    expect((await store.permissions('dev'))!.folders.find((f) => f.id === 'froot')!.allowedGroups).toEqual(['g1', 'g3']);
    await a.putFolders('dev', tree({ froot: ['g1', 'g3'], fb: ['g3'] }));
  });

  test('with security on, a folder may allow no group its parent doesn\'t', async () => {
    const wider = tree({ froot: ['g1'], fb: ['g1', 'g9'] });
    await expect(a.putFolders('dev', wider, true)).rejects.toThrow(PermissionsError);
    expect((await store.permissions('dev'))!.security).toBe(false);
    // With security off, the gate is off: the groups are only kept.
    await a.putFolders('dev', wider);
    await expect(a.putFolders('dev', tree({ froot: undefined, fb: undefined }), true)).rejects.toMatchObject({ problems: ['fb allows g9, which its parent froot doesn\'t'] });
  });

  test('security can\'t be turned on while an xcube older than version 4 is connected', async () => {
    const old = new Client({ connectionString: DATABASE_URL, application_name: 'xcube:oldhost/42/abcdef' });
    await old.connect();
    try {
      await expect(a.putFolders('dev', tree({ froot: ['g1', 'g3'], fb: ['g3'] }), true)).rejects.toThrow(OlderInstancesError);
      await expect(a.putFolders('dev', tree({ froot: ['g1', 'g3'], fb: ['g3'] }), true)).rejects.toMatchObject({ instances: ['xcube:oldhost/42/abcdef'] });
    } finally {
      await old.end();
    }
    await eventually(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name = 'xcube:oldhost/42/abcdef'`)).rowCount === 0);
  });

  test('a change reaches the other instances by notification, and by the poll without one', async () => {
    const { permissionsVersion } = await a.putFolders('dev', tree({ froot: ['g1', 'g3'], fb: ['g3'] }), true);
    for (const r of [a, b, polled]) {
      await eventually(() => r.permissionsOf('dev')?.version === permissionsVersion);
      expect(r.permissionsOf('dev')!.security).toBe(true);
      expect(r.admits('dev', 'fb', new Set(['g3']))).toBe(true);
      expect(r.admits('dev', 'fb', new Set(['g1']))).toBe(false);
    }
    await a.putFolders('dev', tree({ froot: ['g1', 'g3'], fb: ['g1', 'g3'] }));
    await eventually(() => b.admits('dev', 'fb', new Set(['g1'])));
    await eventually(() => polled.admits('dev', 'fb', new Set(['g1'])));
  });

  test('a database whose versions went back (restored from a backup) is taken as it is', async () => {
    await pool.query(`UPDATE ${schema}.models SET permissions_version = 1, security = false WHERE id = 'dev'`);
    await b.refreshSecurity();
    expect(b.permissionsOf('dev')).toMatchObject({ version: 1, security: false });
  });

  test('keys reach the other instances; one that hasn\'t heard yet reads them for the token that needs them', async () => {
    const quiet = new XcubeRuntime(settings(), { logger: () => undefined, listenClient: null });
    await quiet.start();
    try {
      await a.putKeys('dev', { version: 1, keys: [publicJwk(signer.publicKey, 'k1')] });
      await eventually(() => b.verifier.hasKeys('dev'));
      await eventually(() => polled.verifier.hasKeys('dev'));
      expect(quiet.verifier.hasKeys('dev')).toBe(false);

      const now = Math.floor(Date.now() / 1000);
      const token = jwt.sign({ aud: 'xcube', role: 'user', groups: ['g1'], iat: now, exp: now + 60 },
        signer.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, { algorithm: 'RS256', keyid: 'k1' });
      const { securityContext } = await quiet.verifier.verify(token);
      expect(securityContext).toMatchObject({ xcubeModel: 'dev', groups: ['g1'] });
    } finally {
      await quiet.stop();
    }
  });

  test('an overlay dropped on one instance is gone on the others at once, not after their cache\'s 30 s', async () => {
    const overlay = {
      model: 'dev',
      id: 'ws-x',
      upserts: [],
      deletes: [],
      contentHash: 'a'.repeat(64),
      validatedRevision: null,
      validatedTree: null,
      connections: [],
      expiresAt: new Date(Date.now() + 60000),
    };
    const { overlay: stored } = await store.putOverlay(overlay, 100);
    await eventually(async () => (await (b as any).overlayRecord('dev', 'ws-x'))?.version === stored!.version);
    await store.deleteOverlay('dev', 'ws-x');
    await eventually(async () => (await (b as any).overlayRecord('dev', 'ws-x')) === null, 2000);
    // Pushed again, it has a newer version: nothing compiled for the dropped one is taken for it.
    const { overlay: again } = await store.putOverlay({ ...overlay, contentHash: 'b'.repeat(64) }, 100);
    expect(again!.version).toBeGreaterThan(stored!.version);
    await eventually(async () => (await (b as any).overlayRecord('dev', 'ws-x'))?.version === again!.version, 2000);
    await store.deleteOverlay('dev', 'ws-x');
  });

  test('of two different sets pushed with one version at once, exactly one is kept', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const results = await Promise.all([
      a.putKeys('race', { version: 5, keys: [publicJwk(signer.publicKey, 'r1')] }),
      b.putKeys('race', { version: 5, keys: [publicJwk(other.publicKey, 'r2')] }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['conflict', 'replaced']);
    expect((await store.keys('race'))!.keys).toHaveLength(1);
  });
});
