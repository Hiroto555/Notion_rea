/** Coordinates a transfer pass with workspace mutations and maintenance.
 * Reads and crash-recovery checkpoints do not use this gate. A sync pass waits
 * for existing writes, then holds new writes until the pass settles; input can
 * still be captured in the separate durable recovery file while it waits. */
export class WorkspaceSyncGate {
  private activeWrites = 0;
  private waitingWrites = 0;
  private syncPending = false;
  private syncPromise?: Promise<unknown>;
  private waiters: Array<() => void> = [];

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  /** A restart host must check this from main, not infer it from renderer state. */
  isIdle(): boolean {
    return !this.syncPending && this.activeWrites === 0 && this.waitingWrites === 0;
  }
  async write<T>(work: () => Promise<T> | T): Promise<T> {
    this.waitingWrites++;
    try { while (this.syncPending) await this.wait(); }
    finally { this.waitingWrites--; }
    this.activeWrites++;
    try { return await work(); }
    finally { this.activeWrites--; this.wake(); }
  }
  sync<T>(work: () => Promise<T>): Promise<T> {
    if (this.syncPromise) return this.syncPromise as Promise<T>;
    this.syncPending = true;
    const result = Promise.resolve().then(async () => {
      try {
        while (this.activeWrites > 0) await this.wait();
        return await work();
      } finally {
        this.syncPending = false;
        this.syncPromise = undefined;
        this.wake();
      }
    });
    this.syncPromise = result;
    return result;
  }
}
