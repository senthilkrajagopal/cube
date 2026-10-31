import type crypto from 'crypto';
import fs from 'fs';

import { configuredKeys, publicKeyOf, TokenError, tokenParts, verifyRs256 } from './tokens';
import type { TokenSettings } from '../runtime/settings';

/**
 * In a security context xcube built from a token it verified: `user` or
 * `service`. Taken out of any other context, so no token can claim it.
 */
export const ROLE_KEY = 'xcubeRole';

export type Role = 'user' | 'service';

/**
 * A user token's claim, and its context's key, for the user's attributes:
 * each a list of strings, read by a policy as `security_context.attributes.<name>`.
 */
export const ATTRIBUTES_KEY = 'attributes';

export const ATTRIBUTE_LIMITS = { attributes: 100, values: 100, valueLength: 200 };

const ATTRIBUTE_NAME = /^[a-z0-9_]{1,40}$/;

/**
 * The attributes a user token carries, as its context holds them: none for no
 * claim. A claim that isn't an object of string lists, within the limits, is
 * refused: a policy reading it would otherwise filter by what wechart never signed.
 */
export function attributesOf(claim: unknown): Record<string, string[]> {
  if (claim === undefined) {
    return {};
  }
  if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) {
    throw new TokenError(`The token's ${ATTRIBUTES_KEY} must be an object of string lists`);
  }
  const entries = Object.entries(claim);
  if (entries.length > ATTRIBUTE_LIMITS.attributes) {
    throw new TokenError(`The token has more than ${ATTRIBUTE_LIMITS.attributes} ${ATTRIBUTES_KEY}`);
  }
  for (const [name, values] of entries) {
    // `__proto__` would be an object's prototype, not one of its keys, wherever the context is copied.
    if (!ATTRIBUTE_NAME.test(name) || name === '__proto__') {
      throw new TokenError(`The token's attribute ${JSON.stringify(name.slice(0, 64))} isn't named with 1 to 40 of a-z, 0-9 and _`);
    }
    if (!Array.isArray(values) || values.length > ATTRIBUTE_LIMITS.values
      || !values.every((v) => typeof v === 'string' && v.length <= ATTRIBUTE_LIMITS.valueLength)) {
      throw new TokenError(`The token's attribute ${name} must be a list of at most ${ATTRIBUTE_LIMITS.values} strings `
        + `of at most ${ATTRIBUTE_LIMITS.valueLength} characters`);
    }
  }
  return Object.fromEntries(entries.map(([name, values]) => [name, [...(values as string[])]]));
}

interface ModelKeys {
  version: number;
  issuer: string | null;
  keys: Map<string, crypto.KeyObject>;
}

export interface VerifiedToken {
  role: Role;
  securityContext: Record<string, unknown>;
}

export interface VerifierOptions {
  modelClaim: () => string;
  revisionClaim: () => string;
  /** The claim naming the overlay a user's token previews. */
  overlayClaim?: () => string;
  /** Asked once when a token names a kid no key has: reads the keys again, in case a push hasn't arrived here yet. */
  missingKid: (kid: string) => Promise<void>;
}

/**
 * Verifies RS256 tokens: a user's against the keys pushed for the model it
 * reads, the service credential's against the keys configured for it. What
 * it builds is the whole security context: a user's model, groups,
 * revision and attributes, nothing else of the token.
 */
export class TokenVerifier {
  protected readonly models = new Map<string, ModelKeys>();

  /** kid → the models whose pushed sets hold it. */
  protected readonly byKid = new Map<string, Set<string>>();

  protected service = new Map<string, crypto.KeyObject>();

  protected serviceSource = '';

  public constructor(protected readonly settings: TokenSettings, protected readonly options: VerifierOptions) {}

  /** A model's pushed key set, or `null` for none. Keys that no longer parse are skipped. */
  public setModelKeys(model: string, set: { version: number; issuer: string | null; keys: Record<string, unknown>[] } | null) {
    const before = this.models.get(model);
    before?.keys.forEach((_key, kid) => {
      const holders = this.byKid.get(kid);
      holders?.delete(model);
      if (holders && !holders.size) {
        this.byKid.delete(kid);
      }
    });
    if (!set) {
      this.models.delete(model);
      return [];
    }
    const keys = new Map<string, crypto.KeyObject>();
    const skipped: string[] = [];
    for (const jwk of set.keys) {
      try {
        const { kid, key } = publicKeyOf(jwk);
        keys.set(kid, key);
        this.byKid.set(kid, (this.byKid.get(kid) ?? new Set()).add(model));
      } catch {
        skipped.push(String(jwk?.kid).slice(0, 128));
      }
    }
    this.models.set(model, { version: set.version, issuer: set.issuer, keys });
    return skipped;
  }

  public keysVersion(model: string): number | null {
    return this.models.get(model)?.version ?? null;
  }

  /** Whether the model takes RS256 tokens only. */
  public hasKeys(model: string): boolean {
    return this.models.has(model);
  }

  public anyKeys(): boolean {
    return this.models.size > 0;
  }

  public isServiceKid(kid: string): boolean {
    return this.service.has(kid);
  }

  public get serviceConfigured(): boolean {
    return this.service.size > 0;
  }

  /**
   * Reads the service credential's keys from the settings or their file;
   * `true` when they changed. Throws when they don't parse.
   */
  public loadServiceKeys(): boolean {
    const { serviceKeys, serviceKeysFile } = this.settings;
    const source = serviceKeysFile ? fs.readFileSync(serviceKeysFile, 'utf8') : serviceKeys;
    if (source === this.serviceSource) {
      return false;
    }
    const keys = configuredKeys(source);
    this.service = new Map(keys.map(({ kid, key }) => [kid, key]));
    this.serviceSource = source;
    return true;
  }

  /** Verifies an RS256 token as a user's or the service credential's, by its kid. */
  public async verify(token: string): Promise<VerifiedToken> {
    const { header, payload } = tokenParts(token);
    if (header.alg !== 'RS256') {
      throw new TokenError('Only RS256 tokens are taken');
    }
    if (typeof header.kid !== 'string' || !header.kid) {
      throw new TokenError('The token has no kid');
    }
    const { kid } = header;
    if (this.service.has(kid)) {
      return this.verifyService(token, kid);
    }
    if (!this.byKid.has(kid)) {
      await this.options.missingKid(kid);
    }
    const holders = this.byKid.get(kid);
    if (!holders?.size) {
      throw new TokenError('No key has the token\'s kid');
    }
    const modelClaim = this.options.modelClaim();
    // Which model's key: the one the token names, which only a signature by that key can then confirm.
    let named: unknown;
    try {
      named = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.[modelClaim];
    } catch {
      named = undefined;
    }
    let model: string;
    if (typeof named === 'string') {
      if (!holders.has(named)) {
        throw new TokenError('The token\'s key is not one of its model\'s');
      }
      model = named;
    } else if (named === undefined && holders.size === 1) {
      [model] = holders;
    } else {
      throw new TokenError(`The token must name its model in ${modelClaim}`);
    }
    const set = this.models.get(model)!;
    const claims = verifyRs256(token, set.keys.get(kid)!, {
      audience: this.settings.audience,
      issuer: set.issuer ?? undefined,
      clockToleranceS: this.settings.clockToleranceS,
      maxLifetimeS: this.settings.maxLifetimeS,
    });
    if (claims.role !== 'user') {
      throw new TokenError('A model\'s key signs user tokens only (role: user)');
    }
    const revisionClaim = this.options.revisionClaim();
    const overlayClaim = this.options.overlayClaim?.();
    const groups = Array.isArray(claims.groups) ? claims.groups.filter((g): g is string => typeof g === 'string') : [];
    const attributes = attributesOf(claims[ATTRIBUTES_KEY]);
    return {
      role: 'user',
      securityContext: {
        [modelClaim]: model,
        groups,
        // Always there, so a policy reading one the token lacks gets no rows (gate.ts, `noRows`), not an error.
        [ATTRIBUTES_KEY]: attributes,
        ...(claims[revisionClaim] !== undefined ? { [revisionClaim]: claims[revisionClaim] } : {}),
        // The overlay it previews: the client signs one only for those it allows (AC-323).
        ...(overlayClaim && claims[overlayClaim] !== undefined ? { [overlayClaim]: claims[overlayClaim] } : {}),
        [ROLE_KEY]: 'user',
      },
    };
  }

  /** The service credential, for the admin routes: the model it is for, when it names one. */
  public verifyServiceToken(token: string): { model?: string } {
    const { header } = tokenParts(token);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !this.service.has(header.kid)) {
      throw new TokenError('Not signed by the service credential');
    }
    const model = this.verifyService(token, header.kid).securityContext[this.options.modelClaim()];
    return typeof model === 'string' ? { model } : {};
  }

  protected verifyService(token: string, kid: string): VerifiedToken {
    const claims = verifyRs256(token, this.service.get(kid)!, {
      audience: this.settings.serviceAudience,
      issuer: this.settings.serviceIssuer,
      clockToleranceS: this.settings.clockToleranceS,
      maxLifetimeS: this.settings.maxLifetimeS,
    });
    if (claims.role !== 'service') {
      throw new TokenError('The service key signs service tokens only (role: service)');
    }
    const modelClaim = this.options.modelClaim();
    const model = claims[modelClaim];
    return {
      role: 'service',
      securityContext: { ...(typeof model === 'string' ? { [modelClaim]: model } : {}), [ROLE_KEY]: 'service' },
    };
  }
}
