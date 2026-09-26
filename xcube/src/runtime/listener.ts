import type { Logger } from '../store/db';

/** What a notification announces: a revision (`rev`), permissions or keys, each at its new version. */
export interface Notice {
  rev?: number;
  permissions?: number;
  keys?: number;
}

/** What the listener needs of a `pg.Client`. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', listener: (e: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(): unknown;
  end(): Promise<unknown>;
}

export interface ListenerOptions {
  channel: string;
  createClient: () => ListenClient;
  /** A model's revision, permissions or keys may have changed: what the notification says changed. */
  onNotify: (model: string, change: Notice) => void;
  /** Connected and listening; anything announced while it was down was missed. */
  onConnect: () => void;
  onDown?: () => void;
  logger: Logger;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

/**
 * Follows `LISTEN <channel>` on a connection of its own, reconnecting with
 * backoff for as long as it runs. A periodic `SELECT 1` catches a connection
 * that died without telling. Notifications are only hints: receivers always
 * re-read the tables, and a poll covers anything missed.
 */
export class RevisionListener {
  protected client: ListenClient | null = null;

  protected running = false;

  protected connected = false;

  protected backoffMs: number;

  protected reconnectTimer: NodeJS.Timeout | null = null;

  protected healthTimer: NodeJS.Timeout | null = null;

  public constructor(protected readonly options: ListenerOptions) {
    this.backoffMs = options.backoffMinMs ?? 1000;
  }

  public get up(): boolean {
    return this.connected;
  }

  public start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  public async stop() {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHealthCheck();
    await this.drop();
  }

  protected async connect() {
    if (!this.running) {
      return;
    }
    const client = this.options.createClient();
    this.client = client;

    client.on('notification', (message) => {
      if (message.channel !== this.options.channel) {
        return;
      }
      try {
        const { model, rev, permissions, keys } = JSON.parse(message.payload || '{}');
        if (typeof model === 'string') {
          const notice: Notice = {};
          if (typeof rev === 'number') {
            notice.rev = rev;
          }
          if (typeof permissions === 'number') {
            notice.permissions = permissions;
          }
          if (typeof keys === 'number') {
            notice.keys = keys;
          }
          this.options.onNotify(model, notice);
          return;
        }
      } catch {
        // Logged below.
      }
      this.options.logger('xcube: ignored a malformed revision notification', { payload: message.payload, warning: 'malformed notification' });
    });
    client.on('error', (e) => this.lost(client, e));
    client.on('end', () => this.lost(client));

    try {
      await client.connect();
      await client.query(`LISTEN ${this.options.channel}`);
    } catch (e: any) {
      this.lost(client, e);
      return;
    }

    if (this.client !== client || !this.running) {
      return;
    }
    this.connected = true;
    this.backoffMs = this.options.backoffMinMs ?? 1000;
    this.startHealthCheck(client);
    this.options.onConnect();
  }

  protected lost(client: ListenClient, e?: Error) {
    if (this.client !== client) {
      return;
    }
    const wasUp = this.connected;
    this.connected = false;
    this.client = null;
    this.stopHealthCheck();
    client.removeAllListeners();
    // A client that errored may still emit; keep a sink so nothing is unhandled.
    client.on('error', () => undefined);
    client.end().catch(() => undefined);

    if (!this.running) {
      return;
    }
    if (wasUp) {
      this.options.logger('xcube: revision listener lost; reconnecting', { warning: e?.message ?? 'connection ended' });
      this.options.onDown?.();
    }

    const max = this.options.backoffMaxMs ?? 30000;
    const delay = Math.round(this.backoffMs * (0.8 + Math.random() * 0.4));
    this.backoffMs = Math.min(this.backoffMs * 2, max);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  protected startHealthCheck(client: ListenClient) {
    const interval = this.options.healthIntervalMs ?? 30000;
    const timeout = this.options.healthTimeoutMs ?? 5000;
    this.healthTimer = setInterval(() => {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer to a health check in ${timeout} ms`)), timeout);
      });
      Promise.race([client.query('SELECT 1'), expired])
        .catch((e) => this.lost(client, e))
        .finally(() => clearTimeout(timer));
    }, interval);
    this.healthTimer.unref?.();
  }

  protected stopHealthCheck() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  protected async drop() {
    const { client } = this;
    this.client = null;
    this.connected = false;
    if (client) {
      client.removeAllListeners();
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
    }
  }
}
