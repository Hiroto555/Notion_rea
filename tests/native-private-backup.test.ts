import fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { withPrivatePersistence, type NativePrivateFilesystemPort, type NativePrivateFile } from "../src/platform/private-persistence";
import { attachFile } from "../src/persistence/assets";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { createMigrationSnapshot } from "../src/persistence/migration-snapshot";
import { createRawWorkspaceSalvage } from "../src/persistence/raw-workspace-salvage";
import { writeRecoveryFile } from "../src/persistence/recovery-file";
import { verifyWorkspaceBinding } from "../src/sync/workspace-binding";
import { OrphanMaintenance } from "../src/main/orphan-maintenance";
import { Store } from "../src/persistence/store";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Disposable POSIX adapter exercising Windows FAMILY branches. These tests
 * make no SID/DACL/NTFS/sharing/durability/OS acceptance claim.
 */
function contractAdapter() {
  const calls: string[] = [];
  let failUnlink = false;
  const identity = (path: string) => {
    const stat = fs.lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("unsafe");
    return { path, fileId: stat.ino.toString(16).padStart(32, "0"), volumeId: stat.dev.toString(16).padStart(16, "0") };
  };
  const inspect = (path: string, max: number): NativePrivateFile => {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error("bounded file");
    return { ...identity(path), bytes: stat.size, sha256: sha(fs.readFileSync(path)) };
  };
  const exact = (path: string, expected: NativePrivateFile, max: number) => {
    expect(inspect(path, max)).toEqual(expected);
  };
  const receipt = (path: string, max: number) => ({
    profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const,
    scope: "PROCESS_CRASH" as const, identity: inspect(path, max),
  });
  const port: NativePrivateFilesystemPort = {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory(path) { if (!fs.lstatSync(path).isDirectory()) throw new Error("directory"); return identity(path); },
    inspectFileIdentity: identity,
    inspectFile: inspect,
    read(path, expected, max) { exact(path, expected, max); return fs.readFileSync(path); },
    writeNew(path, bytes, max) {
      calls.push(`write:${basename(path)}`);
      if (bytes.length > max) throw new Error("capacity");
      fs.writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      return receipt(path, max);
    },
    copyNew(source, destination, expected, max) {
      calls.push("copy"); exact(source, expected, max);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      return receipt(destination, max);
    },
    renameNew(source, destination, expected, max) {
      calls.push("rename"); exact(source, expected, max);
      if (fs.existsSync(destination)) throw new Error("collision");
      fs.renameSync(source, destination); return receipt(destination, max);
    },
    unlinkExact(path, expected, max) {
      calls.push("unlink"); exact(path, expected, max);
      if (failUnlink) throw new Error("UNKNOWN");
      fs.unlinkSync(path);
    },
    proveSync(path, expected) { exact(path, expected, expected.bytes); return receipt(path, expected.bytes); },
    createDirectory(path) { calls.push("directory"); fs.mkdirSync(path, { mode: 0o700 }); return identity(path); },
    acquireSqliteLease(path, expected) {
      calls.push("sqlite-lease"); let live = true;
      expect(port.inspectFileIdentity(path)).toEqual(expected);
      return {assertHeld() {expect(live).toBe(true); expect(port.inspectFileIdentity(path)).toEqual(expected);},
        close() {expect(live).toBe(true); live = false; calls.push("sqlite-lease-close");}};
    },
    snapshotSqlite(db, path) {
      calls.push("sqlite-snapshot");
      if (db.isTransaction) throw new Error("transaction");
      fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      db.prepare("VACUUM INTO ?").run(path);
      return receipt(path, 256 * 1024 * 1024);
    },
  };
  return { port, calls, failMarker() { failUnlink = true; } };
}
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-native-family-contract-")));
  roots.push(root);
  const workspace = join(root, "workspace"), assets = join(workspace, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const store = new Store(join(workspace, "workspace.sqlite")); stores.push(store);
  store.create(null, "page", "committed WAL content");
  const adapter = contractAdapter();
  return { root, workspace, assets, store, ...adapter };
}

describe("POSIX contract simulation of native private family branches (NOT Windows acceptance)", () => {
  it("attaches exactly 20MB, snapshots committed WAL, restores nonempty backup and preserves sources", () => {
    const f = fixture();
    const input = join(f.root, "source.bin"), bytes = Buffer.alloc(20_000_000, 0x5a);
    fs.writeFileSync(input, bytes);
    withPrivatePersistence({ nativePrivateFilesystem: f.port }, () => {
      let admitted = 0;
      const asset = attachFile(f.store.db, f.assets, input, n => { admitted = n; });
      expect(admitted).toBe(bytes.length);
      const backup = createFullBackup(f.store.db, f.workspace, join(f.root, "backup"));
      const restored = restoreFullBackup(backup.directory, join(f.root, "restored"), backup.fingerprint);
      expect(verifyFullBackup(restored.directory).fingerprint).toBe(backup.fingerprint);
      expect(fs.readFileSync(join(restored.directory, "assets", asset.id)).equals(bytes)).toBe(true);
      const snapshot = new DatabaseSync(join(restored.directory, "workspace.sqlite"), { readOnly: true });
      try { expect(snapshot.prepare("SELECT count(*) AS n FROM pages").get()?.n).toBe(1); }
      finally { snapshot.close(); }
      expect(fs.readFileSync(input).equals(bytes)).toBe(true);
      expect(f.calls).toContain("sqlite-snapshot");
      expect(f.calls).toContain("copy");
    });
  });
  it("retains a partial marker and all copied data on UNKNOWN; refuses existing backup", () => {
    const f = fixture();
    withPrivatePersistence({ nativePrivateFilesystem: f.port }, () => {
      f.failMarker();
      const destination = join(f.root, "partial");
      expect(() => createFullBackup(f.store.db, f.workspace, destination)).toThrow("UNKNOWN");
      expect(fs.existsSync(join(destination, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(true);
      expect(fs.existsSync(join(destination, "manifest.json"))).toBe(true);
      expect(() => createFullBackup(f.store.db, f.workspace, destination)).toThrow();
      expect(() => verifyFullBackup(destination)).toThrow();
    });
  });
  it("captures migration and raw salvage with SQLite snapshots and preserved original journals", () => {
    const f = fixture();
    const input = join(f.root, "input.txt"); fs.writeFileSync(input, "asset");
    withPrivatePersistence({ nativePrivateFilesystem: f.port }, () => {
      attachFile(f.store.db, f.assets, input);
      createMigrationSnapshot(f.store.db, f.assets, join(f.root, "migration"));
      expect(fs.existsSync(join(f.root, "migration", ".manifest-pending.json"))).toBe(true);
      fs.writeFileSync(join(f.workspace, "crash-recovery.json"), "raw original journal");
      const outside = join(f.root, "outside"); fs.mkdirSync(outside);
      const result = createRawWorkspaceSalvage(f.store.db, f.workspace, outside);
      expect(result.files).toBe(3);
      expect(fs.readFileSync(join(result.directory, "crash-recovery.json"), "utf8")).toBe("raw original journal");
      expect(fs.readFileSync(join(f.workspace, "crash-recovery.json"), "utf8")).toBe("raw original journal");
    });
  });
  it("pins versioned native binding, blocks missing/stale identity, and explicitly reenrolls retaining old sidecar", () => {
    const f = fixture(), device = { workspaceId: "workspace", clientId: "client", bindingId: "binding" };
    const database = join(f.root, "binding.sqlite"); fs.writeFileSync(database, "database fixture");
    const options = { nativePrivateFilesystem: f.port };
    withPrivatePersistence(options, () => {
      expect(() => verifyWorkspaceBinding(database, device, false)).toThrow("workspace-binding-missing");
      verifyWorkspaceBinding(database, device, true);
      verifyWorkspaceBinding(database, device, false);
      const sidecar = join(dirname(database), ".folio-sync-binding"), old = fs.readFileSync(sidecar);
      expect(JSON.parse(old.toString()).identityKind).toBe("windows-file-id");
      fs.renameSync(database, database + ".prior"); fs.writeFileSync(database, "database fixture");
      expect(() => verifyWorkspaceBinding(database, device, false)).toThrow("workspace-binding-mismatch");
      verifyWorkspaceBinding(database, device, true, { ...options, reenroll: true });
      const retained = fs.readdirSync(f.root).filter(name => name.startsWith(".folio-sync-binding.retained-"));
      expect(retained).toHaveLength(1);
      expect(fs.readFileSync(join(f.root, retained[0]))).toEqual(old);
      verifyWorkspaceBinding(database, device, false);
    });
  });
  it("publishes recovery without replacement and moves only explicitly ticketed unregistered orphan", () => {
    const f = fixture();
    withPrivatePersistence({ nativePrivateFilesystem: f.port }, () => {
      const path = join(f.root, "recovery.json"), content = JSON.stringify({
        format: "folio-recovery", schemaVersion: 2, pages: f.store.pages(),
      });
      writeRecoveryFile(path, content);
      expect(() => writeRecoveryFile(path, content)).toThrow();
      expect(fs.readFileSync(path, "utf8")).toBe(content);
      const orphan = join(f.assets, "unregistered.cache"); fs.writeFileSync(orphan, "retained bytes");
      const maintenance = new OrphanMaintenance(f.store.db, f.workspace);
      const plan = maintenance.plan(orphan), outside = join(f.root, "external"); fs.mkdirSync(outside);
      const result = maintenance.move(plan.ticket, outside);
      expect(fs.readFileSync(result.destination, "utf8")).toBe("retained bytes");
      expect(fs.existsSync(orphan)).toBe(false);
      expect(() => maintenance.move(plan.ticket, outside)).toThrow();
    });
  });
  it("refuses explicit reenrollment of a foreign sidecar and preserves its bytes", () => {
    const f = fixture(), database = join(f.root, "foreign.sqlite");
    fs.writeFileSync(database, "fixture");
    const sidecar = join(f.root, ".folio-sync-binding"), bytes = Buffer.from(JSON.stringify({
      version: 2, identityKind: "windows-file-id", workspaceId: "another", clientId: "client",
      bindingId: "binding", database, fileId: "1".repeat(32), volumeId: "2".repeat(16),
    }));
    fs.writeFileSync(sidecar, bytes);
    expect(() => verifyWorkspaceBinding(database, { workspaceId: "workspace", clientId: "client", bindingId: "binding" },
      true, { nativePrivateFilesystem: f.port, reenroll: true })).toThrow("workspace-binding-foreign");
    expect(fs.readFileSync(sidecar)).toEqual(bytes);
    expect(fs.readdirSync(f.root).some(name => name.startsWith(".folio-sync-binding.retained-"))).toBe(false);
  });
});
