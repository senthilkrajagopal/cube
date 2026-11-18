/**
 * The SQL runner's parameters on a real Trino (R12): Trino's client protocol
 * binds nothing, so xcube writes each value into the statement as a typed
 * literal, checked to read as that literal alone, and the read-only check
 * reads the statement as it runs. Runs when given:
 *
 *   XCUBE_TEST_TRINO  a Trino's HTTP port as host:port, without authentication, with its `tpch` catalog
 *                     (docker run trinodb/trino)
 */
/* eslint-disable no-template-curly-in-string -- `${…}` here is text under test */
import crypto from 'crypto';

import { makeTrinoDriver } from '../../src/connections/trino';
import { SqlRuns, type SqlRunRequest, type SqlTarget } from '../../src/sql/runs';

const TRINO = process.env.XCUBE_TEST_TRINO;

jest.setTimeout(5 * 60 * 1000);

(TRINO ? describe : describe.skip)('the SQL runner\'s parameters on Trino, as typed literals (R12)', () => {
  const [host, port] = (TRINO ?? 'x:0').split(':');
  const runs = new SqlRuns('here', () => null, () => undefined);
  const target: SqlTarget = {
    dialect: 'trino',
    label: 'trino',
    build: async () => ({ driver: makeTrinoDriver({ host, port, catalog: 'tpch', schema: 'tiny', user: 'xcube' }), secrets: [] }),
  };
  const run = (sql: string, more: Partial<SqlRunRequest> = {}) => runs.run('m', target, {
    sql, runId: crypto.randomUUID(), maxRows: 100, timeoutMs: 120000, maxBytes: 10 * 1024 * 1024, ...more,
  });

  test('hostile text comes back as data, and nothing else runs', async () => {
    for (const value of ['\'; DROP TABLE x; --', 'it\'s', '\'\'\'', 'back\\slash\\', '${env:HOME}', '*/ x /*', '-- c\n; SELECT 1', 'tab\tq"d', ';']) {
      const answer = await run('SELECT {{t}} AS v', { parameters: { t: { type: 'text', value } } });
      expect([value, answer.rows]).toEqual([value, [[value]]]);
    }
  });

  test('a number, a date, a date and time read as UTC, a boolean, and lists', async () => {
    const answer = await run(`SELECT {{n}} + 1 AS n, {{d}} = DATE '2026-02-28' AS day, {{at}} = TIMESTAMP '2026-03-08 02:30:00.5' AS wall,
      {{at}} = TIMESTAMP '2026-03-08 02:30:00.5 UTC' AS utc, {{b}} AS b, current_timezone() AS zone,
      (SELECT count(*) FROM nation WHERE nationkey IN ({{ids}}) AND name IN ({{names}})) AS listed`, {
      lists: true,
      parameters: {
        n: { type: 'number', value: '-12.50' },
        d: { type: 'date', value: '2026-02-28' },
        at: { type: 'datetime', value: '2026-03-08T02:30:00.5' },
        b: { type: 'boolean', value: false },
        ids: { type: 'number', value: ['0', '1', '2'] },
        names: { type: 'text', value: ['ALGERIA', 'BRAZIL'] },
      },
    });
    expect(answer.rows).toEqual([['-11.50', true, true, true, false, 'UTC', 2]]);
  });
});
