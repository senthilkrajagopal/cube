import { EXPORT_FETCH_BYTES, EXPORT_FETCH_ROWS, ExportRows, exportFetchFromEnv } from '../../src/sql/export';

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
