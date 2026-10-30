/**
 * Cube's ClickHouse driver, fenced to a connection's own fields. Cube's reads
 * its compression, read-only mode, pool size, query timeout and export bucket
 * (with AWS keys it would write into an `INSERT INTO FUNCTION s3`) from its
 * environment; here each is set, and none of them reaches a connection.
 */
import type { ClickHouseDriver as CubeClickHouseDriver } from '@cubejs-backend/clickhouse-driver';

/** Cube's own default: ten minutes. A SQL run's own clock stops its statement sooner. */
const REQUEST_TIMEOUT_MS = 600000;

/** What every query of Cube's sends: nulls for a join's unmatched rows (AC-1041), and the date format Cube's converters read. */
export const CLICKHOUSE_SETTINGS = {
  send_progress_in_http_headers: 0,
  join_use_nulls: 1,
  date_time_output_format: 'simple',
} as const;

let driverClass: (new (config: Record<string, unknown>) => CubeClickHouseDriver) | undefined;

function clickHouseDriverClass() {
  if (!driverClass) {
    // Loaded on first use, as Cube loads a driver: the image lays it beside Cube's own packages.
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { ClickHouseDriver } = require('@cubejs-backend/clickhouse-driver') as typeof import('@cubejs-backend/clickhouse-driver');

    class XcubeClickHouseDriver extends ClickHouseDriver {
      // No export bucket: Cube's reads one, and its keys, from the environment.
      protected override getExportBucket(): null {
        return null;
      }

      // Called last in Cube's constructor: its config is pinned here, before the first client.
      protected override createClient(maxPoolSize: number) {
        Object.assign(this.config, {
          compression: { request: false, response: false },
          clickhouseSettings: { ...CLICKHOUSE_SETTINGS },
          exportBucket: null,
          headers: {},
        });
        return super.createClient(maxPoolSize);
      }

      /**
       * The connection test's catalog read (AC-1031): the named database's
       * tables, so a database that isn't there, or can't be read, fails.
       */
      public override async getSchemas() {
        await this.query(`SHOW TABLES FROM ${this.quoteIdentifier(this.config.database)}`, []);
        return super.getSchemas();
      }
    }
    driverClass = XcubeClickHouseDriver as any;
  }
  return driverClass!;
}

/** A ClickHouse driver from a connection's config (`DRIVERS.clickhouse.config`). */
export function makeClickHouseDriver(config: Record<string, unknown>): CubeClickHouseDriver {
  const DriverClass = clickHouseDriverClass();
  return new DriverClass({
    ...config,
    maxPoolSize: config.maxPoolSize ?? 10,
    requestTimeout: config.requestTimeout ?? REQUEST_TIMEOUT_MS,
  });
}
