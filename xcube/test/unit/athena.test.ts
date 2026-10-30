/**
 * Athena through xcube's own driver and run path, against a double of
 * Athena's API (JSON 1.1 over HTTP) in this process, and of the two places a
 * pod's role comes from: STS's AssumeRoleWithWebIdentity and EKS Pod
 * Identity's agent. The double answers in pages, fails a query, runs one on
 * until stopped, and records each call and the key that signed it.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import { DRIVERS } from '../../src/connections/drivers';
import { athenaInternals } from '../../src/connections/athena';
import { isTimeout, SqlRunError } from '../../src/sql/runner';
import { SqlRuns, type SqlRunRequest, type SqlTarget } from '../../src/sql/runs';

interface Seen {
  target: string;
  body: any;
  authorization: string;
  token: string | undefined;
}

const COLUMNS = [{ Name: 'n', Type: 'bigint' }, { Name: 's', Type: 'varchar' }];
const ROWS = [['1', 'a'], ['2', 'b'], ['3', null], ['4', 'd'], ['5', 'e']];

const cells = (row: (string | null)[]) => ({ Data: row.map((v) => (v === null ? {} : { VarCharValue: v })) });

/**
 * The double. A query is one of: five rows, read in pages of MaxResults
 * after the header; a failure; rows without end; or running until stopped
 * (StopQueryExecution), then CANCELLED. A workgroup named `off` is disabled;
 * the database `missing` isn't in the catalog; the key AKIAREFUSEDREFUSED001 is refused.
 */
class AthenaDouble {
  public readonly seen: Seen[] = [];

  public readonly stopped = new Set<string>();

  protected readonly queries = new Map<string, { sql: string; polls: number }>();

  protected server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const target = String(req.headers['x-amz-target'] ?? '').replace(/^AmazonAthena\./, '');
      const body = raw ? JSON.parse(raw) : {};
      this.seen.push({
        target, body, authorization: String(req.headers.authorization ?? ''), token: req.headers['x-amz-security-token'] as string | undefined,
      });
      const [status, answer] = /Credential=AKIAREFUSEDREFUSED001\//.test(String(req.headers.authorization))
        ? [400, { __type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' }]
        : this.answer(target, body);
      res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' });
      res.end(JSON.stringify(answer));
    });
  });

  public get port() {
    return (this.server.address() as AddressInfo).port;
  }

  public get endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  public calls(target: string) {
    return this.seen.filter((s) => s.target === target);
  }

  public statements() {
    return this.calls('StartQueryExecution').map((s) => s.body.QueryString);
  }

  public idOf(sql: string) {
    return [...this.queries].find(([, q]) => q.sql === sql)?.[0];
  }

  public start() {
    return new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }

  public stop() {
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  protected answer(target: string, body: any): [number, unknown] {
    switch (target) {
      case 'GetWorkGroup':
        return [200, { WorkGroup: { Name: body.WorkGroup, State: body.WorkGroup === 'off' ? 'DISABLED' : 'ENABLED' } }];
      case 'ListDatabases':
        return [200, body.NextToken === 'p2'
          ? { DatabaseList: [{ Name: 'empty' }] }
          : { DatabaseList: [{ Name: 'sales' }], NextToken: 'p2' }];
      case 'GetDatabase':
        return body.DatabaseName === 'missing'
          ? [400, { __type: 'MetadataException', Message: 'Database missing not found.' }]
          : [200, { Database: { Name: body.DatabaseName } }];
      case 'StartQueryExecution': {
        const id = crypto.randomUUID();
        this.queries.set(id, { sql: body.QueryString, polls: 0 });
        return [200, { QueryExecutionId: id }];
      }
      case 'StopQueryExecution':
        this.stopped.add(body.QueryExecutionId);
        return [200, {}];
      case 'GetQueryExecution': {
        const query = this.queries.get(body.QueryExecutionId)!;
        query.polls++;
        let Status: Record<string, unknown>;
        if (this.stopped.has(body.QueryExecutionId)) {
          Status = { State: 'CANCELLED' };
        } else if (/forever/.test(query.sql) || query.polls < 2) {
          Status = { State: 'RUNNING' };
        } else if (/broken/.test(query.sql)) {
          Status = { State: 'FAILED', StateChangeReason: 'DIVISION_BY_ZERO: Division by zero', AthenaError: { ErrorCategory: 2, ErrorType: 1006 } };
        } else {
          Status = { State: 'SUCCEEDED' };
        }
        return [200, { QueryExecution: { QueryExecutionId: body.QueryExecutionId, Query: query.sql, Status } }];
      }
      case 'GetQueryResults': {
        const query = this.queries.get(body.QueryExecutionId)!;
        const from = Number(body.NextToken ?? 0);
        const max = body.MaxResults ?? 1000;
        // The header row first, as Athena sends a SELECT's.
        const all = /many/.test(query.sql)
          ? (i: number) => (i === 0 ? ['n', 's'] : [String(i), 'x'])
          : (i: number) => [['n', 's'], ...ROWS][i];
        const size = /many/.test(query.sql) ? Infinity : ROWS.length + 1;
        const rows = Array.from({ length: Math.min(max, size - from) }, (_, i) => cells(all(from + i)));
        return [200, {
          ResultSet: { Rows: rows, ResultSetMetadata: { ColumnInfo: COLUMNS } },
          ...(from + max < size ? { NextToken: String(from + max) } : {}),
        }];
      }
      default:
        return [400, { __type: 'UnknownOperationException', Message: target }];
    }
  }
}

/** STS's AssumeRoleWithWebIdentity and EKS Pod Identity's agent, each answering a session key. */
class RoleDouble {
  public readonly seen: { path: string; body: string; authorization?: string }[] = [];

  protected server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      this.seen.push({ path: String(req.url), body, authorization: req.headers.authorization });
      if (req.url === '/agent') {
        res.writeHead(req.headers.authorization === 'pod-identity-token' ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.headers.authorization === 'pod-identity-token'
          ? { AccessKeyId: 'ASIAPODIDENTITYKEY01', SecretAccessKey: 'pi-secret', Token: 'pi-session', Expiration: new Date(Date.now() + 3600000).toISOString() }
          : { Message: 'bad token' }));
        return;
      }
      const params = new URLSearchParams(body);
      if (params.get('WebIdentityToken') !== 'irsa-token') {
        res.writeHead(403, { 'content-type': 'text/xml' });
        res.end('<ErrorResponse><Error><Code>InvalidIdentityToken</Code><Message>Bad &amp; wrong</Message></Error></ErrorResponse>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
        <AccessKeyId>ASIAIRSASESSIONKEY01</AccessKeyId><SecretAccessKey>irsa-secret</SecretAccessKey>
        <SessionToken>irsa-session</SessionToken><Expiration>${new Date(Date.now() + 3600000).toISOString()}</Expiration>
      </Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
    });
  });

  public get url() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  public start() {
    return new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }

  public stop() {
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

/**
 * Runs `body` with `env` set, and every `AWS_` and `CUBEJS_` variable read
 * through `process.env` where it could be seen recorded; the environment put
 * back after. Set on the environment itself, which Cube's `getEnv` holds. Not
 * recorded: `withoutEnv`'s own, as it puts them out of sight, and those
 * while they are out of sight (its stand-in set), which find nothing.
 */
async function reading<T>(env: Record<string, string>, body: () => Promise<T>): Promise<{ result: T; reads: string[] }> {
  const real = process.env;
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, real[key]]));
  const reads = new Set<string>();
  const note = (key: string | symbol) => {
    if (typeof key === 'string' && /^(AWS_|CUBEJS_)/.test(key) && real.CUBEJS_DB_NAME !== '-'
      && !new Error().stack!.split('\n').slice(2, 5).some((frame) => /connections[\\/]env\.ts/.test(frame))) {
      reads.add(key);
    }
  };
  Object.assign(real, env);
  process.env = new Proxy(real, {
    get(target, key) {
      note(key);
      return Reflect.get(target, key);
    },
    has(target, key) {
      note(key);
      return Reflect.has(target, key);
    },
  });
  try {
    return { result: await body(), reads: [...reads].sort() };
  } finally {
    process.env = real;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) {
        delete real[key];
      } else {
        real[key] = value;
      }
    }
  }
}

describe('Athena', () => {
  const athena = new AthenaDouble();
  const roles = new RoleDouble();
  const fields = {
    region: 'eu-west-1', workGroup: 'analysts', s3OutputLocation: 's3://results/athena/', catalog: 'AwsDataCatalog', database: 'sales', accessKeyId: 'AKIAABCDEFGHIJKLMNOP',
  };
  const make = (over: Record<string, unknown> = {}, secretAccessKey = 'sk') => DRIVERS.athena.make!({
    ...DRIVERS.athena.config({ ...fields, ...over }, 'access-key', { secretAccessKey }),
    dataSource: 'conn_x',
    endpoint: athena.endpoint,
  }) as any;

  beforeAll(async () => {
    await Promise.all([athena.start(), roles.start()]);
    // Cube's driver and the SDK loaded before any test reads the environment: what they read as they load is no connection's.
    make().release();
  });
  afterAll(() => Promise.all([athena.stop(), roles.stop()]));

  test('the driver is built from the connection alone, whatever Cube\'s and the SDK\'s environment holds, and the environment is put back', async () => {
    const warn = jest.spyOn(console, 'warn');
    const poison = {
      CUBEJS_AWS_KEY: 'poison-key',
      CUBEJS_AWS_SECRET: 'poison-secret',
      CUBEJS_AWS_REGION: 'us-east-2',
      CUBEJS_AWS_S3_OUTPUT_LOCATION: 's3://poison/',
      CUBEJS_AWS_ATHENA_WORKGROUP: 'poison-workgroup',
      CUBEJS_AWS_ATHENA_CATALOG: 'poison-catalog',
      CUBEJS_AWS_ATHENA_ASSUME_ROLE_ARN: 'arn:aws:iam::1:role/poison',
      CUBEJS_DB_NAME: 'poison-db',
      CUBEJS_DB_SCHEMA: 'poison-schema',
      CUBEJS_DB_EXPORT_BUCKET: 'poison-bucket',
      CUBEJS_DB_POLL_TIMEOUT: '1',
      AWS_ACCESS_KEY_ID: 'AKIAPOISONPOISONPOIS',
      AWS_SECRET_ACCESS_KEY: 'poison-aws-secret',
      AWS_SESSION_TOKEN: 'poison-session',
      AWS_REGION: 'us-east-2',
      AWS_ENDPOINT_URL: 'https://poison.example',
      AWS_ENDPOINT_URL_ATHENA: 'https://poison.example',
      AWS_PROFILE: 'poison',
      AWS_MAX_ATTEMPTS: '9',
      AWS_LAMBDA_FUNCTION_NAME: 'poison-lambda',
      _X_AMZN_TRACE_ID: 'poison-trace',
    };
    const { result: driver, reads } = await reading(poison, async () => {
      const built = make();
      expect(process.env.CUBEJS_DB_NAME).toBe('poison-db');
      await built.testConnection();
      return built;
    });
    try {
      const { config } = athenaInternals(driver);
      expect(JSON.stringify(config)).not.toMatch(/poison/);
      expect(config).toMatchObject({
        region: 'eu-west-1', workGroup: 'analysts', S3OutputLocation: 's3://results/athena/', catalog: 'AwsDataCatalog', database: 'sales',
        exportBucket: undefined, readOnly: true, pollTimeout: 600000, pollMaxInterval: 5000, endpoint: athena.endpoint,
      });
      expect(driver.schema).toBe('sales');
      expect(await driver.isUnloadSupported()).toBe(false);
      // Signed with the connection's key, against the double: no AWS_ variable read, Cube's none either once built.
      const call = athena.calls('GetWorkGroup').pop()!;
      expect(call.authorization).toMatch(/Credential=AKIAABCDEFGHIJKLMNOP\/\d{8}\/eu-west-1\/athena\/aws4_request/);
      expect(call.token).toBeUndefined();
      expect(call.body).toEqual({ WorkGroup: 'analysts' });
      expect(reads.filter((k) => k.startsWith('AWS_'))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      // A connection without a database runs without one: no stand-in, and no deprecated variable read.
      const bare = make({ database: '' });
      expect(athenaInternals(bare).config.database).toBeUndefined();
      expect(bare.schema).toBeUndefined();
      expect(process.env.CUBEJS_DB_NAME).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      driver.release();
    }
  });

  test('the pod\'s role: IRSA\'s token exchanged at STS, else EKS Pod Identity\'s agent, reading only their four variables (AC-1028)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-athena-'));
    fs.writeFileSync(path.join(dir, 'irsa'), 'irsa-token\n');
    fs.writeFileSync(path.join(dir, 'pod-identity'), 'pod-identity-token\n');
    const { accessKeyId: _key, ...roleFields } = fields;
    process.env.XCUBE_ALLOW_POD_ROLE = 'true';
    const podDriver = () => DRIVERS.athena.make!({
      ...DRIVERS.athena.config(roleFields, 'pod-role', {}), endpoint: athena.endpoint, stsEndpoint: `${roles.url}/sts`,
    }) as any;
    const poison = { AWS_ACCESS_KEY_ID: 'AKIAPOISONPOISONPOIS', AWS_SECRET_ACCESS_KEY: 'poison', AWS_PROFILE: 'poison' };
    try {
      const irsa = await reading({
        ...poison, AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/cube', AWS_WEB_IDENTITY_TOKEN_FILE: path.join(dir, 'irsa'),
      }, async () => {
        const driver = podDriver();
        await driver.testConnection();
        await driver.testConnection();
        driver.release();
      });
      const exchanged = roles.seen.filter((s) => s.path === '/sts');
      expect(exchanged).toHaveLength(1);
      expect(Object.fromEntries(new URLSearchParams(exchanged[0].body))).toMatchObject({
        Action: 'AssumeRoleWithWebIdentity', RoleArn: 'arn:aws:iam::123456789012:role/cube', WebIdentityToken: 'irsa-token',
      });
      expect(athena.calls('GetWorkGroup').slice(-2).map((c) => [c.authorization.match(/Credential=(\w+)/)![1], c.token])).toEqual([
        ['ASIAIRSASESSIONKEY01', 'irsa-session'], ['ASIAIRSASESSIONKEY01', 'irsa-session'],
      ]);
      const FOUR = ['AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE'];
      expect(irsa.reads.filter((k) => k.startsWith('AWS_'))).toEqual(FOUR);

      const agent = await reading({
        ...poison, AWS_CONTAINER_CREDENTIALS_FULL_URI: `${roles.url}/agent`, AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: path.join(dir, 'pod-identity'),
      }, async () => {
        const driver = podDriver();
        await driver.testConnection();
        driver.release();
      });
      expect(athena.calls('GetWorkGroup').pop()!.token).toBe('pi-session');
      expect(agent.reads.filter((k) => k.startsWith('AWS_'))).toEqual(FOUR);

      await reading({ AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/cube', AWS_WEB_IDENTITY_TOKEN_FILE: path.join(dir, 'pod-identity') }, async () => {
        await expect(podDriver().testConnection()).rejects.toThrow('Taking the pod\'s role (arn:aws:iam::123456789012:role/cube) failed: InvalidIdentityToken: Bad & wrong');
      });
      await reading({ AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.169.254/latest/meta-data' }, async () => {
        await expect(podDriver().testConnection()).rejects.toThrow(/must be https, or the EKS Pod Identity agent's or a loopback address/);
      });
      await reading(poison, async () => {
        await expect(podDriver().testConnection()).rejects.toThrow(/The Cube pods have no role of their own/);
      });
    } finally {
      delete process.env.XCUBE_ALLOW_POD_ROLE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the connection test: the workgroup, which must be on; then the catalog\'s databases, the named one among them (AC-1031)', async () => {
    const driver = make();
    await driver.testConnection();
    expect(await driver.getSchemas()).toEqual([{ schema_name: 'sales' }, { schema_name: 'empty' }]);
    expect(athena.calls('ListDatabases').slice(-2).map((c) => c.body)).toEqual([
      { CatalogName: 'AwsDataCatalog', MaxResults: 50 }, { CatalogName: 'AwsDataCatalog', MaxResults: 50, NextToken: 'p2' },
    ]);
    await expect(make({ workGroup: 'off' }).testConnection()).rejects.toThrow('The workgroup off is disabled');
    const missing = make({ database: 'missing' });
    await missing.testConnection();
    await expect(missing.getSchemas()).rejects.toThrow('Database missing not found.');
    // No query ran: nothing scanned, nothing billed.
    expect(athena.statements()).toEqual([]);
  });

  test('Cube\'s reads: in the connection\'s workgroup, output location, catalog and database, the header skipped', async () => {
    const driver = make();
    expect(await driver.query('SELECT n, s FROM t', [])).toEqual([
      { n: '1', s: 'a' }, { n: '2', s: 'b' }, { n: '3', s: null }, { n: '4', s: 'd' }, { n: '5', s: 'e' },
    ]);
    expect(athena.calls('StartQueryExecution').pop()!.body).toMatchObject({
      QueryString: 'SELECT n, s FROM t',
      WorkGroup: 'analysts',
      ResultConfiguration: { OutputLocation: 's3://results/athena/' },
      QueryExecutionContext: { Catalog: 'AwsDataCatalog', Database: 'sales' },
    });
    await expect(driver.query('SELECT broken', [])).rejects.toThrow('DIVISION_BY_ZERO: Division by zero');
  });

  describe('the SQL runner', () => {
    const runs = new SqlRuns('here', () => null, () => undefined);
    const target = (secretAccessKey = 'sk', accessKeyId = fields.accessKeyId): SqlTarget => ({
      dialect: 'athena',
      label: 'athena',
      build: async () => ({ driver: make({ accessKeyId }, secretAccessKey), secrets: [secretAccessKey] }),
    });
    const run = (sql: string, more: Partial<SqlRunRequest> = {}) => runs.run('m', target(), {
      sql, runId: crypto.randomUUID(), maxRows: 100, timeoutMs: 30000, maxBytes: 10 * 1024 * 1024, ...more,
    });
    const failure = (promise: Promise<unknown>) => promise.then(
      () => { throw new Error('the run answered'); },
      (e) => {
        expect(e).toBeInstanceOf(SqlRunError);
        return e as SqlRunError;
      },
    );

    test('a read: its rows in order, as Athena\'s strings, with its columns as Athena types them, the header skipped', async () => {
      const answer = await run('SELECT n, s FROM t ORDER BY n');
      expect(answer.columns).toEqual([{ name: 'n', type: 'bigint' }, { name: 's', type: 'varchar' }]);
      expect(answer.rows).toEqual(ROWS);
      expect(answer.truncated).toBeNull();
      const id = athena.idOf('SELECT n, s FROM t ORDER BY n')!;
      expect(athena.calls('StartQueryExecution').pop()!.body).toMatchObject({ WorkGroup: 'analysts', QueryExecutionContext: { Catalog: 'AwsDataCatalog', Database: 'sales' } });
      expect(athena.calls('GetQueryResults').filter((c) => c.body.QueryExecutionId === id).map((c) => c.body.MaxResults)).toEqual([102]);
    });

    test('pages in order, of at most 1,000, and the row cap stops at one past it: no page after (AC-1045)', async () => {
      const sql = `SELECT many ${crypto.randomUUID()}`;
      const answer = await run(sql, { maxRows: 2500 });
      expect(answer.rowCount).toBe(2500);
      expect(answer.truncated).toBe('rows');
      expect(answer.rows.slice(0, 2)).toEqual([['1', 'x'], ['2', 'x']]);
      expect(answer.rows[2499]).toEqual(['2500', 'x']);
      const id = athena.idOf(sql)!;
      const pages = athena.calls('GetQueryResults').filter((c) => c.body.QueryExecutionId === id).map((c) => [c.body.MaxResults, c.body.NextToken]);
      expect(pages).toEqual([[1000, undefined], [1000, '1000'], [502, '2000']]);
      // Its result is read once it has finished: nothing left to stop.
      expect(athena.stopped.has(id)).toBe(false);
    });

    test('a failed query fails the run with Athena\'s reason', async () => {
      const e = await failure(run('SELECT broken'));
      expect(e.code).toBe('query_failed');
      expect(e.message).toBe('DIVISION_BY_ZERO: Division by zero');
    });

    test('the time cap: the query stopped on Athena, and the run timed out (AC-1045)', async () => {
      const sql = `SELECT forever ${crypto.randomUUID()}`;
      const e = await failure(run(sql, { timeoutMs: 300 }));
      expect(e.code).toBe('timeout');
      expect(athena.stopped.has(athena.idOf(sql)!)).toBe(true);
      expect(isTimeout('athena', new Error('Query exhausted resources at this scale factor'))).toBe(false);
    });

    test('a cancel stops the query on Athena', async () => {
      const sql = `SELECT forever ${crypto.randomUUID()}`;
      const runId = crypto.randomUUID();
      const running = failure(run(sql, { runId }));
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      expect(await runs.cancel('m', runId)).toEqual({ found: true });
      const e = await running;
      expect(e.code).toBe('cancelled');
      expect(athena.stopped.has(athena.idOf(sql)!)).toBe(true);
    });

    test('refused statements, held parameters and a scan cap never reach Athena (AC-1044, AC-1046, AC-1047)', async () => {
      const before = athena.statements().length;
      for (const sql of [
        'UNLOAD (SELECT * FROM t) TO \'s3://b/x/\'', 'CALL system.x()', 'INSERT INTO t SELECT 1', 'CREATE TABLE t AS SELECT 1',
        'EXPLAIN ANALYZE SELECT 1', 'SELECT * FROM TABLE(system.query(query => \'DELETE FROM t\'))',
      ]) {
        expect([sql, (await failure(run(sql))).code]).toEqual([sql, 'not_read_only']);
      }
      const held = await failure(run('SELECT {{n}}', { parameters: { n: { type: 'number', value: '1' } } }));
      expect(held.code).toBe('parameters_unsupported');
      const capped = await failure(run('SELECT 1', { maxBytesBilled: 10 ** 9 }));
      expect(capped).toMatchObject({ code: 'cap_unsupported', reason: 'athena_workgroup_cutoff' });
      expect(capped.message).toMatch(/BytesScannedCutoffPerQuery/);
      expect(athena.statements().length).toBe(before);
    });

    test('a refused key fails the run without saying the key', async () => {
      const e = await failure(runs.run('m', target('wrong-key-mark', 'AKIAREFUSEDREFUSED001'), {
        sql: 'SELECT n, s FROM t', runId: crypto.randomUUID(), maxRows: 1, timeoutMs: 30000, maxBytes: 1024,
      }));
      expect(e.code).toBe('query_failed');
      expect(e.message).toBe('The security token included in the request is invalid.');
      expect(e.message).not.toContain('wrong-key-mark');
    });
  });
});
