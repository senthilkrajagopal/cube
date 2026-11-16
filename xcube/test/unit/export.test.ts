import { EXPORT_FETCH_BYTES, EXPORT_FETCH_ROWS, ExportRows, exportFetchFromEnv } from '../../src/sql/export';
import { isTimeout } from '../../src/sql/runner';
import { xcubeLogger } from '../../src/logger';

describe('an export\'s batches: sized by the bytes of its rows', () => {
  test('1,000 rows first, then about the bytes asked for, at most the rows asked for', () => {
    const lines: string[] = [];
    const rows = new ExportRows((line) => lines.push(line) > 0, { rows: 50000, bytes: 1024 * 1024 });
    expect(rows.fetchRows(500)).toBe(1000);
    rows.setColumns([{ name: 'pad', type: 'text' }]);
    // Rows of 1,023 bytes and a newline: a MiB is 1,024 of them.
    for (let i = 0; i < 10; i += 1) {
      rows.add(['x'.repeat(1019)]);
    }
    expect(lines[1].length + 1).toBe(1024);
    expect(rows.fetchRows(500)).toBe(1024);
    const small = new ExportRows(() => true, { rows: 50000, bytes: 1024 * 1024 });
    small.add([1]);
    expect(small.fetchRows(500)).toBe(50000);
  });

  test('a client that stopped reading ends the reads', async () => {
    const rows = new ExportRows(() => true, { rows: 10, bytes: 65536 }, async () => false);
    expect(await rows.ready()).toBe(false);
    expect(rows.slow).toBe(true);
    expect(rows.add([1])).toBe(false);
  });

  test('the settings, checked', () => {
    expect(exportFetchFromEnv({})).toEqual({ rows: EXPORT_FETCH_ROWS, bytes: EXPORT_FETCH_BYTES });
    expect(exportFetchFromEnv({ XCUBE_EXPORT_FETCH_ROWS: '10000', XCUBE_EXPORT_FETCH_BYTES: '4194304' })).toEqual({ rows: 10000, bytes: 4194304 });
    expect(() => exportFetchFromEnv({ XCUBE_EXPORT_FETCH_ROWS: '0' })).toThrow(/XCUBE_EXPORT_FETCH_ROWS/);
    expect(() => exportFetchFromEnv({ XCUBE_EXPORT_FETCH_BYTES: String(512 * 1024 * 1024) })).toThrow(/XCUBE_EXPORT_FETCH_BYTES/);
    expect(() => exportFetchFromEnv({ XCUBE_EXPORT_FETCH_ROWS: '1.5' })).toThrow(/whole number/);
  });
});

describe('Redshift\'s statement timeout, which it words as a cancel', () => {
  const cancel = Object.assign(new Error('Query (4711) cancelled on user\'s request'), { code: '57014' });
  const ran = (ms: number) => ({ ms, timeoutMs: 30 * 60 * 1000 });

  test('a cancel that comes at the statement\'s timeout is its timeout', () => {
    expect(isTimeout('redshift', cancel, ran(30 * 60 * 1000 + 250))).toBe(true);
    expect(isTimeout('redshift', cancel, ran(30 * 60 * 1000 - 500))).toBe(true);
    expect(isTimeout('redshift', new Error('Query (4711) canceled on user\'s request'), ran(30 * 60 * 1000))).toBe(true);
    expect(isTimeout('redshift', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe(true);
  });

  test('one well before it, or one whose time isn\'t known, is a cancel from elsewhere; PostgreSQL\'s cancel is never a timeout', () => {
    expect(isTimeout('redshift', cancel, ran(10 * 60 * 1000))).toBe(false);
    expect(isTimeout('redshift', cancel)).toBe(false);
    expect(isTimeout('postgres', Object.assign(new Error('canceling statement due to user request'), { code: '57014' }), ran(30 * 60 * 1000))).toBe(false);
  });
});

describe('xcube\'s logger: the export lines at info', () => {
  test('an export\'s start and end print at info and trace as Cube\'s JSON lines, not at warn', () => {
    const lines: string[] = [];
    const log = xcubeLogger(true, 'info', (line) => lines.push(line));
    log('xcube: export started', { model: 'm', target: 'radix', runId: 'r1', source: 'dae.t' });
    log('xcube: export', { model: 'm', runId: 'r1', outcome: 'ok', rows: 3, durationMs: 9, timestamp: '2026-11-16T00:00:00.000Z' });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { timestamp: expect.any(String), level: 'info', message: 'xcube: export started', model: 'm', target: 'radix', runId: 'r1', source: 'dae.t' },
      { timestamp: '2026-11-16T00:00:00.000Z', level: 'info', message: 'xcube: export', model: 'm', runId: 'r1', outcome: 'ok', rows: 3, durationMs: 9 },
    ]);
    const quiet: string[] = [];
    xcubeLogger(true, 'warn', (line) => quiet.push(line))('xcube: export', { outcome: 'ok' });
    expect(quiet).toEqual([]);
  });

  test('a failure goes to Cube\'s logger, which prints an error at every level; other events as Cube decides', () => {
    const printed = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const lines: string[] = [];
      const log = xcubeLogger(true, 'warn', (line) => lines.push(line));
      log('xcube: export', { outcome: 'timeout', error: 'The statement ran past 30 minutes', databaseMessage: 'Query (1) cancelled on user\'s request' });
      log('xcube: imported a snapshot', { model: 'm' });
      expect(lines).toEqual([]);
      expect(printed).toHaveBeenCalledTimes(1);
      expect(JSON.parse(printed.mock.calls[0][0])).toMatchObject({
        level: 'error', message: 'xcube: export', outcome: 'timeout', databaseMessage: 'Query (1) cancelled on user\'s request',
      });
    } finally {
      printed.mockRestore();
    }
  });
});
