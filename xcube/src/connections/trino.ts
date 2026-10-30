/**
 * Cube's Trino driver, fenced to a connection's own fields. Cube's reads its
 * user, password, token, TLS files and export bucket from its environment in
 * its constructor, and throws on some of them before the connection's own
 * replace them; here it is built with Cube's environment out of its sight.
 * Two of its reads are mended: a result's pages come back in order (Cube's
 * puts each page before the last), and an error after a streamed result's
 * columns fails the stream (Cube's drops it, and the stream never ends).
 */
import { Transform } from 'stream';
import type { TrinoDriver as CubeTrinoDriver } from '@cubejs-backend/trino-driver';

/** Cube's own default, in seconds: ten minutes. A SQL run's own clock stops its statement sooner. */
const QUERY_TIMEOUT_S = 600;

/**
 * Trino's JSON, with an integer past 2^53 kept as its digits: Trino writes a
 * bigint as a JSON number, which JSON.parse would round. Where Node can't show
 * a reviver the source (before Node 21), as JSON.parse reads it.
 */
export const TRINO_JSON = {
  parse(text: string) {
    return JSON.parse(text, (_key, value, context?: { source?: string }) => (
      typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '')
        ? context!.source
        : value
    ));
  },
};

/** presto-client's error: Trino's own (`message`, `errorName`), or the client's (`message`, `error`). */
export function trinoError(e: any): Error {
  if (e instanceof Error) {
    return e;
  }
  return Object.assign(new Error(e?.error && !e?.errorName ? `${e.message}\n${e.error}` : String(e?.message ?? e)), {
    code: e?.errorName,
    errorCode: e?.errorCode,
  });
}

/**
 * Builds with every `CUBEJS_` variable out of the environment, put back before
 * anything else runs. A stand-in catalog and schema are set while it builds:
 * without them Cube's constructor reads the deprecated `CUBEJS_DB_CATALOG` and
 * `CUBEJS_DB_SCHEMA`, and logs so on every build. The config replaces both.
 */
function withoutCubeEnv<T>(build: () => T): T {
  const hidden = Object.entries(process.env).filter(([key]) => key.startsWith('CUBEJS_'));
  for (const [key] of hidden) {
    delete process.env[key];
  }
  process.env.CUBEJS_DB_PRESTO_CATALOG = '-';
  process.env.CUBEJS_DB_NAME = '-';
  try {
    return build();
  } finally {
    delete process.env.CUBEJS_DB_PRESTO_CATALOG;
    delete process.env.CUBEJS_DB_NAME;
    for (const [key, value] of hidden) {
      process.env[key] = value;
    }
  }
}

let driverClass: (new (config: Record<string, unknown>) => CubeTrinoDriver) | undefined;

function trinoDriverClass() {
  if (!driverClass) {
    // Loaded on first use, as Cube loads a driver: the image lays it beside Cube's own packages.
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { TrinoDriver } = require('@cubejs-backend/trino-driver') as typeof import('@cubejs-backend/trino-driver');

    class XcubeTrinoDriver extends TrinoDriver {
      /** Cube's, with its pages in order, and an error after a stream's columns ending the stream. */
      public override queryPromised(query: string, streaming: boolean): Promise<any> {
        const { schema, headers, queryTimeout } = this.config as any;
        const base = { query, schema: schema || 'default', headers };
        if (!streaming) {
          return new Promise((resolve, reject) => {
            const pages: unknown[][] = [];
            this.client.execute({
              ...base,
              data: (_error: unknown, data: any[], columns: any) => {
                pages.push(this.normalizeResultOverColumns(data, columns));
              },
              success: () => resolve(pages.flat()),
              error: (error: unknown) => reject(trinoError(error)),
            });
          });
        }
        const rowStream = new Transform({
          writableObjectMode: true,
          readableObjectMode: true,
          transform(obj, _encoding, callback) {
            callback(null, obj);
          },
        });
        return new Promise((resolve, reject) => {
          let answered = false;
          const answer = (types: unknown) => {
            answered = true;
            resolve({ rowStream, types });
          };
          this.client.execute({
            ...base,
            session: queryTimeout ? `query_max_run_time=${queryTimeout}s` : undefined,
            columns: (_error: unknown, columns: unknown) => answer(columns),
            data: (_error: unknown, data: any[], columns: any) => {
              for (const row of this.normalizeResultOverColumns(data, columns)) {
                rowStream.write(row);
              }
            },
            success: () => {
              if (!answered) {
                answer([]);
              }
              rowStream.end();
            },
            error: (error: unknown) => {
              if (answered) {
                rowStream.destroy(trinoError(error));
              } else {
                reject(trinoError(error));
              }
            },
          });
        });
      }

      // No export bucket: Cube's would write the rollup's rows out with CREATE TABLE … AS.
      public override async isUnloadSupported() {
        return false;
      }

      /** The connection test's catalog read (AC-1031): the catalog's schemas, empty ones too, as its user sees them. */
      protected override getSchemasQuery() {
        return `
      SELECT schema_name as ${this.quoteIdentifier('schema_name')}
      FROM ${this.quoteIdentifier(String(this.config.catalog))}.information_schema.schemata
      WHERE schema_name <> 'information_schema'
    `;
      }
    }
    driverClass = XcubeTrinoDriver as any;
  }
  return driverClass!;
}

/** A Trino driver from a connection's config (`DRIVERS.trino.config`). */
export function makeTrinoDriver(config: Record<string, unknown>): CubeTrinoDriver {
  const DriverClass = trinoDriverClass();
  return withoutCubeEnv(() => new DriverClass({
    ...config,
    queryTimeout: config.queryTimeout ?? QUERY_TIMEOUT_S,
    jsonParser: TRINO_JSON,
  }));
}
