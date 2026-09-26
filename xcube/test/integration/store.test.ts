/**
 * xcube's schema on a real Postgres: migrations, imports and their
 * announcements, retention. Runs when XCUBE_TEST_DATABASE_URL names a
 * Postgres to use; each suite works in a schema of its own.
 */
import crypto from 'crypto';
import { Client, Pool } from 'pg';

import { checksumOf, migrate } from '../../src/store/migrate';
import { MIGRATIONS } from '../../src/store/migrations';
import { channelOf, PgRevisionStore } from '../../src/store/revisions';
import { contentHash } from '../../src/model/snapshot';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60 * 1000);

const quiet = () => undefined;
const random = () => crypto.randomBytes(4).toString('hex');

describeWithDatabase('migrate', () => {
  let pool: Pool;
  const schemas: string[] = [];
  const fresh = () => {
    const s = `xcube_t_${random()}`;
    schemas.push(s);
    return s;
  };

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  });

  afterAll(async () => {
    for (const s of schemas) {
      await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    }
    await pool.query('DROP ROLE IF EXISTS xcube_t_role');
    await pool.end();
  });

  test('applies each migration once, however many processes start together', async () => {
    const schema = fresh();
    await Promise.all([1, 2, 3].map(() => migrate(pool, { schema, apply: true, logger: quiet })));
    await migrate(pool, { schema, apply: true, logger: quiet });
    const { rows } = await pool.query(`SELECT version, checksum FROM ${schema}.schema_migrations`);
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, checksum: checksumOf(m) })));
  });

  test('refuses a schema whose applied migration differs, or that needs a newer xcube', async () => {
    const schema = fresh();
    await migrate(pool, { schema, apply: true, logger: quiet });

    await pool.query(`UPDATE ${schema}.schema_migrations SET checksum = $1 WHERE version = 1`, ['0'.repeat(64)]);
    await expect(migrate(pool, { schema, apply: true, logger: quiet })).rejects.toThrow(/differs/);
    await pool.query(`UPDATE ${schema}.schema_migrations SET checksum = $1 WHERE version = 1`, [checksumOf(MIGRATIONS[0])]);

    // A newer xcube's expand migration: this one runs on, with a warning.
    const logs: string[] = [];
    await pool.query(`INSERT INTO ${schema}.schema_migrations (version, name, checksum, min_reader) VALUES (99, 'later', $1, 1)`, ['a'.repeat(64)]);
    await migrate(pool, { schema, apply: true, logger: (m) => logs.push(m) });
    expect(logs.join()).toMatch(/newer than this xcube/);

    // A newer xcube's contract migration: this one can't read the schema.
    await pool.query(`UPDATE ${schema}.schema_migrations SET min_reader = 99 WHERE version = 99`);
    await expect(migrate(pool, { schema, apply: true, logger: quiet })).rejects.toThrow(/needs xcube schema version 99/);
  });

  test('only checks with apply off', async () => {
    const schema = fresh();
    await expect(migrate(pool, { schema, apply: false, logger: quiet })).rejects.toThrow(/does not exist/);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await expect(migrate(pool, { schema, apply: false, logger: quiet })).rejects.toThrow(/is behind/);
    await migrate(pool, { schema, apply: true, logger: quiet });
    await migrate(pool, { schema, apply: false, logger: quiet });
  });

  test('works for a role that owns only its schema, which the bootstrap created', async () => {
    const schema = fresh();
    const missing = fresh();
    const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
    await pool.query('DROP ROLE IF EXISTS xcube_t_role');
    await pool.query("CREATE ROLE xcube_t_role LOGIN PASSWORD 'xcube_t_role' NOSUPERUSER NOCREATEDB");
    await pool.query(`GRANT CONNECT ON DATABASE ${db} TO xcube_t_role`);
    await pool.query(`CREATE SCHEMA ${schema} AUTHORIZATION xcube_t_role`);

    const url = new URL(DATABASE_URL!);
    url.username = 'xcube_t_role';
    url.password = 'xcube_t_role';
    const rolePool = new Pool({ connectionString: url.toString(), max: 2 });
    try {
      await migrate(rolePool, { schema, apply: true, logger: quiet });
      await expect(migrate(rolePool, { schema: missing, apply: true, logger: quiet }))
        .rejects.toThrow(/run the xcube bootstrap/);
    } finally {
      await rolePool.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.query(`REVOKE ALL ON DATABASE ${db} FROM xcube_t_role`);
    }
  });
});

describeWithDatabase('PgRevisionStore', () => {
  let pool: Pool;
  let listener: Client;
  let store: PgRevisionStore;
  const schema = `xcube_t_${random()}`;
  const heard: string[] = [];

  const files = (n: number) => [
    { path: 'cubes/a.yml', content: 'cubes: [] # shared' },
    { path: 'cubes/b.yml', content: `cubes: [] # ${n}` },
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
    await migrate(pool, { schema, apply: true, logger: quiet });
    store = new PgRevisionStore(pool, { schema, keepRevisions: 3 });
    listener = new Client({ connectionString: DATABASE_URL });
    await listener.connect();
    listener.on('notification', ({ payload }) => heard.push(payload!));
    await listener.query(`LISTEN ${channelOf(schema)}`);
  });

  afterAll(async () => {
    await listener.end();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  test('the first import is revision 1, announced when it commits', async () => {
    expect(await store.head('m')).toBeNull();
    const result = await store.import({ model: 'm', baseRevision: null, files: files(1), source: { reason: 'startup' } });
    expect(result).toEqual({
      outcome: 'created',
      head: {
        model: 'm',
        generation: expect.stringMatching(/^[0-9a-f-]{36}$/),
        revision: 1,
        contentHash: contentHash(files(1)),
        mode: 'files',
        itemsHash: null,
      },
    });
    await settle();
    expect(heard).toEqual(['{"model":"m","rev":1}']);
    expect(await store.files('m', 1)).toEqual(files(1));
    expect(await store.status('m')).toMatchObject({
      model: 'm', current: { revision: 1, files: 2, source: { reason: 'startup' } },
    });
  });

  test('the same content changes nothing, whatever the base; a stale base is a conflict', async () => {
    heard.length = 0;
    expect((await store.import({ model: 'm', baseRevision: 7, files: files(1), source: {} })).outcome).toBe('unchanged');
    const conflict = await store.import({ model: 'm', baseRevision: null, files: files(2), source: {} });
    expect(conflict).toMatchObject({ outcome: 'conflict', current: { revision: 1 } });
    await settle();
    expect(heard).toEqual([]);
  });

  test('the same snapshot imported twice at once is one revision, and never a conflict', async () => {
    const results = await Promise.all([1, 2, 3].map(() => store.import({
      model: 'twin', baseRevision: null, files: files(50), source: {},
    })));
    expect(results.map((r) => r.outcome).sort()).toEqual(['created', 'unchanged', 'unchanged']);
    for (const result of results) {
      expect(result).toMatchObject({ head: { revision: 1, contentHash: contentHash(files(50)) } });
    }
  });

  test('of parallel imports on one base, exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.import({
      model: 'm', baseRevision: 1, files: files(100 + i), source: {},
    })));
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'conflict')).toHaveLength(9);
    expect((await store.head('m'))!.revision).toBe(2);
  });

  test('keeps the newest revisions, and a content once per model', async () => {
    for (let base = 2; base < 6; base++) {
      await store.import({ model: 'm', baseRevision: base, files: files(base + 1), source: {} });
    }
    const { rows: revisions } = await pool.query(`SELECT rev FROM ${schema}.revisions WHERE model = 'm' ORDER BY rev`);
    expect(revisions.map((r) => r.rev)).toEqual([4, 5, 6]);
    const { rows: [{ contents }] } = await pool.query(`SELECT count(*)::int AS contents FROM ${schema}.files WHERE model = 'm'`);
    expect(contents).toBe(4); // the shared file, and one per kept revision
    expect(await store.files('m', 3)).toBeNull();
    expect((await store.earlier('m', 6, 5)).map((h) => h.revision)).toEqual([5, 4]);
    expect((await store.heads()).map((h) => [h.model, h.revision]).sort()).toEqual([['m', 6], ['twin', 1]]);
  });

  test('an empty model is a revision too', async () => {
    const result = await store.import({ model: 'empty', baseRevision: null, files: [], source: {} });
    expect(result.outcome).toBe('created');
    expect(await store.files('empty', 1)).toEqual([]);
  });

  test('a model recreated after its tables were emptied is a new generation', async () => {
    const before = (await store.head('m'))!;
    await pool.query(`TRUNCATE ${schema}.models CASCADE`);
    const result = await store.import({ model: 'm', baseRevision: null, files: files(1), source: {} });
    expect(result).toMatchObject({ outcome: 'created', head: { revision: 1 } });
    expect((result as any).head.generation).not.toBe(before.generation);
  });

  test('an items import on a stale base changes nothing, not even the folder tree', async () => {
    const item = (folderId: string, name: string) => ({
      folderId,
      name,
      kind: 'cube' as const,
      yaml: `cubes:\n  - name: ${name}\n`,
      fullName: folderId === 'froot' ? name : `${folderId}__${name}`,
      bindings: {},
      resolvedYaml: `cubes:\n  - name: ${name}\n`,
    });
    const folders = [{ id: 'froot', parentId: null }, { id: 'fsales', parentId: 'froot' }];
    await store.putFolders('tree', folders);
    const first = await store.importItems({ model: 'tree', baseRevision: null, items: [item('fsales', 'a')], itemsHash: 'a'.repeat(64), source: {} });
    expect(first.outcome).toBe('created');

    const stale = await store.importItems({
      model: 'tree', baseRevision: null, items: [item('froot', 'b')], itemsHash: 'b'.repeat(64), source: {}, folders: [{ id: 'froot', parentId: null }],
    });
    expect(stale.outcome).toBe('conflict');
    expect(await store.folders('tree')).toEqual(folders);
  });
});
