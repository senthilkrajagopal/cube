import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';

import { contentHash, fileHash, snapshotBytes, type SnapshotFile } from '../model/snapshot';
import type { AuthoredItem, Folder, PublishedItem } from '../names/items';
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

/** A module of a stored revision. */
export interface StoredModule {
  id: string;
  /** SHA-256 of its files: an unchanged module keeps its compiled model. */
  version: string;
  members: string[];
  copies: string[];
}

export interface ItemsImportRequest {
  model: string;
  baseRevision: number | null;
  items: PublishedItem[];
  itemsHash: string;
  source: Record<string, unknown>;
  /** Replaces the folder tree in the same transaction (a snapshot). */
  folders?: Folder[];
  modules?: StoredModule[];
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

/** A model's permissions as stored. */
export interface StoredPermissions {
  version: number;
  security: boolean;
  folders: { id: string; allowedGroups: string[] }[];
}

/** The public keys a model's user tokens are signed with, pushed as a whole set. */
export interface StoredKeySet {
  /** Only goes up: a set with a lower version never replaces a newer one. */
  version: number;
  issuer: string | null;
  keys: Record<string, unknown>[];
}

export type PutKeysResult =
  | { outcome: 'replaced' | 'unchanged'; current: StoredKeySet }
  | { outcome: 'stale' | 'conflict'; current: StoredKeySet };

/** A workspace's or a proposal's unpublished items, as stored. */
/** A data source an overlay brings: a connection as it would land in its folder, secrets sealed. */
export interface OverlayConnection {
  folderId: string;
  /** Its short name in the folder. */
  name: string;
  driver: string;
  authMethod: string;
  fields: Record<string, string | number | boolean | null>;
  sealed: Record<string, unknown>;
}

export interface StoredOverlay {
  model: string;
  id: string;
  version: number;
  upserts: AuthoredItem[];
  deletes: { folderId: string; name: string }[];
  /** Data sources previews of it query in place of, or beside, the published ones. */
  connections: OverlayConnection[];
  /** SHA-256 of the upserts, deletes and connections: a push of the same content changes nothing but the expiry. */
  contentHash: string;
  /** The published revision it was last checked against. */
  validatedRevision: number | null;
  /** The folder tree it was checked against (`folderTreeHash`). */
  validatedTree: string | null;
  expiresAt: Date;
}

export type PutOverlayResult = {
  outcome: 'created' | 'updated' | 'unchanged' | 'too_many' | 'conflict';
  overlay: StoredOverlay | null;
};

/** A data source of a model: where it connects, and its sealed secrets. */
export interface StoredConnection {
  model: string;
  /** What models name it by: its short name in the root, `<folderId>__<name>` elsewhere. */
  name: string;
  folderId: string;
  driver: string;
  authMethod: string;
  /** Its fields, secrets excepted. */
  fields: Record<string, string | number | boolean | null>;
  /** Each secret field's envelope, sealed to xcube's credential key. */
  sealed: Record<string, unknown>;
  /** The client's revision id of each secret, reported back as what a live driver uses. */
  revisions: Record<string, string>;
  version: number;
  updatedAt: Date;
}

/** What each model's permissions and keys are at, for an instance to tell it is behind. */
export interface ModelVersions {
  model: string;
  permissions: number;
  keys: number | null;
}

/** Folder groups the gate can't be sound with: a child allowing a group its parent doesn't. */
export class PermissionsError extends Error {
  public constructor(public readonly problems: string[]) {
    super('Each folder\'s allowed groups must include all of its children\'s');
  }
}

/** What older code would serve wrongly can't be turned on while it still serves the schema. */
export class OlderInstancesError extends Error {
  public constructor(
    public readonly instances: string[],
    message = 'xcube instances older than schema version 4 are connected; they serve without the folder gate. Turn security on once every instance runs this version',
  ) {
    super(message);
  }
}

/** Security can't be on for a model that holds a file set: only published items carry their folder. */
export class SecurityModeError extends Error {
  public constructor(model: string) {
    super(`Model "${model}" holds a file set; security needs items, as only items carry their folder`);
  }
}

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
  /**
   * Replaces the folder tree, setting the allowed groups of the folders
   * that carry them, and security when given.
   */
  putFolders(model: string, folders: Folder[], security?: boolean): Promise<{
    hash: string;
    permissionsVersion: number;
    security: boolean;
  }>;
  permissions(model: string): Promise<StoredPermissions | null>;
  versions(): Promise<ModelVersions[]>;
  putKeys(model: string, set: StoredKeySet): Promise<PutKeysResult>;
  keys(model: string): Promise<StoredKeySet | null>;
  /**
   * Stores an overlay's new content, or only extends its life when the
   * content is the same; with `baseVersion`, only over that version
   * (`null`: only as a new overlay).
   */
  putOverlay(overlay: Omit<StoredOverlay, 'version'>, maxOverlays: number, baseVersion?: number | null): Promise<PutOverlayResult>;
  /** An overlay that hasn't expired. */
  overlay(model: string, id: string): Promise<StoredOverlay | null>;
  /** How many live overlays a model holds. */
  overlayCount(model: string): Promise<number>;
  connections(model: string): Promise<StoredConnection[]>;
  putConnection(connection: Omit<StoredConnection, 'version' | 'updatedAt'>): Promise<StoredConnection>;
  deleteConnection(model: string, name: string): Promise<boolean>;
  reportConnection(model: string, name: string, instance: string, version: number | null, state: string, error: string | null): Promise<void>;
  connectionReports(model: string, name: string): Promise<{ instance: string; version: number | null; state: string; error: string | null; reportedAt: Date }[]>;
  deleteOverlay(model: string, id: string): Promise<boolean>;
  /** A revision's items, with their authored and resolved YAML. */
  items(model: string, revision: number): Promise<PublishedItem[]>;
  /** A revision's modules; empty when it is served whole. */
  modules(model: string, revision: number): Promise<StoredModule[]>;
}

export interface PgRevisionStoreOptions {
  schema: string;
  /** Revisions kept per model, the current one included. */
  keepRevisions: number;
}

function sortedGroups(groups: string[]): string[] {
  return [...new Set(groups)].sort();
}

/** A key set's identity, whatever order its keys or their members come in (jsonb reorders members). */
function keySetId(set: StoredKeySet): string {
  const keys = set.keys.map((k) => [k.kid, k.kty, k.n, k.e].join('|')).sort();
  return JSON.stringify([set.issuer, keys]);
}

function versionOf(value: unknown): number {
  return Number(value);
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

  public async putFolders(model: string, folders: Folder[], security?: boolean) {
    const { s } = this;
    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(`INSERT INTO ${s}.models (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [model]);
      const { rows: [locked] } = await client.query(
        `SELECT mode, current_rev, security FROM ${s}.models WHERE id = $1 FOR UPDATE`,
        [model]
      );
      if (security === true && locked.mode === 'files' && locked.current_rev !== null) {
        throw new SecurityModeError(model);
      }
      if (security === true && !locked.security) {
        const older = await this.olderInstances(client, 4);
        if (older.length) {
          throw new OlderInstancesError(older);
        }
      }
      await this.replaceFolders(client, model, folders);
      if (security !== undefined && security !== locked.security) {
        await client.query(`UPDATE ${s}.models SET security = $2, updated_at = now() WHERE id = $1`, [model, security]);
      }
      if (security === true) {
        // Code before version 4 serves the model without the gate: from now on it may not run on this schema.
        await client.query(`UPDATE ${s}.schema_migrations SET min_reader = GREATEST(min_reader, 4) WHERE version = 4`);
      }
      return {
        hash: folderTreeHash(folders),
        permissionsVersion: await this.touchPermissions(client, model),
        security: security ?? locked.security,
      };
    });
  }

  /**
   * The xcube connections to this database from code before schema version
   * `below`. Code before version 4 named them without a version (`db.ts`
   * `applicationName`).
   */
  protected async olderInstances(client: PoolClient, below: number): Promise<string[]> {
    const { rows } = await client.query(
      `SELECT DISTINCT application_name FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND application_name ~ '^xcube(-listen)?:'
          AND (application_name !~ '^xcube(-listen)?:v[0-9]+:'
               OR substring(application_name from '^xcube(?:-listen)?:v([0-9]+):')::int < $1)
        ORDER BY 1`,
      [below]
    );
    return rows.map((row) => row.application_name);
  }

  /** Each folder of the tree with its groups (none, for a folder without a row). */
  protected async groupsIn(client: Pick<PoolClient, 'query'>, model: string): Promise<{ id: string; parentId: string | null; groups: string[] }[]> {
    const { rows } = await client.query(
      `SELECT f.id, f.parent_id, coalesce(g.groups, '{}') AS groups
         FROM ${this.s}.folders f
         LEFT JOIN ${this.s}.folder_groups g ON g.model = f.model AND g.folder_id = f.id
        WHERE f.model = $1
        ORDER BY f.id COLLATE "C"`,
      [model]
    );
    return rows.map((r) => ({ id: r.id, parentId: r.parent_id, groups: sortedGroups(r.groups) }));
  }

  /**
   * Under the model's row lock: checks the groups, with security on, and
   * bumps the permissions version when security or any folder's groups
   * changed, and announces it.
   */
  protected async touchPermissions(client: PoolClient, model: string): Promise<number> {
    const { s } = this;
    const { rows: [row] } = await client.query(
      `SELECT security, permissions_version, permissions_hash FROM ${s}.models WHERE id = $1`,
      [model]
    );
    const folders = await this.groupsIn(client, model);
    if (row.security) {
      // The gate checks each item by its own folder only. That is sound because a
      // folder allows every group its children do, as the client works them out.
      const byId = new Map(folders.map((f) => [f.id, new Set(f.groups)]));
      const problems = folders.flatMap((f) => {
        const parent = f.parentId === null ? undefined : byId.get(f.parentId);
        const missing = parent ? f.groups.filter((g) => !parent.has(g)) : [];
        return missing.length ? [`${f.id} allows ${missing.slice(0, 5).join(', ')}, which its parent ${f.parentId} doesn't`] : [];
      });
      if (problems.length) {
        throw new PermissionsError(problems);
      }
    }
    // Parents too: a moved folder changes how an overlay's names resolve.
    const hash = crypto.createHash('sha256')
      .update(JSON.stringify([row.security, folders.map((f) => [f.id, f.parentId, f.groups])]), 'utf8')
      .digest('hex');
    if (hash === row.permissions_hash) {
      return versionOf(row.permissions_version);
    }
    const { rows: [bumped] } = await client.query(
      `UPDATE ${s}.models SET permissions_hash = $2, permissions_version = permissions_version + 1
        WHERE id = $1 RETURNING permissions_version`,
      [model, hash]
    );
    const version = versionOf(bumped.permissions_version);
    await client.query('SELECT pg_notify($1, $2)', [channelOf(s), JSON.stringify({ model, permissions: version })]);
    return version;
  }

  public async permissions(model: string): Promise<StoredPermissions | null> {
    const { rows: [row] } = await this.pool.query(
      `SELECT security, permissions_version FROM ${this.s}.models WHERE id = $1`,
      [model]
    );
    if (!row) {
      return null;
    }
    return {
      version: versionOf(row.permissions_version),
      security: row.security,
      folders: (await this.groupsIn(this.pool, model)).map((f) => ({ id: f.id, allowedGroups: f.groups })),
    };
  }

  public async versions(): Promise<ModelVersions[]> {
    const { rows } = await this.pool.query(`SELECT id, permissions_version, keys_version FROM ${this.s}.models`);
    return rows.map((row) => ({
      model: row.id,
      permissions: versionOf(row.permissions_version),
      keys: row.keys_version === null ? null : versionOf(row.keys_version),
    }));
  }

  public async keys(model: string): Promise<StoredKeySet | null> {
    const { rows: [row] } = await this.pool.query(
      `SELECT keys_version, keys_issuer FROM ${this.s}.models WHERE id = $1`,
      [model]
    );
    if (!row || row.keys_version === null) {
      return null;
    }
    const { rows } = await this.pool.query(
      `SELECT jwk FROM ${this.s}.model_keys WHERE model = $1 ORDER BY kid COLLATE "C"`,
      [model]
    );
    return { version: versionOf(row.keys_version), issuer: row.keys_issuer, keys: rows.map((r) => r.jwk) };
  }

  /**
   * Replaces the model's key set when `set.version` is newer than the one
   * stored; the same version again is taken only as the same set.
   */
  public async putKeys(model: string, set: StoredKeySet): Promise<PutKeysResult> {
    const { s } = this;
    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(`INSERT INTO ${s}.models (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [model]);
      await client.query(`SELECT 1 FROM ${s}.models WHERE id = $1 FOR UPDATE`, [model]);
      const stored = await this.keysIn(client, model);
      if (stored && set.version <= stored.version) {
        if (set.version < stored.version) {
          return { outcome: 'stale', current: stored };
        }
        return { outcome: keySetId(set) === keySetId(stored) ? 'unchanged' : 'conflict', current: stored };
      }
      await client.query(`DELETE FROM ${s}.model_keys WHERE model = $1`, [model]);
      await client.query(
        `INSERT INTO ${s}.model_keys (model, kid, jwk) SELECT $1, k, j::jsonb FROM unnest($2::text[], $3::text[]) AS u(k, j)`,
        [model, set.keys.map((k) => k.kid), set.keys.map((k) => JSON.stringify(k))]
      );
      await client.query(
        `UPDATE ${s}.models SET keys_version = $2, keys_issuer = $3, updated_at = now() WHERE id = $1`,
        [model, set.version, set.issuer]
      );
      await client.query('SELECT pg_notify($1, $2)', [channelOf(s), JSON.stringify({ model, keys: set.version })]);
      return { outcome: 'replaced', current: (await this.keysIn(client, model))! };
    });
  }

  protected overlayOf(row: any): StoredOverlay {
    return {
      model: row.model,
      id: row.id,
      version: versionOf(row.version),
      upserts: row.upserts,
      deletes: row.deletes,
      connections: row.connections ?? [],
      contentHash: row.content_hash,
      validatedRevision: row.validated_rev,
      validatedTree: row.validated_tree,
      expiresAt: new Date(row.expires_at),
    };
  }

  public async putOverlay(
    overlay: Omit<StoredOverlay, 'version'>,
    maxOverlays: number,
    baseVersion?: number | null,
  ): Promise<PutOverlayResult> {
    const { s } = this;
    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(`SELECT 1 FROM ${s}.models WHERE id = $1 FOR UPDATE`, [overlay.model]);
      await client.query(`DELETE FROM ${s}.overlays WHERE model = $1 AND expires_at < now()`, [overlay.model]);
      const { rows: [known] } = await client.query(
        `SELECT * FROM ${s}.overlays WHERE model = $1 AND id = $2`,
        [overlay.model, overlay.id]
      );
      if (baseVersion !== undefined && (known ? versionOf(known.version) : null) !== baseVersion) {
        return { outcome: 'conflict', overlay: known ? this.overlayOf(known) : null };
      }
      if (!known) {
        const { rows: [{ n }] } = await client.query(`SELECT count(*)::int AS n FROM ${s}.overlays WHERE model = $1`, [overlay.model]);
        if (n >= maxOverlays) {
          return { outcome: 'too_many', overlay: null };
        }
      }
      if (overlay.connections.length) {
        // Code before version 7 would preview it on the published data sources.
        const older = await this.olderInstances(client, 7);
        if (older.length) {
          throw new OlderInstancesError(older, 'xcube instances older than schema version 7 are connected; they would preview the overlay on the published data sources. Push its connections once every instance runs this version');
        }
      }
      const same = known && known.content_hash === overlay.contentHash;
      const { rows: [row] } = await client.query(
        `INSERT INTO ${s}.overlays (model, id, version, upserts, deletes, connections, content_hash, validated_rev, validated_tree, expires_at)
         VALUES ($1, $2, nextval('${s}.overlay_versions'), $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
         ON CONFLICT (model, id) DO UPDATE SET
           version = CASE WHEN ${s}.overlays.content_hash = EXCLUDED.content_hash THEN ${s}.overlays.version ELSE EXCLUDED.version END,
           upserts = EXCLUDED.upserts, deletes = EXCLUDED.deletes, connections = EXCLUDED.connections,
           content_hash = EXCLUDED.content_hash, validated_rev = EXCLUDED.validated_rev, validated_tree = EXCLUDED.validated_tree,
           expires_at = EXCLUDED.expires_at, updated_at = now()
         RETURNING *`,
        [overlay.model, overlay.id, JSON.stringify(overlay.upserts), JSON.stringify(overlay.deletes), JSON.stringify(overlay.connections),
          overlay.contentHash, overlay.validatedRevision, overlay.validatedTree, overlay.expiresAt]
      );
      const stored = this.overlayOf(row);
      await client.query('SELECT pg_notify($1, $2)', [
        channelOf(s), JSON.stringify({ model: overlay.model, overlay: overlay.id, version: stored.version }),
      ]);
      let outcome: 'created' | 'updated' | 'unchanged' = 'created';
      if (known) {
        outcome = same ? 'unchanged' : 'updated';
      }
      return { outcome, overlay: stored };
    });
  }

  public async overlay(model: string, id: string): Promise<StoredOverlay | null> {
    const { rows: [row] } = await this.pool.query(
      `SELECT * FROM ${this.s}.overlays WHERE model = $1 AND id = $2 AND expires_at > now()`,
      [model, id]
    );
    return row ? this.overlayOf(row) : null;
  }

  protected connectionOf(row: any): StoredConnection {
    return {
      model: row.model,
      name: row.name,
      folderId: row.folder_id,
      driver: row.driver,
      authMethod: row.auth_method,
      fields: row.fields,
      sealed: row.sealed,
      revisions: row.revisions,
      version: versionOf(row.version),
      updatedAt: new Date(row.updated_at),
    };
  }

  public async connections(model: string): Promise<StoredConnection[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.s}.connections WHERE model = $1 ORDER BY name COLLATE "C"`,
      [model]
    );
    return rows.map((row) => this.connectionOf(row));
  }

  public async putConnection(c: Omit<StoredConnection, 'version' | 'updatedAt'>): Promise<StoredConnection> {
    const { s } = this;
    return inTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO ${s}.models (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [c.model]);
      const { rows: [row] } = await client.query(
        `INSERT INTO ${s}.connections (model, name, folder_id, driver, auth_method, fields, sealed, revisions, version)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, nextval('${s}.connection_versions'))
         ON CONFLICT (model, name) DO UPDATE SET
           folder_id = EXCLUDED.folder_id, driver = EXCLUDED.driver, auth_method = EXCLUDED.auth_method,
           fields = EXCLUDED.fields, sealed = EXCLUDED.sealed, revisions = EXCLUDED.revisions,
           version = EXCLUDED.version, updated_at = now()
         RETURNING *`,
        [c.model, c.name, c.folderId, c.driver, c.authMethod, JSON.stringify(c.fields), JSON.stringify(c.sealed), JSON.stringify(c.revisions)]
      );
      const stored = this.connectionOf(row);
      await client.query('SELECT pg_notify($1, $2)', [
        channelOf(s), JSON.stringify({ model: c.model, connection: c.name, version: stored.version }),
      ]);
      return stored;
    });
  }

  public async deleteConnection(model: string, name: string): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(`DELETE FROM ${this.s}.connections WHERE model = $1 AND name = $2`, [model, name]);
      await client.query(`DELETE FROM ${this.s}.connection_reports WHERE model = $1 AND name = $2`, [model, name]);
      await client.query('SELECT pg_notify($1, $2)', [channelOf(this.s), JSON.stringify({ model, connection: name })]);
      return Boolean(rowCount);
    });
  }

  public async reportConnection(model: string, name: string, instance: string, version: number | null, state: string, error: string | null) {
    await this.pool.query(
      `INSERT INTO ${this.s}.connection_reports (model, name, instance, version, state, error, reported_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (model, name, instance) DO UPDATE SET
         version = EXCLUDED.version, state = EXCLUDED.state, error = EXCLUDED.error, reported_at = now()`,
      [model, name, instance, version, state, error]
    );
  }

  public async connectionReports(model: string, name: string) {
    const { rows } = await this.pool.query(
      `SELECT instance, version, state, error, reported_at FROM ${this.s}.connection_reports
        WHERE model = $1 AND name = $2 ORDER BY instance`,
      [model, name]
    );
    return rows.map((r) => ({
      instance: r.instance, version: r.version === null ? null : versionOf(r.version), state: r.state, error: r.error, reportedAt: new Date(r.reported_at),
    }));
  }

  public async overlayCount(model: string): Promise<number> {
    const { rows: [{ n }] } = await this.pool.query(
      `SELECT count(*)::int AS n FROM ${this.s}.overlays WHERE model = $1 AND expires_at > now()`,
      [model]
    );
    return n;
  }

  public async deleteOverlay(model: string, id: string): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(`DELETE FROM ${this.s}.overlays WHERE model = $1 AND id = $2`, [model, id]);
      await client.query('SELECT pg_notify($1, $2)', [channelOf(this.s), JSON.stringify({ model, overlay: id })]);
      return Boolean(rowCount);
    });
  }

  protected async keysIn(client: PoolClient, model: string): Promise<StoredKeySet | null> {
    const { rows: [row] } = await client.query(
      `SELECT keys_version, keys_issuer FROM ${this.s}.models WHERE id = $1`,
      [model]
    );
    if (!row || row.keys_version === null) {
      return null;
    }
    const { rows } = await client.query(
      `SELECT jwk FROM ${this.s}.model_keys WHERE model = $1 ORDER BY kid COLLATE "C"`,
      [model]
    );
    return { version: versionOf(row.keys_version), issuer: row.keys_issuer, keys: rows.map((r) => r.jwk) };
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
    const { rows: before } = await client.query(`SELECT id, parent_id FROM ${s}.folders WHERE model = $1`, [model]);
    const parentBefore = new Map(before.map((row) => [row.id, row.parent_id]));
    await client.query(`DELETE FROM ${s}.folders WHERE model = $1 AND NOT (id = ANY($2::text[]))`, [model, [...ids]]);
    if (folders.length) {
      await client.query(
        `INSERT INTO ${s}.folders (model, id, parent_id) SELECT $1, * FROM unnest($2::text[], $3::text[])
         ON CONFLICT (model, id) DO UPDATE SET parent_id = EXCLUDED.parent_id`,
        [model, folders.map((f) => f.id), folders.map((f) => f.parentId)]
      );
    }
    // Groups where given. A folder sent without them keeps its own, unless it
    // moved: what its old place allowed is no guide to its new one.
    const moved = folders
      .filter((f) => f.allowedGroups === undefined && parentBefore.has(f.id) && parentBefore.get(f.id) !== f.parentId)
      .map((f) => f.id);
    await client.query(
      `DELETE FROM ${s}.folder_groups WHERE model = $1 AND (NOT (folder_id = ANY($2::text[])) OR folder_id = ANY($3::text[]))`,
      [model, [...ids], moved]
    );
    const grouped = folders.filter((f) => f.allowedGroups !== undefined);
    if (grouped.length) {
      await client.query(
        `INSERT INTO ${s}.folder_groups (model, folder_id, groups)
         SELECT $1, u.id, ARRAY(SELECT jsonb_array_elements_text(u.groups::jsonb))
           FROM unnest($2::text[], $3::text[]) AS u(id, groups)
         ON CONFLICT (model, folder_id) DO UPDATE SET groups = EXCLUDED.groups`,
        [model, grouped.map((f) => f.id), grouped.map((f) => JSON.stringify(sortedGroups(f.allowedGroups!)))]
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

  public async modules(model: string, revision: number): Promise<StoredModule[]> {
    const { rows } = await this.pool.query(
      `SELECT module_id, version, members, copies FROM ${this.s}.revision_modules
        WHERE model = $1 AND rev = $2 ORDER BY module_id`,
      [model, revision]
    );
    return rows.map((row) => ({ id: row.module_id, version: row.version, members: row.members, copies: row.copies }));
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
      modules: request.modules,
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
    modules?: StoredModule[];
  }): Promise<ImportResult> {
    const { model, baseRevision, files, source, mode, items, itemsHash, folders, modules } = request;
    const hash = contentHash(files);
    const { s } = this;

    return inTransaction(this.pool, async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(`INSERT INTO ${s}.models (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [model]);
      // The row alone: a lock taken over a join is re-checked, after a wait,
      // against the joined row as it was, which would miss a revision the
      // holder just added.
      const { rows: [locked] } = await client.query(
        `SELECT id, generation, current_rev, mode, security FROM ${s}.models WHERE id = $1 FOR UPDATE`,
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

      if (mode === 'files' && (current?.mode === 'items' || locked.security)) {
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
        await this.touchPermissions(client, model);
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
      if (modules?.length) {
        await client.query(
          `INSERT INTO ${s}.revision_modules (model, rev, module_id, version, members, copies)
           SELECT $1, $2, i, v, m::jsonb, c::jsonb FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS u(i, v, m, c)`,
          [
            model,
            revision,
            modules.map((m) => m.id),
            modules.map((m) => m.version),
            modules.map((m) => JSON.stringify(m.members)),
            modules.map((m) => JSON.stringify(m.copies)),
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
