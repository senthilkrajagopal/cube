import { Client, Pool, type ClientConfig, type PoolClient } from 'pg';

export type Logger = (message: string, params?: Record<string, unknown>) => void;

/** A schema name as an SQL identifier: lower-case letters, digits and `_`. */
export const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertSchemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(`Invalid xcube schema name: ${JSON.stringify(schema)}`);
  }
  return schema;
}

/** Settings every xcube connection shares. The warehouse's `CUBEJS_DB_*` is never read. */
export function connectionConfig(connectionString: string, applicationName: string): ClientConfig {
  return {
    connectionString,
    application_name: applicationName.slice(0, 63),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    connectionTimeoutMillis: 10000,
    options: '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000',
  };
}

export function createPool(connectionString: string, instanceId: string, logger: Logger): Pool {
  const pool = new Pool({
    ...connectionConfig(connectionString, `xcube:${instanceId}`),
    max: 4,
    idleTimeoutMillis: 30000,
  });
  // An idle client's error is emitted on the pool; unhandled, it would end the process.
  pool.on('error', (e) => logger('xcube: database connection lost', { error: e.message }));
  return pool;
}

export function createListenClient(connectionString: string, instanceId: string): Client {
  return new Client(connectionConfig(connectionString, `xcube-listen:${instanceId}`));
}

export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
