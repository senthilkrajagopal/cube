import crypto from 'crypto';
import yaml from 'js-yaml';

import type { SnapshotFile } from '../model/snapshot';
import { dump, saltedAlias } from '../names/publish';
import type { StoredConnection } from '../store/revisions';

/**
 * What a connection reaches: its driver, auth method and fields, secrets
 * left out. A new password keeps it; a new host, database or user is another
 * identity, whose data cached results and rollups of the old one mustn't
 * stand for.
 */
export function identityOf(connection: Pick<StoredConnection, 'driver' | 'authMethod' | 'fields'>): string {
  const fields = Object.fromEntries(Object.entries(connection.fields).sort(([a], [b]) => (a < b ? -1 : 1)));
  return crypto.createHash('sha256').update(JSON.stringify([connection.driver, connection.authMethod, fields]), 'utf8')
    .digest('hex').slice(0, 12);
}

/** The leading comment lines of a file (an overlay's marks), kept when it is dumped again. */
function leadingComments(content: string): string {
  return /^(?:#[^\n]*\n)*/.exec(content)?.[0] ?? '';
}

/**
 * A revision's files as served over its connections' identities. Each cube on
 * a connection (its own data source, or its parent's through `extends`) is
 * aliased by `<data source>@<identity>`. Its SQL, and so Cube's cached results
 * and its rollup tables, are then another target's than those of any identity
 * before. Returns, by path, the salt of each file aliased so.
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
    try {
      const doc = yaml.load(file.content) as any;
      const cube = Array.isArray(doc?.cubes) && doc.cubes.length === 1 && typeof doc.cubes[0]?.name === 'string' ? doc.cubes[0] : undefined;
      return { file, cube };
    } catch {
      // Not xcube's YAML (a JavaScript file): served as it is.
      return { file, cube: undefined };
    }
  });
  const byName = new Map(parsed.filter((p) => p.cube).map((p) => [p.cube.name as string, p.cube]));
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
  const served = parsed.map(({ file, cube }) => {
    const dataSource = cube ? dataSourceOf(cube) : undefined;
    const identity = dataSource === undefined ? undefined : identities.get(dataSource);
    if (!cube || identity === undefined) {
      return file;
    }
    const salt = `${dataSource}@${identity}`;
    salts.set(file.path, salt);
    const alias = saltedAlias(cube.name, cube, salt);
    if (cube.sql_alias === alias && cube.sqlAlias === undefined) {
      return file;
    }
    delete cube.sqlAlias;
    cube.sql_alias = alias;
    return { ...file, content: `${leadingComments(file.content)}${dump('cube', cube)}` };
  });
  return { files: served, salts };
}
