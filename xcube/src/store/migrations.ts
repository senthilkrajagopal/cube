/**
 * xcube's schema, one migration at a time. Migrations are expand/contract:
 * an expand migration (a new table, a nullable column) keeps `minReader`; a
 * contract migration raises it to its own version, and ships at least one
 * release after the code stops using what it drops. Never edit a migration
 * that has shipped: its checksum is checked on every start.
 */
export interface Migration {
  version: number;
  name: string;
  /** The oldest xcube schema version whose code can still read the schema once this is applied. */
  minReader: number;
  sql: (schema: string) => string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    minReader: 1,
    sql: (s) => `
      CREATE TABLE ${s}.models (
        id          text        PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
        generation  uuid        NOT NULL DEFAULT gen_random_uuid(),
        current_rev integer,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Each distinct file content once per model, shared by its revisions. Per
      -- model, so that pruning one model never races another's import.
      CREATE TABLE ${s}.files (
        model   text     NOT NULL REFERENCES ${s}.models (id) ON DELETE CASCADE,
        hash    char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
        content text     NOT NULL,
        PRIMARY KEY (model, hash)
      );

      CREATE TABLE ${s}.revisions (
        model        text        NOT NULL REFERENCES ${s}.models (id) ON DELETE CASCADE,
        rev          integer     NOT NULL CHECK (rev > 0),
        content_hash char(64)    NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        file_count   integer     NOT NULL,
        bytes        bigint      NOT NULL,
        base_rev     integer,
        source       jsonb       NOT NULL DEFAULT '{}'::jsonb,
        created_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (model, rev)
      );

      CREATE TABLE ${s}.revision_files (
        model text     NOT NULL,
        rev   integer  NOT NULL,
        path  text     NOT NULL,
        hash  char(64) NOT NULL,
        PRIMARY KEY (model, rev, path),
        FOREIGN KEY (model, rev) REFERENCES ${s}.revisions (model, rev) ON DELETE CASCADE,
        FOREIGN KEY (model, hash) REFERENCES ${s}.files (model, hash)
      );
      CREATE INDEX revision_files_hash_idx ON ${s}.revision_files (model, hash);

      -- The current revision always exists, so retention can never delete it.
      ALTER TABLE ${s}.models ADD CONSTRAINT models_current_fk FOREIGN KEY (id, current_rev)
        REFERENCES ${s}.revisions (model, rev) DEFERRABLE INITIALLY DEFERRED;
    `,
  },
  {
    version: 2,
    name: 'items',
    // Readers before 2 would prune authored item contents they don't know
    // about, so they may not run on this schema.
    minReader: 2,
    sql: (s) => `
      ALTER TABLE ${s}.models ADD COLUMN mode text NOT NULL DEFAULT 'files' CHECK (mode IN ('files', 'items'));
      ALTER TABLE ${s}.revisions ADD COLUMN items_hash char(64) CHECK (items_hash ~ '^[0-9a-f]{64}$');

      -- The client's folder tree: only what resolution needs, ids and parents.
      CREATE TABLE ${s}.folders (
        model     text NOT NULL REFERENCES ${s}.models (id) ON DELETE CASCADE,
        id        text NOT NULL CHECK (id ~ '^f[a-z0-9]{1,40}$'),
        parent_id text,
        PRIMARY KEY (model, id)
      );

      -- Each revision's items: as written (authored_hash, in files), their
      -- full name (the resolved file is <full_name>.yml in revision_files),
      -- and what each short name they use was bound to at publish.
      CREATE TABLE ${s}.revision_items (
        model         text     NOT NULL,
        rev           integer  NOT NULL,
        folder_id     text     NOT NULL,
        name          text     NOT NULL,
        kind          text     NOT NULL CHECK (kind IN ('cube', 'view')),
        full_name     text     NOT NULL,
        authored_hash char(64) NOT NULL,
        bindings      jsonb    NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (model, rev, folder_id, name),
        UNIQUE (model, rev, full_name),
        FOREIGN KEY (model, rev) REFERENCES ${s}.revisions (model, rev) ON DELETE CASCADE,
        FOREIGN KEY (model, authored_hash) REFERENCES ${s}.files (model, hash)
      );
      CREATE INDEX revision_items_hash_idx ON ${s}.revision_items (model, authored_hash);
    `,
  },
];

/** The newest schema version this code knows. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
