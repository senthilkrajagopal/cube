/**
 * A stand-in for wechart's engine, for the integration tests: a real DuckDB
 * in this process behind the engine's routes, its cells encoded by Cube's own
 * DuckDB driver (`Transform.ts`), as the engine encodes them.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { buildTransform, transformChunk } = require('@cubejs-backend/duckdb-driver/dist/src/Transform');

export const ENGINE_TOKEN = 'engine-service-token-0123456789';

export const FACTS = `CREATE TABLE main.t_sales AS SELECT * FROM (VALUES
  (1, TIMESTAMP '2024-01-15 10:00:00', 'east', 10.50),
  (2, TIMESTAMP '2024-01-20 00:00:00', 'west', 5.25),
  (3, TIMESTAMP '2024-03-03 12:30:00', 'east', 7.00),
  (4, TIMESTAMP '2024-04-10 23:59:59', 'west', 1.00)
) AS t(c_id, c_ts, c_region, c_amount)`;

/** The stand-in engine: its routes, over one DuckDB, and every call it was sent. */
export async function standInEngine(tables: string[] = [FACTS], token = ENGINE_TOKEN) {
  const instance = await DuckDBInstance.create(':memory:');
  const connection: DuckDBConnection = await instance.connect();
  // As the engine runs its sessions: in UTC, whatever the host's zone.
  await connection.run('SET TimeZone = \'UTC\'');
  for (const table of tables) {
    await connection.run(table);
  }
  const calls: { method: string; url: string; body: any; requestId?: string }[] = [];
  /** An answer of the test's own in place of the engine's, for a query it returns one for: a status and its body. */
  let intercept: ((body: any) => { status: number; body: unknown } | undefined) | undefined;
  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ method: req.method!, url: req.url!, body, requestId: req.headers['x-request-id'] as string | undefined });
      if (req.method === 'GET' && req.url === '/v1/health') {
        reply(res, 200, { status: 'ok' });
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply(res, 401, { error: 'Missing or wrong token', code: 'unauthorized' });
        return;
      }
      if (req.method === 'DELETE') {
        reply(res, 404, { error: 'No such query', code: 'unknown_query' });
        return;
      }
      const forced = intercept?.(body);
      if (forced) {
        reply(res, forced.status, forced.body);
        return;
      }
      const unknown = Object.keys(body ?? {}).filter((k) => !['sql', 'params', 'queryId', 'timeoutMs', 'requestId', 'maxRows'].includes(k));
      if (unknown.length) {
        reply(res, 400, { error: `Unknown fields ${unknown.join(', ')}`, code: 'bad_request' });
        return;
      }
      try {
        const result = await connection.run(body.sql, body.params);
        const names = result.columnNames();
        const types = result.columnTypes();
        const transform = buildTransform(names, types);
        const rows: unknown[][] = [];
        for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await result.fetchChunk()) {
          for (const row of transformChunk(chunk, transform)) {
            rows.push(names.map((name: string) => row[name]));
          }
        }
        reply(res, 200, {
          columns: names.map((name: string, i: number) => ({ name, type: String(types[i]) })),
          rows: body.maxRows ? rows.slice(0, body.maxRows) : rows,
        });
      } catch (e: any) {
        reply(res, 422, { error: String(e.message).split('\n')[0], code: 'query_failed' });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    connection,
    /** Answers the queries `fn` returns an answer for with it, until set again (`undefined`: none). */
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      connection.closeSync();
      instance.closeSync();
    },
  };
}

