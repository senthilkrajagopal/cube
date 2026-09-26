import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DRIVERS, type DriverType } from '../connections/drivers';
import { HpkeError, open, rawPublicKey, seal } from './hpke';

/**
 * Data-source secrets, sealed by the client's browser to xcube's public key
 * (wechart's `research/credential-sealing.md`, scheme v1): HPKE base mode,
 * DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM; one envelope per
 * secret field, bound to its driver, field and connection target. The
 * client stores envelopes and can't open them; xcube opens them only to
 * connect, test or re-wrap.
 */

export const INFO_V1 = Buffer.from('wechart/data-source-secret/v1');

/** The sample envelope each key comes with: opened at start, it proves the key file is the key. */
export const CHECK_INFO = Buffer.from('wechart/xcube-key-check/v1');
export const CHECK_PLAINTEXT = 'xcube-key-check';

const BUCKET = 256;

export class CredentialError extends Error {}

/** A sealed secret: base64url `enc` (32 bytes) and `ct`. */
export interface SealedV1 {
  v: 1;
  kid: string;
  enc: string;
  ct: string;
}

export type Connection = Readonly<Record<string, string | number | boolean | null | undefined>>;

/**
 * What a secret is bound to: its driver, its field and the connection's
 * target, from the values as the client sent them (before defaults), the
 * target keys sorted. Byte-identical to the client's `secretAadV1`.
 */
export function secretAadV1(driver: DriverType, field: string, connection: Connection): Buffer {
  const pairs = [...DRIVERS[driver].target].sort().map((k) => {
    const v = connection[k];
    return [k, v === undefined || v === null ? '' : String(v)];
  });
  return Buffer.from(JSON.stringify(['wechart/data-source-secret/v1', driver, field, pairs]), 'utf8');
}

/** `0x01 ‖ uint32be(len) ‖ UTF-8 ‖ zeros`, to a multiple of 256 bytes: the length is hidden to the bucket. */
export function padV1(secret: string): Buffer {
  const body = Buffer.from(secret, 'utf8');
  const out = Buffer.alloc(Math.ceil((5 + body.length) / BUCKET) * BUCKET);
  out[0] = 1;
  out.writeUInt32BE(body.length, 1);
  body.copy(out, 5);
  body.fill(0);
  return out;
}

export function unpadV1(pt: Buffer): string {
  const length = pt.length >= 5 ? pt.readUInt32BE(1) : -1;
  if (pt[0] !== 1 || pt.length % BUCKET !== 0 || length < 0 || 5 + length > pt.length || pt.subarray(5 + length).some((b) => b !== 0)) {
    throw new CredentialError('malformed credential plaintext');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(pt.subarray(5, 5 + length));
}

/** RFC 7638's thumbprint of an X25519 public key (RFC 8037's members: crv, kty, x). */
export function x25519Thumbprint(x: string): string {
  return crypto.createHash('sha256').update(`{"crv":"X25519","kty":"OKP","x":"${x}"}`, 'utf8').digest('base64url');
}

interface Key {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  x: string;
}

function isSealed(value: unknown): value is SealedV1 {
  const e = value as SealedV1;
  return Boolean(e) && typeof e === 'object' && e.v === 1 && typeof e.kid === 'string'
    && typeof e.enc === 'string' && typeof e.ct === 'string';
}

function sealWith(key: crypto.KeyObject, kid: string, pt: Buffer, info: Buffer, aad: Buffer): SealedV1 {
  const { enc, ciphertext } = seal(key, pt, info, aad);
  return { v: 1, kid, enc: enc.toString('base64url'), ct: ciphertext.toString('base64url') };
}

/**
 * xcube's credential keys, read at start from `<dir>/<kid>.pem` (PKCS#8
 * X25519) and `<dir>/<kid>.check`: each must be X25519, match its kid, and
 * open its sample envelope, or the process doesn't start.
 */
export class CredentialKeys {
  protected readonly keys = new Map<string, Key>();

  public constructor(dir: string, kids: string[], public readonly activeKid: string) {
    if (!kids.includes(activeKid)) {
      throw new CredentialError(`the active credential key ${activeKid} is not among XCUBE_CREDENTIAL_KEY_IDS`);
    }
    for (const kid of kids) {
      const file = path.join(dir, `${kid}.pem`);
      let privateKey: crypto.KeyObject;
      try {
        privateKey = crypto.createPrivateKey(fs.readFileSync(file));
      } catch (e: any) {
        throw new CredentialError(`credential key ${kid}: can't read ${file} (${e.code ?? e.message})`);
      }
      if (privateKey.asymmetricKeyType !== 'x25519') {
        throw new CredentialError(`credential key ${kid}: not an X25519 key`);
      }
      const publicKey = crypto.createPublicKey(privateKey);
      const x = rawPublicKey(publicKey).toString('base64url');
      if (x25519Thumbprint(x) !== kid) {
        throw new CredentialError(`credential key ${kid}: the key file doesn't match its id`);
      }
      const key = { kid, privateKey, publicKey, x };
      let check: unknown;
      try {
        check = JSON.parse(fs.readFileSync(path.join(dir, `${kid}.check`), 'utf8'));
      } catch (e: any) {
        throw new CredentialError(`credential key ${kid}: can't read its sample credential ${kid}.check (${e.code ?? e.message})`);
      }
      try {
        if (!isSealed(check) || check.kid !== kid
          || unpadV1(this.openWith(key, check, CHECK_INFO, Buffer.from(kid))) !== CHECK_PLAINTEXT) {
          throw new Error();
        }
      } catch {
        throw new CredentialError(`credential key ${kid} can't decrypt its sample credential`);
      }
      this.keys.set(kid, key);
    }
  }

  /** The public keys the client may seal to: the active one, and those kept for secrets still sealed to them. */
  public publicKeys(): { kid: string; x: string; active: boolean }[] {
    return [...this.keys.values()].map(({ kid, x }) => ({ kid, x, active: kid === this.activeKid }));
  }

  protected openWith(key: Key, envelope: SealedV1, info: Buffer, aad: Buffer): Buffer {
    return open(key.privateKey, Buffer.from(envelope.enc, 'base64url'), Buffer.from(envelope.ct, 'base64url'), info, aad);
  }

  /**
   * A secret, opened for the connection it is used with: the binding is
   * computed from that connection, never read from the envelope.
   */
  public open(envelope: unknown, driver: DriverType, field: string, connection: Connection): string {
    if (!isSealed(envelope)) {
      throw new CredentialError(`${field}: not a sealed secret (v1)`);
    }
    const key = this.keys.get(envelope.kid);
    if (!key) {
      throw new CredentialError(`${field}: sealed to key ${envelope.kid.slice(0, 64)}, which xcube doesn't hold`);
    }
    let pt: Buffer | undefined;
    try {
      pt = this.openWith(key, envelope, INFO_V1, secretAadV1(driver, field, connection));
      return unpadV1(pt);
    } catch (e) {
      if (e instanceof HpkeError || e instanceof CredentialError) {
        throw new CredentialError(`${field}: the stored secret can't be used for this connection target; enter it again`);
      }
      throw e;
    } finally {
      pt?.fill(0);
    }
  }

  /** A secret sealed again to the active key, with the same binding: rotation, never a re-bind. */
  public rewrap(envelope: unknown, driver: DriverType, field: string, connection: Connection): SealedV1 {
    if (!isSealed(envelope)) {
      throw new CredentialError(`${field}: not a sealed secret (v1)`);
    }
    const key = this.keys.get(envelope.kid);
    if (!key) {
      throw new CredentialError(`${field}: sealed to key ${envelope.kid.slice(0, 64)}, which xcube doesn't hold`);
    }
    const aad = secretAadV1(driver, field, connection);
    let pt: Buffer | undefined;
    try {
      pt = this.openWith(key, envelope, INFO_V1, aad);
      unpadV1(pt);
      return sealWith(this.keys.get(this.activeKid)!.publicKey, this.activeKid, pt, INFO_V1, aad);
    } catch (e) {
      if (e instanceof HpkeError || e instanceof CredentialError) {
        throw new CredentialError(`${field}: doesn't open for this connection target`);
      }
      throw e;
    } finally {
      pt?.fill(0);
    }
  }
}

/** A new credential key: its kid, private PEM, sample envelope, and public JWK for the client. */
export function generateCredentialKey(privatePem?: string) {
  const privateKey = privatePem ? crypto.createPrivateKey(privatePem) : crypto.generateKeyPairSync('x25519').privateKey;
  if (privateKey.asymmetricKeyType !== 'x25519') {
    throw new CredentialError('not an X25519 key');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const x = rawPublicKey(publicKey).toString('base64url');
  const kid = x25519Thumbprint(x);
  const check = sealWith(publicKey, kid, padV1(CHECK_PLAINTEXT), CHECK_INFO, Buffer.from(kid));
  return {
    kid,
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    check: JSON.stringify(check),
    jwk: { kty: 'OKP', crv: 'X25519', x, kid },
  };
}

/** Seals a secret as the client does, for tests and tools: never used to store one. */
export function sealSecretV1(publicX: string, kid: string, driver: DriverType, field: string, connection: Connection, secret: string): SealedV1 {
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicX }, format: 'jwk' });
  const pt = padV1(secret);
  try {
    return sealWith(publicKey, kid, pt, INFO_V1, secretAadV1(driver, field, connection));
  } finally {
    pt.fill(0);
  }
}
