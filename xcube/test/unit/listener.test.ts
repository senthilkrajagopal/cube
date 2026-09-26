import { EventEmitter } from 'events';

import { RevisionListener, type ListenClient } from '../../src/runtime/listener';

class FakeClient extends EventEmitter implements ListenClient {
  public queries: string[] = [];

  public ended = false;

  public constructor(public connectError?: Error, public hang = false) {
    super();
  }

  public async connect() {
    if (this.connectError) {
      throw this.connectError;
    }
  }

  public query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    if (this.hang && sql === 'SELECT 1') {
      return new Promise(() => undefined);
    }
    return Promise.resolve({});
  }

  public async end() {
    this.ended = true;
  }
}

const flush = () => new Promise((resolve) => jest.requireActual('timers').setImmediate(resolve));

describe('RevisionListener', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function listener(clients: FakeClient[], extra: object = {}) {
    const notified: string[] = [];
    let connects = 0;
    let downs = 0;
    const made: FakeClient[] = [];
    const l = new RevisionListener({
      channel: 'xcube_revision',
      createClient: () => {
        const client = clients.shift() ?? new FakeClient();
        made.push(client);
        return client;
      },
      onNotify: (model) => notified.push(model),
      onConnect: () => {
        connects++;
      },
      onDown: () => {
        downs++;
      },
      logger: () => undefined,
      ...extra,
    });
    return { l, notified, made, connects: () => connects, downs: () => downs };
  }

  test('listens, then passes on each model it hears of, ignoring other channels and bad payloads', async () => {
    const { l, notified, made, connects } = listener([]);
    l.start();
    await flush();

    expect(made[0].queries).toEqual(['LISTEN xcube_revision']);
    expect(connects()).toBe(1);
    expect(l.up).toBe(true);

    made[0].emit('notification', { channel: 'xcube_revision', payload: '{"model":"dev","rev":2}' });
    made[0].emit('notification', { channel: 'other', payload: '{"model":"x"}' });
    made[0].emit('notification', { channel: 'xcube_revision', payload: 'not json' });
    made[0].emit('notification', { channel: 'xcube_revision', payload: '{"rev":3}' });
    expect(notified).toEqual(['dev']);
    await l.stop();
  });

  test('reconnects with growing, jittered backoff, and resyncs on each connect', async () => {
    const refused = new Error('refused');
    const { l, made, connects, downs } = listener([new FakeClient(), new FakeClient(refused), new FakeClient(refused)], {
      backoffMinMs: 1000,
      backoffMaxMs: 4000,
    });
    l.start();
    await flush();
    expect(connects()).toBe(1);

    made[0].emit('error', new Error('connection reset'));
    expect(l.up).toBe(false);
    expect(downs()).toBe(1);
    expect(made[0].ended).toBe(true);

    jest.advanceTimersByTime(1200); // first retry: 1 s ± 20%
    await flush();
    expect(made).toHaveLength(2);

    jest.advanceTimersByTime(799); // second: 2 s ± 20%, not yet
    await flush();
    expect(made).toHaveLength(2);
    jest.advanceTimersByTime(2401 - 799);
    await flush();
    expect(made).toHaveLength(3);

    jest.advanceTimersByTime(4800);
    await flush();
    expect(made).toHaveLength(4);
    expect(l.up).toBe(true);
    expect(connects()).toBe(2);
    expect(downs()).toBe(1);
    await l.stop();
  });

  test('drops a connection that stops answering its health check', async () => {
    const { l, made } = listener([new FakeClient(undefined, true)], { healthIntervalMs: 1000, healthTimeoutMs: 500 });
    l.start();
    await flush();
    expect(l.up).toBe(true);

    jest.advanceTimersByTime(1000);
    await flush();
    jest.advanceTimersByTime(500);
    await flush();
    expect(l.up).toBe(false);
    expect(made[0].ended).toBe(true);
    await l.stop();
  });

  test('an end after stop does nothing', async () => {
    const { l, made } = listener([]);
    l.start();
    await flush();
    await l.stop();
    made[0].emit('end');
    jest.advanceTimersByTime(60000);
    expect(made).toHaveLength(1);
  });
});
