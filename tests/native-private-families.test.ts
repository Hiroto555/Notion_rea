import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPrivatePersistence, type NativePrivateFile, type NativePrivateFilesystemPort,
  type NativePrivateIdentity, type NativePrivateTree } from "../src/platform/private-persistence";
import { backupWorkspace, migrateWorkspace } from "../src/persistence/workspace";
import { archiveBackup, planBackupArchive } from "../src/main/backup-maintenance";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { Store } from "../src/persistence/store";
import { attachFile } from "../src/persistence/assets";
import { RecordRepository } from "../src/persistence/record-repository";
import { exportPortableRecordRecovery, restorePortableRecordRecoveryToNewWorkspace } from "../src/persistence/portable-recovery";
import { exportRecoveryArchive } from "../src/persistence/conflict-recovery-export";
import { restoreRecoveryBundle } from "../src/persistence/conflict-recovery-import";
import { verifyRecoveryBundle } from "../src/persistence/conflict-recovery-verify";
import { copyRecoveryAsset } from "../src/persistence/conflict-recovery-assets";
import { inspectRecoveredContent } from "../src/persistence/recovered-content";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { hashCheckpoint } from "../src/sync/protocol";

const MAX = 256 * 1024 * 1024, MARKER = "FOLIO-RECOVERY-INCOMPLETE";
const roots: string[] = [], stores: Store[] = [];
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Disposable POSIX contract adapter ONLY. NOT Windows acceptance, NTFS,
 * DACL, handle-sharing or power-loss evidence. Never used by production. */
function adapter() {
  const calls: string[] = [];
  const faults = { renameUnknown: false, copyUnknown: false, lease: false,
    beforeRename: undefined as undefined | ((source: string, destination: string) => void),
    afterLeaseClose: undefined as undefined | ((path: string) => void),
    afterDirectory: undefined as undefined | ((path: string) => void) };
  const identity = (path: string): NativePrivateIdentity => {
    const s = fs.lstatSync(path, { bigint: true });
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error("unsafe identity");
    return { path, fileId: s.ino.toString(16).padStart(32, "0"), volumeId: s.dev.toString(16).padStart(16, "0") };
  };
  const inspect = (path: string, max: number): NativePrivateFile => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.size > max) throw new Error("file bound");
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      for (;;) {
        const n = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!n) break;
        total += n; if (total > max) throw new Error("file bound");
        hash.update(buffer.subarray(0, n));
      }
      const after = fs.fstatSync(fd);
      if (total !== s.size || s.ino !== after.ino || s.mtimeMs !== after.mtimeMs) throw new Error("file changed");
      return { ...identity(path), bytes: total, sha256: hash.digest("hex") };
    } finally { fs.closeSync(fd); }
  };
  const exact = (path: string, expected: NativePrivateFile, max: number) => {
    if (JSON.stringify(inspect(path, max)) !== JSON.stringify(expected)) throw new Error("stale file");
  };
  const receipt = (path: string, max: number) => ({
    profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const, scope: "PROCESS_CRASH" as const,
    identity: inspect(path, max),
  });
  const tree = (path: string): NativePrivateTree => {
    const records: { relative: string; text: string }[] = [], held: number[] = [];
    let bytes = 0;
    const walk = (current: string, relative: string, depth: number) => {
      if (records.length >= 4096 || depth > 64) throw new Error("tree bound");
      const s = fs.lstatSync(current), id = identity(current);
      held.push(fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)));
      if (s.isDirectory()) {
        records.push({ relative, text: `D\0${relative}\0${id.fileId}\0${id.volumeId}\n` });
        const names = new Set<string>(), dir = fs.opendirSync(current);
        try {
          for (let child = dir.readSync(); child; child = dir.readSync()) {
            if (records.length >= 4096 || !/^[\x20-\x7e]+$/.test(child.name) ||
              names.has(child.name.toLowerCase())) throw new Error("tree names");
            names.add(child.name.toLowerCase());
            walk(join(current, child.name), relative ? relative + "/" + child.name : child.name, depth + 1);
          }
        } finally { dir.closeSync(); }
      } else {
        const f = inspect(current, MAX); bytes += f.bytes;
        if (bytes > MAX) throw new Error("tree bytes");
        records.push({ relative, text: `F\0${relative}\0${id.fileId}\0${id.volumeId}\0${f.bytes}\0${f.sha256}\n` });
      }
    };
    try {
      walk(path, "", 0);
      records.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
      return { ...identity(path), entries: records.length, bytes, sha256: sha(records.map(r => r.text).join("")) };
    } finally { held.reverse().forEach(fd => fs.closeSync(fd)); }
  };
  const port: NativePrivateFilesystemPort = {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory(path) { if (!fs.lstatSync(path).isDirectory()) throw new Error("directory"); return identity(path); },
    inspectFileIdentity: identity, inspectFile: inspect, inspectTree: tree,
    read(path, expected, max) { exact(path, expected, max); return fs.readFileSync(path); },
    writeNew(path, bytes, max) {
      if (bytes.length > max) throw new Error("wire cap");
      calls.push("write:" + basename(path)); fs.writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      return receipt(path, max);
    },
    copyNew(source, destination, expected, max) {
      calls.push("copy"); exact(source, expected, max);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      if (faults.copyUnknown) throw new Error("UNKNOWN copy");
      return receipt(destination, max);
    },
    renameNew(source, destination, expected, max) {
      exact(source, expected, max); if (fs.existsSync(destination)) throw new Error("collision");
      fs.renameSync(source, destination); return receipt(destination, max);
    },
    unlinkExact(path, expected, max) { exact(path, expected, max); calls.push("unlink:" + basename(path)); fs.unlinkSync(path); },
    proveSync(path, expected) { exact(path, expected, MAX); calls.push("prove:" + basename(path)); return receipt(path, MAX); },
    createDirectory(path) {
      fs.mkdirSync(path, { mode: 0o700 }); const pin = identity(path);
      faults.afterDirectory?.(path); return pin;
    },
    snapshotSqlite(db, path) {
      calls.push("snapshot"); fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      db.prepare("VACUUM INTO ?").run(path); return receipt(path, MAX);
    },
    acquireSqliteLease(path, expected) {
      expect(identity(path)).toEqual({ path: expected.path, fileId: expected.fileId, volumeId: expected.volumeId });
      calls.push("lease-acquire");
      if (faults.lease) throw new Error("lease failure");
      let closed = false;
      return {
        assertHeld() {
          if (closed) throw new Error("lease closed"); calls.push("lease-held");
          expect(identity(path)).toEqual({ path: expected.path, fileId: expected.fileId, volumeId: expected.volumeId });
        },
        close() {
          if (closed) throw new Error("lease closed");
          closed = true; calls.push("lease-close"); faults.afterLeaseClose?.(path);
        },
      };
    },
    renameDirectoryNew(source, destination, expected, check) {
      calls.push("rename-directory");
      faults.beforeRename?.(source, destination);
      for (const phase of ["reserve", "dispatch"] as const) {
        calls.push(phase); check?.(phase);
        expect(tree(source)).toEqual(expected);
        if (fs.existsSync(destination)) throw new Error("collision");
      }
      fs.renameSync(source, destination);
      if (faults.renameUnknown) throw new Error("UNKNOWN rename");
      const after = tree(destination);
      expect(after).toEqual({ ...expected, path: destination });
      calls.push("success"); check?.("success");
      return { profile: "WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1", scope: "PROCESS_CRASH", identity: after };
    },
  };
  return { port, calls, faults };
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-native-families-"))); roots.push(root);
  const workspace = join(root, "workspace"), assets = join(workspace, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const store = new Store(join(workspace, "workspace.sqlite")); stores.push(store);
  const page = store.create(null, "page", "committed WAL page");
  const input = join(root, "input.png"), bytes = Buffer.from("original asset bytes");
  fs.writeFileSync(input, bytes);
  const asset = attachFile(store.db, assets, input);
  return { root, workspace, assets, store, page, asset, bytes, ...adapter() };
}
function scoped<T>(f: ReturnType<typeof adapter>, work: () => T): T {
  return withPrivatePersistence({ nativePrivateFilesystem: f.port }, work);
}
function pageData(path: string): unknown {
  const db = new DatabaseSync(join(path, "workspace.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT data FROM pages ORDER BY id").all(); } finally { db.close(); }
}
function fullBackups(f: ReturnType<typeof fixture>) {
  const backups = join(f.workspace, "backups"); fs.mkdirSync(backups);
  const make = (n: number) => {
    const path = join(backups, `workspace-${1700000000000 + n}-${randomUUID()}`);
    createFullBackup(f.store.db, f.workspace, path);
    const manifestPath = join(path, "manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.createdAt = new Date(1700000000000 + n).toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    return path;
  };
  const older = make(1), newer = make(2), external = join(f.root, "external"); fs.mkdirSync(external);
  return { older, newer, external };
}
function portable(f: ReturnType<typeof fixture>): string {
  const database = f.store.create(null, "database", "record owner");
  const repo = new RecordRepository(f.store);
  f.store.transaction(() => { repo.createSchema(); repo.attachForMigration(f.page.id, database.id, 4, { status: "saved" }); });
  return exportPortableRecordRecovery(f.store, f.assets, [{
    page: { ...f.page, cover: f.asset.url }, baseValues: { status: "saved" }, valuesPatch: { status: "pending" },
  }]);
}
function conflict(f: ReturnType<typeof fixture>) {
  const checkpoint = buildWorkspaceCheckpoint(f.store.db);
  const path = join(f.root, "bundle");
  exportRecoveryArchive({ checkpoint, target: { source: "a".repeat(64), id: 1, operationId: "op",
    kind: "conflict", createdAt: 1, checkpointHash: hashCheckpoint(checkpoint) } },
  f.workspace, path, "complete-bundle", { assertTarget() {}, admitBytes() {} });
  return verifyRecoveryBundle(path);
}

describe("remaining native private families — POSIX simulation, NOT Windows acceptance (authored, NOT_RUN)", () => {
  it("backs up and migrates committed WAL with one asset, retains backup, removes original-ID markers", () => {
    const f = fixture(), original = pageData(f.workspace);
    scoped(f, () => {
      const backup = backupWorkspace(f.workspace, join(f.root, "legacy-backup"));
      const result = migrateWorkspace(f.workspace, join(f.root, "destination"));
      for (const path of [backup, result.backup, result.destination]) {
        expect(pageData(path)).toEqual(original);
        expect(fs.readFileSync(join(path, "assets", f.asset.id))).toEqual(f.bytes);
        expect(fs.existsSync(join(path, MARKER))).toBe(false);
      }
      expect(pageData(f.workspace)).toEqual(original);
      expect(fs.readFileSync(join(f.assets, f.asset.id))).toEqual(f.bytes);
      expect(f.calls).toEqual(expect.arrayContaining(["snapshot", "copy", "rename-directory", "reserve", "dispatch", "success"]));
    });
  });
  it("refuses admission asset replacement before any output and leaves an existing destination untouched", () => {
    const f = fixture(), target = join(f.root, "destination"), before = fs.readdirSync(f.root).sort();
    scoped(f, () => {
      expect(() => migrateWorkspace(f.workspace, target, { beforeCopy() {
        // Same asset name/count/bytes, different file ID; the old object is
        // retained at the disposable input path, not added to the inventory.
        fs.renameSync(join(f.assets, f.asset.id), join(f.root, "input.png"));
        fs.writeFileSync(join(f.assets, f.asset.id), f.bytes);
      } })).toThrow();
      expect(fs.readdirSync(f.root).sort()).toEqual(before);
      fs.mkdirSync(target); fs.writeFileSync(join(target, "keep"), "collision evidence");
      expect(() => migrateWorkspace(f.workspace, target)).toThrow();
      expect(fs.readFileSync(join(target, "keep"), "utf8")).toBe("collision evidence");
    });
  });
  it("retains moved marked destination and backup on rename UNKNOWN, never deletes or retries", () => {
    const f = fixture(), target = join(f.root, "destination"); f.faults.renameUnknown = true;
    scoped(f, () => {
      expect(() => migrateWorkspace(f.workspace, target)).toThrow("UNKNOWN");
      expect(fs.existsSync(join(target, MARKER))).toBe(true);
      expect(fs.readdirSync(f.root).filter(n => n.startsWith("destination.backup-"))).toHaveLength(1);
      expect(f.calls.filter(c => c === "rename-directory")).toHaveLength(1);
      expect(fs.readFileSync(join(f.assets, f.asset.id))).toEqual(f.bytes);
    });
  });
  it("rejects stale held-tree digest and added child", () => {
    const f = fixture(), source = join(f.root, "tree"), target = join(f.root, "moved"); fs.mkdirSync(source);
    const tree = f.port.inspectTree!(source); fs.writeFileSync(join(source, "added"), "new");
    expect(() => f.port.renameDirectoryNew!(source, target, tree)).toThrow();
    expect(fs.existsSync(source)).toBe(true); expect(fs.existsSync(target)).toBe(false);
  });
  it("archives older verified generation by directory method, preserving fingerprint and newer backup", () => {
    const f = fixture(), b = fullBackups(f);
    scoped(f, () => {
      const plan = planBackupArchive(f.workspace, b.older, () => false);
      const moved = archiveBackup(f.workspace, b.older, b.external, plan.fingerprint, () => false);
      expect(verifyFullBackup(join(moved.destination, basename(b.older))).fingerprint).toBe(plan.fingerprint);
      expect(fs.existsSync(b.older)).toBe(false); expect(fs.existsSync(b.newer)).toBe(true);
      expect(f.calls.filter(c => c === "rename-directory")).toHaveLength(1);
    });
  });
  it.each(["pin", "fingerprint", "no-newer", "wrapper", "collision"] as const)("refuses archive %s without overwriting evidence", fault => {
    const f = fixture(), b = fullBackups(f);
    scoped(f, () => {
      const plan = planBackupArchive(f.workspace, b.older, () => false);
      if (fault === "no-newer") fs.rmSync(b.newer, { recursive: true });
      if (fault === "wrapper") f.faults.afterDirectory = path => {
        if (basename(path).startsWith("folio-backup-archive-")) {
          fs.renameSync(path, path + ".original"); fs.mkdirSync(path);
        }
      };
      if (fault === "collision") f.faults.beforeRename = (_source, dest) => {
        fs.mkdirSync(dest); fs.writeFileSync(join(dest, "keep"), "collision");
      };
      expect(() => archiveBackup(f.workspace, b.older, b.external,
        fault === "fingerprint" ? "0".repeat(64) : plan.fingerprint, () => fault === "pin")).toThrow();
      expect(fs.existsSync(b.older)).toBe(true);
    });
  });
  it("retains archive wrapper and moved evidence on UNKNOWN without retry", () => {
    const f = fixture(), b = fullBackups(f); f.faults.renameUnknown = true;
    scoped(f, () => {
      const plan = planBackupArchive(f.workspace, b.older, () => false);
      expect(() => archiveBackup(f.workspace, b.older, b.external, plan.fingerprint, () => false)).toThrow("UNKNOWN");
      const wrappers = fs.readdirSync(b.external); expect(wrappers).toHaveLength(1);
      expect(verifyFullBackup(join(b.external, wrappers[0], basename(b.older))).fingerprint).toBe(plan.fingerprint);
      expect(f.calls.filter(c => c === "rename-directory")).toHaveLength(1);
    });
  });
  it("restores portable pages/records/assets with rewritten IDs and closes Store before lease", () => {
    const f = fixture(), content = portable(f), target = join(f.root, "portable");
    const originalClose = Store.prototype.close;
    let closingConnection: DatabaseSync | undefined;
    f.faults.afterLeaseClose = () => { expect(closingConnection?.isOpen).toBe(false); };
    vi.spyOn(Store.prototype, "close").mockImplementation(function(this: Store) {
      closingConnection = this.db;
      f.calls.push("store-close"); originalClose.call(this);
    });
    scoped(f, () => {
      const out = restorePortableRecordRecoveryToNewWorkspace(content, target);
      expect(out.pageIds[f.page.id]).not.toBe(f.page.id);
      expect(out.assetIds[f.asset.id]).not.toBe(f.asset.id);
      expect(fs.readFileSync(join(target, "assets", out.assetIds[f.asset.id]))).toEqual(f.bytes);
      expect(fs.readFileSync(join(target, "FOLIO-RECOVERY-ORIGINAL.json"), "utf8")).toBe(content);
      const db = new DatabaseSync(join(target, "workspace.sqlite"), { readOnly: true });
      try { expect(db.prepare("SELECT count(*) AS n FROM record_memberships").get()?.n).toBe(1); } finally { db.close(); }
      expect(f.calls.indexOf("lease-close")).toBeGreaterThan(f.calls.indexOf("store-close"));
      expect(f.calls.indexOf("prove:workspace.sqlite")).toBeGreaterThan(f.calls.indexOf("lease-close"));
      expect(fs.existsSync(join(target, MARKER))).toBe(false);
      expect(fs.existsSync(join(target, "FOLIO-RECOVERY-COMPLETE"))).toBe(true);
    });
  });
  it.each(["database", "before-complete", "lease"] as const)("retains portable marker and original on %s failure", fault => {
    const f = fixture(), content = portable(f), target = join(f.root, "portable");
    if (fault === "lease") f.faults.lease = true;
    scoped(f, () => {
      expect(() => restorePortableRecordRecoveryToNewWorkspace(content, target, phase => {
        if (phase === fault) throw new Error("injected");
      })).toThrow();
      expect(fs.existsSync(join(target, MARKER))).toBe(true);
      expect(fs.readFileSync(join(target, "FOLIO-RECOVERY-ORIGINAL.json"), "utf8")).toBe(content);
      expect(() => restorePortableRecordRecoveryToNewWorkspace(content, target)).toThrow();
      expect(fs.readFileSync(join(f.assets, f.asset.id))).toEqual(f.bytes);
    });
  });
  it("restores conflict checkpoint/page/asset by native copy with matching recovered-content hash", () => {
    const f = fixture(), bundle = conflict(f), target = join(f.root, "restored");
    scoped(f, () => {
      const out = restoreRecoveryBundle(bundle, target, { admitBytes() {} });
      expect(inspectRecoveredContent(target, out.checkpointHash)).toBe(out.recoveryId);
      expect(out.checkpointHash).toBe(hashCheckpoint(bundle.checkpoint));
      expect(fs.readFileSync(join(target, "assets", f.asset.id))).toEqual(f.bytes);
      expect(fs.existsSync(join(target, MARKER))).toBe(false);
      expect(f.calls).toContain("copy");
      expect(verifyRecoveryBundle(bundle.directory).fingerprint).toBe(bundle.fingerprint);
    });
  });
  it("revalidates conflict source after admission before output", () => {
    const f = fixture(), bundle = conflict(f), target = join(f.root, "restored");
    scoped(f, () => {
      expect(() => restoreRecoveryBundle(bundle, target, { admitBytes() {
        fs.writeFileSync(join(bundle.directory, "assets", f.asset.id), "mutated");
      } })).toThrow();
      expect(fs.existsSync(target)).toBe(false);
    });
  });
  it("retains conflict marker on asset copy UNKNOWN and refuses stale asset/collision without replacement", () => {
    const f = fixture(), bundle = conflict(f), target = join(f.root, "restored"); f.faults.copyUnknown = true;
    scoped(f, () => {
      expect(() => restoreRecoveryBundle(bundle, target, { admitBytes() {} })).toThrow("UNKNOWN");
      expect(fs.existsSync(join(target, MARKER))).toBe(true);
      expect(fs.readFileSync(join(target, "assets", f.asset.id))).toEqual(f.bytes);
      expect(() => restoreRecoveryBundle(bundle, target, { admitBytes() {} })).toThrow();
      f.faults.copyUnknown = false;
      const asset = bundle.manifest.assets[0];
      expect(() => copyRecoveryAsset(bundle.directory, target, asset)).toThrow();
      fs.writeFileSync(join(bundle.directory, "assets", f.asset.id), "stale");
      expect(() => copyRecoveryAsset(bundle.directory, target, asset)).toThrow();
      expect(fs.readFileSync(join(target, "assets", f.asset.id))).toEqual(f.bytes);
    });
  });
  it("rejects same-byte portable asset replacement in before-complete and retains original evidence", () => {
    const f = fixture(), content = portable(f), target = join(f.root, "portable-replaced-asset");
    scoped(f, () => {
      expect(() => restorePortableRecordRecoveryToNewWorkspace(content, target, phase => {
        if (phase !== "before-complete") return;
        const assets = join(target, "assets"), path = join(assets, fs.readdirSync(assets)[0]);
        fs.renameSync(path, join(f.root, "retained-original-asset"));
        fs.writeFileSync(path, f.bytes, { flag: "wx" });
      })).toThrow("identity changed");
      expect(fs.existsSync(join(target, MARKER))).toBe(true);
      expect(fs.readFileSync(join(target, "FOLIO-RECOVERY-ORIGINAL.json"), "utf8")).toBe(content);
      expect(f.calls).not.toContain("unlink:" + MARKER);
    });
  });
  it.each(["portable", "conflict"] as const)("rejects %s DB replacement at final lease release before marker unlink", family => {
    const f = fixture(), target = join(f.root, "replaced-db");
    const content = family === "portable" ? portable(f) : undefined;
    const bundle = family === "conflict" ? conflict(f) : undefined;
    let closes = 0;
    f.faults.afterLeaseClose = path => {
      // Conflict has a distinct second inspection lease; replace only on its
      // release, so this exercises the final identity check, not reacquisition.
      if (++closes !== (family === "portable" ? 1 : 2)) return;
      fs.copyFileSync(path, path + ".replacement", fs.constants.COPYFILE_EXCL);
      fs.renameSync(path, path + ".retained");
      fs.renameSync(path + ".replacement", path);
    };
    scoped(f, () => {
      expect(() => family === "portable"
        ? restorePortableRecordRecoveryToNewWorkspace(content!, target)
        : restoreRecoveryBundle(bundle!, target, { admitBytes() {} })).toThrow(/identity.changed/);
      expect(closes).toBe(family === "portable" ? 1 : 2);
      expect(fs.existsSync(join(target, MARKER))).toBe(true);
      expect(fs.existsSync(join(target, "workspace.sqlite.retained"))).toBe(true);
      expect(f.calls).not.toContain("prove:workspace.sqlite");
      expect(f.calls).not.toContain("unlink:" + MARKER);
    });
  });
  it.each(["portable", "conflict"] as const)("retains %s Store/lease on uncertain close without a second close attempt", family => {
    const f = fixture(), target = join(f.root, "close-unknown");
    const content = family === "portable" ? portable(f) : undefined;
    const bundle = family === "conflict" ? conflict(f) : undefined;
    const originalClose = Store.prototype.close;
    let captured: Store | undefined, attempts = 0;
    const spy = vi.spyOn(Store.prototype, "close").mockImplementation(function(this: Store) {
      if (this.path !== join(target, "workspace.sqlite")) return originalClose.call(this);
      captured = this; attempts++; throw new Error("injected SQLite close UNKNOWN");
    });
    try {
      scoped(f, () => {
        expect(() => family === "portable"
          ? restorePortableRecordRecoveryToNewWorkspace(content!, target)
          : restoreRecoveryBundle(bundle!, target, { admitBytes() {} })).toThrow("UNKNOWN");
        expect(attempts).toBe(1);
        expect(captured?.db.isOpen).toBe(true);
        expect(f.calls).not.toContain("lease-close");
        expect(fs.existsSync(join(target, MARKER))).toBe(true);
      });
    } finally {
      // Test-only teardown, outside the simulated operation: production has
      // deliberately retained this owner and exposes no automatic retry API.
      spy.mockRestore();
      if (captured) originalClose.call(captured);
    }
  });
  it("retains source DatabaseSync lease when close throws with isOpen true", () => {
    const f = fixture(), originalClose = DatabaseSync.prototype.close;
    let captured: DatabaseSync | undefined, attempts = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
      const main = this.prepare("PRAGMA database_list").all().find(row => row.name === "main");
      if (main?.file !== join(f.workspace, "workspace.sqlite")) return originalClose.call(this);
      captured = this; attempts++; throw new Error("source close UNKNOWN");
    });
    try {
      scoped(f, () => {
        expect(() => migrateWorkspace(f.workspace, join(f.root, "no-output"), {
          beforeCopy() { throw new Error("stop before output"); },
        })).toThrow("UNKNOWN");
        expect(attempts).toBe(1); expect(captured?.isOpen).toBe(true);
        expect(f.calls).not.toContain("lease-close");
        expect(fs.existsSync(join(f.root, "no-output"))).toBe(false);
      });
    } finally {
      spy.mockRestore();
      if (captured) originalClose.call(captured); // disposable test cleanup only
    }
  });
});
