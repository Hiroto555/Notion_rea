import { randomUUID, createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { TransferMaintenanceEntry, TransferMaintenanceView, TransferReleasePlanView, TransferReleaseResult } from "../shared/sync-management";
import type { CacheReleaseOperation, ReleaseFilePin } from "../sync/cache-release-types";
import { canonicalJson, requireCondition, SyncError } from "../sync/protocol";
import { BlobTransferJournal } from "../sync/blob-transfer-journal";
import { PrivateLedger } from "../sync/private-ledger";
import { pinPrivateRoot, assertPrivateRoot } from "../sync/m3-private-root";
import { inspectTransferCacheCatalog } from "../sync/transfer-cache-catalog";
import { pinReleaseFile, trashReleaseFile, unlinkReleaseTrash } from "../sync/cache-release-file";
import { inspectVerifiedServerFile } from "../sync/server-verified-file";
import { withBlobUploadLock } from "../sync/blob-upload-resume";
import { syncPath } from "../persistence/durable-file";
import { inspectWorkspaceTransferBudget } from "../sync/blob-transfer-budget";
import {
  createProductPrivatePlatform,
  type ProductPrivateJournalOptions,
} from "../platform/product-private-journals";
import {
  inspectNativeTransferBudget,
  nativeOptionalFile,
  nativePathPresent,
  sameNativeIdentity,
  nativeTransferPort,
  withNativeTransferLock,
  type NativeTransferContext,
  type NativeTransferOptions,
} from "../platform/windows/private-transfer";
import type {
  NativePrivateFile,
  NativePrivateIdentity,
} from "../platform/private-persistence";
import type { BlobTransferRecord } from "../sync/blob-transfer-types";

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const JOURNAL = /^(download|upload)-[a-f0-9]{64}$/;
const METADATA = new Set(["state.sqlite", "state.sqlite-journal", "state.sqlite-wal", "state.sqlite-shm"]);
function names(path: string): string[] {
  const directory = opendirSync(path), result: string[] = [];
  try {for (let entry; (entry = directory.readSync());) {
    requireCondition(result.length < 16, "cache-release-stale", 409); result.push(entry.name);
  }} finally {directory.closeSync();}
  return result;
}
function empty(path: string) {const directory = opendirSync(path); try {return directory.readSync() === null;} finally {directory.closeSync();}}
function optional(path: string) {
  try {return lstatSync(path);} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e;}
}
function locator(value: string) {
  const parts = value.split("/");
  requireCondition(parts.length === 3 && HASH.test(parts[0]) && JOURNAL.test(parts[1]) &&
    (HASH.test(parts[2]) || parts[2] === "!"), "cache-release-stale", 409);
  return {scopeHash: parts[0], journalName: parts[1], key: parts[2]};
}
function samePin(left: ReleaseFilePin | null, right: ReleaseFilePin | null) {return canonicalJson(left) === canonicalJson(right);}
function metadataPin(path: string): ReleaseFilePin {
  const before = lstatSync(path);
  requireCondition(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 &&
    (before.mode & 0o777) === 0o600 && typeof process.getuid === "function" && before.uid === process.getuid(), "cache-release-stale", 409);
  const file = inspectVerifiedServerFile(path, undefined, 16 * 1024 * 1024), after = lstatSync(path);
  requireCondition(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, "cache-release-stale", 409);
  return {dev: after.dev, ino: after.ino, size: file.bytes, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, sha256: file.sha256};
}
/** Deletes one frozen metadata file, never an arbitrary caller path. */
function unlinkMetadata(directory: string, name: string, pin: ReleaseFilePin) {
  requireCondition(METADATA.has(name), "cache-release-stale", 409);
  const root = pinPrivateRoot(directory), path = join(root.path, name);
  if (!optional(path)) return;
  requireCondition(samePin(metadataPin(path), pin), "cache-release-stale", 409);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    requireCondition(stat.dev === pin.dev && stat.ino === pin.ino && stat.nlink === 1 && stat.size === pin.size, "cache-release-stale", 409);
    for (let offset = 0; offset < stat.size;) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      requireCondition(n > 0, "cache-release-stale", 409); hash.update(buffer.subarray(0, n)); offset += n;
    }
    requireCondition(hash.digest("hex") === pin.sha256 && samePin(metadataPin(path), pin), "cache-release-stale", 409);
    assertPrivateRoot(root); unlinkSync(path); syncPath(root.path);
  } finally {closeSync(fd);}
}
/** Native (Windows K-port) release state: native identities, no dev/ino. */
type NativeReleaseOperation = {
  driver: "native";
  id: string;
  kind: "partial" | "empty-journal";
  scopeHash: string;
  journalName: string;
  root: NativePrivateIdentity;
  database: NativePrivateIdentity;
  record: BlobTransferRecord | null;
  file: NativePrivateFile | null;
  expiresAt: number;
  phase: "planned" | "marking" | "releasing" | "trashed" | "unlinked" | "completed";
  releasedBytes: number;
  metadata?: { name: string; file: NativePrivateFile }[];
  currentScopeAtPlan: string | null;
};

const NATIVE_PHASES = ["planned", "marking", "releasing", "trashed", "unlinked", "completed"];

function nativeMetadataFile(
  native: NativeTransferContext,
  path: string,
  maxBytes: number,
): NativePrivateFile | undefined {
  return nativeOptionalFile(native.filesystem, path, maxBytes);
}

export class TransferMaintenanceService {
  private readonly workspace: string;
  private readonly root: string;
  constructor(directory: string, private readonly currentScope: () => string | null,
    private readonly afterPhase?: (phase: CacheReleaseOperation["phase"], operationId: string) => void,
    private readonly privateJournals?: ProductPrivateJournalOptions,
    private readonly nativeTransfer?: NativeTransferOptions) {
    const native = nativeTransferPort(nativeTransfer);
    if (native) this.nativeTransfer = {...nativeTransfer, nativePrivateFilesystem: native.filesystem, nativeTransferIo: native.append};
    this.workspace = native
      ? native.filesystem.inspectDirectory(directory).path
      : realpathSync(directory);
    this.root = join(this.workspace, ".folio-sync-transfers");
  }
  /** A fresh port per open; the journal or ledger that receives it owns it. */
  private platform(directory: string, name: string) {
    return createProductPrivatePlatform(directory, name, this.privateJournals ?? this.nativeTransfer?.privateJournals);
  }
  private async locked<T>(work: (db: PrivateLedger) => Promise<T> | T): Promise<T> {
    const native = nativeTransferPort(this.nativeTransfer);
    if (native)
      return withNativeTransferLock(this.root, async () => {
        const db = new PrivateLedger(this.root, "cache-maintenance.sqlite", "cache-maintenance", [],
          this.platform(this.root, "cache-maintenance.sqlite"));
        try {return await work(db);} finally {db.close();}
      }, this.privateJournals, this.nativeTransfer);
    pinPrivateRoot(this.root);
    return withBlobUploadLock(this.root, async () => {
      const db = new PrivateLedger(this.root, "cache-maintenance.sqlite", "cache-maintenance", [],
        this.platform(this.root, "cache-maintenance.sqlite"));
      try {return await work(db);} finally {db.close();}
    });
  }
  private parse(value: string): CacheReleaseOperation | NativeReleaseOperation {
    const op = JSON.parse(value) as CacheReleaseOperation | NativeReleaseOperation;
    if ((op as NativeReleaseOperation).driver === "native") {
      const n = op as NativeReleaseOperation;
      const path = join(this.root, n.scopeHash, n.journalName);
      const identity = (v: NativePrivateIdentity | undefined, expected: string) =>
        v !== undefined && v.path === expected && /^[a-f0-9]{32}$/i.test(v.fileId) &&
        /^[a-f0-9]{16}$/i.test(v.volumeId);
      const file = (v: NativePrivateFile | null | undefined, expected: string, max: number) =>
        v !== null && v !== undefined && identity(v, expected) && Number.isSafeInteger(v.bytes) &&
        v.bytes >= 0 && v.bytes <= max && HASH.test(v.sha256);
      requireCondition(n && ID.test(n.id) && HASH.test(n.scopeHash) && JOURNAL.test(n.journalName) &&
        ["partial", "empty-journal"].includes(n.kind) && NATIVE_PHASES.includes(n.phase) &&
        Number.isSafeInteger(n.expiresAt) && Number.isSafeInteger(n.releasedBytes) && n.releasedBytes >= 0 &&
        (n.currentScopeAtPlan === null || HASH.test(n.currentScopeAtPlan)) &&
        identity(n.root, path) && identity(n.database, join(path, "state.sqlite")) &&
        (n.kind === "partial"
          ? n.record !== null && n.record.scopeHash === n.scopeHash && HASH.test(n.record.key) &&
            n.record.partialName === n.record.key + ".part" &&
            file(n.file, join(path, n.record.partialName), 20_000_000)
          : n.record === null && n.file === null && Array.isArray(n.metadata) &&
            n.metadata.length > 0 && n.metadata.length <= 4 &&
            new Set(n.metadata.map(f => f.name)).size === n.metadata.length &&
            n.metadata.every(f => METADATA.has(f.name) && file(f.file, join(path, f.name), 32 * 1024 * 1024))),
        "cache-release-stale", 409);
      return n;
    }
    requireCondition(op && ID.test(op.id) && HASH.test(op.scopeHash) && JOURNAL.test(op.journalName) &&
      ["partial", "empty-journal"].includes(op.kind) && ["planned", "marking", "releasing", "trashed", "unlinked", "completed"].includes(op.phase) &&
      Number.isSafeInteger(op.expiresAt) && Number.isSafeInteger(op.releasedBytes) && op.releasedBytes >= 0 &&
      [(op as CacheReleaseOperation).rootDev, (op as CacheReleaseOperation).rootIno, (op as CacheReleaseOperation).dbDev, (op as CacheReleaseOperation).dbIno].every(Number.isSafeInteger), "cache-release-stale", 409);
    return op;
  }
  private write(db: PrivateLedger, op: CacheReleaseOperation | NativeReleaseOperation) {
    db.transaction(() => db.write("release:" + op.id, canonicalJson(op, 32 * 1024)));
  }
  private prunePlans(db: PrivateLedger) {
    const rows = db.entries("release:", 1000).map(row => {
      const op = this.parse(row.value); requireCondition(row.key === "release:" + op.id, "cache-release-stale", 409); return {...row, op};
    });
    const completed = rows.filter(row => row.op.phase === "completed").sort((a,b) => b.op.expiresAt - a.op.expiresAt);
    const remove = completed.slice(256).map(row => row.key);
    // An expired plan is discardable only after proving its journal has no
    // matching release marker. Never prune an uncertain or started operation.
    const checked = new Map<string, Map<string, {state: string; reason: string | null}>>();
    for (const row of rows) {
      const op = row.op;
      if (op.phase !== "planned" || op.expiresAt >= Date.now()) continue;
      const path = join(this.root, op.scopeHash, op.journalName);
      try {
        if (!checked.has(path)) {
          if (checked.size >= 32) continue;
          if ((op as NativeReleaseOperation).driver === "native") {
            const n = op as NativeReleaseOperation, ctx = nativeTransferPort(this.nativeTransfer);
            requireCondition(ctx !== undefined, "cache-release-stale", 409);
            const dir = ctx.filesystem.inspectDirectory(path), db = ctx.filesystem.inspectFileIdentity(join(path, "state.sqlite"));
            requireCondition(dir.fileId === n.root.fileId && dir.volumeId === n.root.volumeId &&
              db.fileId === n.database.fileId && db.volumeId === n.database.volumeId, "cache-release-stale", 409);
          } else {
            const posix = op as CacheReleaseOperation;
            const root = pinPrivateRoot(path), main = lstatSync(join(path, "state.sqlite"));
            requireCondition(root.dev === posix.rootDev && root.ino === posix.rootIno && main.isFile() && !main.isSymbolicLink() &&
              main.nlink === 1 && main.size > 0 && main.dev === posix.dbDev && main.ino === posix.dbIno, "cache-release-stale", 409);
          }
          const journal = new BlobTransferJournal(path, {scopeHash: op.scopeHash}, {},
            this.platform(path, "state.sqlite"));
          try {checked.set(path, new Map(journal.inventory().map(record => [record.key, record])));} finally {journal.close();}
        }
        const record = op.record ? checked.get(path)!.get(op.record.key) : undefined;
        if (record?.state === "releasing" && record.reason === op.id) continue;
        remove.push(row.key);
      } catch { /* Preserve plans whose ownership cannot be checked. */ }
    }
    if (remove.length) db.transaction(() => {for (const key of remove) db.write(key, null);});
  }
  private entry(op: CacheReleaseOperation | NativeReleaseOperation): TransferMaintenanceEntry {
    const native = (op as NativeReleaseOperation).driver === "native" ? op as NativeReleaseOperation : undefined;
    return {entryId: `${op.scopeHash}/${op.journalName}/${op.record?.key ?? "!"}`, scopeHash: op.scopeHash,
      assetId: op.record?.assetId ?? null,
      bytes: native ? (native.file?.bytes ?? native.metadata?.reduce((n, f) => n + f.file.bytes, 0) ?? 0)
        : (op as CacheReleaseOperation).file?.size ?? (op as CacheReleaseOperation).metadata?.reduce((n, f) => n + f.pin.size, 0) ?? 0,
      offset: op.record?.offset ?? 0, state: op.phase === "completed" ? "completed" : "releasing",
      currentScope: op.scopeHash === this.currentScope(), canRelease: false, reason: "release-pending", operationId: op.id};
  }
  async view(cursor?: string): Promise<TransferMaintenanceView> {
    const native = nativeTransferPort(this.nativeTransfer);
    if (native ? !nativePathPresent(native.filesystem, this.root) : !optional(this.root))
      return {entries: [], nextCursor: null, usedBytes: 0, overLimit: false, held: null};
    const view = await this.locked(db => {
      const view = inspectTransferCacheCatalog(this.workspace, this.currentScope(), cursor, this.privateJournals, this.nativeTransfer);
      for (const row of db.entries("release:", 1000)) {
        const op = this.parse(row.value);
        requireCondition(row.key === "release:" + op.id, "cache-release-stale", 409);
        if (op.phase === "planned" || op.phase === "completed") continue;
        const entry = this.entry(op), old = view.entries.findIndex(e => e.entryId === entry.entryId);
        if (old >= 0) view.entries[old] = entry;
        else if (!cursor && view.entries.length < 100) view.entries.push(entry);
      }
      return view;
    });
    // A diagnostic snapshot after our ledger AND mutex have closed. SQLite's
    // first mutex COMMIT may grow its file. Admission/plan/delete checks still
    // run separately under the common mutex; this number authorizes no writes.
    try {
      const budget = native ? inspectNativeTransferBudget(native, this.workspace) : inspectWorkspaceTransferBudget(this.workspace);
      view.usedBytes = budget.bytes; view.overLimit = budget.overLimit;
    } catch {view.held = "unsafe-cache-entry";}
    return view;
  }
  async plan(entryId: string): Promise<TransferReleasePlanView> {
    const loc = locator(entryId);
    const native = nativeTransferPort(this.nativeTransfer);
    return this.locked(db => {
      if (native) return this.planNative(native, db, loc);
      this.prunePlans(db);
      const path = join(this.root, loc.scopeHash, loc.journalName), root = pinPrivateRoot(path);
      pinPrivateRoot(join(this.root, loc.scopeHash));
      const database = lstatSync(join(path, "state.sqlite"));
      requireCondition(database.isFile() && !database.isSymbolicLink() && database.nlink === 1 && database.size > 0, "cache-release-stale", 409);
      const journal = new BlobTransferJournal(path, {scopeHash: loc.scopeHash}, {},
        this.platform(path, "state.sqlite"));
      let record: CacheReleaseOperation["record"] = null, file: ReleaseFilePin | null = null;
      try {
        if (loc.key === "!") requireCondition(this.currentScope() !== loc.scopeHash && journal.inventory().length === 0, "cache-release-stale", 409);
        else {
          record = journal.get(loc.key);
          requireCondition(record && record.state !== "releasing", "cache-release-stale", 409);
          file = pinReleaseFile(path, record.partialName);
        }
      } finally {journal.close();}
      const metadata = record ? undefined : names(path).map(name => {
        requireCondition(METADATA.has(name), "cache-release-stale", 409);
        return {name, pin: metadataPin(join(path, name))};
      });
      assertPrivateRoot(root);
      const dbPin = lstatSync(join(path, "state.sqlite"));
      requireCondition(dbPin.dev === database.dev && dbPin.ino === database.ino, "cache-release-stale", 409);
      const operation: CacheReleaseOperation = {id: randomUUID(), kind: record ? "partial" : "empty-journal",
        ...loc, rootDev: root.dev, rootIno: root.ino, dbDev: dbPin.dev, dbIno: dbPin.ino,
        record, file, expiresAt: Date.now() + 180_000, phase: "planned", releasedBytes: 0, ...(metadata ? {metadata} : {})};
      requireCondition(db.entries("release:", 1000).length < 1000, "cache-release-limit", 409);
      this.write(db, operation);
      return {operationId: operation.id, entry: {...this.entry(operation), state: record?.state ?? "empty-scope", canRelease: true, operationId: undefined}, expiresAt: operation.expiresAt};
    });
  }
  private result(op: CacheReleaseOperation | NativeReleaseOperation): TransferReleaseResult {
    return {operationId: op.id, outcome: op.phase === "completed" ? "released" : "outcome-unknown",
      releasedBytes: op.releasedBytes, reason: op.phase === "completed" ? null : "release-pending"};
  }
  /** Native plan: same locators/phases; identities are native IDs. */
  private planNative(
    native: NativeTransferContext,
    db: PrivateLedger,
    loc: {scopeHash: string; journalName: string; key: string},
  ): TransferReleasePlanView {
    this.prunePlans(db);
    const path = join(this.root, loc.scopeHash, loc.journalName);
    native.filesystem.inspectDirectory(join(this.root, loc.scopeHash));
    const root = native.filesystem.inspectDirectory(path);
    const database = native.filesystem.inspectFile(join(path, "state.sqlite"), 16 * 1024 * 1024);
    requireCondition(database.bytes > 0, "cache-release-stale", 409);
    const journal = new BlobTransferJournal(path, {scopeHash: loc.scopeHash}, {},
      this.platform(path, "state.sqlite"));
    let record: BlobTransferRecord | null = null, file: NativePrivateFile | null = null;
    try {
      if (loc.key === "!") requireCondition(this.currentScope() !== loc.scopeHash && journal.inventory().length === 0, "cache-release-stale", 409);
      else {
        record = journal.get(loc.key);
        requireCondition(record && record.state !== "releasing", "cache-release-stale", 409);
        const partial = nativeMetadataFile(native, join(path, record.partialName), 20_000_000);
        requireCondition(partial !== undefined, "cache-release-stale", 409);
        file = partial;
      }
    } finally {journal.close();}
    const metadata = record ? undefined : names(path).map(name => {
      requireCondition(METADATA.has(name), "cache-release-stale", 409);
      return {name, file: native.filesystem.inspectFile(join(path, name), 32 * 1024 * 1024)};
    });
    const after = native.filesystem.inspectFileIdentity(join(path, "state.sqlite"));
    requireCondition(after.fileId === database.fileId && after.volumeId === database.volumeId, "cache-release-stale", 409);
    const operation: NativeReleaseOperation = {driver: "native", id: randomUUID(), kind: record ? "partial" : "empty-journal",
      ...loc, root: {path: root.path, fileId: root.fileId, volumeId: root.volumeId},
      database: {path: database.path, fileId: database.fileId, volumeId: database.volumeId},
      record, file, currentScopeAtPlan: this.currentScope(),
      expiresAt: Date.now() + 180_000, phase: "planned", releasedBytes: 0, ...(metadata ? {metadata} : {})};
    requireCondition(db.entries("release:", 1000).length < 1000, "cache-release-limit", 409);
    this.write(db, operation);
    return {operationId: operation.id, entry: {...this.entry(operation), state: record?.state ?? "empty-scope", canRelease: true, operationId: undefined}, expiresAt: operation.expiresAt};
  }
  async resolve(operationId: string): Promise<TransferReleaseResult> {
    requireCondition(ID.test(operationId), "cache-release-stale", 409);
    return this.locked(db => {
      const raw = db.read("release:" + operationId);
      requireCondition(raw, "cache-release-stale", 409); const op = this.parse(raw);
      requireCondition(op.id === operationId, "cache-release-stale", 409); return this.result(op);
    });
  }
  async release(operationId: string): Promise<TransferReleaseResult> {
    requireCondition(ID.test(operationId), "cache-release-stale", 409);
    return this.locked(async db => {
      const raw = db.read("release:" + operationId);
      requireCondition(raw, "cache-release-stale", 409);
      const parsed = this.parse(raw);
      requireCondition(parsed.id === operationId, "cache-release-stale", 409);
      if ((parsed as NativeReleaseOperation).driver === "native")
        return this.releaseNative(nativeTransferPort(this.nativeTransfer)!, db, parsed as NativeReleaseOperation);
      const op = parsed as CacheReleaseOperation;
      if (op.phase === "completed") return this.result(op);
      const posix = op as CacheReleaseOperation;
      const path = join(this.root, op.scopeHash, op.journalName);
      const advance = (phase: CacheReleaseOperation["phase"]) => {posix.phase = phase; this.write(db, posix); this.afterPhase?.(phase, op.id);};
      try {
        if (op.phase === "planned" && op.kind === "empty-journal") requireCondition(Date.now() <= op.expiresAt, "cache-release-expired", 409);
        if (op.phase !== "unlinked") {
          const root = pinPrivateRoot(path);
          requireCondition(root.dev === op.rootDev && root.ino === op.rootIno, "cache-release-stale", 409);
        }
        if (op.kind === "partial") {
          requireCondition(op.record && op.record.scopeHash === op.scopeHash, "cache-release-stale", 409);
          const database = lstatSync(join(path, "state.sqlite"));
          requireCondition(database.dev === op.dbDev && database.ino === op.dbIno, "cache-release-stale", 409);
          const journal = new BlobTransferJournal(path, {scopeHash: op.scopeHash}, {},
            this.platform(path, "state.sqlite"));
          try {
            if (op.phase === "planned") {
              const current = journal.get(op.record.key);
              const alreadyMarked = current?.state === "releasing" && current.reason === op.id;
              if (!alreadyMarked) {
                requireCondition(Date.now() <= op.expiresAt, "cache-release-expired", 409);
                requireCondition(current && canonicalJson(current) === canonicalJson(op.record), "cache-release-stale", 409);
                requireCondition(samePin(pinReleaseFile(path, op.record.partialName), op.file), "cache-release-stale", 409);
              }
              // Durable intent BEFORE the separate journal COMMIT. A kill or
              // unknown COMMIT can never strand a marked record behind expiry.
              advance("marking");
            }
            if (op.phase === "marking") {
              const current = journal.get(op.record.key);
              if (current?.state !== "releasing" || current.reason !== op.id)
                requireCondition(samePin(pinReleaseFile(path, op.record.partialName), op.file), "cache-release-stale", 409);
              journal.markRelease(op.record, op.id); advance("releasing");
            }
            if (op.phase === "releasing") {
              if (op.file) trashReleaseFile(path, op.record.partialName, op.id, op.file);
              else requireCondition(!optional(join(path, op.record.partialName)), "cache-release-stale", 409);
              advance("trashed");
            }
            if (op.phase === "trashed") {
              requireCondition(!optional(join(path, op.record.partialName)), "cache-release-stale", 409);
              if (op.file) unlinkReleaseTrash(path, op.id, op.file);
              op.releasedBytes = op.file?.size ?? 0; advance("unlinked");
            }
            journal.finishRelease(op.record.key, op.id);
          } finally {journal.close();}
        } else {
          requireCondition(this.currentScope() !== op.scopeHash && Array.isArray(op.metadata), "cache-release-stale", 409);
          if (op.phase === "planned") {
            const journal = new BlobTransferJournal(path, {scopeHash: op.scopeHash}, {},
              this.platform(path, "state.sqlite"));
            try {requireCondition(journal.inventory().length === 0, "cache-release-stale", 409);} finally {journal.close();}
            for (const f of op.metadata) requireCondition(samePin(metadataPin(join(path, f.name)), f.pin), "cache-release-stale", 409);
            advance("releasing");
          }
          if (op.phase !== "unlinked") {
            const listed = names(path);
            requireCondition(listed.every(name => op.metadata!.some(f => f.name === name)), "cache-release-stale", 409);
            const main = optional(join(path, "state.sqlite"));
            requireCondition(!main || (main.dev === op.dbDev && main.ino === op.dbIno), "cache-release-stale", 409);
            for (const f of op.metadata) unlinkMetadata(path, f.name, f.pin);
            op.releasedBytes = op.metadata.reduce((n, f) => n + f.pin.size, 0); advance("unlinked");
          }
          const root = optional(path);
          if (root && root.dev === op.rootDev && root.ino === op.rootIno) {rmdirSync(path); syncPath(join(this.root, op.scopeHash));}
          const scope = join(this.root, op.scopeHash);
          if (optional(scope) && empty(scope)) {rmdirSync(scope); syncPath(this.root);}
        }
        advance("completed"); return this.result(op);
      } catch (error) {
        const reason = error instanceof SyncError && ["cache-release-stale", "cache-release-expired"].includes(error.code) ? error.code : "cache-release-held";
        return {operationId, outcome: op.phase === "planned" ? "held" : "outcome-unknown", releasedBytes: op.releasedBytes, reason};
      }
    });
  }
  /**
   * Native release: each phase re-proves root/db/record/file identity before
   * mutating; a missing name is never inferred as success. A restarted op
   * whose durable phase is past `planned` reports outcome-unknown and is
   * never re-dispatched — only a call that enters at `planned` mutates.
   */
  private releaseNative(
    native: NativeTransferContext,
    db: PrivateLedger,
    op: NativeReleaseOperation,
  ): TransferReleaseResult {
    const started = op.phase !== "planned";
    const advance = (phase: NativeReleaseOperation["phase"]) => {
      op.phase = phase; this.write(db, op); this.afterPhase?.(phase, op.id);
    };
    try {
      // A restarted started operation never dispatches another mutation.
      requireCondition(!started, "cache-release-stale", 409);
      requireCondition(Date.now() <= op.expiresAt, "cache-release-expired", 409);
      requireCondition(this.currentScope() === op.currentScopeAtPlan, "cache-release-stale", 409);
      const path = join(this.root, op.scopeHash, op.journalName);
      const root = native.filesystem.inspectDirectory(path);
      requireCondition(
        root.fileId === op.root.fileId && root.volumeId === op.root.volumeId,
        "cache-release-stale", 409);
      const assertCurrent = () => {
        db.assertOwned();
        requireCondition(this.currentScope() === op.currentScopeAtPlan &&
          sameNativeIdentity(op.root, native.filesystem.inspectDirectory(path)),
          "cache-release-stale", 409);
      };
      if (op.kind === "partial") {
        requireCondition(op.record && op.record.scopeHash === op.scopeHash && op.file,
          "cache-release-stale", 409);
        const currentDb = native.filesystem.inspectFileIdentity(join(path, "state.sqlite"));
        requireCondition(
          currentDb.fileId === op.database.fileId && currentDb.volumeId === op.database.volumeId,
          "cache-release-stale", 409);
        const journal = new BlobTransferJournal(path, {scopeHash: op.scopeHash}, {},
          this.platform(path, "state.sqlite"));
        try {
          const current = journal.get(op.record.key);
          requireCondition(
            current && canonicalJson(current) === canonicalJson(op.record),
            "cache-release-stale", 409);
          const partial = native.filesystem.inspectFile(
            join(path, op.record.partialName), 20_000_000);
          requireCondition(
            partial.fileId === op.file.fileId && partial.volumeId === op.file.volumeId &&
            partial.bytes === op.file.bytes && partial.sha256 === op.file.sha256,
            "cache-release-stale", 409);
          // Durable phase BEFORE the separate journal mark COMMIT.
          advance("marking");
          journal.markRelease(op.record, op.id);
          advance("releasing");
          assertCurrent();
          const trash = `.release-${op.id}.part`;
          const renamed = native.filesystem.renameNew(
            partial.path, join(path, trash), partial, 20_000_000);
          advance("trashed");
          assertCurrent();
          const trashed = native.filesystem.inspectFile(renamed.identity.path, 20_000_000);
          requireCondition(
            trashed.fileId === partial.fileId && trashed.volumeId === partial.volumeId &&
              trashed.bytes === partial.bytes && trashed.sha256 === partial.sha256,
            "cache-release-stale", 409);
          native.filesystem.unlinkExact(trashed.path, trashed, 20_000_000);
          op.releasedBytes = trashed.bytes;
          advance("unlinked");
          journal.finishRelease(op.record.key, op.id);
        } finally {journal.close();}
      } else {
        requireCondition(this.currentScope() !== op.scopeHash && Array.isArray(op.metadata),
          "cache-release-stale", 409);
        requireCondition(Date.now() <= op.expiresAt, "cache-release-expired", 409);
        // Fresh journal proof of emptiness BEFORE the write-ahead phase.
        const journal = new BlobTransferJournal(path, {scopeHash: op.scopeHash}, {},
          this.platform(path, "state.sqlite"));
        try {requireCondition(journal.inventory().length === 0, "cache-release-stale", 409);}
        finally {journal.close();}
        for (const f of op.metadata) {
          const current = native.filesystem.inspectFile(join(path, f.name), 32 * 1024 * 1024);
          requireCondition(
            current.fileId === f.file.fileId && current.volumeId === f.file.volumeId &&
            current.bytes === f.file.bytes && current.sha256 === f.file.sha256,
            "cache-release-stale", 409);
        }
        advance("releasing");
        const listed = names(path);
        requireCondition(
          listed.every(name => op.metadata!.some(f => f.name === name)),
          "cache-release-stale", 409);
        for (const f of op.metadata) {
          assertCurrent();
          native.filesystem.unlinkExact(join(path, f.name), f.file, 32 * 1024 * 1024);
        }
        op.releasedBytes = op.metadata.reduce((n, f) => n + f.file.bytes, 0);
        advance("unlinked");
        // A proved-empty native directory is retained — no rmdir claim.
      }
      advance("completed");
      return this.result(op);
    } catch (error) {
      const reason = error instanceof SyncError &&
        ["cache-release-stale", "cache-release-expired"].includes(error.code)
        ? error.code : "cache-release-held";
      return {
        operationId: op.id,
        outcome: op.phase === "planned" && !started ? "held" : "outcome-unknown",
        releasedBytes: op.releasedBytes, reason};
    }
  }
}
