import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { canonical } from "../../collaboration/runtime/canonical";
import { synchronousPrivatePlatform, type PrivatePlatform } from "../../sync/private-platform";
import { preflightExistingJournal } from "../../sync/journal-preflight";
import { SqliteConnectionOwner, closeSqlitePlatform } from "../../sync/sqlite-connection-owner";
import { SyncSqliteGuard } from "../../sync/sqlite-guard";
import { isAuthorityLeasePlatform } from "./authority-lease";
import { asciiCaseFold, assertWindowsProbe, validateWindowsPath, type WindowsProbeEvidence } from "./path-policy";
import type { NativePrivatePersistenceAuthority } from "./private-persistence";
import type { WindowsPrivateMaintenanceContext, WindowsPrivatePersistenceMaintenanceProof } from "./private-persistence-journal";
import type { NativePrivateFile } from "../private-persistence";

export type WindowsPrivateTransferMaintenanceProof = WindowsPrivatePersistenceMaintenanceProof & Readonly<{
  read(path: string, identity: NativePrivateFile, maxBytes: number): Uint8Array;
}>;

export type WindowsPrivateTransferInspection = Readonly<{
  attemptId: string; fingerprint: string; binding: string; metadata: string; resource: string;
  wire: Uint8Array; original: Uint8Array;
  captures: Readonly<{stdout?: Uint8Array; stderr?: Uint8Array; status?: Uint8Array}>;
  terminal: Readonly<{state: string; receipt: string}> | null; resolution: string | null;
}>;

export const WINDOWS_PRIVATE_TRANSFER_DATABASE = "private-transfer-v1.sqlite";
const DATA = 512 * 1024 * 1024, META = 8 * 1024 * 1024, VALUE = 64 * 1024;
const CHUNK = 1024 * 1024, HEADER = 8192, REPLY = 16 * 1024;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`WINDOWS_TRANSFER_JOURNAL_${reason}`);
}
function sync(fn: () => void): void {
  check(!types.isAsyncFunction(fn) && !types.isGeneratorFunction(fn), "ASYNC");
  const result: unknown = fn();
  if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
  check(result === undefined, "ACK");
}
function pathKey(value: unknown): string {
  check(typeof value === "string" && /^[A-Z]:\\[\x20-\x7e]*$/.test(value) && value.length <= 240 &&
    validateWindowsPath(value, value.slice(0, 3)).canonical === value, "PATH");
  return asciiCaseFold(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  check(Object.keys(value).sort().join(",") === [...expected].sort().join(","), "FIELDS");
}
function frame(bytes: Buffer, limit: number): {header: Record<string, unknown>; text: string; payload: Buffer} {
  check(bytes.length >= 4, "FRAME");
  const n = bytes.readUInt32LE(0);
  check(n > 0 && n <= limit && bytes.length >= n + 4, "FRAME");
  const text = bytes.subarray(4, n + 4).toString("ascii");
  check([...bytes.subarray(4, n + 4)].every(b => b >= 32 && b <= 126), "FRAME");
  const header = JSON.parse(text) as Record<string, unknown>;
  // Retain the original bytes; this check rejects duplicate keys/whitespace
  // normalization rather than silently translating another protocol.
  check(header && !Array.isArray(header) && JSON.stringify(header) === text, "FRAME");
  return {header, text, payload: bytes.subarray(n + 4)};
}

/** Dedicated APPEND v1 authority. No K v4 translation, replay, deletion, or
 * process-local substitute. An absent exact ACK holds the path after restart. */
export class WindowsPrivateTransferJournal implements NativePrivatePersistenceAuthority {
  readonly version = 1 as const;
  readonly independent = true as const;
  private readonly platform!: PrivatePlatform;
  private readonly owner: SqliteConnectionOwner;
  private readonly guard!: SyncSqliteGuard;
  private readonly path!: string;
  private readonly local = new Set<string>();
  private closing = false;
  private closed = false;
  private failed: unknown;
  constructor(directory: string, platform: PrivatePlatform, private readonly binding: string,
    private readonly current: () => void, forbiddenRoots: readonly string[]) {
    check(platform.kind === "windows" && (process.platform !== "win32" || isAuthorityLeasePlatform(platform)), "LEASE");
    check(binding.length > 0 && Buffer.byteLength(binding) <= VALUE && forbiddenRoots.length > 0, "BINDING");
    const folded = asciiCaseFold(directory).replace(/\\/g, "/").replace(/\/$/, "");
    for (const root of forbiddenRoots) {
      const other = asciiCaseFold(root).replace(/\\/g, "/").replace(/\/$/, "");
      check(folded !== other && !folded.startsWith(other + "/") && !other.startsWith(folded + "/"), "ROOT_OVERLAP");
    }
    let cleanupPlatform: PrivatePlatform = platform;
    this.owner = new SqliteConnectionOwner(() => closeSqlitePlatform(cleanupPlatform));
    try {
      this.platform = synchronousPrivatePlatform(platform);
      cleanupPlatform = this.platform;
      this.path = join(this.platform.bind(directory), WINDOWS_PRIVATE_TRANSFER_DATABASE);
      this.platform.createExclusive(this.path);
      this.platform.assertFile(this.path); this.platform.assertSidecars(this.path);
      const schema = (db: DatabaseSync) => {
        const names = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        check(names.length === 5 && names.every(r => r.type === "table" &&
          ["identity", "attempts", "blobs", "terminals", "releases"].includes(String(r.name))), "SCHEMA");
        const ids = db.prepare("SELECT * FROM identity").all();
        check(ids.length === 1 && ids[0].version === 1 && ids[0].protocol === "append-v1" && ids[0].binding === binding, "BINDING");
      };
      if (lstatSync(this.path).size > 0) preflightExistingJournal(this.path, () => {
        this.platform.assertRoot(); this.platform.assertFile(this.path); this.platform.assertSidecars(this.path);
      }, schema, this.platform, this.owner);
      const db = new DatabaseSync(this.path);
      this.owner.opened(db);
      const guard = this.owner.guarded(db); this.guard = guard;
      check(guard.db.prepare("PRAGMA page_size").get()?.page_size === 4096, "PAGE_SIZE");
      guard.db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=262144");
      guard.transaction(() => {
        if (guard!.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0) {
          this.platform.assertEmptyFile(this.path);
          guard!.db.exec("CREATE TABLE identity(version INTEGER,protocol TEXT,binding TEXT);" +
            "CREATE TABLE attempts(id TEXT PRIMARY KEY,target TEXT,resource TEXT,budget INTEGER,metadata TEXT);" +
            "CREATE TABLE blobs(id TEXT,kind TEXT,bytes BLOB,sha TEXT,PRIMARY KEY(id,kind));" +
            "CREATE TABLE terminals(id TEXT PRIMARY KEY,state TEXT,receipt TEXT);" +
            "CREATE TABLE releases(id TEXT PRIMARY KEY,unused INTEGER,receipt_sha TEXT)");
          guard!.db.prepare("INSERT INTO identity VALUES(1,'append-v1',?)").run(binding);
        } else schema(guard!.db);
      });
      this.assertCurrent();
      this.retainedCharge();
    } catch (error) {
      this.owner.fail(error);
    }
  }
  assertCurrent(): void {
    check(!this.closing && !this.closed && !this.failed, "UNAVAILABLE");
    this.platform.assertRoot(); this.platform.assertFile(this.path); this.platform.assertSidecars(this.path);
    this.guard.assertUsable(); sync(this.current);
    let physical = 0;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { physical += lstatSync(this.path + suffix).size; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    check(physical <= 1024 * 1024 * 1024, "PHYSICAL_CAPACITY");
  }
  private transaction(work: () => void): void {
    this.assertCurrent();
    try { this.guard.transaction(() => { this.assertCurrent(); work(); this.assertCurrent(); }); this.assertCurrent(); }
    catch (error) { this.failed = error; throw error; }
  }
  private put(id: string, kind: string, bytes: Uint8Array): void {
    this.guard.db.prepare("INSERT INTO blobs VALUES(?,?,?,?)").run(id, kind, bytes, hash(bytes));
  }
  private read(id: string, kind: string): Buffer {
    const row = this.guard.db.prepare("SELECT bytes,sha FROM blobs WHERE id=? AND kind=?").get(id, kind);
    check(row?.bytes instanceof Uint8Array && row.sha === hash(row.bytes), "BLOB");
    return Buffer.from(row.bytes);
  }
  private retainedCharge(resource?: string): {attempts: number; charge: number; metadataBytes: number} {
    const rows = this.guard.db.prepare("SELECT a.*,t.state,t.receipt,r.unused,r.receipt_sha FROM attempts a LEFT JOIN terminals t ON t.id=a.id LEFT JOIN releases r ON r.id=a.id").all();
    check(rows.length <= 64 && rows.length * 9 + 1 <= 4096, "CAPACITY");
    let charge = 0, metadataBytes = Buffer.byteLength(this.binding);
    for (const row of rows) {
      const id = String(row.id), budget = Number(row.budget), other = String(row.resource);
      check(Number.isSafeInteger(budget) && budget > 0 && budget <= DATA, "BUDGET");
      const observationRow = this.guard.db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='observation'").get(id);
      const observation = observationRow ? this.read(id, "observation").toString("utf8") : undefined;
      if (observation !== undefined) this.validateObservation(this.inspect(id));
      if (resource !== undefined && row.state !== "APPLIED" && observation === undefined)
        check(!(resource === other || resource.startsWith(other + "\\") || other.startsWith(resource + "\\")), "UNRESOLVED");
      const unused = row.unused === null ? 0 : Number(row.unused);
      const retained = Number(this.guard.db.prepare("SELECT sum(length(bytes)) AS n FROM blobs WHERE id=?").get(id)?.n);
      check(Number.isSafeInteger(retained) && retained >= 0 && retained <= budget &&
        Number.isSafeInteger(unused) && unused >= 0 && unused <= budget, "RELEASE");
      if (row.unused !== null) {
        if (observation === undefined) this.validateApplied(id, String(row.receipt));
        const receipt = observation ?? String(row.receipt);
        check((row.state === "APPLIED" || observation !== undefined) && row.receipt_sha === hash(receipt) &&
          budget - retained === unused, "RELEASE");
      }
      if (observation !== undefined || row.state === "APPLIED") check(row.unused !== null, "RELEASE");
      for (const text of [String(row.metadata), String(row.receipt ?? ""), observation ?? ""])
        check(Buffer.byteLength(text) <= VALUE, "METADATA_CAPACITY");
      const statusBytes = Number(this.guard.db.prepare("SELECT coalesce(sum(length(bytes)),0) AS n FROM blobs WHERE id=? AND kind='status'").get(id)?.n);
      check(statusBytes <= 4096, "METADATA_CAPACITY");
      metadataBytes += Buffer.byteLength(String(row.metadata)) + Buffer.byteLength(String(row.receipt ?? "")) +
        Buffer.byteLength(observation ?? "") + statusBytes + 1024;
      charge += budget - unused;
    }
    check(Number.isSafeInteger(charge) && charge <= DATA && metadataBytes <= META, "CAPACITY");
    return {attempts: rows.length, charge, metadataBytes};
  }
  reserve(intent: Parameters<NativePrivatePersistenceAuthority["reserve"]>[0]): void {
    check(/^[a-f0-9]{32}$/.test(intent.attemptId) && /^target:[a-f0-9]{64}$/.test(intent.targetKey), "INTENT");
    const wire = Buffer.from(intent.wire), original = Buffer.from(intent.payload);
    check(wire.length <= 4 + HEADER + CHUNK && original.length > 0 && original.length <= CHUNK, "WIRE");
    check(Number.isSafeInteger(intent.maxCaptureBytes) && intent.maxCaptureBytes >= 4 + REPLY &&
      intent.maxCaptureBytes <= 4 + REPLY + CHUNK, "CAPTURE_BOUND");
    const {header: h, payload} = frame(wire, HEADER), resource = pathKey(h.path);
    keys(h, ["attemptId", "byteLength", "contractVersion", "directoryFileId", "directoryVolumeId",
      "expectedSha256", "fileId", "maxBytes", "operation", "path", "payloadSha256", "root", "rootFileId", "rootVolumeId", "volumeId"]);
    check(h.contractVersion === 1 && h.operation === "append" && h.attemptId === intent.attemptId &&
      payload.equals(original) && h.payloadSha256 === hash(original) &&
      Number.isSafeInteger(h.byteLength) && Number(h.byteLength) >= 0 &&
      Number.isSafeInteger(h.maxBytes) && Number(h.maxBytes) <= 20_000_000 &&
      Number(h.byteLength) + original.length <= Number(h.maxBytes), "PROTOCOL");
    pathKey(h.root);
    check(resource.startsWith(pathKey(h.root).replace(/\\$/, "") + "\\"), "ROOT");
    for (const field of ["fileId", "directoryFileId", "rootFileId"]) check(/^[a-fA-F0-9]{32}$/.test(String(h[field])), "ID");
    for (const field of ["volumeId", "directoryVolumeId", "rootVolumeId"]) check(/^[a-fA-F0-9]{16}$/.test(String(h[field])), "ID");
    check(/^[a-f0-9]{64}$/.test(String(h.expectedSha256)), "HASH");
    check(intent.targetKey === `target:${hash([h.rootVolumeId, h.rootFileId, h.directoryVolumeId, h.directoryFileId,
      win32.basename(String(h.path))].map(v => asciiCaseFold(String(v))).join("|"))}`, "TARGET");
    const metadata = JSON.stringify({wire: hash(wire), original: hash(original), maxCaptureBytes: intent.maxCaptureBytes});
    const budget = wire.length + original.length + 2 * intent.maxCaptureBytes + 4096;
    this.transaction(() => {
      const prior = this.retainedCharge(resource);
      check(prior.attempts < 64 && (prior.attempts + 1) * 9 + 1 <= 4096 &&
        prior.metadataBytes + Buffer.byteLength(metadata) + 2 * VALUE + 8192 <= META, "METADATA_CAPACITY");
      check(prior.charge + budget <= DATA, "DATA_CAPACITY");
      this.guard.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?)").run(intent.attemptId, intent.targetKey, resource, budget, metadata);
      this.put(intent.attemptId, "wire", wire); this.put(intent.attemptId, "original", original);
    });
    check(this.read(intent.attemptId, "wire").equals(wire) && this.read(intent.attemptId, "original").equals(original), "READBACK");
    this.local.add(intent.attemptId);
  }
  capture(id: string, value: Parameters<NativePrivatePersistenceAuthority["capture"]>[1]): void {
    check(this.local.has(id), "OWNER");
    const stdout = Buffer.from(value.stdout), stderr = Buffer.from(value.stderr);
    const status = Buffer.from(JSON.stringify({status: value.status, signal: value.signal, errorCode: value.errorCode}));
    this.transaction(() => {
      const row = this.guard.db.prepare("SELECT metadata FROM attempts WHERE id=?").get(id);
      const max = JSON.parse(String(row?.metadata)).maxCaptureBytes;
      check(stdout.length <= max && stderr.length <= max && status.length <= 4096, "CAPTURE_CAPACITY");
      this.put(id, "stdout", stdout); this.put(id, "stderr", stderr); this.put(id, "status", status);
    });
    check(this.read(id, "stdout").equals(stdout) && this.read(id, "stderr").equals(stderr) &&
      this.read(id, "status").equals(status), "READBACK");
  }
  private validateOriginal(id: string) {
    const row = this.guard.db.prepare("SELECT * FROM attempts WHERE id=?").get(id);
    check(row, "ATTEMPT");
    const wire = this.read(id, "wire"), original = this.read(id, "original"), request = frame(wire, HEADER), h = request.header;
    const m = JSON.parse(String(row.metadata));
    keys(m, ["wire", "original", "maxCaptureBytes"]);
    keys(h, ["attemptId", "byteLength", "contractVersion", "directoryFileId", "directoryVolumeId",
      "expectedSha256", "fileId", "maxBytes", "operation", "path", "payloadSha256", "root", "rootFileId", "rootVolumeId", "volumeId"]);
    check(wire.length <= 4 + HEADER + CHUNK && original.length > 0 && original.length <= CHUNK &&
      m.wire === hash(wire) && m.original === hash(original) && request.payload.equals(original) &&
      Number.isSafeInteger(m.maxCaptureBytes) && m.maxCaptureBytes >= 4 + REPLY && m.maxCaptureBytes <= 4 + REPLY + CHUNK &&
      Number(row.budget) === wire.length + original.length + 2 * m.maxCaptureBytes + 4096 &&
      h.contractVersion === 1 && h.operation === "append" && h.attemptId === id && h.payloadSha256 === hash(original) &&
      typeof h.expectedSha256 === "string" && /^[a-f0-9]{64}$/.test(h.expectedSha256) &&
      Number.isSafeInteger(h.byteLength) && Number(h.byteLength) >= 0 &&
      Number.isSafeInteger(h.maxBytes) && Number(h.maxBytes) <= 20_000_000 &&
      Number(h.byteLength) + original.length <= Number(h.maxBytes), "ORIGINAL");
    for (const field of ["fileId", "directoryFileId", "rootFileId"])
      check(typeof h[field] === "string" && /^[a-fA-F0-9]{32}$/.test(String(h[field])), "ID");
    for (const field of ["volumeId", "directoryVolumeId", "rootVolumeId"])
      check(typeof h[field] === "string" && /^[a-fA-F0-9]{16}$/.test(String(h[field])) &&
        asciiCaseFold(String(h[field])) === asciiCaseFold(String(h.rootVolumeId)), "ID");
    const resource = pathKey(h.path);
    check(resource.startsWith(pathKey(h.root).replace(/\\$/, "") + "\\") && row.resource === resource &&
      row.target === `target:${hash([h.rootVolumeId, h.rootFileId, h.directoryVolumeId, h.directoryFileId,
        win32.basename(String(h.path))].map(v => asciiCaseFold(String(v))).join("|"))}`, "TARGET");
    return {wire, original, request};
  }
  private validateApplied(id: string, receipt: string): void {
    const {request, original} = this.validateOriginal(id);
    const response = frame(this.read(id, "stdout"), REPLY);
    const h = request.header, r = response.header;
    keys(r, ["contractVersion", "operation", "path", "root", "attemptId", "state", "file", "directory",
      "byteLength", "sha256", "filesystem", "durability", "contentFlushed"]);
    const status = JSON.parse(this.read(id, "status").toString("utf8")), body = JSON.parse(receipt);
    keys(status, ["status", "signal"]);
    keys(body, ["attemptId", "operation", "path", "status", "reply"]);
    check(request.payload.equals(original) && h.payloadSha256 === hash(original) &&
      response.payload.length === 0 && this.read(id, "stderr").length === 0 &&
      status.status === 0 && status.signal === null && status.errorCode === undefined &&
      body.attemptId === id && body.operation === "append" && body.path === h.path && body.status === 0 &&
      JSON.stringify(body.reply) === response.text && r.contractVersion === 1 && r.operation === "append" &&
      r.attemptId === id && r.path === h.path && r.root === h.root && r.state === "APPLIED" &&
      r.contentFlushed === true && r.filesystem === "NTFS" &&
      r.byteLength === Number(h.byteLength) + original.length && Number(r.byteLength) <= Number(h.maxBytes) &&
      /^[a-f0-9]{64}$/.test(String(r.sha256)), "APPLIED");
    check(canonical(r.durability) === canonical({profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH"}), "PROFILE");
    if (h.byteLength === 0) check(h.expectedSha256 === hash(Buffer.alloc(0)) && r.sha256 === hash(original), "HASH");
    const f = r.file as WindowsProbeEvidence, d = r.directory as WindowsProbeEvidence;
    assertWindowsProbe(f, {canonicalPath: String(h.path), canonicalRoot: String(h.root)});
    assertWindowsProbe(d, {canonicalPath: win32.dirname(String(h.path)), canonicalRoot: String(h.root)});
    check(asciiCaseFold(f.fileId) === asciiCaseFold(String(h.fileId)) &&
      asciiCaseFold(f.volumeId) === asciiCaseFold(String(h.volumeId)) &&
      asciiCaseFold(d.fileId) === asciiCaseFold(String(h.directoryFileId)) &&
      asciiCaseFold(d.volumeId) === asciiCaseFold(String(h.directoryVolumeId)) && f.sid === d.sid &&
      [f, d].every(e => asciiCaseFold(e.rootFileId) === asciiCaseFold(String(h.rootFileId)) &&
        asciiCaseFold(e.rootVolumeId) === asciiCaseFold(String(h.rootVolumeId))), "IDENTITY");
  }
  terminal(id: string, state: "APPLIED" | "UNKNOWN", receipt: string): void {
    check(this.local.has(id) && ["APPLIED", "UNKNOWN"].includes(state) && Buffer.byteLength(receipt) <= VALUE, "TERMINAL");
    this.transaction(() => {
      if (state === "APPLIED") this.validateApplied(id, receipt);
      this.guard.db.prepare("INSERT INTO terminals VALUES(?,?,?)").run(id, state, receipt);
      if (state === "APPLIED") {
        const budget = Number(this.guard.db.prepare("SELECT budget FROM attempts WHERE id=?").get(id)?.budget);
        const retained = Number(this.guard.db.prepare("SELECT sum(length(bytes)) AS n FROM blobs WHERE id=?").get(id)?.n);
        check(Number.isSafeInteger(retained) && retained <= budget, "RELEASE");
        this.guard.db.prepare("INSERT INTO releases VALUES(?,?,?)").run(id, budget - retained, hash(receipt));
      }
    });
    const row = this.guard.db.prepare("SELECT state,receipt FROM terminals WHERE id=?").get(id);
    check(row?.state === state && row.receipt === receipt, "READBACK");
    this.local.delete(id);
  }
  listAttempts(): readonly string[] {
    this.assertCurrent();
    const rows = this.guard.db.prepare("SELECT id FROM attempts ORDER BY id LIMIT 65").all();
    check(rows.length <= 64, "CAPACITY");
    return rows.map(r => String(r.id));
  }
  inspect(id: string): WindowsPrivateTransferInspection {
    this.assertCurrent(); check(/^[a-f0-9]{32}$/.test(id), "ATTEMPT");
    const row = this.guard.db.prepare("SELECT * FROM attempts WHERE id=?").get(id);
    check(row, "ATTEMPT");
    const blobs = this.guard.db.prepare("SELECT kind,length(bytes) AS n,sha FROM blobs WHERE id=? ORDER BY kind").all(id);
    check(blobs.length >= 2 && blobs.length <= 6 &&
      blobs.every(b => ["wire", "original", "stdout", "stderr", "status", "observation"].includes(String(b.kind))) &&
      blobs.reduce((n, b) => n + Number(b.n), 0) <= Number(row.budget), "BLOBS");
    const {wire, original} = this.validateOriginal(id);
    const metadata = String(row.metadata);
    const optional = (kind: string) => blobs.some(b => b.kind === kind) ? this.read(id, kind) : undefined;
    const captures = {stdout: optional("stdout"), stderr: optional("stderr"), status: optional("status")};
    const t = this.guard.db.prepare("SELECT state,receipt FROM terminals WHERE id=?").get(id);
    const terminal = t ? {state: String(t.state), receipt: String(t.receipt)} : null;
    const fingerprint = hash(canonical({binding: this.binding, id, target: row.target, resource: row.resource,
      budget: row.budget, metadata, blobs: blobs.filter(b => b.kind !== "observation"), terminal}, VALUE));
    return {attemptId: id, fingerprint, binding: this.binding, metadata, resource: String(row.resource),
      wire, original, captures, terminal, resolution: optional("observation")?.toString("utf8") ?? null};
  }
  private capturedApplied(item: WindowsPrivateTransferInspection) {
    check(item.captures.stdout && item.captures.stderr && item.captures.status, "UNKNOWN_UNRESOLVABLE");
    const request = frame(Buffer.from(item.wire), HEADER), response = frame(Buffer.from(item.captures.stdout), REPLY);
    // This is a comparison object for the captured ACK validator, never a new
    // terminal, wire or relabelled protocol record.
    this.validateApplied(item.attemptId, JSON.stringify({attemptId: item.attemptId,
      operation: "append", path: request.header.path, status: 0, reply: response.header}));
    return {h: request.header, ack: response.header};
  }
  private validateObservation(item: WindowsPrivateTransferInspection): void {
    check(item.resolution !== null, "OBSERVATION");
    const r = JSON.parse(item.resolution!);
    keys(r, ["state", "attemptId", "fingerprint", "originalBinding", "context", "evidence"]);
    check(canonical(r, VALUE) === item.resolution && r.state === "APPLIED_OBSERVED" &&
      r.attemptId === item.attemptId && r.fingerprint === item.fingerprint && r.originalBinding === item.binding, "OBSERVATION");
    const {h, ack} = this.capturedApplied(item), c = r.context, e = r.evidence;
    keys(c, ["workspace", "workspaceId", "workspaceFingerprint", "writerId", "sessionId", "osSid"]);
    check(/^[a-f0-9]{64}$/.test(c.workspaceFingerprint) && /^S-1-\d+(?:-\d+)+$/.test(c.osSid) &&
      [c.workspaceId, c.writerId, c.sessionId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128) &&
      pathKey(h.path).startsWith(pathKey(c.workspace).replace(/\\$/, "") + "\\"), "CONTEXT");
    const file = ack.file as WindowsProbeEvidence, directory = ack.directory as WindowsProbeEvidence;
    check(e.originalAck === hash(item.captures.stdout!) && e.root.path === h.root && e.root.fileId === h.rootFileId &&
      e.root.volumeId === h.rootVolumeId && e.parent.path === win32.dirname(String(h.path)) &&
      e.parent.fileId === h.directoryFileId && e.parent.volumeId === h.directoryVolumeId &&
      e.native.path === h.path && e.native.fileId === file.fileId && e.native.volumeId === file.volumeId &&
      e.native.bytes === ack.byteLength && e.native.sha256 === ack.sha256 &&
      file.sid === c.osSid && directory.sid === c.osSid &&
      e.prefixSha256 === h.expectedSha256 && e.payloadSha256 === hash(item.original), "OBSERVATION");
  }
  investigate(request: Readonly<{attemptId: string; fingerprint: string; context: WindowsPrivateMaintenanceContext}>,
    proof: WindowsPrivateTransferMaintenanceProof): WindowsPrivateTransferInspection {
    check(/^[a-f0-9]{64}$/.test(request.fingerprint), "FINGERPRINT");
    for (const name of ["assertCurrent", "directory", "file", "read"] as const)
      check(typeof proof[name] === "function" && !types.isAsyncFunction(proof[name]) && !types.isGeneratorFunction(proof[name]), "ASYNC");
    const context = JSON.parse(canonical(request.context, 4096)) as WindowsPrivateMaintenanceContext;
    const current = () => sync(() => proof.assertCurrent(context));
    current();
    const initial = this.inspect(request.attemptId);
    check(initial.fingerprint === request.fingerprint && initial.resolution === null && initial.terminal?.state !== "APPLIED", "CONFLICT");
    this.local.delete(initial.attemptId);
    this.transaction(() => {
      current();
      const item = this.inspect(initial.attemptId);
      check(item.fingerprint === initial.fingerprint && item.resolution === null, "CONFLICT");
      const {h} = this.capturedApplied(item);
      const actual = proof.file(String(h.path), Number(h.maxBytes));
      const bytes = Buffer.from(proof.read(String(h.path), actual, Number(h.maxBytes)));
      check(bytes.length === actual.bytes && hash(bytes) === actual.sha256 &&
        hash(bytes.subarray(0, Number(h.byteLength))) === h.expectedSha256 &&
        bytes.subarray(Number(h.byteLength)).equals(Buffer.from(item.original)), "CONTENT_CHANGED");
      const evidence = {originalAck: hash(item.captures.stdout!), root: proof.directory(String(h.root)),
        parent: proof.directory(win32.dirname(String(h.path))), native: actual,
        prefixSha256: hash(bytes.subarray(0, Number(h.byteLength))), payloadSha256: hash(item.original)};
      const receipt = canonical({state: "APPLIED_OBSERVED", attemptId: item.attemptId, fingerprint: item.fingerprint,
        originalBinding: item.binding, context, evidence}, VALUE);
      this.validateObservation({...item, resolution: receipt});
      current();
      const repeat = {originalAck: hash(item.captures.stdout!), root: proof.directory(String(h.root)),
        parent: proof.directory(win32.dirname(String(h.path))), native: proof.file(String(h.path), Number(h.maxBytes)),
        prefixSha256: evidence.prefixSha256, payloadSha256: evidence.payloadSha256};
      check(canonical(repeat) === canonical(evidence), "NATIVE_CHANGED");
      this.put(item.attemptId, "observation", Buffer.from(receipt));
      const budget = Number(this.guard.db.prepare("SELECT budget FROM attempts WHERE id=?").get(item.attemptId)?.budget);
      const retained = Number(this.guard.db.prepare("SELECT sum(length(bytes)) AS n FROM blobs WHERE id=?").get(item.attemptId)?.n);
      check(Number.isSafeInteger(retained) && retained >= 0 && retained <= budget, "CAPACITY");
      this.guard.db.prepare("INSERT INTO releases VALUES(?,?,?)").run(item.attemptId, budget - retained, hash(receipt));
      this.retainedCharge();
      current();
    });
    const result = this.inspect(initial.attemptId); this.validateObservation(result); current();
    return result;
  }
  close(): void {
    if (this.closed) return;
    this.closing = true;
    this.owner.close();
    this.closed = true;
    this.local.clear();
  }
}
