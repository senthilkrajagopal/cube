import crypto from 'crypto';
import yaml from 'js-yaml';
import jwt from 'jsonwebtoken';

import { admits, type Permissions } from '../../src/security/gate';
import { GATE_GROUP, namesGateGroup, withGate } from '../../src/security/marker';
import {
  configuredKeys,
  KeyError,
  keySetOf,
  publicKeyOf,
  thumbprintOf,
  TokenError,
  verifyRs256,
} from '../../src/security/tokens';
import { ROLE_KEY, TokenVerifier } from '../../src/security/verifier';
import { DEFAULT_TOKENS } from '../../src/runtime/settings';
import { parseItem } from '../../src/names/items';

const pair = (bits = 2048) => crypto.generateKeyPairSync('rsa', { modulusLength: bits });
const jwkOf = (key: crypto.KeyObject, kid: string) => ({ ...key.export({ format: 'jwk' }), kid });

const user = pair();
const other = pair();
const service = pair();

const now = () => Math.floor(Date.now() / 1000);

function sign(key: crypto.KeyObject, kid: string, payload: Record<string, unknown>, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, key.export({ format: 'pem', type: 'pkcs8' }) as string, { algorithm: 'RS256', keyid: kid, ...options });
}

const checks = { audience: 'xcube', clockToleranceS: 60, maxLifetimeS: 3600 };

describe('keys', () => {
  test('RFC 7638\'s thumbprint, as jose computes a kid', () => {
    expect(thumbprintOf({
      e: 'AQAB',
      n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
    })).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  test('takes a public RSA key of 2048 bits or more, for RS256 signatures, with a kid', () => {
    const jwk = jwkOf(user.publicKey, 'k1');
    expect(publicKeyOf(jwk).kid).toBe('k1');
    expect(publicKeyOf({ ...jwk, alg: 'RS256', use: 'sig', key_ops: ['verify'] }).kid).toBe('k1');
  });

  test('refuses anything else, naming why and never echoing a private member', () => {
    const jwk = jwkOf(user.publicKey, 'k1');
    const privateJwk = jwkOf(user.privateKey, 'k1') as any;
    expect(() => publicKeyOf({ ...jwk, kid: undefined })).toThrow(/kid is/);
    expect(() => publicKeyOf({ ...jwk, kid: 'bad kid' })).toThrow(/kid is/);
    expect(() => publicKeyOf({ ...jwk, kty: 'EC' })).toThrow(/kty must be RSA/);
    expect(() => publicKeyOf({ ...jwk, alg: 'HS256' })).toThrow(/alg must be RS256/);
    expect(() => publicKeyOf({ ...jwk, use: 'enc' })).toThrow(/use must be sig/);
    expect(() => publicKeyOf({ ...jwk, key_ops: ['sign'] })).toThrow(/key_ops/);
    let message = '';
    try {
      publicKeyOf(privateJwk);
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toMatch(/private key members \(d, p, q, dp, dq, qi\)/);
    expect(message).not.toContain(privateJwk.d);
    expect(() => publicKeyOf(jwkOf(pair(1024).publicKey, 'short'))).toThrow(/1024-bit keys are too short/);
    expect(() => publicKeyOf({ ...jwk, n: 'AAAA' })).toThrow(KeyError);
    expect(() => publicKeyOf('key')).toThrow(/JSON object/);
    expect(() => keySetOf([jwk, jwk])).toThrow(/appears twice/);
  });

  test('configured keys: a JWK set, or PEM public keys whose kid is their thumbprint', () => {
    expect(configuredKeys(JSON.stringify({ keys: [jwkOf(service.publicKey, 's1')] })).map((k) => k.kid)).toEqual(['s1']);
    const pem = service.publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const [key] = configuredKeys(`${pem}\n`);
    expect(key.kid).toBe(thumbprintOf(service.publicKey.export({ format: 'jwk' }) as any));
    expect(configuredKeys('')).toEqual([]);
    expect(() => configuredKeys('{"keys": 1}')).toThrow(/keys array/);
    expect(() => configuredKeys('nonsense')).toThrow(/Neither a JWK set nor PEM/);
    expect(() => configuredKeys(user.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string)).toThrow(/is a private key/);
    expect(() => configuredKeys(user.privateKey.export({ format: 'pem', type: 'pkcs1' }) as string)).toThrow(/is a private key/);
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'pem', type: 'spki' }) as string;
    expect(() => configuredKeys(ec)).toThrow(/not an RSA public key/);
  });
});

describe('verifyRs256', () => {
  const token = (payload: Record<string, unknown>, options: jwt.SignOptions = {}) => sign(user.privateKey, 'k1', payload, options);
  const valid = { aud: 'xcube', iat: now(), exp: now() + 300, role: 'user' };

  test('verifies the signature and the registered claims', () => {
    expect(verifyRs256(token(valid), user.publicKey, checks).role).toBe('user');
    expect(verifyRs256(token({ ...valid, aud: ['other', 'xcube'] }), user.publicKey, checks).role).toBe('user');
    expect(verifyRs256(token({ ...valid, iss: 'wechart' }), user.publicKey, { ...checks, issuer: 'wechart' }).iss).toBe('wechart');
  });

  test('refuses a token signed otherwise, or with claims out of bounds', () => {
    const refuse = (t: string, pattern: RegExp, extra = {}) => expect(() => verifyRs256(t, user.publicKey, { ...checks, ...extra })).toThrow(pattern);
    refuse(sign(other.privateKey, 'k1', valid), /Invalid signature/);
    refuse(jwt.sign(valid, 'a-shared-secret'), /Only RS256/);
    const [h, p] = token(valid).split('.');
    refuse(`${h}.${p}.`, /Invalid signature/);
    refuse(`${h}.${Buffer.from(JSON.stringify({ ...valid, role: 'service' })).toString('base64url')}.${token(valid).split('.')[2]}`, /Invalid signature/);
    refuse('a.b', /Not a JWT/);
    refuse(token({ aud: 'xcube', iat: now() }), /no exp/);
    refuse(token({ aud: 'xcube', exp: now() + 60 }, { noTimestamp: true }), /no iat/);
    refuse(token({ ...valid, iat: now() - 400, exp: now() - 100 }), /expired/);
    expect(verifyRs256(token({ ...valid, iat: now() - 100, exp: now() - 30 }), user.publicKey, checks).role).toBe('user');
    refuse(token({ ...valid, iat: now() + 300, exp: now() + 600 }), /issued in the future/);
    refuse(token({ ...valid, nbf: now() + 300 }), /not valid yet/);
    refuse(token({ ...valid, exp: now() + 7200 }), /lives longer than 3600/);
    refuse(token({ ...valid, aud: 'xcube-admin' }), /aud is not xcube/);
    refuse(token({ ...valid, iss: 'someone' }), /iss/, { issuer: 'wechart' });
  });
});

describe('TokenVerifier', () => {
  const missing: string[] = [];
  const verifier = new TokenVerifier(
    { ...DEFAULT_TOKENS, serviceKeys: JSON.stringify({ keys: [jwkOf(service.publicKey, 'svc')] }) },
    {
      modelClaim: () => 'wechartModel',
      revisionClaim: () => 'wechartRevision',
      overlayClaim: () => 'wechartOverlay',
      missingKid: async (kid) => { missing.push(kid); },
    },
  );
  verifier.loadServiceKeys();
  verifier.setModelKeys('dev', { version: 1, issuer: 'wechart-dev', keys: [jwkOf(user.publicKey, 'u1')] });
  verifier.setModelKeys('demo', { version: 3, issuer: null, keys: [jwkOf(other.publicKey, 'o1')] });

  const claims = (extra: Record<string, unknown> = {}) => ({ aud: 'xcube', iat: now(), exp: now() + 300, role: 'user', ...extra });

  test('a user\'s token: its model, groups and revision, and nothing else of it', async () => {
    const { role, securityContext } = await verifier.verify(sign(user.privateKey, 'u1', claims({
      iss: 'wechart-dev', groups: ['a', 7, 'b'], wechartRevision: 12, sub: 'someone', email: 'x@y', wechartIntrospection: true,
    })));
    expect(role).toBe('user');
    expect(securityContext).toEqual({ wechartModel: 'dev', groups: ['a', 'b'], wechartRevision: 12, [ROLE_KEY]: 'user' });
    // The overlay it previews, signed in for those the client allows.
    const preview = await verifier.verify(sign(user.privateKey, 'u1', claims({ iss: 'wechart-dev', wechartOverlay: 'ws-1' })));
    expect(preview.securityContext.wechartOverlay).toBe('ws-1');
  });

  test('a token is bound to the model whose key signed it', async () => {
    await expect(verifier.verify(sign(user.privateKey, 'u1', claims({ iss: 'wechart-dev', wechartModel: 'demo' }))))
      .rejects.toThrow(/not one of its model's/);
    const named = await verifier.verify(sign(other.privateKey, 'o1', claims({ wechartModel: 'demo' })));
    expect(named.securityContext.wechartModel).toBe('demo');
    // A model's issuer, when pushed, is required.
    await expect(verifier.verify(sign(user.privateKey, 'u1', claims()))).rejects.toThrow(/iss/);
  });

  test('a kid two models share needs the model named', async () => {
    const shared = new TokenVerifier(DEFAULT_TOKENS, {
      modelClaim: () => 'm', revisionClaim: () => 'r', missingKid: async () => undefined,
    });
    shared.setModelKeys('a', { version: 1, issuer: null, keys: [jwkOf(user.publicKey, 'same')] });
    shared.setModelKeys('b', { version: 1, issuer: null, keys: [jwkOf(user.publicKey, 'same')] });
    await expect(shared.verify(sign(user.privateKey, 'same', claims()))).rejects.toThrow(/must name its model in m/);
    expect((await shared.verify(sign(user.privateKey, 'same', claims({ m: 'b' })))).securityContext.m).toBe('b');
    shared.setModelKeys('b', null);
    expect((await shared.verify(sign(user.privateKey, 'same', claims()))).securityContext.m).toBe('a');
    expect(shared.hasKeys('b')).toBe(false);
  });

  test('a model\'s key signs user tokens only; the service key service tokens only', async () => {
    await expect(verifier.verify(sign(user.privateKey, 'u1', claims({ iss: 'wechart-dev', role: 'service' }))))
      .rejects.toThrow(/user tokens only/);
    const svc = await verifier.verify(sign(service.privateKey, 'svc', claims({ aud: 'xcube-admin', role: 'service', wechartModel: 'dev', groups: ['sa'] })));
    expect(svc).toEqual({ role: 'service', securityContext: { wechartModel: 'dev', [ROLE_KEY]: 'service' } });
    await expect(verifier.verify(sign(service.privateKey, 'svc', claims({ aud: 'xcube-admin' }))))
      .rejects.toThrow(/service tokens only/);
    await expect(verifier.verify(sign(service.privateKey, 'svc', claims({ role: 'service' }))))
      .rejects.toThrow(/aud is not xcube-admin/);
    expect(() => verifier.verifyServiceToken(sign(user.privateKey, 'u1', claims({ aud: 'xcube-admin', role: 'service' }))))
      .toThrow(/Not signed by the service credential/);
  });

  test('an unknown kid reads the keys again once, then is refused', async () => {
    await expect(verifier.verify(sign(user.privateKey, 'nope', claims()))).rejects.toThrow(/No key has the token's kid/);
    expect(missing).toEqual(['nope']);
    await expect(verifier.verify(jwt.sign(claims(), 'secret'))).rejects.toThrow(TokenError);
  });
});

describe('the folder gate', () => {
  const permissions = (security: boolean, allowed: Record<string, string[]> = {}): Permissions => ({
    version: 1, security, allowed: new Map(Object.entries(allowed).map(([k, v]) => [k, new Set(v)])),
  });

  test('admits a context holding one of the folder\'s allowed groups, when security is on', () => {
    const on = permissions(true, { fa: ['g1', 'sa'], fb: [] });
    expect(admits(on, 'fa', new Set(['x', 'sa']))).toBe(true);
    expect(admits(on, 'fa', new Set(Array.from({ length: 300 }, (_, i) => `g${i + 2}`).concat('g1')))).toBe(true);
    expect(admits(on, 'fa', new Set(['x']))).toBe(false);
    expect(admits(on, 'fa', new Set())).toBe(false);
    expect(admits(on, 'fb', new Set(['sa']))).toBe(false);
    expect(admits(on, 'unknown', new Set(['sa']))).toBe(false);
    expect(admits(permissions(false), 'fa', new Set())).toBe(true);
    expect(admits(undefined, 'fa', new Set(['sa']))).toBe(false);
  });

  const item = (kind: 'cube' | 'view', extra = '') => yaml.dump({
    [`${kind}s`]: [{ name: 'fa__x', meta: { xcube: { folderId: 'fa', shortName: 'x' } }, ...yaml.load(extra || '{}') as object }],
  });

  test('every published cube and view gets the reserved policy, after its own', () => {
    const cube = yaml.load(withGate({ path: 'fa__x.yml', content: item('cube') }).content) as any;
    expect(cube.cubes[0].access_policy).toEqual([{ group: GATE_GROUP }]);
    const view = yaml.load(withGate({ path: 'fa__x.yml', content: item('view') }).content) as any;
    expect(view.views[0].access_policy).toEqual([{ group: GATE_GROUP }]);
    const authored = yaml.load(withGate({
      path: 'fa__x.yml', content: item('cube', 'access_policy: [{group: g1, row_level: {filters: []}}]'),
    }).content) as any;
    expect(authored.cubes[0].access_policy).toEqual([{ group: 'g1', row_level: { filters: [] } }, { group: GATE_GROUP }]);
    const camel = yaml.load(withGate({ path: 'fa__x.yml', content: item('cube', 'accessPolicy: [{group: g1}]') }).content) as any;
    expect(camel.cubes[0].accessPolicy).toEqual([{ group: 'g1' }, { group: GATE_GROUP }]);
    expect(camel.cubes[0].access_policy).toBeUndefined();
  });

  test('files xcube didn\'t publish are left as they are', () => {
    const plain = { path: 'orders.yml', content: 'cubes:\n  - name: orders\n    sql_table: t\n' };
    expect(withGate(plain)).toBe(plain);
    const js = { path: 'x.js', content: 'cube(`x`, { meta: { xcube: {} } })' };
    expect(withGate(js)).toBe(js);
  });

  test('an authored policy may not name the reserved group', () => {
    const doc = { name: 'x', access_policy: [{ groups: ['a', GATE_GROUP] }] };
    expect(namesGateGroup(doc)).toBe(true);
    expect(namesGateGroup({ name: 'x', accessPolicy: [{ group: 'a' }] })).toBe(false);
    const { errors } = parseItem({
      folderId: 'fa', name: 'x', kind: 'cube', yaml: `cubes:\n  - name: x\n    sql_table: t\n    access_policy:\n      - group: ${GATE_GROUP}\n`,
    });
    expect(errors[0].message).toMatch(/may not name the group xcube.folder-gate/);
  });
});
