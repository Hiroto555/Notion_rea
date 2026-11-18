import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { types } from "node:util";
import { canonicalOperation } from "../shared/save-contract";
import { CRASH_RECOVERY_MAX_BYTES, validateCrashRecoverySnapshot, type CrashRecoveryRead, type CrashRecoverySnapshot } from "../shared/crash-recovery";
import { selectPrivateFilePlatform, PrivateFilePublicationUnknownError } from "../platform/private-file-port";
import { getCheckpointGenerationConflict, getCheckpointPriorPending, propagateCheckpointGenerationConflict, propagateCheckpointPriorPending, recordCheckpointGenerationConflict, type CheckpointGenerationConflict, type CheckpointPostPublicationUnknown, type CheckpointPriorPending } from "../platform/private-mutation-diagnostic";
import { armRecoveryPortObservation, consumeRecoveryPortObservation, isRegisteredRecoveryFilePort, type CrashRecoveryNativePort, type CrashRecoveryNativeRead, type RecoveryPortPublication, type RecoveryPortRecoveryIoFailure } from "../platform/windows/recovery-file-port";
import type { Store } from "./store";

const FORMAT = "folio-crash-recovery-v1", identityKey = "folio.recovery.workspaceId";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const ATTEMPT_TOKEN = /^[0-9a-f]{32}$/;
const digest = (value: unknown) => createHash("sha256").update(canonicalOperation(value)).digest("hex");
type Envelope = {format: typeof FORMAT; workspaceId: string; generation: number; snapshot: CrashRecoverySnapshot; checksum: string};
type FileOperations = Pick<typeof fs, "openSync" | "closeSync" | "readFileSync" | "writeFileSync" | "fsyncSync" | "renameSync" | "lstatSync" | "realpathSync" | "fstatSync">;
export type RecoveryWriteObservation =
  | Readonly<{terminal: "RETURNED"; value: CrashRecoveryRead}>
  | Readonly<{
      terminal: "THREW";
      value: unknown;
      postPublication?: CheckpointPostPublicationUnknown;
      generationConflict?: CheckpointGenerationConflict;
      priorPending?: CheckpointPriorPending;
      recoveryIoFailure?: RecoveryPortRecoveryIoFailure;
    }>;
type RecoveryWriteFacts = {
  publication?: RecoveryPortPublication;
  generationConflict?: CheckpointGenerationConflict;
  recoveryIoFailure?: RecoveryPortRecoveryIoFailure;
};
type CrashRecoveryReadFailure = Readonly<{
  error: unknown;
  priorPending: CheckpointPriorPending | undefined;
}>;
const READ_FAILURES = new WeakMap<object, CrashRecoveryReadFailure>();
/** Exact-identity sidecar for a blocked read result: the original failure and
 * its prior-attempt pending fact stay reachable for Main.observe. Not a
 * classifier, clone or wire DTO. */
export function getCrashRecoveryReadFailure(value: unknown): CrashRecoveryReadFailure | undefined {
  return typeof value === "object" && value !== null ? READ_FAILURES.get(value) : undefined;
}

/** Stored with SQLite, so a journal from an unrelated workspace cannot be applied by filename alone. */
export function crashRecoveryWorkspaceId(store: Store): string {
  return store.transaction(() => {
    const row = store.db.prepare("SELECT value FROM settings WHERE key=?").get(identityKey) as {value: string} | undefined;
    if (row) {if (!identifier(row.value)) throw new Error("Invalid recovery workspace identity"); return row.value;}
    const id = randomUUID();
    store.db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(identityKey, id);
    return id;
  });
}

function assertNativePort(port: unknown): asserts port is CrashRecoveryNativePort {
  const candidate = port as CrashRecoveryNativePort;
  if (!candidate || typeof candidate !== "object" || candidate.contractVersion !== 3 ||
      candidate.platform !== "win32" ||
      typeof candidate.read !== "function" || typeof candidate.compareAndSwap !== "function" ||
      types.isAsyncFunction(candidate.read) || types.isGeneratorFunction(candidate.read) ||
      types.isAsyncFunction(candidate.compareAndSwap) || types.isGeneratorFunction(candidate.compareAndSwap))
    throw new Error("A synchronous Windows recovery native port is required");
}

/** One main-process owner, inside the workspace directory. Input is acknowledged
 * only after file fsync, atomic rename, readback and directory fsync. This is a
 * process-crash checkpoint, not a claim about every device's power-loss behavior.
 * Failed staging files are retained, never treated as an acknowledged checkpoint.
 *
 * On Windows an explicit CrashRecoveryNativePort replaces every fs operation:
 * immutable generation files, a durable CAS pointer and pinned native identity/
 * hash proof, never a POSIX rename emulation. */
export class CrashRecoveryFile {
  readonly path: string;
  private readonly ops: FileOperations;
  private readonly platform: "posix" | "win32";
  private readonly nativePort: CrashRecoveryNativePort | undefined;
  constructor(
    path: string,
    readonly workspaceId: string,
    options: {operations?: Partial<FileOperations>; platform?: NodeJS.Platform; nativePort?: CrashRecoveryNativePort} = {},
  ) {
    this.platform = selectPrivateFilePlatform(options.platform);
    if (!identifier(workspaceId) || path.includes("\0")) throw new Error("Invalid recovery location or workspace identity");
    if (this.platform === "win32") {
      if (!win32.isAbsolute(path)) throw new Error("Invalid recovery location or workspace identity");
      this.path = win32.resolve(path);
      if (options.nativePort === undefined) throw new Error("Windows recovery requires a native port; POSIX fs emulation is not durability proof");
      assertNativePort(options.nativePort);
      this.nativePort = options.nativePort;
      this.ops = {...fs, ...options.operations}; // Retained for type shape only; never invoked on this branch.
      return;
    }
    if (options.nativePort !== undefined) throw new Error("A Windows recovery native port cannot serve a POSIX path");
    if (!isAbsolute(path)) throw new Error("Invalid recovery location or workspace identity");
    this.path = resolve(path); this.ops = {...fs, ...options.operations};
    this.directory();
  }
  private directory() {
    const parent = dirname(this.path), stat = this.ops.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || this.ops.realpathSync(parent) !== parent) throw new Error("Recovery directory is not canonical");
    return stat;
  }
  /** Canonical envelope validation shared by the POSIX file path and the
   * Windows native-port byte path. */
  private decodeEnvelope(content: string): Envelope {
    const envelope = JSON.parse(content) as Envelope;
    if (canonicalOperation(envelope) !== content || Object.keys(envelope).sort().join() !== "checksum,format,generation,snapshot,workspaceId" ||
      envelope.format !== FORMAT || envelope.workspaceId !== this.workspaceId || !Number.isSafeInteger(envelope.generation) || envelope.generation <= 0)
      throw new Error("Recovery format, generation or workspace does not match");
    const {checksum, ...body} = envelope;
    if (checksum !== digest(body)) throw new Error("Recovery checksum does not match");
    validateCrashRecoverySnapshot(envelope.snapshot);
    return envelope;
  }
  private decodeNativeRead(read: CrashRecoveryNativeRead): {envelope: Envelope; token: string; bytes: Uint8Array} {
    const bytes = read.bytes instanceof Uint8Array ? read.bytes : undefined;
    if (!bytes || bytes.byteLength > CRASH_RECOVERY_MAX_BYTES + 4096) throw new Error("Invalid or oversized recovery file");
    const content = Buffer.from(bytes).toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Invalid recovery UTF-8");
    const envelope = this.decodeEnvelope(content);
    if (envelope.generation !== read.generation) throw new Error("Recovery generation does not match the native pointer");
    return {envelope, token: read.token, bytes: Uint8Array.from(bytes)};
  }
  private readNative(): {envelope: Envelope; token: string; bytes: Uint8Array} | undefined {
    const outcome: unknown = this.nativePort!.read(this.path, this.workspaceId);
    if (types.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
    if (outcome === undefined) return undefined;
    if (outcome === null || typeof outcome !== "object" ||
        typeof (outcome as {then?: unknown}).then === "function")
      throw new Error("Malformed native recovery read");
    const read = outcome as CrashRecoveryNativeRead;
    if (!Number.isSafeInteger(read.generation) || read.generation <= 0 ||
        typeof read.token !== "string" || !ATTEMPT_TOKEN.test(read.token))
      throw new Error("Malformed native recovery read");
    return this.decodeNativeRead(read);
  }
  private readEnvelope(): Envelope | undefined {
    this.directory();
    let stat: fs.Stats;
    try {stat = this.ops.lstatSync(this.path);} catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error;}
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CRASH_RECOVERY_MAX_BYTES + 4096) throw new Error("Invalid or oversized recovery file");
    const fd = this.ops.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let content: string;
    try {
      const byFd = this.ops.fstatSync(fd);
      if (!byFd.isFile() || byFd.dev !== stat.dev || byFd.ino !== stat.ino || byFd.size !== stat.size) throw new Error("Recovery identity changed");
      const bytes = this.ops.readFileSync(fd);
      content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Invalid recovery UTF-8");
    } finally {this.ops.closeSync(fd);}
    return this.decodeEnvelope(content);
  }
  private current(): {generation: number; envelope?: Envelope; token?: string; bytes?: Uint8Array} {
    if (this.platform === "win32") {
      const read = this.readNative();
      return read ? {generation: read.envelope.generation, envelope: read.envelope, token: read.token, bytes: read.bytes} : {generation: 0};
    }
    const envelope = this.readEnvelope();
    return {generation: envelope?.generation ?? 0, envelope};
  }
  read(): CrashRecoveryRead {
    try {
      const current = this.current();
      return current.envelope ? {status: "ready", generation: current.envelope.generation, snapshot: structuredClone(current.envelope.snapshot)} : {status: "empty", generation: 0};
    } catch (error) {
      let message = "Crash recovery read is blocked; original failure retained";
      try {
        const legacy = error instanceof Error ? error.message : String(error);
        if (typeof legacy === "string") message = legacy;
      } catch { /* a throwing message accessor keeps the stable blocked text */ }
      const result: CrashRecoveryRead = {status: "blocked", generation: 0, message};
      READ_FAILURES.set(result, Object.freeze({error, priorPending: getCheckpointPriorPending(error)}));
      return result;
    }
  }
  write(expectedGeneration: number, input: CrashRecoverySnapshot): CrashRecoveryRead {
    return this.writeCore(expectedGeneration, input);
  }
  writeObserved(expectedGeneration: number, input: CrashRecoverySnapshot): RecoveryWriteObservation {
    const record: RecoveryWriteFacts = {};
    try {
      const value = this.writeCore(expectedGeneration, input, record);
      const observation: RecoveryWriteObservation = {terminal: "RETURNED", value};
      return Object.freeze(observation);
    } catch (error) {
      const publication = record.publication;
      const postPublication: CheckpointPostPublicationUnknown | undefined = publication === undefined ? undefined : Object.freeze({
        kind: "OUTCOME_UNKNOWN",
        family: "CHECKPOINT",
        stage: publication.stage,
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "DISPATCHED",
        proofOrigin: "DISPATCH_OBSERVED",
        attemptId: publication.attemptId,
        sourceOutcome: publication.sourceOutcome,
      });
      const generationConflict = postPublication === undefined ? record.generationConflict : undefined;
      const priorPending = postPublication === undefined ? getCheckpointPriorPending(error) : undefined;
      const recoveryIoFailure = postPublication === undefined ? record.recoveryIoFailure : undefined;
      const observation: RecoveryWriteObservation = {
        terminal: "THREW",
        value: error,
        ...(postPublication !== undefined ? {postPublication} : {}),
        ...(generationConflict !== undefined ? {generationConflict} : {}),
        ...(priorPending !== undefined ? {priorPending} : {}),
        ...(recoveryIoFailure !== undefined ? {recoveryIoFailure} : {}),
      };
      return Object.freeze(observation);
    }
  }
  private writeCore(expectedGeneration: number, input: CrashRecoverySnapshot, record?: RecoveryWriteFacts): CrashRecoveryRead {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || expectedGeneration >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid recovery generation");
    const snapshot = validateCrashRecoverySnapshot(input);
    if (this.platform === "win32") return this.writeNative(expectedGeneration, snapshot, record);
    // A corrupt/foreign checkpoint is never replaced. A thrown read does not mean absent.
    const prior = this.readEnvelope(), actual = prior?.generation ?? 0;
    if (actual !== expectedGeneration) {
      if (actual === expectedGeneration + 1 && canonicalOperation(prior!.snapshot) === canonicalOperation(snapshot)) {
        this.syncPublished(); // Recover an ACK lost after publication, without advancing the generation twice.
        return {status: "ready", generation: actual, snapshot: structuredClone(snapshot)};
      }
      throw new Error("Recovery generation changed; checkpoint retained");
    }
    const body = {format: FORMAT, workspaceId: this.workspaceId, generation: actual + 1, snapshot};
    const content = canonicalOperation({...body, checksum: digest(body)});
    const staging = this.path + ".stage-" + randomUUID();
    const directory = this.directory();
    const fd = this.ops.openSync(staging, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      this.ops.writeFileSync(fd, content, "utf8"); this.ops.fsyncSync(fd);
      // Reopen for readback; writes have advanced the original descriptor offset.
      const check = this.ops.openSync(staging, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {if (this.ops.readFileSync(check, "utf8") !== content) throw new Error("Recovery staging readback differs");}
      finally {this.ops.closeSync(check);}
    } finally {this.ops.closeSync(fd);}
    const nowDirectory = this.directory();
    if (directory.dev !== nowDirectory.dev || directory.ino !== nowDirectory.ino) throw new Error("Recovery directory changed");
    const latest = this.readEnvelope();
    if ((latest?.generation ?? 0) !== actual || canonicalOperation(latest ?? null) !== canonicalOperation(prior ?? null)) throw new Error("Recovery changed before publication");
    this.ops.renameSync(staging, this.path);
    const written = this.readEnvelope();
    if (!written || written.generation !== actual + 1 || canonicalOperation(written.snapshot) !== canonicalOperation(snapshot)) throw new Error("Recovery published readback differs");
    this.syncPublished();
    return {status: "ready", generation: written.generation, snapshot: structuredClone(written.snapshot)};
  }
  /** Windows immutable-generation CAS: never a rename over the logical name,
   * never a resend of an unresolved attempt, never POSIX fsync emulation. */
  private writeNative(expectedGeneration: number, snapshot: CrashRecoverySnapshot, record?: RecoveryWriteFacts): CrashRecoveryRead {
    const prior = this.readNative(), actual = prior?.envelope.generation ?? 0;
    if (actual !== expectedGeneration) {
      // A previously published identical snapshot is reported without any
      // resend — sound ONLY because the concrete port's read requires the
      // APPLIED pointer proof, so a native-only PUBLISHED can never be
      // silently adopted here; anything else is a deterministic conflict.
      if (actual === expectedGeneration + 1 && canonicalOperation(prior!.envelope.snapshot) === canonicalOperation(snapshot))
        return {status: "ready", generation: actual, snapshot: structuredClone(snapshot)};
      const conflict = new Error("Recovery generation changed; checkpoint retained");
      recordCheckpointGenerationConflict(conflict, expectedGeneration, actual);
      if (record !== undefined) record.generationConflict = getCheckpointGenerationConflict(conflict);
      throw conflict;
    }
    const body = {format: FORMAT, workspaceId: this.workspaceId, generation: actual + 1, snapshot};
    const content = canonicalOperation({...body, checksum: digest(body)});
    const bytes = Buffer.from(content, "utf8");
    let outcome: unknown;
    try {
      const port = this.nativePort!;
      if (record !== undefined && isRegisteredRecoveryFilePort(port)) {
        const method = port.compareAndSwap;
        const request = {
          path: this.path,
          workspaceId: this.workspaceId,
          expected: prior === undefined ? undefined : {generation: prior.envelope.generation, token: prior.token, bytes: prior.bytes},
          generation: actual + 1,
          bytes: Uint8Array.from(bytes),
        };
        const handle = armRecoveryPortObservation(port, request);
        try {
          const returned: unknown = Reflect.apply(method, port, [request]);
          const observed = consumeRecoveryPortObservation(handle, "RETURNED", returned);
          outcome = returned;
          if (observed.matched) {
            if (observed.publication !== undefined) record.publication = observed.publication;
            if (observed.generationConflict !== undefined) record.generationConflict = observed.generationConflict;
            if (observed.recoveryIoFailure !== undefined) record.recoveryIoFailure = observed.recoveryIoFailure;
          }
        } catch (terminal) {
          const observed = consumeRecoveryPortObservation(handle, "THREW", terminal);
          if (observed.matched) {
            if (observed.publication !== undefined) record.publication = observed.publication;
            if (observed.generationConflict !== undefined) record.generationConflict = observed.generationConflict;
            if (observed.recoveryIoFailure !== undefined) record.recoveryIoFailure = observed.recoveryIoFailure;
          }
          throw terminal;
        }
      } else {
        outcome = this.nativePort!.compareAndSwap({
          path: this.path,
          workspaceId: this.workspaceId,
          expected: prior === undefined ? undefined : {generation: prior.envelope.generation, token: prior.token, bytes: prior.bytes},
          generation: actual + 1,
          bytes: Uint8Array.from(bytes),
        });
      }
    } catch (cause) {
      // Publication or pointer uncertainty is retained upstream; keep the
      // typed UNKNOWN so callers can inspect its result, never reduce it to
      // a clean conflict that could invite a resend.
      if (cause instanceof PrivateFilePublicationUnknownError) throw cause;
      const unresolved = new PrivateFilePublicationUnknownError(
        "Recovery publication is unresolved; artifacts retained",
        this.path, this.path, undefined, cause);
      propagateCheckpointGenerationConflict(unresolved, cause);
      propagateCheckpointPriorPending(unresolved, cause);
      throw unresolved;
    }
    if (types.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
    if (outcome === null || typeof outcome !== "object" || typeof (outcome as {then?: unknown}).then === "function")
      throw new Error("Recovery publication is unresolved; artifacts retained");
    const result = outcome as CrashRecoveryNativeRead;
    if (!Number.isSafeInteger(result.generation) || result.generation !== actual + 1 ||
        typeof result.token !== "string" || !ATTEMPT_TOKEN.test(result.token) ||
        !(result.bytes instanceof Uint8Array) || !Buffer.from(result.bytes).equals(bytes))
      throw new Error("Recovery published evidence differs; artifacts retained");
    const written = this.readNative();
    if (!written || written.envelope.generation !== actual + 1 || written.token !== result.token ||
        canonicalOperation(written.envelope.snapshot) !== canonicalOperation(snapshot) ||
        !Buffer.from(written.bytes).equals(bytes))
      throw new Error("Recovery published readback differs; artifacts retained");
    return {status: "ready", generation: written.envelope.generation, snapshot: structuredClone(written.envelope.snapshot)};
  }
  private syncPublished() {
    const fd = this.ops.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {this.ops.fsyncSync(fd);} finally {this.ops.closeSync(fd);}
    const parent = this.ops.openSync(dirname(this.path), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    try {this.ops.fsyncSync(parent);} finally {this.ops.closeSync(parent);}
  }
}
