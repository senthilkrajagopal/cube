import http from 'http';
import type { AddressInfo } from 'net';

import { DRIVERS } from '../../src/connections/drivers';
import { openSession, RowCollector } from '../../src/sql/runner';
import {
  baseUrlProblems, checkedAnswer, EngineDriver, EngineError, engineParam, rowsOf,
} from '../../src/connections/engine';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** A stand-in engine: answers each call with `answer`, and notes what it was sent. */
function fakeEngine(answer: (seen: Seen, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const call = { method: req.method!, url: req.url!, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      seen.push(call);
      answer(call, res);
    });
  });
  return new Promise<{ seen: Seen[]; url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        seen,
        url: `http://127.0.0.1:${port}/engine`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('engine connections', () => {
  const saved = process.env.XCUBE_ENGINE_ALLOW_HTTP;
  beforeEach(() => {
    process.env.XCUBE_ENGINE_ALLOW_HTTP = 'true';
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.XCUBE_ENGINE_ALLOW_HTTP;
    } else {
      process.env.XCUBE_ENGINE_ALLOW_HTTP = saved;
    }
  });

  test('compiles with Cube\'s DuckDB dialect, and binds its token to its base URL and TLS', () => {
    expect(DRIVERS.engine.cubeType).toBe('duckdb');
    expect(DRIVERS.engine.target).toEqual(['baseUrl', 'sslRejectUnauthorized', 'sslCa']);
    expect(Object.keys(DRIVERS.engine.auth)).toEqual(['service-token']);
    expect(DRIVERS.engine.config({ baseUrl: 'https://engine.example:8443' }, 'service-token', { token: 't' })).toEqual({
      baseUrl: 'https://engine.example:8443', token: 't', sslRejectUnauthorized: true, sslCa: undefined,
    });
  });

  test('a base URL is an https origin and a path alone; plain HTTP only where the deployment allows it', () => {
    expect(baseUrlProblems('https://engine.example:8443/api')).toEqual([]);
    expect(baseUrlProblems('http://engine.svc:8080')).toEqual([]);
    delete process.env.XCUBE_ENGINE_ALLOW_HTTP;
    expect(baseUrlProblems('http://engine.svc:8080')).toEqual([
      'baseUrl must be https://: plain HTTP isn\'t allowed in this deployment (XCUBE_ENGINE_ALLOW_HTTP)',
    ]);
    expect(baseUrlProblems('ftp://engine')).toEqual(['baseUrl must be an https:// URL']);
    expect(baseUrlProblems('https://u:p@engine/x?y=1#z')).toEqual([
      'baseUrl can\'t hold a user or password: the token signs in',
      'baseUrl can\'t hold a query or fragment',
    ]);
    expect(baseUrlProblems('engine.example')).toEqual(['baseUrl must be a URL, such as https://engine.example:8443']);
    expect(DRIVERS.engine.check!({ baseUrl: 'http://engine' }, 'service-token')).toHaveLength(1);
  });

  test('a query sends the statement, its values, its ids and the token, and answers rows by column name', async () => {
    const engine = await fakeEngine((_seen, res) => json(res, 200, {
      columns: [{ name: 'orders__status', type: 'VARCHAR' }, { name: 'orders__count', type: 'BIGINT' }],
      rows: [['done', '2'], [null, '1']],
    }));
    const driver = new EngineDriver({ baseUrl: engine.url, token: 'tok', queryTimeoutMs: 1000 });
    try {
      const rows = await driver.query('SELECT ? AS a, ? AS b, ? AS c', ['x', 1, new Date('2024-01-02T03:04:05.000Z')], { requestId: 'req-1' });
      expect(rows).toEqual([{ orders__status: 'done', orders__count: '2' }, { orders__status: null, orders__count: '1' }]);
      const [call] = engine.seen;
      expect(call.method).toBe('POST');
      expect(call.url).toBe('/engine/v1/query');
      expect(call.headers.authorization).toBe('Bearer tok');
      expect(call.headers['x-request-id']).toBe('req-1');
      expect(call.body).toEqual({
        sql: 'SELECT ? AS a, ? AS b, ? AS c',
        params: ['x', 1, '2024-01-02T03:04:05.000Z'],
        queryId: expect.any(String),
        requestId: 'req-1',
        timeoutMs: 1000,
      });
    } finally {
      await driver.release();
      await engine.close();
    }
  });

  test('the engine\'s error reaches Cube with its message and code', async () => {
    const engine = await fakeEngine((_seen, res) => json(res, 400, { error: 'Binder Error: no such column x', code: 'binder' }));
    const driver = new EngineDriver({ baseUrl: engine.url, token: 'tok' });
    try {
      await expect(driver.query('SELECT x')).rejects.toMatchObject({ name: 'EngineError', message: 'Binder Error: no such column x', code: 'binder', status: 400 });
    } finally {
      await driver.release();
      await engine.close();
    }
  });

  test('a cancel drops the request and stops the query on the engine by its id', async () => {
    const engine = await fakeEngine((seen, res) => {
      if (seen.method === 'DELETE') {
        json(res, 204, {});
      }
      // The query itself never answers.
    });
    const driver = new EngineDriver({ baseUrl: engine.url, token: 'tok' });
    try {
      const running = driver.query('SELECT 1') as Promise<unknown> & { cancel: () => Promise<void> };
      await new Promise((r) => setTimeout(r, 50));
      expect(typeof running.cancel).toBe('function');
      const failed = expect(running).rejects.toMatchObject({ code: 'cancelled' });
      await running.cancel();
      await failed;
      const { queryId } = engine.seen[0].body;
      expect(engine.seen[1]).toMatchObject({ method: 'DELETE', url: `/engine/v1/query/${queryId}` });
    } finally {
      await driver.release();
      await engine.close();
    }
  });

  test('past its time cap, a query is stopped on the engine too', async () => {
    const engine = await fakeEngine((seen, res) => {
      if (seen.method === 'DELETE') {
        json(res, 204, {});
      }
    });
    const driver = new EngineDriver({ baseUrl: engine.url, token: 'tok' });
    try {
      // The engine's own cap is 10 ms; xcube waits 5 s past it.
      await expect(driver.run('SELECT 1', [], { timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
      expect(engine.seen.map((s) => s.method)).toEqual(['POST', 'DELETE']);
    } finally {
      await driver.release();
      await engine.close();
    }
  }, 15000);

  test('the connection test asks for its health, then runs a statement with the token', async () => {
    const engine = await fakeEngine((seen, res) => {
      if (seen.method === 'GET') {
        json(res, 200, { status: 'ok' });
      } else if (seen.headers.authorization === 'Bearer tok') {
        json(res, 200, { columns: [{ name: 'ok', type: 'INTEGER' }], rows: [['1']] });
      } else {
        json(res, 401, { error: 'Missing or wrong token', code: 'unauthorized' });
      }
    });
    const driver = new EngineDriver({ baseUrl: `${engine.url}/`, token: 'tok' });
    const wrong = new EngineDriver({ baseUrl: engine.url, token: 'nope' });
    try {
      await driver.testConnection();
      expect(engine.seen[0]).toMatchObject({ method: 'GET', url: '/engine/v1/health' });
      expect(engine.seen[1]).toMatchObject({ method: 'POST', url: '/engine/v1/query' });
      expect(engine.seen[1].body).not.toHaveProperty('requestId');
      await expect(wrong.testConnection()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
      expect(driver.readOnly()).toBe(true);
    } finally {
      await driver.release();
      await wrong.release();
      await engine.close();
    }
  });

  test('the catalog is read through the engine\'s information_schema', async () => {
    const engine = await fakeEngine((_seen, res) => json(res, 200, { columns: [{ name: 'schema_name', type: 'VARCHAR' }], rows: [['engine']] }));
    const driver = new EngineDriver({ baseUrl: engine.url, token: 'tok' });
    try {
      expect(await driver.getSchemas()).toEqual([{ schema_name: 'engine' }]);
      expect(engine.seen[0].body.sql).toMatch(/FROM information_schema\.tables/);
    } finally {
      await driver.release();
      await engine.close();
    }
  });

  test('an answer of another shape is refused, as are values JSON can\'t carry', () => {
    expect(() => checkedAnswer({ rows: [] })).toThrow(EngineError);
    expect(() => checkedAnswer({ columns: [{ name: 'a' }], rows: [[1, 2]] })).toThrow('isn\'t 1 cells wide');
    expect(rowsOf({ columns: [{ name: 'a', type: 'INTEGER' }], rows: [] })).toEqual([]);
    expect(engineParam(10n)).toBe('10');
    expect(engineParam(undefined)).toBeNull();
    expect(() => engineParam(Buffer.from('x'))).toThrow('binary');
  });

  test('the SQL runner runs on it, asking for one row past its cap, with the run\'s time cap', async () => {
    const engine = await fakeEngine((seen, res) => (seen.method === 'DELETE'
      ? json(res, 204, {})
      : json(res, 200, { columns: [{ name: 'a', type: 'INTEGER' }], rows: [['1'], ['2'], ['3'], ['4']] })));
    const driver = new EngineDriver({ baseUrl: engine.url, token: 'tok' });
    const caps = { maxRows: 3, timeoutMs: 30000, maxBytes: 1024 * 1024 };
    const session = await openSession('duckdb', driver, caps, (message: string): never => {
      throw new Error(message);
    });
    try {
      const rows = new RowCollector(caps.maxRows, caps.maxBytes);
      await session.run('SELECT a FROM t WHERE a > ?::INTEGER', rows, [{ id: '1', type: 'integer', value: '0' }] as any);
      expect(rows.columns).toEqual([{ name: 'a', type: 'INTEGER' }]);
      expect(rows.rows).toEqual([['1'], ['2'], ['3']]);
      expect(rows.truncated).toBe('rows');
      expect(engine.seen[0].body).toMatchObject({ sql: 'SELECT a FROM t WHERE a > ?::INTEGER', params: ['0'], timeoutMs: 30000, maxRows: 4 });
    } finally {
      await session.close();
      await engine.close();
    }
  });

  test('it needs a base URL and a token', () => {
    expect(() => new EngineDriver({ baseUrl: '', token: '' })).toThrow('baseUrl is required; token is required');
  });
});
