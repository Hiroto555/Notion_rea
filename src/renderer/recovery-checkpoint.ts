import { canonicalOperation } from "../shared/save-contract";
import {
  CHECKPOINT_OBSERVATION_MAX_EVENTS,
  CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_BYTES,
  CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_TOTAL_BYTES,
  CHECKPOINT_OBSERVATION_SCHEMA,
  utf8Length,
  type CheckpointObservationEvent,
  type CheckpointObservationReport,
  type CheckpointObservationStatus,
} from "../shared/checkpoint-observation";
import { validateCrashRecoverySnapshot, type CrashRecoveryRead, type CrashRecoverySnapshot } from "../shared/crash-recovery";
import type { StorageFailureV1 } from "../shared/private-storage-failure";
import {
  requestStorageFailure,
  StorageFailureError,
  toStorageFailureError,
  unclassifiedRequestFailure,
} from "./private-request";

export type RecoveryWriteRequest = {type: "recovery:write"; expectedGeneration: number; snapshot: CrashRecoverySnapshot};
export type RecoveryCheckpointStatus = {state: "saved" | "saving" | "error"; generation: number;
  offeredSeq: number; savedSeq: number; error?: string; storageFailure?: StorageFailureV1};
type Offered = {seq: number; snapshot: CrashRecoverySnapshot};
type Attempt = Offered & {expectedGeneration: number};
type Waiter = {target: number; resolve: () => void; reject: (error: Error) => void};

/** One queue per renderer lifetime, initialized from recovery:read. offer captures
 * synchronously; only unsent snapshots coalesce. A failed attempt stays immutable
 * so an explicit retry can recover a lost write ACK before advancing the CAS.
 * With diagnostics:'v1' every latched error carries a validated bounded
 * recovery:write diagnostic and retry holds instead of resending: no new
 * request, no clear, no reschedule, and a late ACK cannot apply or resume. */
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
  private readonly diagnostics?: "v1";
  private readonly testObservation?: "v1";
  private observationEvents?: CheckpointObservationEvent[];
  private observationIncomplete = false;
  private observationCaptureStopped = false;
  private observationSnapshotBytes = 0;
  constructor(private readonly write: (request: RecoveryWriteRequest) => Promise<unknown>, initialGeneration: number,
    private readonly onChange?: (status: RecoveryCheckpointStatus) => void,
    private readonly options: {timeoutMs?: number; diagnostics?: "v1"; testObservation?: "v1"} = {}) {
    if (options.diagnostics !== undefined && options.diagnostics !== "v1") throw new Error("Invalid recovery diagnostics");
    this.diagnostics = options.diagnostics;
    // A v1 queue cannot be constructed invalid, but its refusal still carries
    // the bounded recovery:write diagnostic instead of a raw message.
    const refused = () => this.diagnostics === "v1" ?
      new StorageFailureError(unclassifiedRequestFailure("recovery:write")) : undefined;
    // A non-literal observation option disables observation only; the queue
    // still validates its generation/timeout and saves normally.
    this.testObservation = options.testObservation === "v1" ? "v1" : undefined;
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 0) throw refused() ?? new Error("Invalid initial recovery generation");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw refused() ?? new Error("Invalid recovery timeout");
    this.generation = initialGeneration;
    if (this.testObservation === "v1") {
      this.observationEvents = [];
      this.recordObservation("INIT", {generation: initialGeneration});
    }
  }
  getStatus(): RecoveryCheckpointStatus {
    const failure = this.error && this.diagnostics === "v1" ?
      requestStorageFailure(this.error, "recovery:write") : undefined;
    return {state: this.error ? "error" : this.savedSeq < this.offeredSeq ? "saving" : "saved",
      generation: this.generation, offeredSeq: this.offeredSeq, savedSeq: this.savedSeq,
      ...(this.error ? {error: this.error.message} : {}),
      ...(failure ? {storageFailure: failure} : {})};
  }
  offer(snapshot: CrashRecoverySnapshot): number {
    // Validation clones immediately, before any await or caller mutation. A
    // local capture failure in v1 latches and rethrows the held failure, so
    // the barrier holds: pending input, generation and sequences stay as they
    // were and no scheduled write can dispatch past the latch.
    try {
      const captured = validateCrashRecoverySnapshot(snapshot);
      const content = canonicalOperation(captured);
      if (content === this.latestContent) return this.offeredSeq;
      if (this.offeredSeq === Number.MAX_SAFE_INTEGER) throw new Error("Recovery input generation exhausted");
      const seq = ++this.offeredSeq;
      this.latestContent = content;
      this.pending = {seq, snapshot: captured};
      this.recordObservation("OFFERED", {seq, snapshot: captured});
      this.notify(); this.schedule();
      return seq;
    } catch (error) {
      if (this.diagnostics !== "v1") throw error;
      this.captureFailure(error);
      throw this.error!;
    }
  }
  /** Latch a failure raised before offer could capture its input (a capture
   * construction error or one caught from offer itself). In v1 mode the held
   * error carries the bounded local diagnostic so the barrier and every retry
   * path hold identically to a failed write; generation, savedSeq, pending
   * input and an immutable failed attempt all stay as they were. */
  captureFailure(error: unknown) {
    this.latch(error);
    this.notify(); this.settle();
  }
  /** Wait for all input offered before this call. Later input may be coalesced
   * into the same checkpoint, but cannot make an earlier durable ACK premature.
   * In v1 mode a latched failure rejects even when every offered input is
   * already saved; legacy keeps the original resolve-first order. */
  flush(): Promise<void> {
    const target = this.offeredSeq;
    if (this.diagnostics === "v1" && this.error) return Promise.reject(this.error);
    if (this.savedSeq >= target) return Promise.resolve();
    if (this.error) return Promise.reject(this.error);
    const result = new Promise<void>((resolve, reject) => {this.waiters.push({target, resolve, reject});});
    this.schedule();
    return result;
  }
  /** A user-triggered retry repeats the exact failed journal write first. This
   * does not retry any application mutation stored inside the snapshot. In v1
   * mode a latched failure is retained: retry rejects with it, sends no new
   * request and never clears or reschedules the failed attempt. */
  retry(): Promise<void> {
    if (this.error) {
      if (this.diagnostics === "v1") return Promise.reject(this.error);
      this.error = undefined; this.notify(); this.schedule();
    }
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
  private latch(error: unknown) {
    // The first retained failure is canonical: a later capture, reject, timer
    // or late-ACK failure can neither clear nor reclassify it. v1 never stores
    // a raw error: a validated recovery:write diagnostic is preserved,
    // anything else becomes the local UNCLASSIFIED failure that carries only
    // the bounded DTO and the fixed safe message.
    if (this.error) return;
    this.error = this.diagnostics === "v1" ? toStorageFailureError(error, "recovery:write") :
      error instanceof Error ? error : new Error(String(error));
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
          // A failure latched while the write was in flight cannot be undone
          // by its late ACK: keep the retained attempt and the held error.
          if (this.error) this.failed = attempt;
          else {
            if (result.status !== "ready" || result.generation !== attempt.expectedGeneration + 1 || !result.snapshot ||
              canonicalOperation(validateCrashRecoverySnapshot(result.snapshot)) !== canonicalOperation(attempt.snapshot))
              throw new Error(result.message ?? "Recovery write ACK differs; checkpoint retained for explicit retry");
            this.generation = result.generation;
            this.savedSeq = attempt.seq;
            this.failed = undefined;
            this.recordObservation("ACK_APPLIED", {seq: attempt.seq, generation: result.generation, snapshot: attempt.snapshot});
          }
          this.notify(); this.settle();
        } catch (error) {
          this.failed = attempt;
          this.latch(error);
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
  /** Passive observation capture, populated only when testObservation:'v1' was
   * enabled. Canonical serialize, UTF-8 accounting and append all stay inside
   * this isolated helper: any failure or fixed-budget overflow keeps the
   * recorded prefix, marks the log sticky incomplete and stops further capture
   * while saving and ACK handling continue unchanged. No reset/clear exists. */
  private recordObservation(type: "INIT" | "OFFERED" | "ACK_APPLIED",
    fields: {seq?: number; generation?: number; snapshot?: CrashRecoverySnapshot}) {
    const events = this.observationEvents;
    if (this.testObservation !== "v1" || !events || this.observationIncomplete) return;
    try {
      if (events.length >= CHECKPOINT_OBSERVATION_MAX_EVENTS) throw new Error("observation event budget");
      let snapshotJson: string | null = null;
      if (fields.snapshot !== undefined) {
        snapshotJson = canonicalOperation(fields.snapshot);
        const bytes = utf8Length(snapshotJson);
        if (bytes > CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_BYTES ||
          this.observationSnapshotBytes + bytes > CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_TOTAL_BYTES)
          throw new Error("observation snapshot budget");
        this.observationSnapshotBytes += bytes;
      }
      const index = events.length;
      if (type === "INIT") events.push({index, type, generation: fields.generation ?? 0, snapshotJson: null});
      else if (type === "OFFERED") events.push({index, type, seq: fields.seq ?? 0, snapshotJson: snapshotJson ?? ""});
      else events.push({index, type, seq: fields.seq ?? 0, generation: fields.generation ?? 0, snapshotJson: snapshotJson ?? ""});
    } catch {
      this.observationIncomplete = true;
      this.observationCaptureStopped = true;
    }
  }
  /** Read-only detached observation for the explicit test gate. Returns null
   * unless testObservation:'v1' was enabled; status is the CURRENT getStatus()
   * so a post-ACK error is never hidden. Never calls offer/flush/retry/write. */
  getTestObservation(): CheckpointObservationReport | null {
    if (this.testObservation !== "v1") return null;
    const detach = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    let status: CheckpointObservationStatus | null = null;
    try {status = detach(this.getStatus());} catch {status = null;}
    return detach({
      schema: CHECKPOINT_OBSERVATION_SCHEMA,
      events: this.observationEvents ?? [],
      incomplete: this.observationIncomplete,
      captureStopped: this.observationCaptureStopped,
      status,
    });
  }
}
