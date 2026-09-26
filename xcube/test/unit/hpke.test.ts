import crypto from 'crypto';
import { execFileSync } from 'child_process';
import path from 'path';

import { HpkeError, open, rawPublicKey, seal, x25519PublicKey } from '../../src/credentials/hpke';

const hex = (s: string) => Buffer.from(s, 'hex');
/** An X25519 private key from its 32 raw bytes, as PKCS#8. */
const privateKey = (sk: Buffer) => crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), sk]), format: 'der', type: 'pkcs8',
});

// RFC 9180 Appendix A.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
const A1 = {
  info: hex('4f6465206f6e2061204772656369616e2055726e'),
  pkEm: hex('37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431'),
  skEm: hex('52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736'),
  pkRm: hex('3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d'),
  skRm: hex('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8'),
  pt: hex('4265617574792069732074727574682c20747275746820626561757479'),
  aad: hex('436f756e742d30'),
  ct: hex('f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a'),
};

const oracle = (request: object) => JSON.parse(execFileSync(
  process.execPath,
  [path.join(__dirname, '../fixtures/hpke-oracle.mjs')],
  { input: JSON.stringify(request) },
).toString());
const b64 = (b: Buffer) => b.toString('base64url');

describe('HPKE (RFC 9180)', () => {
  test('opens and seals RFC 9180 A.1 exactly', () => {
    const recipient = privateKey(A1.skRm);
    expect(open(recipient, A1.pkEm, A1.ct, A1.info, A1.aad)).toEqual(A1.pt);
    const { enc, ciphertext } = seal(x25519PublicKey(A1.pkRm), A1.pt, A1.info, A1.aad, privateKey(A1.skEm));
    expect(enc).toEqual(A1.pkEm);
    expect(ciphertext).toEqual(A1.ct);
  });

  test('refuses another key, info, aad or a tampered ciphertext', () => {
    const recipient = privateKey(A1.skRm);
    const other = crypto.generateKeyPairSync('x25519').privateKey;
    expect(() => open(other, A1.pkEm, A1.ct, A1.info, A1.aad)).toThrow(HpkeError);
    expect(() => open(recipient, A1.pkEm, A1.ct, Buffer.from('other'), A1.aad)).toThrow(HpkeError);
    expect(() => open(recipient, A1.pkEm, A1.ct, A1.info, Buffer.from('Count-1'))).toThrow(HpkeError);
    const tampered = Buffer.from(A1.ct);
    tampered[3] = tampered[3] === 0 ? 1 : 0;
    expect(() => open(recipient, A1.pkEm, tampered, A1.info, A1.aad)).toThrow(HpkeError);
    expect(() => open(recipient, A1.pkEm.subarray(1), A1.ct, A1.info, A1.aad)).toThrow(/Malformed/);
  });

  test('interoperates with hpke 1.1.7, the client\'s library, both ways', () => {
    const { privateKey: sk, publicKey: pk } = crypto.generateKeyPairSync('x25519');
    const { d } = sk.export({ format: 'jwk' }) as { d: string };
    const info = Buffer.from('wechart/data-source-secret/v1');
    const aad = Buffer.from('["wechart/data-source-secret/v1","postgres","password",[["host","db"],["port","5432"]]]');
    const pt = Buffer.from('s3cret, with ünïcode');

    const sealed = oracle({ op: 'seal', pk: b64(rawPublicKey(pk)), pt: b64(pt), info: b64(info), aad: b64(aad) });
    expect(open(sk, Buffer.from(sealed.enc, 'base64url'), Buffer.from(sealed.ct, 'base64url'), info, aad)).toEqual(pt);

    const mine = seal(pk, pt, info, aad);
    const opened = oracle({ op: 'open', sk: d, pk: b64(rawPublicKey(pk)), enc: b64(mine.enc), ct: b64(mine.ciphertext), info: b64(info), aad: b64(aad) });
    expect(Buffer.from(opened.pt, 'base64url')).toEqual(pt);
  });
});
