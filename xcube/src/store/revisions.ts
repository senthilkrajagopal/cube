import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';

import { contentHash, fileHash, snapshotBytes, type SnapshotFile } from '../model/snapshot';
import type { Folder, PublishedItem } from '../names/items';
import { filesOf } from '../names/publish';
import { assertSchemaName, inTransaction } from './db';

/** `files`: a whole file set per revision (slice 2). `items`: folders and items, resolved by xcube (slice 3). */
export type ModelMode = 'files' | 'items';

/** What a model's current revision is. */
export interface ModelHead {
  model: string;
  /** Changes only when the model is recreated, for example after xcube's schema was emptied. */
  generation: string;
  revision: number;
  contentHash: string;
  mode?: ModelMode;
  /** The client's items as it wrote them, hashed (items mode). */
  itemsHash?: string | null;
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
  mode: ModelMode;
  /** `null` until the model's first import commits. */
  current: (RevisionInfo & { itemsHash: string | null }) | null;
}

export interface ItemsImportRequest {
  model: string;
  baseRevision: number | null;
  items: PublishedItem[];
  itemsHash: string;
  source: Record<string, unknown>;
  /** Replaces the folder tree in the same transaction (a snapshot). */
  folders?: Folder[];
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
  | { outcome: 'conflict' | 'mode'; current: ModelHead | null };

/** A folder that still holds items can't leave the tree. */
export class FolderInUseError extends Error {
  public constructor(public readonly folders: string[]) {
    super(`Folders still holding items can't be removed: ${folders.join(', ')}`);
  }
}

export function folderTreeHash(folders: Folder[]): string {
  const sorted = [...folders].sort((a, b) => (a.id < b.id ? -1 : 1)).map(({ id, parentId }) => ({ id, parentId }));
  return crypto.createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}

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
  importItems(request: ItemsImportRequest): Promise<ImportResult>;
  folders(model: string): Promise<Folder[]>;
  /** Replaces the folder tree; answers its hash. */
  putFolders(model: string, folders: Folder[]): Promise<string>;
  /** A revision's items, with their authored and resolved YAML. */
  items(model: string, revision: number): Promise<PublishedItem[]>;
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
      mode: row.mode ?? 'files',
      itemsHash: row.items_hash ?? null,
    };
  }

  public async heads(): Promise<ModelHead[]> {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.generation, m.current_rev, m.mode, r.content_hash, r.items_hash
         FROM ${this.s}.models m
         JOIN ${this.s}.revisions r ON r.model = m.id AND r.rev = m.current_rev`
    );
    return rows.map((row) => this.headOf(row));
  }

  public async head(model: string): Promise<ModelHead | null> {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.generation, m.current_rev, m.mode, r.content_hash, r.items_hash
         FROM ${this.s}.models m
         JOIN ${this.s}.revisions r ON r.model = m.id AND r.rev = m.current_rev
        WHERE m.id = $1`,
      [model]
    );
    return rows.length ? this.headOf(rows[0]) : null;
  }

  public async status(model: string): Promise<ModelStatus | null> {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.generation, m.mode, r.rev, r.content_hash, r.items_hash, r.file_count, r.bytes, r.created_at, r.source
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
      mode: row.mode,
      current: row.rev === null ? null : {
        revision: row.rev,
        contentHash: row.content_hash,
        itemsHash: row.items_hash,
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
      `SELECT m.id, m.generation, m.mode, r.rev AS current_rev, r.content_hash, r.items_hash
         FROM ${this.s}.revisions r
         JOIN ${this.s}.models m ON m.id = r.model
        WHERE r.model = $1 AND r.rev < $2
        ORDER BY r.rev DESC
        LIMIT $3`,
      [model, revision, limit]
    );
    return rows.map((row) => this.headOf(row));
  }

  public async folders(model: string): Promise<Folder[]> {
    const { rows } = await this.pool.query(
      `SELECT id, parent_id FROM ${this.s}.folders WHERE model = $1 ORDER BY id`,
      [model]
    );
    return rows.map((row) => ({ id: row.id, parentId: row.parent_id }));
  }

  public async putFolders(model: string, folders: Folder[]): Promise<string> {
    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(`INSERT INTO ${this.s}.models (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [model]);
      await client.query(`SELECT 1 FROM ${this.s}.models WHERE id = $1 FOR UPDATE`, [model]);
      await this.replaceFolders(client, model, folders);
      return folderTreeHash(folders);
    });
  }

  /** Under the model's row lock: refuses to drop a folder the current revision still has items in. */
  protected async replaceFolders(client: PoolClient, model: string, folders: Folder[], keeping?: PublishedItem[]) {
    const { s } = this;
    const ids = new Set(folders.map((f) => f.id));
    let used: string[];
    if (keeping) {
      used = [...new Set(keeping.map((item) => item.folderId))];
    } else {
      const { rows } = await client.query(
        `SELECT DISTINCT ri.folder_id FROM ${s}.revision_items ri
           JOIN ${s}.models m ON m.id = ri.model AND m.current_rev = ri.rev
          WHERE ri.model = $1`,
        [model]
      );
      used = rows.map((row) => row.folder_id);
    }
    const orphaned = used.filter((id) => !ids.has(id)).sort();
    if (orphaned.length) {
      throw new FolderInUseError(orphaned);
    }
    await client.query(`DELETE FROM ${s}.folders WHERE model = $1`, [model]);
    if (folders.length) {
      await client.query(
        `INSERT INTO ${s}.folders (model, id, parent_id) SELECT $1, * FROM unnest($2::text[], $3::text[])`,
        [model, folders.map((f) => f.id), folders.map((f) => f.parentId)]
      );
    }
  }

  public async items(model: string, revision: number): Promise<PublishedItem[]> {
    const { s } = this;
    const { rows } = await this.pool.query(
      `SELECT ri.folder_id, ri.name, ri.kind, ri.full_name, ri.bindings, a.content AS yaml, r.content AS resolved
         FROM ${s}.revision_items ri
         JOIN ${s}.files a ON a.model = ri.model AND a.hash = ri.authored_hash
         JOIN ${s}.revision_files rf ON rf.model = ri.model AND rf.rev = ri.rev AND rf.path = ri.full_name || '.yml'
         JOIN ${s}.files r ON r.model = rf.model AND r.hash = rf.hash
        WHERE ri.model = $1 AND ri.rev = $2
        ORDER BY ri.full_name COLLATE "C"`,
      [model, revision]
    );
    return rows.map((row) => ({
      folderId: row.folder_id,
      name: row.name,
      kind: row.kind,
      fullName: row.full_name,
      bindings: row.bindings,
      yaml: row.yaml,
      resolvedYaml: row.resolved,
    }));
  }

  /**
   * Stores the files as the model's new current revision, and announces it.
   * Imports of one model are serialized by a lock on its row, on every
   * instance. The same content as the current revision changes nothing,
   * whatever the base; otherwise a base other than the current revision is a
   * conflict. A model holding items takes no file sets.
   */
  public async import({ model, baseRevision, files, source }: ImportRequest): Promise<ImportResult> {
    return this.write({ model, baseRevision, files, source, mode: 'files' });
  }

  /**
   * Stores items as the model's new current revision: their resolved files,
   * what each was bound to, and their authored YAML. The same items as the
   * current revision change nothing, whatever the base. A file-set model
   * becomes an items model this way.
   */
  public async importItems(request: ItemsImportRequest): Promise<ImportResult> {
    return this.write({
      model: request.model,
      baseRevision: request.baseRevision,
      files: filesOf(request.items),
      source: request.source,
      mode: 'items',
      items: request.items,
      itemsHash: request.itemsHash,
      folders: request.folders,
    });
  }

  protected async write(request: {
    model: string;
    baseRevision: number | null;
    files: SnapshotFile[];
    source: Record<string, unknown>;
    mode: ModelMode;
    items?: PublishedItem[];
    itemsHash?: string;
    folders?: Folder[];
  }): Promise<ImportResult> {
    const { model, baseRevision, files, source, mode, items, itemsHash, folders } = request;
    const hash = contentHash(files);
    const { s } = this;

    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(`INSERT INTO ${s}.models (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [model]);
      // The row alone: a lock taken over a join is re-checked, after a wait,
      // against the joined row as it was, which would miss a revision the
      // holder just added.
      const { rows: [locked] } = await client.query(
        `SELECT id, generation, current_rev, mode FROM ${s}.models WHERE id = $1 FOR UPDATE`,
        [model]
      );
      let current: ModelHead | null = null;
      if (locked.current_rev !== null) {
        const { rows: [revision] } = await client.query(
          `SELECT content_hash, items_hash FROM ${s}.revisions WHERE model = $1 AND rev = $2`,
          [model, locked.current_rev]
        );
        current = this.headOf({ ...locked, ...revision });
      }

      if (mode === 'files' && current?.mode === 'items') {
        return { outcome: 'mode', current };
      }
      // Items are the same when both what the client wrote and what Cube
      // compiles are: republishing an item can rebind it.
      const same = Boolean(current) && (mode === 'items'
        ? current!.mode === 'items' && current!.itemsHash === itemsHash && current!.contentHash === hash
        : current!.contentHash === hash);
      if (!same && (current?.revision ?? null) !== baseRevision) {
        return { outcome: 'conflict', current };
      }
      if (folders) {
        await this.replaceFolders(client, model, folders, items);
      }
      if (same) {
        return { outcome: 'unchanged', head: current! };
      }

      const { rows: [{ next }] } = await client.query(
        `SELECT coalesce(max(rev), 0) + 1 AS next FROM ${s}.revisions WHERE model = $1`,
        [model]
      );
      const revision: number = next;

      const contents = [...files.map((f) => f.content), ...(items ?? []).map((item) => item.yaml)];
      const hashes = contents.map((content) => fileHash(content));
      const { rows: stored } = await client.query(
        `SELECT hash FROM ${s}.files WHERE model = $1 AND hash = ANY($2::text[])`,
        [model, [...new Set(hashes)]]
      );
      const have = new Set(stored.map((row) => row.hash));
      const missing = new Map<string, string>();
      contents.forEach((content, i) => {
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
        `INSERT INTO ${s}.revisions (model, rev, content_hash, file_count, bytes, base_rev, source, items_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [model, revision, hash, files.length, snapshotBytes(files), baseRevision, source, itemsHash ?? null]
      );
      if (files.length) {
        await client.query(
          `INSERT INTO ${s}.revision_files (model, rev, path, hash)
           SELECT $1, $2, * FROM unnest($3::text[], $4::text[])`,
          [model, revision, files.map(({ path }) => path), hashes.slice(0, files.length)]
        );
      }
      if (items?.length) {
        await client.query(
          `INSERT INTO ${s}.revision_items (model, rev, folder_id, name, kind, full_name, authored_hash, bindings)
           SELECT $1, $2, f, n, k, fn, h, b::jsonb
             FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS u(f, n, k, fn, h, b)`,
          [
            model,
            revision,
            items.map((i) => i.folderId),
            items.map((i) => i.name),
            items.map((i) => i.kind),
            items.map((i) => i.fullName),
            hashes.slice(files.length),
            items.map((i) => JSON.stringify(i.bindings)),
          ]
        );
      }
      await client.query(
        `UPDATE ${s}.models SET current_rev = $2, mode = $3, updated_at = now() WHERE id = $1`,
        [model, revision, mode]
      );

      // Retention: the oldest revisions go, then the contents no revision uses.
      const cut = revision - this.options.keepRevisions;
      if (cut > 0) {
        const { rows: goneFiles } = await client.query(
          `DELETE FROM ${s}.revision_files WHERE model = $1 AND rev <= $2 RETURNING hash`,
          [model, cut]
        );
        const { rows: goneItems } = await client.query(
          `DELETE FROM ${s}.revision_items WHERE model = $1 AND rev <= $2 RETURNING authored_hash AS hash`,
          [model, cut]
        );
        await client.query(`DELETE FROM ${s}.revisions WHERE model = $1 AND rev <= $2`, [model, cut]);
        const gone = [...new Set([...goneFiles, ...goneItems].map((row) => row.hash))];
        if (gone.length) {
          await client.query(
            `DELETE FROM ${s}.files f
              WHERE f.model = $1 AND f.hash = ANY($2::text[])
                AND NOT EXISTS (SELECT 1 FROM ${s}.revision_files rf WHERE rf.model = f.model AND rf.hash = f.hash)
                AND NOT EXISTS (SELECT 1 FROM ${s}.revision_items ri WHERE ri.model = f.model AND ri.authored_hash = f.hash)`,
            [model, gone]
          );
        }
      }

      // Delivered to every listener when the transaction commits, and never if it doesn't.
      await client.query('SELECT pg_notify($1, $2)', [channelOf(s), JSON.stringify({ model, rev: revision })]);

      return {
        outcome: 'created',
        head: {
          model, generation: locked.generation, revision, contentHash: hash, mode, itemsHash: itemsHash ?? null,
        },
      };
    });
  }
}
