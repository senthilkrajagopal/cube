import {
  BuildStopped, isStopped, STOPPED, stoppableExternal, stoppableSource,
} from '../../src/builds/stop';
import { buildOutcome } from '../../src/gateway';

const later = <T>(value: T, ms: number) => new Promise<T>((resolve) => {
  setTimeout(() => resolve(value), ms);
});

describe('a build the queue\'s cancel takes out while it builds', () => {
  test('its source call is cancellable: the driver\'s own cancel, and it fails as stopped', async () => {
    const own = jest.fn();
    const driver = {
      downloadQueryResults: () => Object.assign(later({ rows: [] }, 200), { cancel: own }),
      query: () => 'not wrapped',
    };
    const source = stoppableSource(driver, () => undefined);
    expect(source.constructor).toBe(Object);
    expect(source.query()).toBe('not wrapped');
    const call = source.downloadQueryResults('SELECT 1', [], { targetTableName: 's.t_one' });
    expect(typeof call.cancel).toBe('function');
    await call.cancel();
    await expect(call).rejects.toBeInstanceOf(BuildStopped);
    expect(own).toHaveBeenCalled();
    expect(isStopped('s.t_one')).toBe(true);
    expect(isStopped('s.t_other')).toBe(false);
  });

  test('one that ends as the cancel comes keeps nothing: a stream released, a table in the source dropped', async () => {
    const released = jest.fn();
    const dropped: string[] = [];
    const driver = {
      downloadQueryResults: () => later({ rowStream: { destroy: jest.fn() }, release: released }, 50),
      loadPreAggregationIntoTable: () => later(undefined, 50),
      dropTable: async (table: string) => {
        dropped.push(table);
      },
    };
    const source = stoppableSource(driver, () => undefined);
    const streamed = source.downloadQueryResults('SELECT 1', [], { targetTableName: 's.t_two' });
    const loaded = source.loadPreAggregationIntoTable('s.t_three', 'CREATE TABLE s.t_three AS SELECT 1', [], {});
    await Promise.all([streamed.cancel(), loaded.cancel()]);
    await expect(streamed).rejects.toThrow(STOPPED);
    await expect(loaded).rejects.toThrow(STOPPED);
    expect(released).toHaveBeenCalled();
    expect(dropped).toEqual(['s.t_three']);
  });

  test('a stream handed over already is cut; an uncancelled call is untouched', async () => {
    const destroy = jest.fn();
    const source = stoppableSource({ downloadQueryResults: async () => ({ rowStream: { destroy } }) }, () => undefined);
    const handed = source.downloadQueryResults('SELECT 1', [], { targetTableName: 's.t_four' });
    const data = await handed;
    expect(data.rowStream.destroy).toBe(destroy);
    await handed.cancel();
    expect(destroy).toHaveBeenCalledWith(expect.any(BuildStopped));
    const plain = stoppableSource({ downloadQueryResults: async () => 'rows' }, () => undefined);
    await expect(plain.downloadQueryResults('SELECT 1', [], {})).resolves.toBe('rows');
  });

  test('Cube Store commits no table of a stopped build: its upload refused, or its table dropped if the stop came as it ended', async () => {
    const dropped: string[] = [];
    let finish: () => void = () => undefined;
    const external = stoppableExternal({
      uploadTableWithIndexes: (table: string) => (table === 's.t_slow' ? new Promise<void>((resolve) => {
        finish = resolve;
      }) : Promise.resolve()),
      dropTable: async (table: string) => {
        dropped.push(table);
      },
    });
    await expect(external.uploadTableWithIndexes('s.t_one')).rejects.toThrow(STOPPED);
    await expect(external.uploadTableWithIndexes('s.t_fresh')).resolves.toBeUndefined();
    // Stopped while it uploaded: done, then dropped.
    const uploading = external.uploadTableWithIndexes('s.t_slow');
    const source = stoppableSource({ downloadQueryResults: () => later(null, 1000) }, () => undefined);
    const call = source.downloadQueryResults('SELECT 1', [], { targetTableName: 's.t_slow' });
    await call.cancel();
    finish();
    await expect(uploading).rejects.toThrow(STOPPED);
    expect(dropped).toEqual(['s.t_slow']);
    await expect(call).rejects.toThrow(STOPPED);
  });
});

describe('what came of a processing build after the cancel', () => {
  const statuses = (...sequence: any[]) => {
    let i = 0;
    return async () => sequence[Math.min(i++, sequence.length - 1)];
  };

  test('stopped, failed of itself, finished (it landed), or still stopping when the wait ends', async () => {
    const building = { status: 'building' };
    expect(await buildOutcome(statuses(building, { status: 'failure', error: STOPPED }), 5000)).toBe('stopped');
    expect(await buildOutcome(statuses(building, { status: 'failure', error: 'relation does not exist' }), 5000)).toBe('failed');
    expect(await buildOutcome(statuses(building, building, null), 5000)).toBe('finished');
    // Never seen building: its status gone isn't a landing.
    expect(await buildOutcome(statuses(null), 600)).toBe('stopping');
    expect(await buildOutcome(statuses(building), 600)).toBe('stopping');
  });
});
