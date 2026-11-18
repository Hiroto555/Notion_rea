import {createHash} from "node:crypto";
import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, win32} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Store} from "../src/persistence/store";
import {createWindowsPrivatePersistenceForTesting} from "../src/platform/windows/private-persistence";

// Actual PRIMARY Store + actual K lease facade, with synthetic Windows
// transport/native IDs on disposable Mac SQLite. Windows OS/Main GUI NOT_RUN.
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) try {s.close();} catch {}
  for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true});
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-primary-fence-"))); roots.push(root);
  const rootPath = "C:\\Folio", directory = rootPath + "\\workspace", file = directory + "\\workspace.sqlite";
  const rootId = "1".repeat(32), dirId = "2".repeat(32), fileId = "3".repeat(32), volumeId = "4".repeat(16);
  const executable = Buffer.from("contract-only helper"), hash = createHash("sha256").update(executable).digest("hex");
  let bound: (() => void) | undefined, rawClosed = false, staleId = false, checking = false, assertions = 0;
  const proof = (path: string, id: string) => ({platform: "win32", sid: "S-1-5-21-123", ownerSid: "S-1-5-21-123",
    daclPrivate: true, reparsePoint: false, linkCount: 1, localFilesystem: true, fileId: id, volumeId,
    rootFileId: rootId, rootVolumeId: volumeId, canonicalRoot: rootPath, canonicalPath: path});
  const native = createWindowsPrivatePersistenceForTesting({
    root: rootPath, probeExecutable: "C:\\Tools\\probe.exe", expectedHash: hash, systemRoot: "C:\\Windows",
    expectedRoot: {rootFileId: rootId, volumeId},
    directoryIdentity: p => ({fileId: p === rootPath ? rootId : dirId, volumeId}),
    createDirectory: () => {throw new Error("unexpected directory mutation");},
    authority: {version: 1, independent: true, assertCurrent() {}, reserve() {}, capture() {}, terminal() {}},
    assertCurrent() {
      if (checking) throw new Error("recursive workspace fence");
      checking = true;
      try {bound?.();} finally {checking = false;}
    },
    acquireSqliteLease: () => ({trust: "untrusted-test", assertHeld() {
      assertions++; if (rawClosed) throw new Error("raw lease closed");
    }, close() {rawClosed = true;}}),
  }, {
    fs: {lstat: () => ({isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
      nlink: 1, dev: 1, ino: 1, size: executable.length, mtimeMs: 1}), readFile: () => executable},
    exec(request) {
      const input = Buffer.from(request.input), n = input.readUInt32LE(0), h = JSON.parse(input.subarray(4, 4+n).toString("ascii"));
      if (h.operation !== "inspect-file-identity") throw new Error("unexpected mutation");
      const header = Buffer.from(JSON.stringify({contractVersion: 4, operation: h.operation, root: rootPath, path: h.path,
        state: "OK", file: proof(file, staleId ? "f".repeat(32) : fileId), directory: proof(win32.dirname(file), dirId)}), "ascii");
      const stdout = Buffer.alloc(4 + header.length); stdout.writeUInt32LE(header.length); header.copy(stdout, 4);
      return {status: 0, signal: null, stdout, stderr: Buffer.alloc(0)};
    },
  });
  const lease = native.acquireSqliteLease!(file, {path: file, fileId, volumeId});
  const store = new Store(join(root, "workspace.sqlite"), {nativeLease: lease}); stores.push(store);
  store.db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run("folio.recovery.workspaceId", "workspace-one");
  const bind = () => {bound = store.recoveryWorkspaceFence("workspace-one");};
  return {store, bind, lost() {rawClosed = true;}, replaced() {staleId = true;}, assertions: () => assertions,
    proof: () => bound!()};
}

describe("PRIMARY Main-style K workspace fence (contract only)", () => {
  it("binds an owned connection proof and continues normal public reads and writes", () => {
    const f = fixture(); f.bind();
    f.store.db.prepare("INSERT INTO settings(key,value) VALUES('normal','retained')").run();
    expect(f.store.db.prepare("SELECT value FROM settings WHERE key='normal'").get()?.value).toBe("retained");
    expect(f.assertions()).toBeGreaterThan(2); f.proof();
  });
  it("refuses a changed recovery identity through the bound proof", () => {
    const f = fixture(); f.bind();
    f.store.db.prepare("UPDATE settings SET value='other' WHERE key='folio.recovery.workspaceId'").run();
    expect(f.proof).toThrow("workspace-recovery-binding-changed");
    expect(() => f.store.db).toThrow("REVALIDATE");
  });
  it("keeps native ID replacement checks on ordinary public access", () => {
    const f = fixture(); f.bind(); f.replaced();
    expect(() => f.store.db).toThrow();
  });
  it("refuses a closed raw lease and a closed owned connection", () => {
    const f = fixture(); f.bind(); f.lost(); expect(() => f.store.db).toThrow();
    const g = fixture(); g.bind(); g.store.close(); expect(g.proof).toThrow("workspace-recovery-binding-changed");
  });
  it("retains the native protector when close silently leaves SQLite open", () => {
    const f = fixture(); f.bind(); const db = f.store.db;
    const spy = vi.spyOn(db, "close").mockImplementationOnce(() => {});
    expect(() => f.store.close()).toThrow("UNKNOWN"); expect(db.isOpen).toBe(true);
    expect(f.proof).toThrow("workspace-recovery-binding-changed");
    expect(() => f.store.db).toThrow("REVALIDATE");
    spy.mockRestore(); f.store.close(); expect(db.isOpen).toBe(false);
  });
  it.each([false, true])("preserves a thrown undefined close and releases only a proven-closed connection (%s)", closes => {
    const f = fixture(); f.bind(); const db = f.store.db, close = db.close;
    const spy = vi.spyOn(db, "close").mockImplementationOnce(() => {if (closes) close.call(db); throw undefined;});
    let caught = false, failure: unknown = "unset";
    try {f.store.close();} catch (e) {caught = true; failure = e;}
    expect(caught).toBe(true); expect(failure).toBeUndefined(); expect(db.isOpen).toBe(!closes);
    spy.mockRestore(); f.store.close(); expect(db.isOpen).toBe(false);
  });

});
