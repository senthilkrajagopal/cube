/** Lower runs first. */
export enum Priority {
  /** Compiling a revision to serve it. */
  Activate = 1,
  /** Checking a snapshot before storing it. */
  Import = 2,
  /** Checking a snapshot that won't be stored. */
  DryRun = 3,
}

export class LaneBusyError extends Error {
  public constructor(public readonly retryAfterMs: number) {
    super('Cube is busy compiling; try again');
  }
}

interface Waiting {
  priority: Priority;
  seq: number;
  start: () => void;
  timer?: NodeJS.Timeout;
}

export interface CompileLaneOptions {
  /** Imports and dry runs that may wait; activations always queue. */
  maxWaiting: number;
  /** How long an import or dry run may wait before it is refused. */
  maxWaitMs: number;
}

/**
 * One compile at a time per process, in priority order. A compile runs on
 * the event loop of a process that also answers queries, so CPU and memory
 * stay bounded. A running compile is never interrupted.
 */
export class CompileLane {
  protected running = false;

  protected seq = 0;

  protected readonly waiting: Waiting[] = [];

  public constructor(protected readonly options: CompileLaneOptions) {
  }

  public get size(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  /**
   * Runs `task` once the lane is free and nothing of a higher priority waits.
   *
   * @throws LaneBusyError when an import or dry run can't wait
   */
  public async run<T>(priority: Priority, task: () => Promise<T>): Promise<T> {
    await this.acquire(priority);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  protected acquire(priority: Priority): Promise<void> {
    if (!this.running && !this.waiting.length) {
      this.running = true;
      return Promise.resolve();
    }

    const optional = priority !== Priority.Activate;
    if (optional && this.waiting.filter((w) => w.priority !== Priority.Activate).length >= this.options.maxWaiting) {
      return Promise.reject(new LaneBusyError(this.options.maxWaitMs));
    }

    return new Promise<void>((resolve, reject) => {
      const entry: Waiting = { priority, seq: this.seq++, start: resolve };
      if (optional) {
        entry.timer = setTimeout(() => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) {
            this.waiting.splice(i, 1);
            reject(new LaneBusyError(this.options.maxWaitMs));
          }
        }, this.options.maxWaitMs);
        entry.timer.unref?.();
      }
      this.waiting.push(entry);
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    });
  }

  protected release() {
    const next = this.waiting.shift();
    if (!next) {
      this.running = false;
      return;
    }
    if (next.timer) {
      clearTimeout(next.timer);
    }
    next.start();
  }
}
