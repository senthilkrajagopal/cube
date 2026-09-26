// Seals or opens with `hpke` 1.1.7, the library the client seals with: an
// oracle for xcube's own RFC 9180 code. Reads a JSON request on stdin.
import * as HPKE from 'hpke';

const suite = new HPKE.CipherSuite(HPKE.KEM_DHKEM_X25519_HKDF_SHA256, HPKE.KDF_HKDF_SHA256, HPKE.AEAD_AES_128_GCM);
const b = (s) => Buffer.from(s, 'base64url');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const req = JSON.parse(input);
if (req.op === 'seal') {
  const pk = await suite.DeserializePublicKey(b(req.pk));
  const { encapsulatedSecret, ciphertext } = await suite.Seal(pk, b(req.pt), { info: b(req.info), aad: b(req.aad) });
  process.stdout.write(JSON.stringify({ enc: Buffer.from(encapsulatedSecret).toString('base64url'), ct: Buffer.from(ciphertext).toString('base64url') }));
} else {
  const pair = { privateKey: await suite.DeserializePrivateKey(b(req.sk), false), publicKey: await suite.DeserializePublicKey(b(req.pk)) };
  const pt = await suite.Open(pair, b(req.enc), b(req.ct), { info: b(req.info), aad: b(req.aad) });
  process.stdout.write(JSON.stringify({ pt: Buffer.from(pt).toString('base64url') }));
}
