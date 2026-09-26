import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';

import type { Logger } from './db';
import { MIGRATIONS, SCHEMA_VERSION, type Migration } from './migrations';

export interface MigrateOptions {
  schema: string;
  /** `false` only checks that the schema is up to date, and refuses to start when it isn't. */
  apply: boolean;
  logger: Logger;
  /** How long to wait for another process's migration. */
  lockTimeoutMs?: number;
  migrations?: Migration[];
}

/** The same for every schema name, so disposable test schemas share checksums. */
export function checksumOf(migration: Migration): string {
  return crypto.createHash('sha256').update(migration.sql('__schema__'), 'utf8').digest('hex');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lock(client: PoolClient, key: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    if (rows[0].locked) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`xcube: another process has held the migration lock for ${timeoutMs} ms`);
    }
    await sleep(250);
  }
}

/**
 * Brings xcube's schema up to date, under an advisory lock, so any number of
 * processes may start at once. Each migration runs in its own transaction.
 *
 * The schema is created only when it is missing, and only by a role allowed
 * to: `CREATE SCHEMA IF NOT EXISTS` is refused for a role without `CREATE` on
 * the database even when the schema exists, so the bootstrap creates it for
 * the xcube role.
 */
export async function migrate(pool: Pool, options: MigrateOptions): Promise<void> {
  const { schema, apply, logger } = options;
  const migrations = options.migrations ?? MIGRATIONS;
  const newest = migrations[migrations.length - 1]?.version ?? SCHEMA_VERSION;
  const client = await pool.connect();

  try {
    await lock(client, `${schema}.migrate`, options.lockTimeoutMs ?? 5 * 60 * 1000);
    try {
      const { rowCount } = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
      if (!rowCount) {
        if (!apply) {
          throw new Error(`xcube: schema ${schema} does not exist`);
        }
        try {
          await client.query(`CREATE SCHEMA ${schema}`);
        } catch (e: any) {
          throw new Error(
            `xcube: schema ${schema} does not exist and this role may not create it (${e.message}): run the xcube bootstrap`
          );
        }
      }

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
          version    integer     PRIMARY KEY,
          name       text        NOT NULL,
          checksum   char(64)    NOT NULL,
          min_reader integer     NOT NULL DEFAULT 1,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);

      const { rows } = await client.query(
        `SELECT version, name, checksum, min_reader FROM ${schema}.schema_migrations ORDER BY version`
      );
      const applied = new Map<number, { name: string; checksum: string; min_reader: number }>(
        rows.map((row) => [row.version, row])
      );

      for (const migration of migrations) {
        const row = applied.get(migration.version);
        if (row && row.checksum !== checksumOf(migration)) {
          throw new Error(
            `xcube: migration ${migration.version} (${migration.name}) differs from the one applied to ${schema}`
          );
        }
      }

      const minReader = Math.max(0, ...rows.map((row) => row.min_reader));
      if (minReader > newest) {
        throw new Error(
          `xcube: schema ${schema} needs xcube schema version ${minReader} or later to read it; this is ${newest}`
        );
      }
      const unknown = rows.filter((row) => row.version > newest);
      if (unknown.length) {
        logger('xcube: the schema has migrations newer than this xcube; running on', {
          versions: unknown.map((row) => row.version),
          warning: 'schema newer than this xcube',
        });
      }

      const pending = migrations.filter((migration) => !applied.has(migration.version));
      if (pending.length && !apply) {
        throw new Error(
          `xcube: schema ${schema} is behind (pending: ${pending.map((m) => m.version).join(', ')}) and XCUBE_MIGRATE is false`
        );
      }

      for (const migration of pending) {
        await client.query('BEGIN');
        try {
          await client.query("SET LOCAL lock_timeout = '10s'");
          await client.query(migration.sql(schema));
          await client.query(
            `INSERT INTO ${schema}.schema_migrations (version, name, checksum, min_reader) VALUES ($1, $2, $3, $4)`,
            [migration.version, migration.name, checksumOf(migration), migration.minReader]
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
        logger('xcube: migrated', { schema, version: migration.version, name: migration.name });
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${schema}.migrate`]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
