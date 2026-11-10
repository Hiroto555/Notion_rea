import type { SharedRuntimeRequest } from "./shared-runtime-ipc";
type Draft = Extract<SharedRuntimeRequest, { type: "draft" }>;
/** Coalesces only the unsent editor draft, never an authoritative intent/attempt. */
export class SharedDraftLane {
  private pending: Draft | null = null;
  private active: Promise<void> | null = null;
  constructor(private readonly write: (input: Draft) => Promise<unknown>) {}
  retain(generation: number, raw: string): Promise<void> {
    this.pending = { type: "draft", generation, raw };
    return this.flush();
  }
  flush(): Promise<void> {
    if (this.active) return this.active;
    if (!this.pending) return Promise.resolve();
    const run = Promise.resolve().then(async () => {
      while (this.pending) {
        const draft = this.pending;
        this.pending = null;
        try {
          await this.write(draft);
        } catch (error) {
          if (!this.pending) this.pending = draft;
          throw error;
        }
      }
    });
    const finished = run.finally(() => {
      if (this.active === finished) this.active = null;
    });
    this.active = finished;
    return finished;
  }
}
