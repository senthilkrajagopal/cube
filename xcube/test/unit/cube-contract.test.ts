/**
 * What xcube relies on in Cube that the compiler can't check, run on every
 * upgrade of Cube (see "Upgrading Cube" in the README). The rest is checked
 * by the compiler: every hook xcube overrides is marked `override`, and a
 * protected member it reads is read from a subclass, so a Cube that renames
 * or drops one fails the typecheck.
 */
import fs from 'fs';
import path from 'path';

import { getEnv } from '@cubejs-backend/shared';

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const cubePackages = (deps: Record<string, string> = {}) => Object.entries(deps).filter(([name]) => name.startsWith('@cubejs-backend/'));

describe('Cube version', () => {
  const version: string = pkg.peerDependencies['@cubejs-backend/server-core'];

  test('every Cube package is the one version, exactly', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const named = [...cubePackages(pkg.peerDependencies), ...cubePackages(pkg.devDependencies)];
    expect(named.filter(([, v]) => v !== version)).toEqual([]);
  });

  test('the Cube packages installed are that version', () => {
    const installed = cubePackages(pkg.devDependencies).map(([name]) => [
      name,
      JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version,
    ]);
    expect(installed.filter(([, v]) => v !== version)).toEqual([]);
  });

  test('the image is built on that version of Cube\'s image', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`ARG CUBE_VERSION=v${version}\n`);
  });
});

describe('Cube\'s environment', () => {
  // Cube reads the `process.env` object it started with: set and delete keys, never replace it.
  const saved = { ...process.env };
  afterEach(() => {
    Object.keys(process.env).filter((k) => !(k in saved)).forEach((k) => delete process.env[k]);
    Object.assign(process.env, saved);
  });

  // The server sets it, and wechart's deployment may: Cube must read it under this name.
  test('reads each compile\'s transpiler pool size from CUBEJS_TRANSPILATION_WORKER_THREADS_COUNT', () => {
    process.env.CUBEJS_TRANSPILATION_WORKER_THREADS_COUNT = '3';
    expect(getEnv('transpilationWorkerThreadsCount')).toBe(3);
  });

  // config.ts derives each model's pre-aggregation schema from these.
  test('reads the pre-aggregation schema and dev mode as config.ts expects', () => {
    process.env.CUBEJS_PRE_AGGREGATIONS_SCHEMA = 'xc_pre';
    process.env.CUBEJS_DEV_MODE = 'true';
    expect(getEnv('preAggregationsSchema')).toBe('xc_pre');
    expect(getEnv('devMode')).toBe(true);
  });

  // config.ts's fallback for a model's `default` without a connection.
  test('reads a data source\'s type from CUBEJS_DB_TYPE, or CUBEJS_DS_<NAME>_DB_TYPE', () => {
    process.env.CUBEJS_DB_TYPE = 'postgres';
    expect(getEnv('dbType', { dataSource: 'default' })).toBe('postgres');
    process.env.CUBEJS_DATASOURCES = 'default,other';
    process.env.CUBEJS_DS_OTHER_DB_TYPE = 'mysql';
    expect(getEnv('dbType', { dataSource: 'other' })).toBe('mysql');
  });
});
