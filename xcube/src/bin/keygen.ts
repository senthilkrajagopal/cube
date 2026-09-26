#!/usr/bin/env node
/**
 * Makes a credential key for xcube: `<kid>.pem` (the private key, for
 * xcube's Secret only) and `<kid>.check` (its sample credential), in a
 * directory, and prints the public JWK the client seals to.
 *
 *   xcube-keygen <dir>               a new X25519 key
 *   xcube-keygen <dir> <key.pem>     the files for an existing X25519 key
 *                                    (e.g. from `openssl genpkey -algorithm X25519`)
 */
import fs from 'fs';
import path from 'path';

import { generateCredentialKey } from '../credentials/credentials';

function main() {
  const [dir, existing] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: xcube-keygen <dir> [<existing X25519 key.pem>]');
    process.exit(2);
  }
  const key = generateCredentialKey(existing ? fs.readFileSync(existing, 'utf8') : undefined);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key.kid}.pem`), key.pem, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, `${key.kid}.check`), key.check);
  console.log(JSON.stringify(key.jwk));
  console.error(`Wrote ${key.kid}.pem and ${key.kid}.check to ${dir}. Keep the .pem only in xcube's Secret; give the client the JWK above.`);
}

main();
