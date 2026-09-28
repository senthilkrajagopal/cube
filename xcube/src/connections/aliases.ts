import crypto from 'crypto';
import yaml from 'js-yaml';

import type { SnapshotFile } from '../model/snapshot';
import { MAX_TABLE_STEM } from '../names/publish';
import type { StoredConnection } from '../store/revisions';

/** Secrets that say who connects, as a service-account key or a token does; a password for a named user doesn't. */
const PRINCIPAL_SECRETS = new Set(['credentials', 'oauthToken', 'token']);

/** Fields that say how the server is checked, not what it is. */
const TRANSPORT_FIELDS = new Set(['ssl', 'sslRejectUnauthorized', 'sslCa', 'sslCert', 'encrypt', 'trustServerCertificate']);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(text: string, length: number): string {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  let out = '';
  for (let i = 0; out.length < length; i++) {
    out += BASE32[digest[i] % 32];
  }
  return out;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 12);
}

/** The secrets of a connection that say who connects (a service-account key, a token), not a password for a named user. */
export function principalSecrets(connection: Partial<Pick<StoredConnection, 'sealed'>>): string[] {
  return Object.keys(connection.sealed ?? {}).filter((field) => PRINCIPAL_SECRETS.has(field)).sort();
}

/**
 * What a connection reaches and as whom: its driver, auth method and fields
 * (how the server is checked left out), and each secret that names who
 * connects, by what `principals` says of it: its revision, or a hash of it
 * opened (`Connections.identityOf`). A new password for the same user keeps
 * it, as does sealing the same key again; a new host, database, user or key
 * holder is another identity, whose data cached results and rollups of the
 * old one mustn't stand for.
 */
export function identityOf(
  connection: Pick<StoredConnection, 'driver' | 'authMethod' | 'fields'> & Partial<Pick<StoredConnection, 'sealed' | 'revisions'>>,
  principals: Record<string, string> = {},
): string {
  const fields = Object.entries(connection.fields)
    .filter(([key]) => !TRANSPORT_FIELDS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const named = principalSecrets(connection)
    .map((field) => [field, principals[field] ?? connection.revisions?.[field] ?? hash((connection.sealed as any)[field]?.ct ?? null)]);
  return hash([connection.driver, connection.authMethod, fields, named]);
}

/** An epoch: the identities of a model's connections together, or nothing without connections. */
export function epochOf(identities: ReadonlyMap<string, string>): string | undefined {
  return identities.size ? hash([...identities].sort(([a], [b]) => (a < b ? -1 : 1))) : undefined;
}

/** The leading comment lines of a file (an overlay's marks), kept when it is dumped again. */
function leadingComments(content: string): string {
  return /^(?:#[^\n]*\n)*/.exec(content)?.[0] ?? '';
}

function preAggregationNames(cube: any): string[] {
  const list = cube.pre_aggregations ?? cube.preAggregations;
  return Array.isArray(list)
    ? list.filter((pa) => pa && typeof pa.name === 'string').map((pa) => pa.sql_alias ?? pa.sqlAlias ?? pa.name)
    : [];
}

/**
 * A cube's alias over an identity: a hash of its name and the identity, short
 * enough that `<alias>_<pre-aggregation>` stays within the rollup table stem
 * where it can, and never under 25 bits; `extra` characters more to part it
 * from another's.
 */
function identityAlias(name: string, salt: string, rollups: string[], extra = 0): string {
  const longest = Math.max(0, ...rollups.map((r) => r.length));
  const length = Math.max(5, Math.min(9, MAX_TABLE_STEM - 2 - longest)) + extra;
  return `x${base32(`${name}@${salt}`, length)}`;
}

/**
 * A revision's files as served over its connections' identities. Each cube on
 * a connection (its own data source, or its parent's through `extends`) is
 * aliased by a hash of its name and `<data source>@<identity>`, so its rollup
 * tables are another target's than those of any identity before. Files of
 * several documents, or not YAML, are served as they are. Returns, by path,
 * the salts of each file aliased so.
 */
export function withIdentityAliases(
  files: SnapshotFile[],
  identities: ReadonlyMap<string, string>,
): { files: SnapshotFile[]; salts: Map<string, string> } {
  const salts = new Map<string, string>();
  if (!identities.size) {
    return { files, salts };
  }
  const parsed = files.map((file) => {
    if (!/\.ya?ml$/.test(file.path)) {
      return { file, doc: undefined };
    }
    try {
      const doc = yaml.load(file.content) as any;
      return { file, doc: doc && typeof doc === 'object' && Array.isArray(doc.cubes) ? doc : undefined };
    } catch {
      return { file, doc: undefined };
    }
  });
  const byName = new Map<string, any>();
  parsed.forEach(({ doc }) => (doc?.cubes ?? []).forEach((cube: any) => {
    if (cube && typeof cube.name === 'string') {
      byName.set(cube.name, cube);
    }
  }));
  const dataSourceOf = (cube: any): string => {
    const seen = new Set<string>();
    for (let at = cube; at && !seen.has(at.name);) {
      seen.add(at.name);
      const named = at.data_source ?? at.dataSource;
      if (typeof named === 'string') {
        return named;
      }
      at = typeof at.extends === 'string' ? byName.get(at.extends.trim()) : undefined;
    }
    return 'default';
  };
  // Each cube on a connection, with its salt; the others keep the aliases (or names) Cube uses for them.
  const aliased = new Map<any, string>();
  const taken = new Set<string>();
  parsed.forEach(({ doc }) => (doc?.cubes ?? []).forEach((cube: any) => {
    const dataSource = cube && typeof cube.name === 'string' ? dataSourceOf(cube) : undefined;
    const identity = dataSource === undefined ? undefined : identities.get(dataSource);
    if (identity !== undefined) {
      aliased.set(cube, `${dataSource}@${identity}`);
    } else if (cube && typeof cube.name === 'string') {
      taken.add(cube.sql_alias ?? cube.sqlAlias ?? cube.name);
    }
  }));
  // One alias per cube, in name order so every instance gives the same: lengthened past any clash.
  [...aliased].sort(([a], [b]) => (a.name < b.name ? -1 : 1)).forEach(([cube, salt]) => {
    let extra = 0;
    let alias = identityAlias(cube.name, salt, preAggregationNames(cube));
    while (taken.has(alias) && extra < 12) {
      extra += 2;
      alias = identityAlias(cube.name, salt, preAggregationNames(cube), extra);
    }
    taken.add(alias);
    delete cube.sqlAlias;
    cube.sql_alias = alias;
  });
  const served = parsed.map(({ file, doc }) => {
    if (!doc) {
      return file;
    }
    const fileSalts = doc.cubes.filter((cube: any) => aliased.has(cube)).map((cube: any) => `${cube.name}:${aliased.get(cube)}`);
    if (!fileSalts.length) {
      return file;
    }
    salts.set(file.path, fileSalts.join(','));
    const content = yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' });
    return { ...file, content: `${leadingComments(file.content)}${content}` };
  });
  return { files: served, salts };
}
