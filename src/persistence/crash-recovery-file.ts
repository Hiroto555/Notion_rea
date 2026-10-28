import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalOperation } from "../shared/save-contract";
import { CRASH_RECOVERY_MAX_BYTES, validateCrashRecoverySnapshot, type CrashRecoveryRead, type CrashRecoverySnapshot } from "../shared/crash-recovery";
import type { Store } from "./store";

const FORMAT = "folio-crash-recovery-v1", identityKey = "folio.recovery.workspaceId";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const digest = (value: unknown) => createHash("sha256").update(canonicalOperation(value)).digest("hex");
type Envelope = {format: typeof FORMAT; workspaceId: string; generation: number; snapshot: CrashRecoverySnapshot; checksum: string};
type FileOperations = Pick<typeof fs, "openSync" | "closeSync" | "readFileSync" | "writeFileSync" | "fsyncSync" | "renameSync" | "lstatSync" | "realpathSync" | "fstatSync">;

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

/** One main-process owner, inside the workspace directory. Input is acknowledged
 * only after file fsync, atomic rename, readback and directory fsync. This is a
 * process-crash checkpoint, not a claim about every device's power-loss behavior.
 * Failed staging files are retained, never treated as an acknowledged checkpoint. */
export class CrashRecoveryFile {
  readonly path: string;
  private readonly ops: FileOperations;
  constructor(path: string, readonly workspaceId: string, options: {operations?: Partial<FileOperations>} = {}) {
    if (!isAbsolute(path) || path.includes("\0") || !identifier(workspaceId)) throw new Error("Invalid recovery location or workspace identity");
    this.path = resolve(path); this.ops = {...fs, ...options.operations};
    this.directory();
  }
  private directory() {
    const parent = dirname(this.path), stat = this.ops.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || this.ops.realpathSync(parent) !== parent) throw new Error("Recovery directory is not canonical");
    return stat;
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
    const envelope = JSON.parse(content) as Envelope;
    if (canonicalOperation(envelope) !== content || Object.keys(envelope).sort().join() !== "checksum,format,generation,snapshot,workspaceId" ||
      envelope.format !== FORMAT || envelope.workspaceId !== this.workspaceId || !Number.isSafeInteger(envelope.generation) || envelope.generation <= 0)
      throw new Error("Recovery format, generation or workspace does not match");
    const {checksum, ...body} = envelope;
    if (checksum !== digest(body)) throw new Error("Recovery checksum does not match");
    validateCrashRecoverySnapshot(envelope.snapshot);
    return envelope;
  }
  read(): CrashRecoveryRead {
    try {
      const envelope = this.readEnvelope();
      return envelope ? {status: "ready", generation: envelope.generation, snapshot: structuredClone(envelope.snapshot)} : {status: "empty", generation: 0};
    } catch (error) {
      return {status: "blocked", generation: 0, message: error instanceof Error ? error.message : String(error)};
    }
  }
  write(expectedGeneration: number, input: CrashRecoverySnapshot): CrashRecoveryRead {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || expectedGeneration >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid recovery generation");
    const snapshot = validateCrashRecoverySnapshot(input);
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
  private syncPublished() {
    const fd = this.ops.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {this.ops.fsyncSync(fd);} finally {this.ops.closeSync(fd);}
    const parent = this.ops.openSync(dirname(this.path), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    try {this.ops.fsyncSync(parent);} finally {this.ops.closeSync(parent);}
  }
}
