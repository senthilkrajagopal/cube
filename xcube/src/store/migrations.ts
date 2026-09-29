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
  {
    version: 3,
    name: 'modules',
    // Additive: code at version 2 serves an items revision whole, as it did.
    minReader: 2,
    sql: (s) => `
      -- The modules an items revision compiles in: the items each owns, and
      -- the shared cubes it carries copies of; its version is the hash of
      -- its files, so an unchanged module keeps its compiled model.
      CREATE TABLE ${s}.revision_modules (
        model     text     NOT NULL,
        rev       integer  NOT NULL,
        module_id text     NOT NULL,
        version   char(64) NOT NULL CHECK (version ~ '^[0-9a-f]{64}$'),
        members   jsonb    NOT NULL,
        copies    jsonb    NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (model, rev, module_id),
        FOREIGN KEY (model, rev) REFERENCES ${s}.revisions (model, rev) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 4,
    name: 'permissions',
    // Additive: code at version 2 or 3 runs on it while no model has
    // security on; turning it on raises this migration's min_reader to 4
    // (PgRevisionStore.putFolders), as that code wouldn't gate by folder.
    minReader: 2,
    sql: (s) => `
      -- Each folder's allowed groups, as the client works them out (granted
      -- on it, an ancestor or a descendant, plus its Super-Admin group). A
      -- table of their own, which code before version 4 never writes: it
      -- replaces a tree by deleting and inserting its folders.
      CREATE TABLE ${s}.folder_groups (
        model     text   NOT NULL REFERENCES ${s}.models (id) ON DELETE CASCADE,
        folder_id text   NOT NULL,
        groups    text[] NOT NULL,
        PRIMARY KEY (model, folder_id)
      );

      -- Whether Cube gates by folder, and a counter every instance compares
      -- to know its permissions are stale.
      ALTER TABLE ${s}.models ADD COLUMN security boolean NOT NULL DEFAULT false;
      ALTER TABLE ${s}.models ADD COLUMN permissions_version bigint NOT NULL DEFAULT 0;
      ALTER TABLE ${s}.models ADD COLUMN permissions_hash char(64);

      -- The public keys the model's user tokens are signed with, pushed by
      -- the client as a whole set with a version that only goes up.
      ALTER TABLE ${s}.models ADD COLUMN keys_version bigint;
      ALTER TABLE ${s}.models ADD COLUMN keys_issuer text;
      CREATE TABLE ${s}.model_keys (
        model text  NOT NULL REFERENCES ${s}.models (id) ON DELETE CASCADE,
        kid   text  NOT NULL,
        jwk   jsonb NOT NULL,
        PRIMARY KEY (model, kid)
      );
    `,
  },
  {
    version: 5,
    name: 'overlays',
    // Additive: older code has no overlays and never reads the table.
    minReader: 2,
    sql: (s) => `
      -- A workspace's or a proposal's unpublished items: a changeset, as the
      -- client wrote it, applied to whatever is published when a query
      -- names it. Its version goes up with each change; it is gone once it
      -- expires.
      -- Versions only go up, across drops too: an id dropped and pushed
      -- again is never taken for what it was.
      CREATE SEQUENCE ${s}.overlay_versions;
      CREATE TABLE ${s}.overlays (
        model          text        NOT NULL REFERENCES ${s}.models (id) ON DELETE CASCADE,
        id             text        NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
        version        bigint      NOT NULL,
        upserts        jsonb       NOT NULL,
        deletes        jsonb       NOT NULL,
        content_hash   char(64)    NOT NULL,
        validated_rev  integer,
        validated_tree char(64),
        expires_at     timestamptz NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (model, id)
      );
      CREATE INDEX overlays_expires_idx ON ${s}.overlays (expires_at);
    `,
  },
  {
    version: 6,
    name: 'connections',
    // Additive: older code reads Cube's data sources from its environment, as before.
    minReader: 2,
    sql: (s) => `
      -- Each model's data sources: where each connects, and its secrets
      -- sealed by the client to xcube's credential key. Never plaintext.
      CREATE SEQUENCE ${s}.connection_versions;
      CREATE TABLE ${s}.connections (
        model       text        NOT NULL REFERENCES ${s}.models (id) ON DELETE CASCADE,
        name        text        NOT NULL,
        folder_id   text        NOT NULL,
        driver      text        NOT NULL,
        auth_method text        NOT NULL,
        fields      jsonb       NOT NULL,
        sealed      jsonb       NOT NULL,
        revisions   jsonb       NOT NULL DEFAULT '{}'::jsonb,
        version     bigint      NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (model, name)
      );

      -- What each instance's driver for a connection is doing, for the client to show.
      CREATE TABLE ${s}.connection_reports (
        model       text        NOT NULL,
        name        text        NOT NULL,
        instance    text        NOT NULL,
        version     bigint,
        state       text        NOT NULL,
        error       text,
        reported_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (model, name, instance)
      );
    `,
  },
  {
    version: 7,
    name: 'overlay connections',
    // Additive: older code ignores the column, so an overlay holding
    // connections is refused while such code serves (`putOverlay`).
    minReader: 2,
    sql: (s) => `
      -- A workspace's own data sources, as they would land: previews of the
      -- overlay query them in place of, or beside, the published ones.
      -- Secrets sealed by the client, as a connection's are.
      ALTER TABLE ${s}.overlays ADD COLUMN connections jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    version: 8,
    name: 'connection bases',
    // Additive: older code aliases every cube on a connection by its identity, as before.
    minReader: 2,
    sql: (s) => `
      -- The identity each connection was first served with, its base: its
      -- cubes keep their names while it has it, and are aliased by identity
      -- once it moves. Kept when the connection or its model goes (a model's
      -- rollup schema is named by the model alone), since tables under those
      -- names hold only that target's rows.
      CREATE TABLE ${s}.connection_bases (
        model       text        NOT NULL,
        name        text        NOT NULL,
        identity    text        NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (model, name)
      );
    `,
  },
  {
    version: 9,
    name: 'connection base targets',
    // Additive: older code reads and writes the columns it names.
    minReader: 2,
    sql: (s) => `
      -- Where a base reaches, in the form Cube's environment is compared in
      -- (host, port, database and user, for Postgres, Redshift and MySQL):
      -- the environment reaching it serves the data source at its base.
      ALTER TABLE ${s}.connection_bases ADD COLUMN target text;
    `,
  },
  {
    version: 10,
    name: 'build jobs and refresh ticks',
    // Additive: older code neither writes nor reads them.
    minReader: 2,
    sql: (s) => `
      -- The builds a jobs request asked for, by the version of a table each
      -- builds: what names a queued build's job token.
      CREATE TABLE ${s}.build_jobs (
        model        text        NOT NULL,
        token        text        NOT NULL,
        request_id   text,
        target_table text        NOT NULL,
        posted_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (model, token)
      );
      CREATE INDEX build_jobs_target_idx ON ${s}.build_jobs (model, target_table);

      -- Each refresh worker's last run of each module of a model: the
      -- revision it refreshed, when, and its last error.
      CREATE TABLE ${s}.refresh_ticks (
        model         text        NOT NULL,
        instance      text        NOT NULL,
        module        text        NOT NULL,
        revision      integer     NOT NULL,
        served_key    text        NOT NULL,
        last_tick_at  timestamptz NOT NULL,
        last_finished boolean     NOT NULL,
        last_ok_at    timestamptz,
        last_error    text,
        last_error_at timestamptz,
        PRIMARY KEY (model, instance, module)
      );
    `,
  },
  {
    version: 11,
    name: 'calculations',
    // Additive: older code serves models without the companions.
    minReader: 2,
    sql: (s) => `
      -- The quick calculations a model has been asked for: each a companion
      -- measure xcube adds to its cube when it serves the model, from the
      -- first query asking for it on.
      CREATE TABLE ${s}.calculations (
        model        text        NOT NULL,
        cube         text        NOT NULL,
        measure      text        NOT NULL,
        kind         text        NOT NULL,
        granularity  text        NOT NULL DEFAULT '',
        periods      integer     NOT NULL DEFAULT 0,
        requested_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (model, cube, measure, kind, granularity, periods)
      );
    `,
  },
];

/** The newest schema version this code knows. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
