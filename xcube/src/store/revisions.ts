import type { Pool } from 'pg';

import { contentHash, fileHash, snapshotBytes, type SnapshotFile } from '../model/snapshot';
import { assertSchemaName, inTransaction } from './db';

/** What a model's current revision is. */
export interface ModelHead {
  model: string;
  /** Changes only when the model is recreated, for example after xcube's schema was emptied. */
  generation: string;
  revision: number;
  contentHash: string;
}

export interface RevisionInfo {
  revision: number;
  contentHash: string;
  files: number;
  bytes: number;
  createdAt: string;
  source: Record<string, unknown>;
}

export interface ModelStatus {
  model: string;
  generation: string;
  /** `null` until the model's first import commits. */
  current: RevisionInfo | null;
}

export interface ImportRequest {
  model: string;
  /** The revision the files were based on: `null` for a model with none yet. */
  baseRevision: number | null;
  /** Sorted by path, already checked. */
  files: SnapshotFile[];
  source: Record<string, unknown>;
}

export type ImportResult =
  | { outcome: 'created' | 'unchanged'; head: ModelHead }
  | { outcome: 'conflict'; current: ModelHead | null };

/** Where revisions are kept. Postgres in production; tests may fake it. */
export interface RevisionStore {
  /** Every model's current revision. */
  heads(): Promise<ModelHead[]>;
  head(model: string): Promise<ModelHead | null>;
  status(model: string): Promise<ModelStatus | null>;
  /** A revision's files, sorted by path; `null` when it has been pruned. */
  files(model: string, revision: number): Promise<SnapshotFile[] | null>;
  /** The revisions before `revision`, newest first. */
  earlier(model: string, revision: number, limit: number): Promise<ModelHead[]>;
  import(request: ImportRequest): Promise<ImportResult>;
}

export interface PgRevisionStoreOptions {
  schema: string;
  /** Revisions kept per model, the current one included. */
  keepRevisions: number;
}

/** The NOTIFY channel each committed import announces itself on. */
export function channelOf(schema: string): string {
  return `${schema}_revision`;
}

export class PgRevisionStore implements RevisionStore {
  protected readonly s: string;

  public constructor(protected readonly pool: Pool, protected readonly options: PgRevisionStoreOptions) {
    this.s = assertSchemaName(options.schema);
  }

  protected headOf(row: any): ModelHead {
    return {
      model: row.id,
      generation: row.generation,
      revision: row.current_rev,
      contentHash: row.content_hash,
    };
  }

  public async heads(): Promise<ModelHead[]> {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.generation, m.current_rev, r.content_hash
         FROM ${this.s}.models m
         JOIN ${this.s}.revisions r ON r.model = m.id AND r.rev = m.current_rev`
    );
    return rows.map((row) => this.headOf(row));
  }

  public async head(model: string): Promise<ModelHead | null> {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.generation, m.current_rev, r.content_hash
         FROM ${this.s}.models m
         JOIN ${this.s}.revisions r ON r.model = m.id AND r.rev = m.current_rev
        WHERE m.id = $1`,
      [model]
    );
    return rows.length ? this.headOf(rows[0]) : null;
  }

  public async status(model: string): Promise<ModelStatus | null> {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.generation, r.rev, r.content_hash, r.file_count, r.bytes, r.created_at, r.source
         FROM ${this.s}.models m
         LEFT JOIN ${this.s}.revisions r ON r.model = m.id AND r.rev = m.current_rev
        WHERE m.id = $1`,
      [model]
    );
    if (!rows.length) {
      return null;
    }
    const [row] = rows;
    return {
      model: row.id,
      generation: row.generation,
      current: row.rev === null ? null : {
        revision: row.rev,
        contentHash: row.content_hash,
        files: row.file_count,
        bytes: Number(row.bytes),
        createdAt: new Date(row.created_at).toISOString(),
        source: row.source,
      },
    };
  }

  public async files(model: string, revision: number): Promise<SnapshotFile[] | null> {
    const { rows } = await this.pool.query(
      `SELECT r.file_count, rf.path, f.content
         FROM ${this.s}.revisions r
         LEFT JOIN ${this.s}.revision_files rf ON rf.model = r.model AND rf.rev = r.rev
         LEFT JOIN ${this.s}.files f ON f.model = rf.model AND f.hash = rf.hash
        WHERE r.model = $1 AND r.rev = $2
        ORDER BY rf.path COLLATE "C"`,
      [model, revision]
    );
    if (!rows.length) {
      return null;
    }
    return rows.filter((row) => row.path !== null).map((row) => ({ path: row.path, content: row.content }));
  }

  public async earlier(model: string, revision: number, limit: number): Promise<ModelHead[]> {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.generation, r.rev AS current_rev, r.content_hash
         FROM ${this.s}.revisions r
         JOIN ${this.s}.models m ON m.id = r.model
        WHERE r.model = $1 AND r.rev < $2
        ORDER BY r.rev DESC
        LIMIT $3`,
      [model, revision, limit]
    );
    return rows.map((row) => this.headOf(row));
  }

  /**
   * Stores the files as the model's new current revision, and announces it.
   * Imports of one model are serialized by a lock on its row, on every
   * instance. The same content as the current revision changes nothing,
   * whatever the base; otherwise a base other than the current revision is a
   * conflict.
   */
  public async import({ model, baseRevision, files, source }: ImportRequest): Promise<ImportResult> {
    const hash = contentHash(files);
    const { s } = this;

    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(`INSERT INTO ${s}.models (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [model]);
      // The row alone: a lock taken over a join is re-checked, after a wait,
      // against the joined row as it was, which would miss a revision the
      // holder just added.
      const { rows: [locked] } = await client.query(
        `SELECT id, generation, current_rev FROM ${s}.models WHERE id = $1 FOR UPDATE`,
        [model]
      );
      let current: ModelHead | null = null;
      if (locked.current_rev !== null) {
        const { rows: [revision] } = await client.query(
          `SELECT content_hash FROM ${s}.revisions WHERE model = $1 AND rev = $2`,
          [model, locked.current_rev]
        );
        current = this.headOf({ ...locked, content_hash: revision.content_hash });
      }

      if (current && current.contentHash === hash) {
        return { outcome: 'unchanged', head: current };
      }
      if ((current?.revision ?? null) !== baseRevision) {
        return { outcome: 'conflict', current };
      }

      const { rows: [{ next }] } = await client.query(
        `SELECT coalesce(max(rev), 0) + 1 AS next FROM ${s}.revisions WHERE model = $1`,
        [model]
      );
      const revision: number = next;

      const hashes = files.map(({ content }) => fileHash(content));
      const { rows: stored } = await client.query(
        `SELECT hash FROM ${s}.files WHERE model = $1 AND hash = ANY($2::text[])`,
        [model, [...new Set(hashes)]]
      );
      const have = new Set(stored.map((row) => row.hash));
      const missing = new Map<string, string>();
      files.forEach(({ content }, i) => {
        if (!have.has(hashes[i])) {
          missing.set(hashes[i], content);
        }
      });
      if (missing.size) {
        await client.query(
          `INSERT INTO ${s}.files (model, hash, content)
           SELECT $1, * FROM unnest($2::text[], $3::text[])`,
          [model, [...missing.keys()], [...missing.values()]]
        );
      }

      await client.query(
        `INSERT INTO ${s}.revisions (model, rev, content_hash, file_count, bytes, base_rev, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [model, revision, hash, files.length, snapshotBytes(files), baseRevision, source]
      );
      if (files.length) {
        await client.query(
          `INSERT INTO ${s}.revision_files (model, rev, path, hash)
           SELECT $1, $2, * FROM unnest($3::text[], $4::text[])`,
          [model, revision, files.map(({ path }) => path), hashes]
        );
      }
      await client.query(
        `UPDATE ${s}.models SET current_rev = $2, updated_at = now() WHERE id = $1`,
        [model, revision]
      );

      // Retention: the oldest revisions go, then the contents no revision uses.
      const cut = revision - this.options.keepRevisions;
      if (cut > 0) {
        const { rows: gone } = await client.query(
          `DELETE FROM ${s}.revision_files WHERE model = $1 AND rev <= $2 RETURNING hash`,
          [model, cut]
        );
        await client.query(`DELETE FROM ${s}.revisions WHERE model = $1 AND rev <= $2`, [model, cut]);
        if (gone.length) {
          await client.query(
            `DELETE FROM ${s}.files f
              WHERE f.model = $1 AND f.hash = ANY($2::text[])
                AND NOT EXISTS (SELECT 1 FROM ${s}.revision_files rf WHERE rf.model = f.model AND rf.hash = f.hash)`,
            [model, [...new Set(gone.map((row) => row.hash))]]
          );
        }
      }

      // Delivered to every listener when the transaction commits, and never if it doesn't.
      await client.query('SELECT pg_notify($1, $2)', [channelOf(s), JSON.stringify({ model, rev: revision })]);

      return {
        outcome: 'created',
        head: { model, generation: locked.generation, revision, contentHash: hash },
      };
    });
  }
}
