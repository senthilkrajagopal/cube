import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  CredentialError,
  CredentialKeys,
  generateCredentialKey,
  INFO_V1,
  padV1,
  sealSecretV1,
  secretAadV1,
  unpadV1,
} from '../../src/credentials/credentials';

const target = { host: 'db.example.com', port: 5432, database: 'sales' };

function keyDir(n = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-keys-'));
  const keys = Array.from({ length: n }, () => {
    const key = generateCredentialKey();
    fs.writeFileSync(path.join(dir, `${key.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(dir, `${key.kid}.check`), key.check);
    return key;
  });
  return { dir, keys };
}

describe('credential sealing, scheme v1', () => {
  test('the binding: driver, field and the target keys sorted, as strings, from the values as sent', () => {
    expect(secretAadV1('postgres', 'password', target).toString()).toBe(
      '["wechart/data-source-secret/v1","postgres","password",[["host","db.example.com"],["port","5432"],["ssl",""],["sslCa",""],["sslRejectUnauthorized",""]]]',
    );
    // TLS settings are bound as the host is (wechart's decision): turning verification off needs the secret again.
    expect(secretAadV1('mysql', 'password', { host: 'h', port: 3306, ssl: true, sslRejectUnauthorized: false, sslCa: 'PEM' }).toString()).toBe(
      '["wechart/data-source-secret/v1","mysql","password",[["host","h"],["port","3306"],["ssl","true"],["sslCa","PEM"],["sslRejectUnauthorized","false"]]]',
    );
    expect(secretAadV1('mssql', 'password', { host: 'h', encrypt: true }).toString()).toBe(
      '["wechart/data-source-secret/v1","mssql","password",[["encrypt","true"],["host","h"],["port",""],["trustServerCertificate",""]]]',
    );
    expect(secretAadV1('oracle', 'password', { host: 'h' }).toString()).toBe(
      '["wechart/data-source-secret/v1","oracle","password",[["connectString",""],["database",""],["host","h"],["port",""]]]',
    );
    expect(secretAadV1('dremio', 'token', { url: 'https://api.dremio.cloud/v0/projects/p' }).toString()).toBe(
      '["wechart/data-source-secret/v1","dremio","token",[["host",""],["port",""],["ssl",""],["url","https://api.dremio.cloud/v0/projects/p"]]]',
    );
  });

  test('padding hides the length to 256 bytes, and is checked when removed', () => {
    const pt = padV1('s3cret');
    expect(pt.length).toBe(256);
    expect(unpadV1(pt)).toBe('s3cret');
    expect(padV1('x'.repeat(252)).length).toBe(512);
    const bad = Buffer.from(pt);
    bad[200] = 1;
    expect(() => unpadV1(bad)).toThrow(/malformed/);
  });

  test('keys load only when each file is its kid\'s X25519 key and opens its sample', () => {
    const { dir, keys: [key] } = keyDir();
    const loaded = new CredentialKeys(dir, [key.kid], key.kid);
    expect(loaded.publicKeys()).toEqual([{ kid: key.kid, x: key.jwk.x, active: true }]);

    expect(() => new CredentialKeys(dir, ['nope'], 'nope')).toThrow(/can't read .*nope\.pem/);
    expect(() => new CredentialKeys(dir, [key.kid], 'other')).toThrow(/active credential key other/);
    const other = generateCredentialKey();
    fs.writeFileSync(path.join(dir, `${other.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(dir, `${other.kid}.check`), other.check);
    expect(() => new CredentialKeys(dir, [other.kid], other.kid)).toThrow(/doesn't match its id/);
    fs.writeFileSync(path.join(dir, `${other.kid}.pem`), other.pem);
    fs.writeFileSync(path.join(dir, `${other.kid}.check`), key.check);
    expect(() => new CredentialKeys(dir, [other.kid], other.kid)).toThrow(/can't decrypt its sample credential/);
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    fs.writeFileSync(path.join(dir, 'ec.pem'), ec);
    expect(() => new CredentialKeys(dir, ['ec'], 'ec')).toThrow(/not an X25519 key/);
  });

  test('a secret opens only for the driver, field and target it was sealed for', () => {
    const { dir, keys: [key] } = keyDir();
    const keys = new CredentialKeys(dir, [key.kid], key.kid);
    const sealed = sealSecretV1(key.jwk.x, key.kid, 'postgres', 'password', target, 'hunter2');
    expect(keys.open(sealed, 'postgres', 'password', target)).toBe('hunter2');
    // The same target written after defaults differently is still the same string.
    expect(keys.open(sealed, 'postgres', 'password', { ...target, port: '5432', database: 'other' })).toBe('hunter2');
    expect(() => keys.open(sealed, 'postgres', 'password', { ...target, host: 'evil.example.com' })).toThrow(/can't be used for this connection target/);
    expect(() => keys.open(sealed, 'postgres', 'sslPassphrase', target)).toThrow(CredentialError);
    expect(() => keys.open(sealed, 'redshift', 'password', target)).toThrow(CredentialError);
    expect(() => keys.open({ ...sealed, kid: 'gone' }, 'postgres', 'password', target)).toThrow(/which xcube doesn't hold/);
    expect(() => keys.open('plain', 'postgres', 'password', target)).toThrow(/not a sealed secret/);
  });

  test('re-wrap seals to the active key with the same binding', () => {
    const { dir, keys: [old, current] } = keyDir(2);
    const keys = new CredentialKeys(dir, [old.kid, current.kid], current.kid);
    const sealed = sealSecretV1(old.jwk.x, old.kid, 'mysql', 'password', target, 'pw');
    const rewrapped = keys.rewrap(sealed, 'mysql', 'password', target);
    expect(rewrapped.kid).toBe(current.kid);
    expect(keys.open(rewrapped, 'mysql', 'password', target)).toBe('pw');
    expect(() => keys.open(rewrapped, 'mysql', 'password', { ...target, host: 'x' })).toThrow(CredentialError);
    expect(() => keys.rewrap(sealed, 'mysql', 'password', { ...target, host: 'x' })).toThrow(/doesn't open for this connection target/);
  });

  test('opens what the browser seals with hpke 1.1.7', () => {
    const { dir, keys: [key] } = keyDir();
    const keys = new CredentialKeys(dir, [key.kid], key.kid);
    const aad = secretAadV1('snowflake', 'privateKey', { account: 'acme', warehouse: 'wh' });
    const out = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '../fixtures/hpke-oracle.mjs')], {
      input: JSON.stringify({
        op: 'seal',
        pk: key.jwk.x,
        pt: padV1('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----').toString('base64url'),
        info: INFO_V1.toString('base64url'),
        aad: aad.toString('base64url'),
      }),
    }).toString());
    const envelope = { v: 1, kid: key.kid, enc: out.enc, ct: out.ct };
    expect(keys.open(envelope, 'snowflake', 'privateKey', { account: 'acme', warehouse: 'wh', role: 'r' }))
      .toBe('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  });
});
