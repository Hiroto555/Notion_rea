import { afterEach, expect, it, vi } from "vitest";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import { SyncTransportJournal } from "../src/sync/transport-journal";
import { SyncSqliteGuard } from "../src/sync/sqlite-guard";
import type { PrivatePlatform } from "../src/sync/private-platform";

// Real disposable SQLite + injected proof. This is deliberately NOT Windows OS evidence.
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-private-journals-")); roots.push(root);
  let fail = false;
  const port: PrivatePlatform = {
    kind: "windows",
    bind: vi.fn(path => { mkdirSync(path, { recursive: true }); return path; }),
    assertRoot: vi.fn(() => { if (fail) throw new Error("native identity unavailable"); }),
    assertFile: vi.fn(), assertSidecars: vi.fn(),
    createExclusive: vi.fn(path => { if (fail) throw new Error("native identity unavailable"); if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600)); }),
    assertEmptyFile: vi.fn(path => { if (lstatSync(path).size !== 0) throw new Error("not empty"); }),
    close: vi.fn(),
  };
  return { root, port, fail: () => { fail = true; } };
}
const blob = { direction: "download" as const, assetId: "asset", sha256: "a".repeat(64), bytes: 2 };

it("binds a real blob journal through native root/file/sidecar proof and reopens immutable transfer state", () => {
  const f = fixture(); const scope = { scopeHash: "b".repeat(64) };
  const journal = new BlobTransferJournal(f.root, scope, {}, f.port);
  const record = journal.begin(blob); journal.checkpoint(record.key, 1, "c".repeat(64)); journal.close();
  expect(f.port.assertEmptyFile).toHaveBeenCalledOnce();
  expect(f.port.assertSidecars).toHaveBeenCalled();
  const next = new BlobTransferJournal(f.root, scope, {}, { ...f.port });
  try { expect(next.get(record.key)?.offset).toBe(1); } finally { next.close(); }
});

it("fails before creating a blob DB if native proof is unavailable", () => {
  const f = fixture(); f.fail();
  expect(() => new BlobTransferJournal(f.root, { scopeHash: "b".repeat(64) }, {}, f.port)).toThrow("native identity");
  expect(existsSync(join(f.root, "state.sqlite"))).toBe(false);
  expect(f.port.close).toHaveBeenCalledOnce();
});

it("retains committed blob state and blocks reuse after a postCOMMIT proof failure", () => {
  const f = fixture(); const scope = { scopeHash: "b".repeat(64) };
  const journal = new BlobTransferJournal(f.root, scope, {}, f.port);
  const transaction = SyncSqliteGuard.prototype.transaction;
  const spy = vi.spyOn(SyncSqliteGuard.prototype, "transaction").mockImplementation(function (this: SyncSqliteGuard, work) {
    const result = transaction.call(this, work); f.fail(); return result;
  });
  expect(() => journal.begin(blob)).toThrow("blob-transfer-commit-unknown");
  expect(() => journal.inventory()).toThrow("blob-transfer-commit-unknown");
  journal.close(); spy.mockRestore();
  const reopened = new BlobTransferJournal(f.root, scope);
  try { expect(reopened.inventory()).toMatchObject([{ assetId: "asset", state: "active" }]); } finally { reopened.close(); }
});

it("uses native proof for a transport DB and retains the durable epoch across reopen", () => {
  const f = fixture(); const options = { path: join(f.root, "transport.sqlite"), workspaceId: "ws", clientId: "client", bindingId: "binding", platformAdapter: f.port };
  const journal = new SyncTransportJournal(options); journal.bindServer("epoch"); journal.close();
  expect(f.port.assertEmptyFile).toHaveBeenCalledOnce(); expect(f.port.assertSidecars).toHaveBeenCalled();
  const reopened = new SyncTransportJournal({ ...options, platformAdapter: { ...f.port } });
  try { expect(reopened.status().serverEpoch).toBe("epoch"); } finally { reopened.close(); }
});

it("does not reopen or use a transport DB after native identity changes", () => {
  const f = fixture(); const journal = new SyncTransportJournal({ path: join(f.root, "transport.sqlite"), workspaceId: "ws", clientId: "client", bindingId: "binding", platformAdapter: f.port });
  try { f.fail(); expect(() => journal.status()).toThrow("native identity"); } finally { journal.close(); }
});

it("marks transport postCOMMIT evidence loss UNKNOWN while retaining the accepted epoch", () => {
  const f = fixture(); const options = { path: join(f.root, "transport.sqlite"), workspaceId: "ws", clientId: "client", bindingId: "binding" };
  const journal = new SyncTransportJournal({ ...options, platformAdapter: f.port });
  const transaction = SyncSqliteGuard.prototype.transaction;
  const spy = vi.spyOn(SyncSqliteGuard.prototype, "transaction").mockImplementation(function (this: SyncSqliteGuard, work) {
    const result = transaction.call(this, work); f.fail(); return result;
  });
  expect(() => journal.bindServer("epoch")).toThrow("transport-commit-unknown");
  expect(() => journal.status()).toThrow("transport-commit-unknown"); journal.close(); spy.mockRestore();
  const reopened = new SyncTransportJournal(options);
  try { expect(reopened.status().serverEpoch).toBe("epoch"); } finally { reopened.close(); }
});

it("closes the native port after a bind that allocated and then failed", () => {
  const f = fixture(), cause = new Error("bind failed after allocation");
  vi.mocked(f.port.bind).mockImplementation(() => { throw cause; });
  expect(() => new BlobTransferJournal(f.root, { scopeHash: "b".repeat(64) }, {}, f.port)).toThrow(cause);
  expect(f.port.close).toHaveBeenCalledOnce();
});

it.each(["blob", "transport"] as const)("retries unresolved cleanup only and retains both %s close failures", kind => {
  const f = fixture();
  const journal = kind === "blob"
    ? new BlobTransferJournal(f.root, { scopeHash: "b".repeat(64) }, {}, f.port)
    : new SyncTransportJournal({ path: join(f.root, "transport.sqlite"), workspaceId: "ws", clientId: "client", bindingId: "binding", platformAdapter: f.port });
  const dbError = new Error("database close incomplete"), nativeError = new Error("native close incomplete");
  const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => { throw dbError; });
  vi.mocked(f.port.close).mockImplementationOnce(() => { throw nativeError; });
  let failure: unknown;
  try { journal.close(); } catch (error) { failure = error; }
  expect(failure).toBe(dbError);
  expect(f.port.close).not.toHaveBeenCalled();
  expect(() => kind === "blob" ? (journal as BlobTransferJournal).inventory() : (journal as SyncTransportJournal).status()).toThrow("closing");
  expect(() => journal.close()).toThrow(nativeError);
  expect(close).toHaveBeenCalledTimes(2);
  journal.close(); journal.close();
  expect(close).toHaveBeenCalledTimes(2); expect(f.port.close).toHaveBeenCalledTimes(2);
});

it("rejects a wrong-bound transport without changing DELETE mode or main-file bytes", () => {
  const f = fixture(), path = join(f.root, "transport.sqlite");
  const options = { path, workspaceId: "ws", clientId: "client", bindingId: "binding" };
  new SyncTransportJournal(options).close();
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=DELETE"); db.close();
  const before = readFileSync(path);
  expect(() => new SyncTransportJournal({ ...options, bindingId: "wrong" })).toThrow("journal-binding-mismatch");
  expect(readFileSync(path)).toEqual(before);
  const read = new DatabaseSync(path, { readOnly: true });
  try { expect(read.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete"); } finally { read.close(); }
});

it.each(["foreign-schema", "wrong-scope"] as const)("preserves copied WAL evidence when rejecting a %s blob database", kind => {
  const source = fixture(), target = fixture();
  const original = join(source.root, "state.sqlite"), destination = join(target.root, "state.sqlite");
  if (kind === "wrong-scope") new BlobTransferJournal(source.root, { scopeHash: "b".repeat(64) }).close();
  const writer = new DatabaseSync(original);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    if (kind === "foreign-schema") writer.exec("CREATE TABLE foreign_evidence(value TEXT); INSERT INTO foreign_evidence VALUES('keep raw')");
    else writer.exec("UPDATE transfer_identity SET scope_hash='" + "c".repeat(64) + "'");
    const files = ["", "-wal", "-shm"];
    for (const suffix of files) copyFileSync(original + suffix, destination + suffix);
    const main = readFileSync(destination), wal = readFileSync(destination + "-wal");
    expect(() => new BlobTransferJournal(target.root, { scopeHash: "b".repeat(64) })).toThrow(kind === "foreign-schema" ? "blob-transfer-corrupt" : "blob-transfer-scope-mismatch");
    expect(readFileSync(destination)).toEqual(main); expect(readFileSync(destination + "-wal")).toEqual(wal);
    for (const suffix of files) expect(existsSync(destination + suffix)).toBe(true);
  } finally { writer.close(); }
});

it.each(["blob", "transport"] as const)("retains bind and native cleanup failures during %s construction", kind => {
  const f = fixture(), primary = new Error("bind allocated then failed"), cleanup = new Error("native cleanup failed");
  vi.mocked(f.port.bind).mockImplementation(() => {throw primary;});
  vi.mocked(f.port.close).mockImplementation(() => {throw cleanup;});
  let actual: unknown;
  try {
    if (kind === "blob") new BlobTransferJournal(f.root, {scopeHash: "b".repeat(64)}, {}, f.port);
    else new SyncTransportJournal({path: join(f.root, "transport.sqlite"), workspaceId: "ws", clientId: "client", bindingId: "binding", platformAdapter: f.port});
  } catch (error) {actual = error;}
  expect(actual).toBeInstanceOf(AggregateError);
  expect((actual as AggregateError).errors).toEqual([primary, cleanup]);
});
