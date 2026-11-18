import { describe, expect, it } from "vitest";
import { createWindowsExternalFilesystem, planWindowsExternalSelection } from "../src/platform/windows/external-capability";
import { startupRetainsNativeLease } from "../src/persistence/startup-connection-owner";
import type {
  NativePrivateFile,
  NativePrivateFilesystemPort,
  NativePrivateIdentity,
  NativePrivateReceipt,
} from "../src/platform/private-persistence";

// Pure facade contract tests: the delegate is a spy so a scope violation must
// fail BEFORE any dispatch reaches it. Contract-only; not OS acceptance.
const CAP_ROOT = "C:\\Private";
const WORKSPACE = "C:\\Private\\Workspace";
const SELECTED = "C:\\Private\\Archive";
const SOURCE = "C:\\Private\\Backup";
const FILE_ID = "a".repeat(32);
const VOLUME = "b".repeat(16);
const identity = (path: string): NativePrivateIdentity => ({path, fileId: FILE_ID, volumeId: VOLUME});
const file = (path: string): NativePrivateFile => ({...identity(path), bytes: 3, sha256: "0".repeat(64)});
const receipt = (path: string): NativePrivateReceipt => ({
  profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH",
  identity: file(path),
});

function spy(): NativePrivateFilesystemPort & {calls: string[]; leaseCloseThrows?: boolean} {
  const calls: string[] = [];
  const mark = <T>(name: string, value: () => T) => () => { calls.push(name); return value(); };
  const port: NativePrivateFilesystemPort = {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory: mark("inspectDirectory", () => identity(SELECTED)) as never,
    inspectFile: mark("inspectFile", () => file(SELECTED)) as never,
    inspectFileIdentity: mark("inspectFileIdentity", () => identity(SELECTED)) as never,
    read: mark("read", () => new Uint8Array(3)) as never,
    writeNew: mark("writeNew", () => receipt(SELECTED)) as never,
    copyNew: mark("copyNew", () => receipt(SELECTED)) as never,
    renameNew: mark("renameNew", () => receipt(SELECTED)) as never,
    unlinkExact: mark("unlinkExact", () => undefined) as never,
    proveSync: mark("proveSync", () => receipt(SELECTED)) as never,
    createDirectory: mark("createDirectory", () => identity(SELECTED)) as never,
    snapshotSqlite: mark("snapshotSqlite", () => receipt(SELECTED)) as never,
  };
  port.inspectTree = mark("inspectTree", () => ({...file(SELECTED), entries: 2})) as never;
  port.acquireSqliteLease = mark("acquireSqliteLease", () => Object.freeze({assertHeld() {},
    close() { calls.push("lease.close"); if ((port as {leaseCloseThrows?: boolean}).leaseCloseThrows) throw new Error("lease close lost"); }})) as never;
  return Object.assign(port, {calls});
}

function scoped(extra: Partial<Parameters<typeof createWindowsExternalFilesystem>[1]> = {}) {
  const delegate = spy();
  const scope = {
    capabilityRoot: CAP_ROOT,
    writable: SELECTED,
    readable: Object.freeze([WORKSPACE, SELECTED, SOURCE]),
    movable: Object.freeze([`${SOURCE}\\archive.folio`]),
    assertCurrent() {},
    ...extra,
  };
  return {delegate, fs: createWindowsExternalFilesystem(delegate, scope)};
}

describe("windows external capability filesystem scope (contract-only, NOT_RUN on Windows)", () => {
  it("rejects every mutation outside the selected parent before delegate dispatch", () => {
    const {delegate, fs} = scoped();
    for (const target of [WORKSPACE, "C:\\Private\\Sibling", CAP_ROOT]) {
      expect(() => fs.writeNew(`${target}\\x.bin`, new Uint8Array(1), 16)).toThrow("SCOPE_WRITE");
      expect(() => fs.createDirectory(`${target}\\x`)).toThrow("SCOPE_WRITE");
      expect(() => fs.unlinkExact(`${target}\\x.bin`, file(`${target}\\x.bin`), 16)).toThrow("SCOPE_WRITE");
      expect(() => fs.proveSync(`${target}\\x.bin`, file(`${target}\\x.bin`))).toThrow("SCOPE_WRITE");
    }
    expect(delegate.calls).toEqual([]);
    expect(() => fs.writeNew(`${SELECTED}\\ok.bin`, new Uint8Array(1), 16)).not.toThrow();
    expect(delegate.calls).toEqual(["writeNew"]);
  });

  it("limits reads to the selected parent and the explicit readable scopes", () => {
    const {delegate, fs} = scoped();
    expect(() => fs.inspectFile(`${WORKSPACE}\\journal.db`, 1024)).not.toThrow();
    expect(() => fs.inspectTree!(`${SOURCE}`)).not.toThrow();
    expect(() => fs.acquireSqliteLease!(`${SELECTED}\\db.sqlite`, identity(`${SELECTED}\\db.sqlite`))).not.toThrow();
    for (const path of ["C:\\Private\\Sibling\\x.bin", "C:\\Elsewhere\\x.bin", CAP_ROOT]) {
      expect(() => fs.inspectFile(path, 16)).toThrow();
      expect(() => fs.read(path, file(path), 16)).toThrow();
    }
    expect(delegate.calls).toEqual(["inspectFile", "inspectTree", "acquireSqliteLease"]);
  });

  it("copies only from readable sources and moves only the exact selected archive", () => {
    const {delegate, fs} = scoped();
    expect(() => fs.copyNew(`${WORKSPACE}\\a.bin`, `${SELECTED}\\b.bin`, file(`${WORKSPACE}\\a.bin`), 16)).not.toThrow();
    expect(() => fs.copyNew("C:\\Private\\Sibling\\a.bin", `${SELECTED}\\c.bin`,
      file("C:\\Private\\Sibling\\a.bin"), 16)).toThrow("SCOPE_READ");
    expect(() => fs.renameNew(`${SOURCE}\\archive.folio`, `${SELECTED}\\archive.folio`,
      file(`${SOURCE}\\archive.folio`), 16)).not.toThrow();
    // Only the exact admitted movable may leave; its siblings stay read-only.
    expect(() => fs.renameNew(`${SOURCE}\\other.folio`, `${SELECTED}\\other.folio`,
      file(`${SOURCE}\\other.folio`), 16)).toThrow("SCOPE_MOVE");
    // The writable parent itself is never a move source.
    expect(() => fs.renameNew(SELECTED, `${SELECTED}\\moved`, file(SELECTED) as never, 16))
      .toThrow("SCOPE_MOVE");
    expect(() => fs.renameNew(`${WORKSPACE}\\a.bin`, `${SELECTED}\\d.bin`, file(`${WORKSPACE}\\a.bin`), 16))
      .toThrow("SCOPE_MOVE");
    expect(delegate.calls).toEqual(["copyNew", "renameNew"]);
  });

  it("rejects async or stale authority and non-canonical paths without dispatch", () => {
    const {fs: stale} = scoped({assertCurrent() { throw new Error("revoked"); }});
    expect(() => stale.inspectFile(`${SELECTED}\\x.bin`, 16)).toThrow("revoked");
    const {delegate, fs} = scoped({assertCurrent: (async () => {}) as never});
    expect(() => fs.inspectFile(`${SELECTED}\\x.bin`, 16)).toThrow("CALLBACK");
    const {fs: ack} = scoped({assertCurrent: (() => 1) as never});
    expect(() => ack.inspectFile(`${SELECTED}\\x.bin`, 16)).toThrow("CALLBACK_ACK");
    const clean = scoped();
    expect(() => clean.fs.inspectFile("c:\\private\\archive\\x.bin", 16)).toThrow();
    expect(() => clean.fs.inspectFile(`${SELECTED}\\..\\Sibling\\x.bin`, 16)).toThrow();
    expect(delegate.calls).toEqual([]);
    expect(clean.delegate.calls).toEqual([]);
  });

  it("denies every write on a read-only backup-source capability", () => {
    const {delegate, fs} = scoped({writable: undefined, readable: Object.freeze([SOURCE]), movable: Object.freeze([])});
    expect(() => fs.inspectFile(`${SOURCE}\\manifest.json`, 16)).not.toThrow();
    expect(() => fs.writeNew(`${SOURCE}\\x.bin`, new Uint8Array(1), 16)).toThrow("SCOPE_WRITE");
    expect(() => fs.renameNew(`${SOURCE}\\a.bin`, `${SOURCE}\\b.bin`, file(`${SOURCE}\\a.bin`), 16)).toThrow("SCOPE_MOVE");
    expect(delegate.calls).toEqual(["inspectFile"]);
  });

  it("scopes the SQLite snapshot source like a read and never mutates the selected parent", () => {
    const {delegate, fs} = scoped();
    const dbFor = (mainFile: unknown) => ({prepare: (sql: string) => ({
      all: () => [{name: "main", file: mainFile}],
    })});
    // A source handle outside the readable scopes is refused before dispatch.
    expect(() => fs.snapshotSqlite(dbFor("C:\\Private\\Sibling\\db.sqlite") as never, `${SELECTED}\\snap.sqlite`))
      .toThrow("SCOPE_READ");
    // An absent or non-string main file is refused.
    expect(() => fs.snapshotSqlite(dbFor(undefined) as never, `${SELECTED}\\snap.sqlite`)).toThrow("SQLITE_SOURCE");
    // The writable parent itself is never a mutation target.
    expect(() => fs.createDirectory(SELECTED)).toThrow("SCOPE_WRITE");
    expect(() => fs.writeNew(SELECTED, new Uint8Array(1), 16)).toThrow("SCOPE_WRITE");
    // An in-scope source reaches the delegate normally.
    expect(() => fs.snapshotSqlite(dbFor(`${SELECTED}\\journal.sqlite`) as never, `${SELECTED}\\snap.sqlite`))
      .not.toThrow();
    expect(delegate.calls).toEqual(["snapshotSqlite"]);
  });

  it("closes an acquired lease once when the post-acquire fence goes stale", () => {
    let calls = 0;
    const {delegate, fs} = scoped({assertCurrent() { if (++calls >= 2) throw new Error("revoked"); }});
    expect(() => fs.acquireSqliteLease!(`${SELECTED}\\db.sqlite`, identity(`${SELECTED}\\db.sqlite`)))
      .toThrow("revoked");
    expect(delegate.calls).toEqual(["acquireSqliteLease", "lease.close"]);
  });

  it("retains the lease protector with the branded error when the post-acquire close fails", () => {
    let calls = 0;
    const {delegate, fs} = scoped({assertCurrent() { if (++calls >= 2) throw new Error("revoked"); }});
    delegate.leaseCloseThrows = true;
    let thrown: unknown;
    try { fs.acquireSqliteLease!(`${SELECTED}\\db.sqlite`, identity(`${SELECTED}\\db.sqlite`)); }
    catch (error) { thrown = error; }
    expect(startupRetainsNativeLease(thrown)).toBe(true);
    expect(delegate.calls).toEqual(["acquireSqliteLease", "lease.close"]);
  });

  it("captures the authority callback once at construction", () => {
    const delegate = spy();
    const scope = {
      capabilityRoot: CAP_ROOT, writable: SELECTED,
      readable: Object.freeze([SELECTED]), movable: Object.freeze([]),
      assertCurrent() {},
    };
    const fs = createWindowsExternalFilesystem(delegate, scope);
    // Mutating the scope object afterwards cannot substitute the authority.
    (scope as {assertCurrent: () => void}).assertCurrent = () => { throw new Error("revoked"); };
    expect(() => fs.inspectFile(`${SELECTED}\\x.bin`, 16)).not.toThrow();
    expect(delegate.calls).toEqual(["inspectFile"]);
  });
});

describe("windows external selection plan (pure lexical, NOT_RUN on Windows)", () => {
  const base = {
    root: "C:\\Private\\Workspace", workspace: "C:\\Private\\Workspace",
    stateRoot: "C:\\FolioState", capabilityRoot: "C:\\Private", outputParent: "C:\\Private\\Archive",
  };
  it("accepts the supported root==workspace private common-ancestor layout", () => {
    expect(planWindowsExternalSelection(base))
      .toEqual({capabilityRoot: "C:\\Private", path: "C:\\Private\\Archive"});
    expect(planWindowsExternalSelection(base, "C:\\Private\\Rescue"))
      .toEqual({capabilityRoot: "C:\\Private", path: "C:\\Private\\Rescue"});
    // The returned plan is detached.
    expect(Object.isFrozen(planWindowsExternalSelection(base))).toBe(true);
  });
  it("rejects drive-level roots, state overlap and workspace collisions", () => {
    // Direct C:\FolioData -> C:\Backup via a C:\ common root is unsupported.
    expect(() => planWindowsExternalSelection({root: "C:\\FolioData", workspace: "C:\\FolioData\\ws",
      stateRoot: "C:\\FolioState", capabilityRoot: "C:\\", outputParent: "C:\\Backup"})).toThrow("DRIVE_ROOT");
    expect(() => planWindowsExternalSelection({...base, stateRoot: "C:\\Private\\state"})).toThrow("STATE_OVERLAP");
    expect(() => planWindowsExternalSelection({...base, stateRoot: "C:\\Private"})).toThrow("STATE_OVERLAP");
    expect(() => planWindowsExternalSelection(base, "C:\\Private\\Workspace")).toThrow("SELECTED");
    expect(() => planWindowsExternalSelection(base, "C:\\Elsewhere")).toThrow("SELECTED");
    expect(() => planWindowsExternalSelection({...base, outputParent: "C:\\Private"})).toThrow("OUTPUT");
    expect(() => planWindowsExternalSelection({...base, capabilityRoot: "C:\\Private\\Workspace\\Archive"})).toThrow("ROOT");
  });
});
