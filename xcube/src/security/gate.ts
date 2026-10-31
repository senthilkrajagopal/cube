import crypto from 'crypto';

import { CompilerApi } from '@cubejs-backend/server-core';

import { folderOf, isGate } from './marker';

/** Admits every member on every row, as a policy with no member or row rules does (CompilerApi.ts:640-708, 1010-1013). */
const ALLOW_ALL = Object.freeze({});

/** Operators Cube's gateway takes without values (gateway.ts, normalize). */
const VALUELESS = new Set(['set', 'notSet', 'measureFilter']);

/** A row filter that passes no row and needs no values: the member both set and not set. */
export function noRows(member: string): any {
  return { and: [{ member, operator: 'set' }, { member, operator: 'notSet' }] };
}

/** Whether a row filter passes no row: it holds a `noRows` its other parts can't undo. */
export function passesNoRow(filter: any): boolean {
  if (Array.isArray(filter?.and)) {
    const [a, b] = filter.and;
    return (filter.and.length === 2 && a?.operator === 'set' && b?.operator === 'notSet' &&
      typeof a.member === 'string' && a.member === b.member) || filter.and.some(passesNoRow);
  }
  if (Array.isArray(filter?.or)) {
    return filter.or.length > 0 && filter.or.every(passesNoRow);
  }
  return false;
}

/** The first member a row filter names. */
function memberOf(filter: any): string | undefined {
  return filter?.member ?? [...(filter?.and ?? []), ...(filter?.or ?? [])]
    .map(memberOf).find((member: string | undefined) => member !== undefined);
}

/**
 * Whether policies show a member, as Cube decides for a dimension (CompilerApi,
 * patchVisibilityByAccessPolicy). A hierarchy is also shown by an `includes` of
 * `'*'`, which Cube expands to measures, dimensions and segments only.
 */
export function policiesShow(policies: any[], member: string, hierarchy = false): boolean {
  return policies.some((policy) => (!policy.memberLevel && !policy.memberMasking) ||
    [policy.memberLevel, policy.memberMasking].some((rules) => rules && !rules.excludesMembers.includes(member) &&
      (rules.includesMembers.includes(member) || (hierarchy && (rules.includes ?? '*') === '*'))));
}

/** A model's permissions: whether security is on, and each folder's allowed groups. */
export interface Permissions {
  version: number;
  security: boolean;
  allowed: Map<string, Set<string>>;
}

/** Whether a context holding `groups` may read what a folder holds. */
export function admits(permissions: Permissions | undefined, folderId: string, groups: Set<string>): boolean {
  if (!permissions) {
    // Not known yet on this instance: closed.
    return false;
  }
  if (!permissions.security) {
    return true;
  }
  const allowed = permissions.allowed.get(folderId);
  if (!allowed?.size || !groups.size) {
    return false;
  }
  const [small, large] = groups.size <= allowed.size ? [groups, allowed] : [allowed, groups];
  for (const group of small) {
    if (large.has(group)) {
      return true;
    }
  }
  return false;
}

/** What the gate reads of a model's permissions: the latest, each time. */
export type PermissionsSource = () => Permissions | undefined;

/**
 * Cube's compiler API, with each cube's and view's policies gated by its
 * folder: a context its folder doesn't admit gets no policy, so Cube denies
 * it; one it admits gets the cube's own policies, or all members and rows
 * when it has none but the reserved one. The gate is read on every call,
 * before Cube's policy cache, so a permission change needs no recompile.
 */
export class FolderGateCompilerApi extends CompilerApi {
  public constructor(
    repository: any,
    dbType: any,
    options: any,
    protected readonly permissions: PermissionsSource,
  ) {
    super(repository, dbType, options);
  }

  protected override async getApplicablePolicies(cube: any, context: any, compilers: any): Promise<any[]> {
    const folderId = folderOf(cube);
    const policies: any[] = Array.isArray(cube?.accessPolicy) ? cube.accessPolicy : [];
    if (folderId === undefined || !policies.some(isGate)) {
      // Not something xcube published: Cube's own rules.
      return super.getApplicablePolicies(cube, context, compilers);
    }
    if (!admits(this.permissions(), folderId, await this.getGroupsFromContext(context))) {
      return [];
    }
    return policies.some((policy) => !isGate(policy))
      ? super.getApplicablePolicies(cube, context, compilers)
      : [ALLOW_ALL];
  }

  /**
   * A row filter whose values come out missing or empty (`security_context.attributes.<name>`
   * the token lacks, misspelled, or gave no values) passes no row, where Cube would refuse
   * the query with an error naming the member. So it fails closed for every operator.
   */
  protected override evaluateNestedFilter(filter: any, cube: any, context: any, cubeEvaluator: any): any {
    if (!filter?.memberReference || VALUELESS.has(filter.operator)) {
      return super.evaluateNestedFilter(filter, cube, context, cubeEvaluator);
    }
    let evaluated: any;
    try {
      evaluated = super.evaluateNestedFilter(filter, cube, context, cubeEvaluator);
    } catch (e) {
      // A path through what the context lacks, e.g. attributes on an HS256 token. The
      // model's code runs in its own realm, so its TypeError is known by name.
      if ((e as Error)?.name === 'TypeError') {
        return noRows(filter.memberReference);
      }
      throw e;
    }
    const { values } = evaluated;
    return Array.isArray(values) && values.some((value: unknown) => value !== undefined)
      ? evaluated
      : noRows(filter.memberReference);
  }

  /**
   * A hierarchy is shown as its dimensions are: under `includes: '*'`, or one that
   * names it, and not excluded; an author's `public: false` still hides it. Its
   * levels are the dimensions the context sees, and with none it is hidden.
   */
  protected override async patchVisibilityByAccessPolicy(compilers: any, context: any, cubes: any[]) {
    const patched = await super.patchVisibilityByAccessPolicy(compilers, context, cubes);
    const { cubeEvaluator } = compilers;
    if (!patched.visibilityMaskHash) {
      return patched;
    }
    const shown: Record<string, string[] | false> = {};
    const patchedCubes = await Promise.all(patched.cubes.map(async (cube: any, i: number) => {
      const { hierarchies, dimensions } = cubes[i].config;
      const evaluated = cubeEvaluator.cubeFromPath(cube.config.name);
      if (!hierarchies?.length || !cubeEvaluator.isRbacEnabledForCube(evaluated)) {
        return cube;
      }
      const policies = await this.getApplicablePolicies(evaluated, context, compilers);
      const seen = new Set((dimensions ?? []).map((d: any) => d.name).filter((name: string) => policiesShow(policies, name)));
      return {
        config: {
          ...cube.config,
          hierarchies: cube.config.hierarchies.map((hierarchy: any, j: number) => {
            const levels = (hierarchy.levels ?? []).filter((level: string) => seen.has(level));
            const visible = levels.length > 0 && policiesShow(policies, hierarchy.name, true);
            shown[hierarchy.name] = visible && levels;
            return { ...hierarchy, levels, public: (hierarchies[j].public ?? true) && visible };
          }),
        },
      };
    }));
    // The compiler id a context's meta gets is told apart by what it shows.
    const visibilityMaskHash = crypto.createHash('sha256').update(patched.visibilityMaskHash)
      .update(JSON.stringify(shown, Object.keys(shown).sort())).digest('hex');
    return { cubes: patchedCubes, visibilityMaskHash };
  }

  /** A query whose row filter passes no row is denied as Cube denies one: no rows, by `1 = 0`. */
  public override async applyRowLevelSecurity(
    ...args: Parameters<CompilerApi['applyRowLevelSecurity']>
  ): ReturnType<CompilerApi['applyRowLevelSecurity']> {
    const [query] = args;
    const before = query.filters?.length ?? 0;
    const result = await super.applyRowLevelSecurity(...args);
    const filters: any[] | undefined = result.query.filters;
    const rlsFilter = filters && filters.length > before ? filters[filters.length - 1] : undefined;
    if (result.denied || !passesNoRow(rlsFilter)) {
      return result;
    }
    filters!.pop();
    result.query.segments = [...(result.query.segments ?? []), {
      expression: () => '1 = 0',
      cubeName: memberOf(rlsFilter)!.split('.')[0],
      name: 'rlsAccessDenied',
    } as any];
    return { query: result.query, denied: true };
  }
}
