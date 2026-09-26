/**
 * One stable driver per connection and orchestrator, which Cube keeps, and a
 * real driver behind it that can be replaced while Cube runs (a rotated
 * password, a moved host): new calls go to the new driver, and the old one
 * is released once its calls, and any stream or table handle they gave out,
 * are done, or after a drain timeout.
 */

interface Entry {
  driver: any;
  inflight: number;
  draining: boolean;
  releasing: Promise<void> | null;
  timer: NodeJS.Timeout | null;
}

export class SwitchableDriver {
  protected current: Entry;

  protected readonly draining = new Set<Entry>();

  protected logger: any = null;

  /** Why calls are refused, once the connection is gone. */
  protected removed: string | null = null;

  public readonly proxy: any;

  public constructor(
    public readonly name: string,
    driver: any,
    protected readonly onRelease: () => void = () => undefined,
    /** Takes the connection's secrets out of an error's text (a driver may print its config). */
    protected readonly redact: (text: string) => string = (text) => text,
    protected readonly drainTimeoutMs = 30 * 60 * 1000,
  ) {
    this.current = this.track(driver);
    this.proxy = this.createProxy();
  }

  /** An error as the caller gets it: with the connection's secrets taken out. */
  protected clean(e: any) {
    if (e && typeof e === 'object') {
      try {
        if (typeof e.message === 'string') {
          e.message = this.redact(e.message);
        }
        if (typeof e.stack === 'string') {
          e.stack = this.redact(e.stack);
        }
      } catch {
        // A frozen error keeps its text.
      }
    }
    return e;
  }

  protected track(driver: any): Entry {
    return { driver, inflight: 0, draining: false, releasing: null, timer: null };
  }

  /** New calls go to `driver` from now on; the old one goes once idle. */
  public swap(driver: any) {
    if (this.logger && driver.setLogger) {
      driver.setLogger(this.logger);
    }
    const old = this.current;
    this.current = this.track(driver);
    this.retire(old);
  }

  /** The connection is gone: calls are refused, and its driver goes once idle. */
  public remove(reason: string) {
    this.removed = reason;
    this.retire(this.current);
  }

  public get isRemoved(): boolean {
    return this.removed !== null;
  }

  /** The connection is back (re-created): calls go to `driver` again. */
  public restore(driver: any) {
    if (this.logger && driver.setLogger) {
      driver.setLogger(this.logger);
    }
    this.current = this.track(driver);
    this.removed = null;
  }

  protected retire(entry: Entry) {
    entry.draining = true;
    this.draining.add(entry);
    entry.timer = setTimeout(() => this.release(entry), this.drainTimeoutMs);
    entry.timer.unref?.();
    if (entry.inflight === 0) {
      this.release(entry);
    }
  }

  protected release(entry: Entry): Promise<void> {
    if (!entry.releasing) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      this.draining.delete(entry);
      entry.releasing = Promise.resolve()
        .then(() => entry.driver.release?.())
        .catch(() => undefined);
    }
    return entry.releasing;
  }

  protected done(entry: Entry) {
    entry.inflight -= 1;
    if (entry.draining && entry.inflight === 0) {
      this.release(entry);
    }
  }

  /** Calls `fn` on the entry's driver, which stays busy until the call, and any handle it returns, is done. */
  protected invoke(entry: Entry, fn: (...args: any[]) => any, args: any[]) {
    entry.inflight += 1;
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        this.done(entry);
      }
    };
    let result: any;
    try {
      result = fn.apply(entry.driver, args);
    } catch (e) {
      finish();
      throw this.clean(e);
    }
    if (result && typeof result.then === 'function') {
      // Before the caller's handlers, and on the promise Cube gets itself: Cube reads `.cancel` off
      // it. The error it rejects with is the caller's too: cleaned here, before they see it.
      result.then((value: any) => {
        if (value && typeof value === 'object' && typeof value.release === 'function') {
          // stream(), downloadTable() and unload() hand out a handle that holds a connection.
          const original = value.release;
          value.release = async (...a: any[]) => {
            try {
              return await original.apply(value, a);
            } finally {
              finish();
            }
          };
        } else {
          finish();
        }
      }, (e: any) => {
        this.clean(e);
        finish();
      });
      return result;
    }
    finish();
    return result;
  }

  /** Cube releasing its orchestrator: every driver behind this one goes. */
  public async releaseAll() {
    this.onRelease();
    const entries = [this.current, ...this.draining];
    await Promise.all(entries.map((entry) => {
      entry.draining = true;
      return this.release(entry);
    }));
  }

  protected createProxy() {
    const self = this;
    const wrappers = new Map<PropertyKey, (...args: any[]) => any>();
    // The target is a stand-in: every trap reads the current driver.
    return new Proxy(Object.create(null), {
      get(_target, prop) {
        if (prop === '__xcubeConnection') {
          return self;
        }
        if (prop === 'release') {
          return () => self.releaseAll();
        }
        if (prop === 'setLogger') {
          return (logger: any) => {
            self.logger = logger;
            self.current.driver.setLogger?.(logger);
          };
        }
        const value = Reflect.get(self.current.driver, prop, self.current.driver);
        if (typeof value !== 'function') {
          return value;
        }
        let wrapped = wrappers.get(prop);
        if (!wrapped) {
          // Resolved at call time, not when read: a swap in between takes effect.
          wrapped = function call(...args: any[]) {
            if (self.removed) {
              return Promise.reject(new Error(self.removed));
            }
            const entry = self.current;
            const fn = entry.driver[prop];
            if (typeof fn !== 'function') {
              throw new TypeError(`${String(prop)} is not a function of the current driver`);
            }
            return self.invoke(entry, fn, args);
          };
          wrappers.set(prop, wrapped);
        }
        return wrapped;
      },
      has(_target, prop) {
        return prop in self.current.driver;
      },
      set(_target, prop, value) {
        self.current.driver[prop] = value;
        return true;
      },
      getPrototypeOf() {
        return Object.getPrototypeOf(self.current.driver);
      },
    });
  }
}
