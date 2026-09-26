import crypto from 'crypto';

/**
 * RS256 tokens, verified with `node:crypto` alone: the image has no JWT
 * library xcube may count on, and RS256 is one algorithm, pinned.
 */

/** Members a public RSA JWK must not carry (RFC 7518 §6.3.2). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

export const MIN_MODULUS_BITS = 2048;

const KID = /^[A-Za-z0-9._~:+/=-]{1,128}$/;

/** A public key a token may name by its `kid`. */
export interface VerificationKey {
  kid: string;
  key: crypto.KeyObject;
}

export class KeyError extends Error {}

/** RFC 7638's thumbprint of an RSA key: base64url SHA-256 of its required members, as jose computes it. */
export function thumbprintOf(jwk: { e: string; n: string }): string {
  const canonical = `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`;
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * A pushed or configured JWK, checked: RSA, for RS256 signatures only, with
 * a `kid`, at least 2048 bits, and public members alone.
 */
export function publicKeyOf(jwk: unknown): VerificationKey {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) {
    throw new KeyError('A key is a JSON object (a JWK)');
  }
  const k = jwk as Record<string, unknown>;
  const where = typeof k.kid === 'string' ? `Key "${k.kid.slice(0, 128)}"` : 'A key';
  if (typeof k.kid !== 'string' || !KID.test(k.kid)) {
    throw new KeyError(`${where}: kid is 1 to 128 characters of A-Z, a-z, 0-9 and ._~:+/=-`);
  }
  if (k.kty !== 'RSA') {
    throw new KeyError(`${where}: kty must be RSA`);
  }
  if (k.alg !== undefined && k.alg !== 'RS256') {
    throw new KeyError(`${where}: alg must be RS256, or absent`);
  }
  if (k.use !== undefined && k.use !== 'sig') {
    throw new KeyError(`${where}: use must be sig, or absent`);
  }
  if (k.key_ops !== undefined && !(Array.isArray(k.key_ops) && k.key_ops.every((op) => op === 'verify'))) {
    throw new KeyError(`${where}: key_ops may hold only verify`);
  }
  const leaked = PRIVATE_MEMBERS.filter((member) => k[member] !== undefined);
  if (leaked.length) {
    // Named, never echoed.
    throw new KeyError(`${where}: carries private key members (${leaked.join(', ')}); send the public key only`);
  }
  if (typeof k.n !== 'string' || typeof k.e !== 'string' || !k.n || !k.e) {
    throw new KeyError(`${where}: n and e are required`);
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' });
  } catch (e: any) {
    throw new KeyError(`${where}: not a valid RSA public key (${e.message})`);
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_MODULUS_BITS) {
    throw new KeyError(`${where}: ${bits}-bit keys are too short; RS256 needs ${MIN_MODULUS_BITS} bits or more`);
  }
  return { kid: k.kid, key };
}

/** A JWK set's keys, checked, with unique kids. */
export function keySetOf(keys: unknown[]): VerificationKey[] {
  const checked = keys.map(publicKeyOf);
  const seen = new Set<string>();
  for (const { kid } of checked) {
    if (seen.has(kid)) {
      throw new KeyError(`Key "${kid}" appears twice`);
    }
    seen.add(kid);
  }
  return checked;
}

/**
 * Keys from configuration: a JWK set (`{"keys": [...]}`), or PEM public keys
 * or certificates, whose kid is their RFC 7638 thumbprint.
 */
export function configuredKeys(text: string): VerificationKey[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('{')) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new KeyError('Not valid JSON');
    }
    if (!Array.isArray(parsed?.keys)) {
      throw new KeyError('A JWK set has a keys array');
    }
    return keySetOf(parsed.keys);
  }
  const blocks = trimmed.match(/-----BEGIN ([A-Z ]+)-----[\s\S]+?-----END \1-----/g) ?? [];
  if (!blocks.length) {
    throw new KeyError('Neither a JWK set nor PEM');
  }
  return keySetOf(blocks.map((pem) => {
    if (/PRIVATE KEY/.test(pem.slice(0, 64))) {
      // Node would derive the public key from it; xcube holds no signing key.
      throw new KeyError('A PEM block is a private key; give xcube the public key or certificate only');
    }
    let key: crypto.KeyObject;
    try {
      key = /CERTIFICATE/.test(pem)
        ? new crypto.X509Certificate(pem).publicKey
        : crypto.createPublicKey(pem);
    } catch (e: any) {
      throw new KeyError(`A PEM block is not a public key or certificate (${e.message})`);
    }
    if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') {
      throw new KeyError('A PEM block is not an RSA public key');
    }
    const jwk = key.export({ format: 'jwk' }) as { n: string; e: string };
    return { kty: 'RSA', n: jwk.n, e: jwk.e, kid: thumbprintOf(jwk) };
  }));
}

export class TokenError extends Error {}

export interface TokenHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

function segmentJson(segment: string, what: string): any {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new TokenError(`The token's ${what} is not base64url`);
  }
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new TokenError(`The token's ${what} is not a JSON object`);
  }
}

/** A compact JWS's parts, unverified. */
export function tokenParts(token: string): { header: TokenHeader; payload: string; signed: string; signature: string } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new TokenError('Not a JWT');
  }
  return { header: segmentJson(parts[0], 'header'), payload: parts[1], signed: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

export interface ClaimChecks {
  audience: string;
  /** When set, `iss` must equal it. */
  issuer?: string;
  /** Allowed clock skew, in seconds. */
  clockToleranceS: number;
  /** The longest `exp - iat` taken, in seconds. */
  maxLifetimeS: number;
  now?: number;
}

/**
 * Verifies an RS256 token's signature with `key`, and its registered claims:
 * `exp` and `iat` are required, `nbf` honoured, `aud` must name the
 * audience, and a token may live at most `maxLifetimeS`.
 */
export function verifyRs256(token: string, key: crypto.KeyObject, checks: ClaimChecks): Record<string, unknown> {
  const { header, payload, signed, signature } = tokenParts(token);
  if (header.alg !== 'RS256') {
    throw new TokenError('Only RS256 tokens are taken');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signature)
    || !crypto.verify('RSA-SHA256', Buffer.from(signed, 'utf8'), key, Buffer.from(signature, 'base64url'))) {
    throw new TokenError('Invalid signature');
  }
  const claims = segmentJson(payload, 'payload');
  const now = checks.now ?? Math.floor(Date.now() / 1000);
  const tolerance = checks.clockToleranceS;
  const { exp, iat, nbf, aud, iss } = claims;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new TokenError('The token has no exp');
  }
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    throw new TokenError('The token has no iat');
  }
  if (now > exp + tolerance) {
    throw new TokenError('The token has expired');
  }
  if (iat > now + tolerance) {
    throw new TokenError('The token was issued in the future');
  }
  if (nbf !== undefined && (typeof nbf !== 'number' || now + tolerance < nbf)) {
    throw new TokenError('The token is not valid yet');
  }
  if (exp - iat > checks.maxLifetimeS) {
    throw new TokenError(`The token lives longer than ${checks.maxLifetimeS} s`);
  }
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(checks.audience)) {
    throw new TokenError(`The token's aud is not ${checks.audience}`);
  }
  if (checks.issuer !== undefined && iss !== checks.issuer) {
    throw new TokenError('The token\'s iss is not the one expected');
  }
  return claims;
}
