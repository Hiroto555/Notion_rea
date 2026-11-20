// Keep the latest callback for each page. The deadline starts with the first
// edit in a burst and survives subsequent resets of the idle timer.
export class SaveScheduler {
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; deadline: number; send: () => void }>();

  constructor(private readonly debounceMs = 500, private readonly maxWaitMs = 2500) {}

  schedule(id: string, send: () => void) {
    const previous = this.pending.get(id);
    if (previous) clearTimeout(previous.timer);
    const now = performance.now();
    const deadline = previous?.deadline ?? now + this.maxWaitMs;
    const delay = Math.max(0, Math.min(this.debounceMs, deadline - now));
    if (!delay) {
      this.pending.delete(id);
      send();
      return;
    }
    const timer = setTimeout(() => this.flush(id), delay);
    this.pending.set(id, { timer, deadline, send });
  }

  flush(id: string) {
    const work = this.pending.get(id);
    if (!work) return;
    clearTimeout(work.timer);
    this.pending.delete(id);
    work.send();
  }

  flushAll() {
    for (const id of [...this.pending.keys()]) this.flush(id);
  }
}
