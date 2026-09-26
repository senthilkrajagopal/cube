import { CompilerApi } from '@cubejs-backend/server-core';

import { folderOf, isGate } from './marker';

/** Admits every member on every row, as a policy with no member or row rules does (CompilerApi.ts:640-708, 1010-1013). */
const ALLOW_ALL = Object.freeze({});

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
}
