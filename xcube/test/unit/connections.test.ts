import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Connections, redact } from '../../src/connections/connections';
import { DRIVERS } from '../../src/connections/drivers';
import { SwitchableDriver } from '../../src/connections/switchable';
import { modelSchema } from '../../src/config';
import { CredentialKeys, generateCredentialKey, sealSecretV1 } from '../../src/credentials/credentials';
import { open } from '../../src/credentials/hpke';

class FakeDriver {
  public released = 0;

  public constructor(public readonly id: string) {}

  public async query(sql: string) {
    return [{ id: this.id, sql }];
  }

  public async slow(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.id;
  }

  public async stream() {
    return { rows: [this.id], release: async () => undefined };
  }

  public async fail(message: string) {
    throw new Error(message);
  }

  public async release() {
    this.released++;
  }
}

describe('SwitchableDriver', () => {
  test('a swap sends new calls to the new driver and releases the old once its calls are done', async () => {
    const a = new FakeDriver('a');
    const b = new FakeDriver('b');
    const sw = new SwitchableDriver('ds', a);
    const running = sw.proxy.slow(50);
    sw.swap(b);
    expect((await sw.proxy.query('x'))[0].id).toBe('b');
    expect(a.released).toBe(0);
    expect(await running).toBe('a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(a.released).toBe(1);
    expect(b.released).toBe(0);
  });

  test('a stream keeps the old driver until the stream is released', async () => {
    const a = new FakeDriver('a');
    const sw = new SwitchableDriver('ds', a);
    const stream = await sw.proxy.stream();
    sw.swap(new FakeDriver('b'));
    expect(a.released).toBe(0);
    await stream.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(a.released).toBe(1);
  });

  test('a removed connection refuses calls, and a re-created one serves again', async () => {
    const sw = new SwitchableDriver('ds', new FakeDriver('a'));
    sw.remove('Connection "ds" was removed');
    await expect(sw.proxy.query('x')).rejects.toThrow(/was removed/);
    sw.restore(new FakeDriver('c'));
    expect((await sw.proxy.query('x'))[0].id).toBe('c');
  });

  test('errors reach the caller with the connection\'s secrets taken out', async () => {
    const sw = new SwitchableDriver('ds', new FakeDriver('a'), () => undefined, (text) => redact(text, ['s3cret-value']));
    await expect(sw.proxy.fail('login failed for {"password":"s3cret-value"}')).rejects.toThrow('login failed for {"password":"[redacted]"}');
  });

  test('releasing it releases every driver behind it; it looks like the driver it wraps', async () => {
    const a = new FakeDriver('a');
    const sw = new SwitchableDriver('ds', a);
    expect(sw.proxy instanceof FakeDriver).toBe(true);
    await sw.proxy.release();
    expect(a.released).toBe(1);
  });
});

describe('redact', () => {
  test('takes secrets out as a driver could print them: raw, JSON, base64, base64url, URL-encoded, and a key\'s parts', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----';
    // Snowflake's own error, which prints its config minus the password.
    const snowflake = `Can't connect to the Snowflake instance: ${JSON.stringify({ account: 'acme', privateKey: pem, privateKeyPass: 'pass-phrase-1' })}`;
    const out = redact(snowflake, [pem, 'pass-phrase-1']);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0B');
    expect(out).not.toContain('pass-phrase-1');
    expect(out).toContain('"account":"acme"');
    const pw = 'p@ss/word+1';
    expect(redact(`x ${encodeURIComponent(pw)} ${Buffer.from(pw).toString('base64url')} ${Buffer.from(pw).toString('base64')}`, [pw]))
      .toBe('x [redacted] [redacted] [redacted]');
    const bq = JSON.stringify({ type: 'service_account', client_email: 'a@b.iam', private_key: pem });
    expect(redact(`key ${pem} leaked`, [bq])).not.toContain('MIIEvQIBADANBgkqhkiG9w0B');
  });
});

describe('connection checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-keys-'));
  const key = generateCredentialKey();
  fs.writeFileSync(path.join(dir, `${key.kid}.pem`), key.pem);
  fs.writeFileSync(path.join(dir, `${key.kid}.check`), key.check);
  const connections = new Connections(() => { throw new Error('no store'); }, new CredentialKeys(dir, [key.kid], key.kid), 'i', () => undefined);
  const fields = { host: 'db', port: 5432, database: 'd', user: 'u' };
  const sealed = (secret: string) => sealSecretV1(key.jwk.x, key.kid, 'postgres', 'password', fields, secret);

  test('an envelope must have its shape: v 1, a kid, 32 bytes of enc, whole padded blocks of ct', () => {
    const good = sealed('pw');
    const problems = (envelope: unknown) => Connections.validate({ driver: 'postgres', authMethod: 'password', fields, sealed: { password: envelope } }).problems;
    expect(problems(good)).toEqual([]);
    expect(problems({ ...good, extra: 1 })[0]).toMatch(/must be a sealed secret/);
    expect(problems({ ...good, enc: good.enc.slice(4) })[0]).toMatch(/enc must be 32 bytes/);
    expect(problems({ ...good, ct: good.ct.slice(8) })[0]).toMatch(/ct must be a padded ciphertext/);
    expect(problems('plain')[0]).toMatch(/must be a sealed secret/);
  });

  test('an empty secret is refused: the driver would use Cube\'s own', () => {
    expect(() => connections.check({ driver: 'postgres', authMethod: 'password', fields, sealed: { password: sealed('') } }))
      .toThrow(/password is empty/);
    expect(connections.check({ driver: 'postgres', authMethod: 'password', fields, sealed: { password: sealed('pw') } }).driver).toBe('postgres');
  });

  test('BigQuery takes a service-account key and nothing else of Google\'s credential types', () => {
    const config = (credentials: object) => DRIVERS.bigquery.config({ projectId: 'p' }, 'service-account', { credentials: JSON.stringify(credentials) });
    expect(() => config({ type: 'external_account', credential_source: { file: '/etc/passwd' }, token_url: 'https://evil/' }))
      .toThrow(/must be a service-account key/);
    expect(() => config({ type: 'authorized_user', refresh_token: 'x' })).toThrow(/must be a service-account key/);
    const ok = config({ type: 'service_account', client_email: 'a@b', private_key: 'k', token_uri: 'https://evil/', universe_domain: 'evil' }) as any;
    expect(ok.credentials).toEqual({ type: 'service_account', client_email: 'a@b', private_key: 'k' });
    expect(ok.keyFilename).toBeUndefined();
  });

  test('Postgres with a certificate never has an empty password pg would fill from PGPASSWORD', () => {
    const config = DRIVERS.postgres.config({ ...fields, sslCert: 'cert' }, 'client-certificate', { sslKey: 'key' }) as any;
    expect(typeof config.password).toBe('function');
    expect(config.password()).toBe('');
    expect((DRIVERS.redshift.config(fields, 'password', { password: 'x' }) as any)).toHaveProperty('exportBucket', undefined);
  });
});

describe('modelSchema', () => {
  test('no two model ids share a schema, and each fits Postgres\'s 63 bytes', () => {
    expect(modelSchema('prod_pre_aggregations', 'acme-co')).not.toBe(modelSchema('prod_pre_aggregations', 'acme_co'));
    const long = modelSchema('prod_pre_aggregations', 'a'.repeat(63));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(modelSchema('prod_pre_aggregations', 'dev')).toMatch(/^prod_pre_aggregations_dev_[0-9a-f]{12}$/);
  });
});

describe('HPKE, low-order points', () => {
  test('an all-zero enc (a low-order point) is refused, not opened with an all-zero secret', () => {
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    expect(() => open(privateKey, Buffer.alloc(32), Buffer.alloc(272), Buffer.from('i'), Buffer.from('a'))).toThrow(/Malformed envelope|doesn't open/);
  });
});
