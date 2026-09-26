import crypto from 'crypto';

/**
 * HPKE (RFC 9180), base mode, single-shot, for the one suite credentials are
 * sealed with: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM (the
 * suite of RFC 9180's test vector A.1). On `node:crypto` alone, so the image
 * needs no package beyond Cube's; checked against A.1 and against `hpke`
 * 1.1.7, which the client seals with.
 */

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0001;
const N_SECRET = 32;
const N_K = 16;
const N_N = 12;
const N_T = 16;
const N_PK = 32;

const i2osp = (value: number, length: number) => {
  const out = Buffer.alloc(length);
  out.writeUIntBE(value, 0, length);
  return out;
};

const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(KEM_ID, 2)]);
const HPKE_SUITE = Buffer.concat([Buffer.from('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2)]);
const VERSION = Buffer.from('HPKE-v1');

const extract = (salt: Buffer, ikm: Buffer) => crypto.createHmac('sha256', salt).update(ikm).digest();

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    previous = crypto.createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([i])])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) => extract(
  salt,
  Buffer.concat([VERSION, suite, Buffer.from(label), ikm]),
);

const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) => expand(
  prk,
  Buffer.concat([i2osp(length, 2), VERSION, suite, Buffer.from(label), info]),
  length,
);

/** An X25519 public key from its 32 raw bytes. */
export function x25519PublicKey(raw: Buffer): crypto.KeyObject {
  if (raw.length !== N_PK) {
    throw new Error('An X25519 public key is 32 bytes');
  }
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** An X25519 key's raw public bytes. */
export function rawPublicKey(key: crypto.KeyObject): Buffer {
  const { x } = key.export({ format: 'jwk' }) as { x: string };
  return Buffer.from(x, 'base64url');
}

function sharedSecret(dh: Buffer, enc: Buffer, pkRm: Buffer): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE, Buffer.alloc(0), 'eae_prk', dh);
  return labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', Buffer.concat([enc, pkRm]), N_SECRET);
}

function keySchedule(shared: Buffer, info: Buffer): { key: Buffer; nonce: Buffer } {
  const pskIdHash = labeledExtract(HPKE_SUITE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0));
  const infoHash = labeledExtract(HPKE_SUITE, Buffer.alloc(0), 'info_hash', info);
  const context = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', Buffer.alloc(0));
  return {
    key: labeledExpand(HPKE_SUITE, secret, 'key', context, N_K),
    // Sequence number 0: the base nonce itself.
    nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, N_N),
  };
}

export class HpkeError extends Error {}

/**
 * Opens a ciphertext sealed to `recipient` (an X25519 private key). Throws
 * `HpkeError` on any mismatch: another key, `info` or `aad`, or tampering.
 */
export function open(recipient: crypto.KeyObject, enc: Buffer, ciphertext: Buffer, info: Buffer, aad: Buffer): Buffer {
  if (enc.length !== N_PK || ciphertext.length < N_T) {
    throw new HpkeError('Malformed envelope');
  }
  let dh: Buffer;
  try {
    dh = crypto.diffieHellman({ privateKey: recipient, publicKey: x25519PublicKey(enc) });
  } catch {
    throw new HpkeError('Malformed envelope');
  }
  const pkRm = rawPublicKey(crypto.createPublicKey(recipient));
  const { key, nonce } = keySchedule(sharedSecret(dh, enc, pkRm), info);
  try {
    const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - N_T));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - N_T)), decipher.final()]);
  } catch {
    throw new HpkeError('The envelope doesn\'t open with this key and binding');
  } finally {
    key.fill(0);
  }
}

/**
 * Seals a plaintext to `recipient` (an X25519 public key). `ephemeral` is for
 * known-answer tests only; otherwise a fresh key pair is made each time.
 */
export function seal(
  recipient: crypto.KeyObject,
  plaintext: Buffer,
  info: Buffer,
  aad: Buffer,
  ephemeral: crypto.KeyObject = crypto.generateKeyPairSync('x25519').privateKey,
): { enc: Buffer; ciphertext: Buffer } {
  const enc = rawPublicKey(crypto.createPublicKey(ephemeral));
  const dh = crypto.diffieHellman({ privateKey: ephemeral, publicKey: recipient });
  const { key, nonce } = keySchedule(sharedSecret(dh, enc, rawPublicKey(recipient)), info);
  try {
    const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { enc, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
  } finally {
    key.fill(0);
  }
}
