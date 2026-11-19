/**
 * Cube's logger, with xcube's own outcome lines printed at `info`. Cube's
 * production logger prints an event at `info` only when its name is on a
 * fixed list (`REST API Request`), so any other line without an `error` or a
 * `warning` shows only at `trace`. An export's start and end are worth
 * seeing at `info`, the default: a long load's outcome otherwise leaves no
 * trace. A failure carries `error`, which every level prints.
 */
import type { LogLevel, LoggerFn } from '@cubejs-backend/shared';
import { createLogger } from '@cubejs-backend/server-core/dist/src/core/logger';

/** The events printed at `info` as well as `trace`. */
export const XCUBE_INFO_EVENTS: ReadonlySet<string> = new Set([
  'xcube: export started', 'xcube: export', 'xcube: jdbc driver jar', 'xcube: jdbc driver unavailable',
]);

/** Cube's logger for `production` and `level` (`CUBEJS_LOG_LEVEL`, `info` unset), printing `XCUBE_INFO_EVENTS` at `info`. */
export function xcubeLogger(production: boolean, level: string = 'info', write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): LoggerFn {
  const cube = createLogger(production, level as LogLevel);
  const atInfo = ['info', 'trace'].includes(level.toLowerCase());
  return (message, params = {}) => {
    const { error, warning, level: _level, timestamp, ...rest } = params as Record<string, any>;
    if (atInfo && XCUBE_INFO_EVENTS.has(message) && !error && !warning) {
      write(JSON.stringify({ timestamp: timestamp ?? new Date().toISOString(), level: 'info', message, ...rest }));
      return;
    }
    cube(message, params);
  };
}
