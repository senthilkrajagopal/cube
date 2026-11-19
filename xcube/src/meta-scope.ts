/** What a `/v1/meta` request asks for, past Cube's own `extended` and `onlyViews`. */
export interface MetaScope {
  /** Only these cubes and views (by name), asked of only the modules holding them. */
  cubes?: string[];
  /** `false`: each cube without its members, with its joins (name and relationship). */
  members: boolean;
  extended: boolean;
  onlyViews: boolean;
  /** `ndjson`: a line per cube (`writeNdjson`). */
  format: 'json' | 'ndjson';
}

/** The most cubes one `/v1/meta` may name. */
export const MAX_META_CUBES = 20000;

/** A cube's own fields in plain `/v1/meta` (Cube's `CubeToMetaTransformer`), as `members=false` answers them. */
const PLAIN_CUBE_FIELDS = ['name', 'type', 'title', 'isVisible', 'public', 'description', 'viewGroups', 'connectedComponent', 'meta'];

/** A meta cube's member lists: what `members=false` leaves out. */
const MEMBER_LISTS = ['measures', 'dimensions', 'segments', 'hierarchies', 'folders', 'nestedFolders', 'preAggregations'];

export class MetaScopeError extends Error {}

/**
 * A `/v1/meta` request's scope: `GET` from its query (`cubes=a,b`, repeatable;
 * `members=false`; `format=ndjson`; Cube's `extended` and `onlyViews`), `POST`
 * from its JSON body (`{"cubes": [...], "members": false, "extended": true,
 * "onlyViews": true, "format": "ndjson"}`). `Accept: application/x-ndjson`
 * also asks for NDJSON.
 *
 * @throws MetaScopeError
 */
export function metaScopeOf(method: string, query: Record<string, unknown>, body: unknown, accept?: string): MetaScope {
  const post = method === 'POST';
  if (post && (typeof body !== 'object' || body === null || Array.isArray(body))) {
    throw new MetaScopeError('The body is a JSON object');
  }
  const from: Record<string, unknown> = post ? body as Record<string, unknown> : query;
  const known = new Set(['cubes', 'members', 'extended', 'onlyViews', 'format']);
  const unknown = post ? Object.keys(from).filter((k) => !known.has(k)) : [];
  if (unknown.length) {
    throw new MetaScopeError(`Unknown field ${JSON.stringify(unknown[0])}: cubes, members, extended, onlyViews or format`);
  }
  const flag = (name: string, absent: boolean): boolean => {
    const value = from[name];
    if (value === undefined) {
      return absent;
    }
    if (value === true || value === 'true') {
      return true;
    }
    if (value === false || value === 'false') {
      return false;
    }
    throw new MetaScopeError(`${name} is true or false`);
  };

  let cubes: string[] | undefined;
  if (from.cubes !== undefined) {
    const raw = from.cubes;
    const list = post
      ? raw
      : (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]));
    if (!Array.isArray(list) || list.some((n) => typeof n !== 'string')) {
      throw new MetaScopeError('cubes is a list of cube and view names');
    }
    cubes = [...new Set((list as string[]).map((n) => n.trim()).filter((n) => n !== ''))];
    if (cubes.length > MAX_META_CUBES || cubes.some((n) => n.length > 256)) {
      throw new MetaScopeError(`cubes names at most ${MAX_META_CUBES} names of at most 256 characters`);
    }
  }
  const format = from.format ?? (/\bapplication\/x-ndjson\b/.test(accept ?? '') ? 'ndjson' : 'json');
  if (format !== 'json' && format !== 'ndjson') {
    throw new MetaScopeError('format is json or ndjson');
  }
  return {
    ...(cubes ? { cubes } : {}),
    members: flag('members', true),
    // As Cube reads a GET: `extended` present, whatever its value.
    extended: post ? flag('extended', false) : from.extended !== undefined,
    onlyViews: flag('onlyViews', false),
    format,
  };
}

/** A meta answer as a scope asks: only its cubes, and without members when it says so. */
export function scopedMeta(body: any, scope: MetaScope): any {
  if (!body || !Array.isArray(body.cubes)) {
    return body;
  }
  const names = scope.cubes ? new Set(scope.cubes) : null;
  let cubes = names ? body.cubes.filter((cube: any) => names.has(cube.name)) : body.cubes;
  if (!scope.members) {
    cubes = cubes.map((cube: any) => {
      const summary = { ...cube };
      MEMBER_LISTS.forEach((list) => delete summary[list]);
      if (scope.extended) {
        return summary;
      }
      // Asked of extended meta for its joins: plain meta's own fields, and of the joins only what a picker needs.
      const plain: Record<string, unknown> = {};
      PLAIN_CUBE_FIELDS.forEach((field) => {
        if (summary[field] !== undefined) {
          plain[field] = summary[field];
        }
      });
      plain.joins = (cube.joins ?? []).map((join: any) => ({ name: join.name, relationship: join.relationship }));
      return plain;
    });
  }
  return { ...body, cubes };
}
