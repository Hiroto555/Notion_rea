import { canonicalOperation } from "../shared/save-contract";
import { validateCrashRecoverySnapshot, type CrashRecoveryRead, type CrashRecoverySnapshot } from "../shared/crash-recovery";

export type RecoveryWriteRequest = {type: "recovery:write"; expectedGeneration: number; snapshot: CrashRecoverySnapshot};
export type RecoveryCheckpointStatus = {state: "saved" | "saving" | "error"; generation: number;
  offeredSeq: number; savedSeq: number; error?: string};
type Offered = {seq: number; snapshot: CrashRecoverySnapshot};
type Attempt = Offered & {expectedGeneration: number};
type Waiter = {target: number; resolve: () => void; reject: (error: Error) => void};

/** One queue per renderer lifetime, initialized from recovery:read. offer captures
 * synchronously; only unsent snapshots coalesce. A failed attempt stays immutable
 * so an explicit retry can recover a lost write ACK before advancing the CAS. */
export class RecoveryCheckpoint {
  private generation: number;
  private offeredSeq = 0;
  private savedSeq = 0;
  private latestContent?: string;
  private pending?: Offered;
  private failed?: Attempt;
  private error?: Error;
  private running?: Promise<void>;
  private scheduled = false;
  private waiters: Waiter[] = [];
  constructor(private readonly write: (request: RecoveryWriteRequest) => Promise<unknown>, initialGeneration: number,
    private readonly onChange?: (status: RecoveryCheckpointStatus) => void,
    private readonly options: {timeoutMs?: number} = {}) {
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 0) throw new Error("Invalid initial recovery generation");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error("Invalid recovery timeout");
    this.generation = initialGeneration;
  }
  getStatus(): RecoveryCheckpointStatus {
    return {state: this.error ? "error" : this.savedSeq < this.offeredSeq ? "saving" : "saved",
      generation: this.generation, offeredSeq: this.offeredSeq, savedSeq: this.savedSeq,
      ...(this.error ? {error: this.error.message} : {})};
  }
  offer(snapshot: CrashRecoverySnapshot): number {
    // Validation clones immediately, before any await or caller mutation.
    const captured = validateCrashRecoverySnapshot(snapshot);
    const content = canonicalOperation(captured);
    if (content === this.latestContent) return this.offeredSeq;
    if (this.offeredSeq === Number.MAX_SAFE_INTEGER) throw new Error("Recovery input generation exhausted");
    const seq = ++this.offeredSeq;
    this.latestContent = content;
    this.pending = {seq, snapshot: captured};
    this.notify(); this.schedule();
    return seq;
  }
  /** Wait for all input offered before this call. Later input may be coalesced
   * into the same checkpoint, but cannot make an earlier durable ACK premature. */
  flush(): Promise<void> {
    const target = this.offeredSeq;
    if (this.savedSeq >= target) return Promise.resolve();
    if (this.error) return Promise.reject(this.error);
    const result = new Promise<void>((resolve, reject) => {this.waiters.push({target, resolve, reject});});
    this.schedule();
    return result;
  }
  /** A user-triggered retry repeats the exact failed journal write first. This
   * does not retry any application mutation stored inside the snapshot. */
  retry(): Promise<void> {
    if (this.error) {this.error = undefined; this.notify(); this.schedule();}
    return this.flush();
  }
  private notify() {
    // A display observer cannot break persistence or create an unhandled reject.
    try {this.onChange?.(this.getStatus());} catch { /* status remains available via getStatus */ }
  }
  private settle() {
    const waiting = this.waiters; this.waiters = [];
    for (const waiter of waiting) {
      if (this.savedSeq >= waiter.target) waiter.resolve();
      else if (this.error) waiter.reject(this.error);
      else this.waiters.push(waiter);
    }
  }
  private schedule() {
    if (this.scheduled || this.running || this.error || (!this.pending && !this.failed)) return;
    this.scheduled = true;
    queueMicrotask(() => {this.scheduled = false; this.start();});
  }
  private start() {
    if (this.running || this.error) return;
    const run = async () => {
      while (!this.error && (this.failed || this.pending)) {
        const attempt = this.failed ?? {...this.pending!, expectedGeneration: this.generation};
        if (!this.failed) this.pending = undefined;
        try {
          if (attempt.expectedGeneration >= Number.MAX_SAFE_INTEGER) throw new Error("Recovery generation exhausted");
          const result = await this.exchange(attempt);
          if (result.status !== "ready" || result.generation !== attempt.expectedGeneration + 1 || !result.snapshot ||
            canonicalOperation(validateCrashRecoverySnapshot(result.snapshot)) !== canonicalOperation(attempt.snapshot))
            throw new Error(result.message ?? "Recovery write ACK differs; checkpoint retained for explicit retry");
          this.generation = result.generation;
          this.savedSeq = attempt.seq;
          this.failed = undefined;
          this.notify(); this.settle();
        } catch (error) {
          this.failed = attempt;
          this.error = error instanceof Error ? error : new Error(String(error));
          this.notify(); this.settle();
        }
      }
    };
    this.running = run().finally(() => {this.running = undefined; this.schedule();});
  }
  private async exchange(attempt: Attempt): Promise<CrashRecoveryRead> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.write({type: "recovery:write", expectedGeneration: attempt.expectedGeneration, snapshot: structuredClone(attempt.snapshot)}),
        new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("Recovery write ACK timed out; checkpoint retained")), this.options.timeoutMs ?? 15000);}),
      ]);
      if (!result || typeof result !== "object") throw new Error("Invalid recovery write ACK");
      return result as CrashRecoveryRead;
    } finally {if (timer !== undefined) clearTimeout(timer);}
  }
}
