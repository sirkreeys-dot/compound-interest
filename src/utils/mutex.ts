/** Simple async mutex to serialize alert handling (prevents double-spend races). */
export class Mutex {
  private chain: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.chain;
    this.chain = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** One mutex per key. Used to serialize work per token without blocking other tokens. */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.locks.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(key, mutex);
    }
    return mutex.runExclusive(fn);
  }
}
