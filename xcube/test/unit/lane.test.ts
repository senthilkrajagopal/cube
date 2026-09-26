import { CompileLane, LaneBusyError, Priority } from '../../src/runtime/lane';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('CompileLane', () => {
  test('runs one task at a time, highest priority first, in arrival order within a priority', async () => {
    const lane = new CompileLane({ maxWaiting: 10, maxWaitMs: 60000 });
    const order: string[] = [];
    const first = gate();
    let running = 0;
    let most = 0;

    const task = (name: string, wait?: Promise<void>) => async () => {
      running++;
      most = Math.max(most, running);
      order.push(name);
      await wait;
      running--;
      return name;
    };

    const all = [
      lane.run(Priority.DryRun, task('dry-1', first.opened)),
      lane.run(Priority.DryRun, task('dry-2')),
      lane.run(Priority.Import, task('import')),
      lane.run(Priority.Activate, task('activate-1')),
      lane.run(Priority.Activate, task('activate-2')),
    ];
    first.open();
    expect(await Promise.all(all)).toEqual(['dry-1', 'dry-2', 'import', 'activate-1', 'activate-2']);
    expect(order).toEqual(['dry-1', 'activate-1', 'activate-2', 'import', 'dry-2']);
    expect(most).toBe(1);
    expect(lane.size).toBe(0);
  });

  test('refuses imports and dry runs beyond the queue, but never an activation', async () => {
    const lane = new CompileLane({ maxWaiting: 1, maxWaitMs: 60000 });
    const held = gate();
    const running = lane.run(Priority.Activate, () => held.opened);
    const waiting = lane.run(Priority.DryRun, async () => 'ok');

    await expect(lane.run(Priority.Import, async () => 'no')).rejects.toBeInstanceOf(LaneBusyError);
    const activation = lane.run(Priority.Activate, async () => 'activated');

    held.open();
    await running;
    expect(await activation).toBe('activated');
    expect(await waiting).toBe('ok');
  });

  test('refuses a task that waited too long', async () => {
    jest.useFakeTimers();
    try {
      const lane = new CompileLane({ maxWaiting: 5, maxWaitMs: 1000 });
      const held = gate();
      const running = lane.run(Priority.Activate, () => held.opened);
      const waiting = lane.run(Priority.Import, async () => 'late');
      jest.advanceTimersByTime(1001);
      await expect(waiting).rejects.toBeInstanceOf(LaneBusyError);
      held.open();
      await running;
      expect(lane.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a failing task frees the lane', async () => {
    const lane = new CompileLane({ maxWaiting: 5, maxWaitMs: 1000 });
    await expect(lane.run(Priority.Import, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await lane.run(Priority.Import, async () => 'next')).toBe('next');
  });
});
