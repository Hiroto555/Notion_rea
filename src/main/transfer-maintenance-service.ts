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
export class TransferMaintenanceService {
  private readonly workspace: string;
  private readonly root: string;
  constructor(directory: string, private readonly currentScope: () => string | null,
    private readonly afterPhase?: (phase: CacheReleaseOperation["phase"], operationId: string) => void) {
    this.workspace = realpathSync(directory); this.root = join(this.workspace, ".folio-sync-transfers");
  }
  private async locked<T>(work: (db: PrivateLedger) => Promise<T> | T): Promise<T> {
    pinPrivateRoot(this.root);
    return withBlobUploadLock(this.root, async () => {
      const db = new PrivateLedger(this.root, "cache-maintenance.sqlite", "cache-maintenance");
      try {return await work(db);} finally {db.close();}
    });
  }
  private parse(value: string): CacheReleaseOperation {
    const op = JSON.parse(value) as CacheReleaseOperation;
    requireCondition(op && ID.test(op.id) && HASH.test(op.scopeHash) && JOURNAL.test(op.journalName) &&
      ["partial", "empty-journal"].includes(op.kind) && ["planned", "marking", "releasing", "trashed", "unlinked", "completed"].includes(op.phase) &&
      Number.isSafeInteger(op.expiresAt) && Number.isSafeInteger(op.releasedBytes) && op.releasedBytes >= 0 &&
      [op.rootDev, op.rootIno, op.dbDev, op.dbIno].every(Number.isSafeInteger), "cache-release-stale", 409);
    return op;
  }
  private write(db: PrivateLedger, op: CacheReleaseOperation) {
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
          const root = pinPrivateRoot(path), main = lstatSync(join(path, "state.sqlite"));
          requireCondition(root.dev === op.rootDev && root.ino === op.rootIno && main.isFile() && !main.isSymbolicLink() &&
            main.nlink === 1 && main.size > 0 && main.dev === op.dbDev && main.ino === op.dbIno, "cache-release-stale", 409);
          const journal = new BlobTransferJournal(path, {scopeHash: op.scopeHash});
          try {checked.set(path, new Map(journal.inventory().map(record => [record.key, record])));} finally {journal.close();}
        }
        const record = op.record ? checked.get(path)!.get(op.record.key) : undefined;
        if (record?.state === "releasing" && record.reason === op.id) continue;
        remove.push(row.key);
      } catch { /* Preserve plans whose ownership cannot be checked. */ }
    }
    if (remove.length) db.transaction(() => {for (const key of remove) db.write(key, null);});
  }
  private entry(op: CacheReleaseOperation): TransferMaintenanceEntry {
    return {entryId: `${op.scopeHash}/${op.journalName}/${op.record?.key ?? "!"}`, scopeHash: op.scopeHash,
      assetId: op.record?.assetId ?? null, bytes: op.file?.size ?? op.metadata?.reduce((n, f) => n + f.pin.size, 0) ?? 0,
      offset: op.record?.offset ?? 0, state: op.phase === "completed" ? "completed" : "releasing",
      currentScope: op.scopeHash === this.currentScope(), canRelease: false, reason: "release-pending", operationId: op.id};
  }
  async view(cursor?: string): Promise<TransferMaintenanceView> {
    if (!optional(this.root)) return {entries: [], nextCursor: null, usedBytes: 0, overLimit: false, held: null};
    const view = await this.locked(db => {
      const view = inspectTransferCacheCatalog(this.workspace, this.currentScope(), cursor);
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
      const budget = inspectWorkspaceTransferBudget(this.workspace);
      view.usedBytes = budget.bytes; view.overLimit = budget.overLimit;
    } catch {view.held = "unsafe-cache-entry";}
    return view;
  }
  async plan(entryId: string): Promise<TransferReleasePlanView> {
    const loc = locator(entryId);
    return this.locked(db => {
      this.prunePlans(db);
      const path = join(this.root, loc.scopeHash, loc.journalName), root = pinPrivateRoot(path);
      pinPrivateRoot(join(this.root, loc.scopeHash));
      const database = lstatSync(join(path, "state.sqlite"));
      requireCondition(database.isFile() && !database.isSymbolicLink() && database.nlink === 1 && database.size > 0, "cache-release-stale", 409);
      const journal = new BlobTransferJournal(path, {scopeHash: loc.scopeHash});
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
  private result(op: CacheReleaseOperation): TransferReleaseResult {
    return {operationId: op.id, outcome: op.phase === "completed" ? "released" : "outcome-unknown",
      releasedBytes: op.releasedBytes, reason: op.phase === "completed" ? null : "release-pending"};
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
      const op = this.parse(raw);
      requireCondition(op.id === operationId, "cache-release-stale", 409);
      if (op.phase === "completed") return this.result(op);
      const path = join(this.root, op.scopeHash, op.journalName);
      const advance = (phase: CacheReleaseOperation["phase"]) => {op.phase = phase; this.write(db, op); this.afterPhase?.(phase, op.id);};
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
          const journal = new BlobTransferJournal(path, {scopeHash: op.scopeHash});
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
            const journal = new BlobTransferJournal(path, {scopeHash: op.scopeHash});
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
}
