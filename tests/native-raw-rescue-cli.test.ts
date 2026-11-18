import fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runRawRescueCli, type RawRescueCliOptions, type RawRescueIo } from "../src/main/raw-rescue-cli";
import {
  privatePersistencePort,
  type NativePrivateFile,
  type NativePrivateFilesystemPort,
  type NativePrivateIdentity,
} from "../src/platform/private-persistence";
import type { WindowsProductNativeOptions } from "../src/platform/windows/product-native";
import type { WindowsOperatorConfig } from "../src/platform/windows/operator-native";

const MARKER = "FOLIO-RAW-SALVAGE-INCOMPLETE";
const CAP = 256 * 1024 * 1024;
const roots: string[] = [];
const connections: DatabaseSync[] = [];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => {
  for (const db of connections.splice(0)) if (db.isOpen) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function captureIo(cwd: string, events: string[] = []) {
  let out = "", err = "";
  const io: RawRescueIo = {
    cwd: () => cwd,
    out(text) { events.push("stdout"); out += text; },
    err(text) { err += text; },
  };
  return { io, get out() { return out; }, get err() { return err; } };
}

/** Disposable POSIX simulation ONLY. dev/ino are synthetic native IDs here,
 * never Windows file-ID, DACL, sharing, helper, or durability acceptance. */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-native-rescue-cli-")));
  roots.push(root);
  const workspace = join(root, "workspace"), destination = join(root, "destination");
  const asset = join(workspace, "assets", "nested", "asset.bin");
  const journal = join(workspace, "crash-recovery.json");
  const stage = join(workspace, "crash-recovery.json.stage-original-1");
  const database = join(workspace, "workspace.sqlite");
  fs.mkdirSync(dirname(asset), { recursive: true });
  fs.mkdirSync(destination);
  fs.writeFileSync(asset, Buffer.from([0, 1, 2, 255, 11]));
  fs.writeFileSync(journal, Buffer.from([255, 0, 123, 10, 125]));
  fs.writeFileSync(stage, "not parsed or migrated\r\n");
  const writer = new DatabaseSync(database); connections.push(writer);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=999; CREATE TABLE raw_rows(value TEXT)");
  writer.prepare("INSERT INTO raw_rows VALUES(?)").run("committed only in WAL");
  expect(fs.statSync(database + "-wal").size).toBeGreaterThan(0);
  const events: string[] = [], hashedPaths: string[] = [], identityPaths: string[] = [];
  const caps: number[] = [], overrides = new Map<string, string>();
  const faults = {
    current: true, acquireUnknown: false, leaseCloseUnknown: false,
    productCloseUnknown: false, copyUnknown: false, markerWriteUnknown: false,
    markerUnlinkUnknown: false, openThrows: false,
    sqlClose: "ok" as "ok" | "before" | "after",
    beforeOpen: undefined as undefined | (() => void),
    beforeCopy: undefined as undefined | (() => void),
    afterSnapshot: undefined as undefined | (() => void),
    afterMarkerUnlink: undefined as undefined | (() => void),
  };
  const env: NodeJS.ProcessEnv = {
    FOLIO_WINDOWS_NATIVE_ROOT: "C:\\Folio",
    FOLIO_WINDOWS_NATIVE_PROBE: "C:\\Tools\\FolioProbe.exe",
    FOLIO_WINDOWS_NATIVE_SHA256: "a".repeat(64),
    FOLIO_WINDOWS_PUBLICATION_STATE_ROOT: "D:\\FolioState",
    FOLIO_WINDOWS_PUBLICATION_STATE_DIR: "D:\\FolioState\\private",
    FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES: "1",
    SystemRoot: "C:\\Windows",
  };
  let productOptions: WindowsProductNativeOptions | undefined;
  let receivedConfig: WindowsOperatorConfig | undefined;
  let reader: DatabaseSync | undefined;
  let held = false, productClosed = false, primaryLeaseAcquired = false;
  const readerLeases = new Set<symbol>();
  const scoped = () => expect(privatePersistencePort()?.platform).toBe("win32");
  const current = () => {
    scoped();
    if (!faults.current || productClosed) throw new Error("SIMULATED_CURRENT_STALE");
    productOptions!.assertCurrent();
  };
  const identity = (path: string): NativePrivateIdentity => {
    const s = fs.lstatSync(path, { bigint: true });
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()) || (s.isFile() && s.nlink !== 1n))
      throw new Error("SIMULATED_UNSAFE_IDENTITY");
    return {
      path, fileId: overrides.get(path) ?? s.ino.toString(16).padStart(32, "0"),
      volumeId: s.dev.toString(16).padStart(16, "0"),
    };
  };
  const inspect = (path: string, max: number): NativePrivateFile => {
    current(); hashedPaths.push(path); caps.push(max);
    // Mutable main/WAL/SHM/journal must never be hashed as immutable input.
    if (path === database || path.startsWith(database + "-")) throw new Error("LIVE_DATABASE_HASH_FORBIDDEN");
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > max || max > CAP)
        throw new Error("SIMULATED_NATIVE_CAP");
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
      if (bytes.length !== before.size || after.ino !== before.ino || after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw new Error("SIMULATED_FILE_CHANGED");
      return { ...identity(path), bytes: bytes.length, sha256: sha(bytes) };
    } finally { fs.closeSync(fd); }
  };
  const exact = (path: string, expected: NativePrivateFile, max: number) =>
    expect(inspect(path, max)).toEqual(expected);
  const receipt = (path: string, max: number) => ({
    profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const,
    scope: "PROCESS_CRASH" as const, identity: inspect(path, max),
  });
  const port: NativePrivateFilesystemPort = {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory(path) {
      current(); if (!fs.lstatSync(path).isDirectory()) throw new Error("directory");
      events.push("directory-proof:" + basename(path)); return identity(path);
    },
    inspectFileIdentity(path) { current(); identityPaths.push(path); return identity(path); },
    inspectFile: inspect,
    read(path, expected, max) { exact(path, expected, max); return fs.readFileSync(path); },
    writeNew(path, bytes, max) {
      current(); caps.push(max); events.push("write:" + basename(path));
      if (bytes.length > max || max > CAP) throw new Error("SIMULATED_NATIVE_CAP");
      fs.writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      if (basename(path) === MARKER && faults.markerWriteUnknown) throw new Error("UNKNOWN marker write applied");
      return receipt(path, max);
    },
    copyNew(source, target, expected, max) {
      current(); events.push("copy:" + basename(source)); exact(source, expected, max);
      faults.beforeCopy?.(); current();
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (faults.copyUnknown) throw new Error("UNKNOWN copy applied");
      return receipt(target, max);
    },
    renameNew() { throw new Error("unexpected rename"); },
    unlinkExact(path, expected, max) {
      current(); exact(path, expected, max); events.push("unlink:" + basename(path));
      fs.unlinkSync(path);
      faults.afterMarkerUnlink?.();
      if (faults.markerUnlinkUnknown) throw new Error("UNKNOWN marker unlink applied");
    },
    proveSync(path, expected) { exact(path, expected, CAP); return receipt(path, CAP); },
    createDirectory(path) { current(); events.push("mkdir:" + basename(path)); fs.mkdirSync(path); return identity(path); },
    snapshotSqlite(db, path) {
      current(); expect(held).toBe(true); expect(reader?.isOpen).toBe(true);
      events.push("snapshot"); fs.writeFileSync(path, "", { flag: "wx" });
      db.prepare("VACUUM INTO ?").run(path);
      const result = receipt(path, CAP);
      faults.afterSnapshot?.();
      return result;
    },
    acquireSqliteLease(path, expected) {
      current();
      const primary = path === database && !primaryLeaseAcquired;
      if (primary) {primaryLeaseAcquired = true; events.push("lease-acquire"); held = true;}
      else {
        expect(path === database || basename(path) === "workspace.raw.sqlite").toBe(true);
        events.push("reader-lease-acquire:" + basename(path));
      }
      expect(identity(path)).toEqual(expected);
      const id = Symbol(path); readerLeases.add(id);
      if (primary && faults.acquireUnknown) throw new Error("UNKNOWN lease acquire");
      return {
        assertHeld() {
          current(); expect(readerLeases.has(id)).toBe(true);
          if (JSON.stringify(identity(path)) !== JSON.stringify(expected)) throw new Error("SIMULATED_LEASE_IDENTITY_CHANGED");
        },
        close() {
          scoped();
          if (primary) {
            events.push("lease-close"); expect(reader?.isOpen ?? false).toBe(false);
            if (faults.leaseCloseUnknown) throw new Error("UNKNOWN lease close");
            held = false;
          } else events.push("reader-lease-close:" + basename(path));
          expect(readerLeases.delete(id)).toBe(true);
        },
      };
    },
  };
  const rootPin = identity(root);
  const execution: RawRescueCliOptions = {
    untrustedTest: {
      trust: "untrusted-test", platform: "win32", env,
      createProductNative(config, options) {
        events.push("factory"); receivedConfig = config; productOptions = options;
        return {
          privateFilesystem: port,
          assertRoot() {
            current();
            if (JSON.stringify(identity(root)) !== JSON.stringify(rootPin)) throw new Error("SIMULATED_ROOT_CHANGED");
          },
          close() {
            scoped(); events.push("product-close"); expect(held).toBe(false); expect(readerLeases.size).toBe(0);
            if (faults.productCloseUnknown) throw new Error("UNKNOWN product close");
            productClosed = true;
          },
        };
      },
      openReadOnlyDatabase(path) {
        scoped(); expect(held).toBe(true); events.push("sql-open");
        faults.beforeOpen?.();
        if (faults.openThrows) throw new Error("UNKNOWN SQLite open");
        const db = new DatabaseSync(path, { readOnly: true }); reader = db; connections.push(db);
        expect(() => db.exec("INSERT INTO raw_rows VALUES('forbidden')")).toThrow();
        return new Proxy(db, {
          get(target, key) {
            if (key === "close") return () => {
              scoped(); events.push("sql-close");
              if (faults.sqlClose === "before") throw new Error("UNKNOWN SQLite close");
              target.close(); events.push("sql-closed");
              if (faults.sqlClose === "after") throw new Error("SQLite closed with error");
            };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    },
  };
  const output = captureIo(root, events);
  const args = ["--workspace", workspace, "--destination", destination, "--workspace-closed"];
  const run = () => runRawRescueCli(args, output.io, execution);
  const bundle = () => {
    const names = fs.readdirSync(destination).filter(name => name.startsWith("folio-raw-salvage-"));
    expect(names).toHaveLength(1); return join(destination, names[0]);
  };
  const sourceHashes = () => Object.fromEntries(
    [database, database + "-wal", asset, journal, stage].map(path => [path, sha(fs.readFileSync(path))]),
  );
  return {
    root, workspace, destination, database, asset, journal, stage, writer, execution, events,
    faults, overrides, hashedPaths, identityPaths, caps, output, args, run, bundle, sourceHashes,
    get productOptions() { return productOptions!; }, get receivedConfig() { return receivedConfig; },
    get reader() { return reader; }, get held() { return held; },
  };
}

it("help and usage never select a factory, open SQLite, or inspect a workspace", () => {
  let touched = false;
  const execution: RawRescueCliOptions = {
    untrustedTest: {
      trust: "untrusted-test", platform: "win32",
      env: { FOLIO_WINDOWS_NATIVE_ROOT: "incomplete configuration" },
      createProductNative() { touched = true; throw new Error("must not run"); },
      openReadOnlyDatabase() { touched = true; throw new Error("must not run"); },
    },
  };
  const output = captureIo("/not-used");
  output.io.cwd = () => { touched = true; throw new Error("must not run"); };
  expect(runRawRescueCli(["--help"], output.io, execution)).toBe(0);
  expect(runRawRescueCli([], output.io, execution)).toBe(2);
  expect(output.out).toContain("--workspace-closed");
  expect(touched).toBe(false);
});

it.skipIf(process.platform !== "win32")("rejects simulation rescue execution on real win32 before factory dispatch", () => {
  let dispatched = false;
  const output = captureIo("C:\\unused");
  expect(runRawRescueCli(
    ["--workspace", "C:\\unused", "--destination", "C:\\other", "--workspace-closed"],
    output.io, { untrustedTest: {
      trust: "untrusted-test", platform: "win32", env: {},
      createProductNative() { dispatched = true; throw new Error("forbidden"); },
    } },
  )).toBe(1);
  expect(output.err).toContain("TEST_OPTIONS_FORBIDDEN");
  expect(dispatched).toBe(false);
});

describe.skipIf(process.platform === "win32")("actual runRawRescueCli Windows branch, untrusted POSIX simulation only", () => {
  it.each([{}, { FOLIO_WINDOWS_NATIVE_ROOT: "C:\\Folio" }])(
    "requires complete explicit installation configuration before source access: %j", (env) => {
      const f = fixture();
      const execution: RawRescueCliOptions = { untrustedTest: { ...f.execution.untrustedTest, env } };
      expect(runRawRescueCli(f.args, f.output.io, execution)).toBe(1);
      expect(f.events).not.toContain("factory");
      expect(f.events).not.toContain("sql-open");
      expect(fs.readdirSync(f.destination)).toEqual([]);
      expect(f.output.err).toMatch(/CONFIG_REQUIRED|CONFIG_INCOMPLETE/);
    },
  );

  it("uses the scoped native family and held source lease for WAL + nonempty assets + exact raw journals", () => {
    const f = fixture(), before = f.sourceHashes();
    expect(f.run()).toBe(0);
    expect(f.output.err).toBe("");
    expect(f.output.out).toContain("成功");
    expect(f.receivedConfig).toEqual({
      root: "C:\\Folio", probeExecutable: "C:\\Tools\\FolioProbe.exe",
      expectedHash: "a".repeat(64), publicationStateRoot: "D:\\FolioState",
      publicationStateDirectory: "D:\\FolioState\\private", systemRoot: "C:\\Windows",
    });
    expect(f.productOptions.enrollExistingSources).toBe(true);
    expect(() => f.productOptions.assertCurrent()).toThrow("SESSION_CLOSED");
    const bundle = f.bundle();
    expect(fs.existsSync(join(bundle, MARKER))).toBe(false);
    expect(fs.readFileSync(join(bundle, "assets", "nested", "asset.bin"))).toEqual(fs.readFileSync(f.asset));
    expect(fs.readFileSync(join(bundle, basename(f.journal)))).toEqual(fs.readFileSync(f.journal));
    expect(fs.readFileSync(join(bundle, basename(f.stage)))).toEqual(fs.readFileSync(f.stage));
    const manifest = JSON.parse(fs.readFileSync(join(bundle, "salvage-manifest.json"), "utf8")) as {
      restorable: boolean; files: number; entries: { path: string; bytes: number; sha256: string }[];
    };
    expect(manifest.restorable).toBe(false);
    expect(manifest.files).toBe(4);
    for (const entry of manifest.entries) {
      const bytes = fs.readFileSync(join(bundle, ...entry.path.split("/")));
      expect(bytes.length).toBe(entry.bytes); expect(sha(bytes)).toBe(entry.sha256);
    }
    const snapshot = new DatabaseSync(join(bundle, "workspace.raw.sqlite"), { readOnly: true });
    connections.push(snapshot);
    expect(snapshot.prepare("SELECT value FROM raw_rows").all()).toEqual([{ value: "committed only in WAL" }]);
    expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(999);
    expect(f.sourceHashes()).toEqual(before);
    expect(f.identityPaths).toEqual(expect.arrayContaining([f.database, f.database + "-wal", f.database + "-shm"]));
    expect(f.hashedPaths).toEqual(expect.arrayContaining([f.asset, f.journal, f.stage]));
    expect(f.hashedPaths.some(path => path === f.database || path.startsWith(f.database + "-"))).toBe(false);
    expect(f.events).toEqual(expect.arrayContaining([
      "snapshot", "copy:asset.bin", "copy:crash-recovery.json", "copy:crash-recovery.json.stage-original-1",
      "write:salvage-manifest.json", "unlink:" + MARKER,
    ]));
    const order = ["lease-acquire", "sql-open", "snapshot", "sql-close", "sql-closed", "lease-close", "product-close", "stdout"];
    expect(order.every(name => f.events.includes(name))).toBe(true);
    expect(order.map(name => f.events.indexOf(name))).toEqual([...order.map(name => f.events.indexOf(name))].sort((a, b) => a - b));
    expect(f.caps.every(max => max <= CAP)).toBe(true);
    expect(f.held).toBe(false);
  });

  it("does not implicitly enroll existing sources", () => {
    const f = fixture();
    delete f.execution.untrustedTest.env.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES;
    expect(f.run()).toBe(0);
    expect(f.productOptions.enrollExistingSources).toBe(false);
  });

  it("reports the configured evidence location without retrying UNKNOWN factory initialization", () => {
    const f = fixture(); let attempts = 0;
    const execution: RawRescueCliOptions = { untrustedTest: {
      ...f.execution.untrustedTest,
      createProductNative() { attempts++; throw new Error("UNKNOWN factory bootstrap"); },
    } };
    expect(runRawRescueCli(f.args, f.output.io, execution)).toBe(1);
    expect(attempts).toBe(1);
    expect(f.output.err).toContain("UNKNOWN factory bootstrap");
    expect(f.output.err).toContain("D:\\FolioState\\private");
    expect(f.output.out).toBe("");
    expect(f.events).not.toContain("sql-open");
  });

  it("rejects an injection not explicitly marked untrusted before factory dispatch", () => {
    const f = fixture();
    const execution = { untrustedTest: { ...f.execution.untrustedTest, trust: "native-helper" } };
    expect(runRawRescueCli(f.args, f.output.io, execution as unknown as RawRescueCliOptions)).toBe(1);
    expect(f.output.err).toContain("TEST_OPTIONS_FORBIDDEN");
    expect(f.events).not.toContain("factory");
  });

  it("refuses a file-only native port without falling back to POSIX or opening SQLite", () => {
    const f = fixture(), create = f.execution.untrustedTest.createProductNative;
    const execution: RawRescueCliOptions = { untrustedTest: {
      ...f.execution.untrustedTest,
      createProductNative(config, options) {
        const product = create(config, options);
        return { ...product, privateFilesystem: { ...product.privateFilesystem, acquireSqliteLease: undefined } };
      },
    } };
    expect(runRawRescueCli(f.args, f.output.io, execution)).toBe(1);
    expect(f.output.err).toContain("SQLITE_LEASE_REQUIRED");
    expect(f.events).not.toContain("sql-open");
    expect(f.events).not.toContain("snapshot");
    expect(fs.readdirSync(f.destination)).toEqual([]);
  });

  it("rejects a read-only SQLite connection to a different canonical file", () => {
    const f = fixture(), open = f.execution.untrustedTest.openReadOnlyDatabase!;
    const otherPath = join(f.root, "other.sqlite"), other = new DatabaseSync(otherPath);
    connections.push(other); other.exec("CREATE TABLE raw_rows(value TEXT)"); other.close();
    const execution: RawRescueCliOptions = { untrustedTest: {
      ...f.execution.untrustedTest, openReadOnlyDatabase: () => open(otherPath),
    } };
    expect(runRawRescueCli(f.args, f.output.io, execution)).toBe(1);
    expect(f.output.err).toContain("一致しません");
    expect(f.events).not.toContain("snapshot");
    expect(f.held).toBe(false);
  });

  it("rejects a changed native main-file ID even when Node namespace metadata is unchanged", () => {
    const f = fixture();
    f.faults.beforeOpen = () => f.overrides.set(f.database, "b".repeat(32));
    expect(f.run()).toBe(1);
    expect(f.output.err).toContain("LEASE_IDENTITY_CHANGED");
    expect(f.events).not.toContain("snapshot");
    expect(fs.readdirSync(f.destination)).toEqual([]);
    expect(f.events).toContain("lease-close");
    expect(f.events).toContain("product-close");
  });

  it.each(["root", "asset", "destination"] as const)("rejects native %s identity drift hidden from Node hints", (kind) => {
    const f = fixture();
    const target = kind === "root" ? f.root : kind === "asset" ? f.asset : f.destination;
    f.faults.afterSnapshot = () => f.overrides.set(target, "c".repeat(32));
    expect(f.run()).toBe(1);
    expect(f.output.out).toBe("");
    expect(f.output.err).toMatch(/ROOT_CHANGED|DESTINATION_CHANGED|ワークスペースが変更/);
    expect(f.events.filter(event => event === "write:" + MARKER)).toHaveLength(1);
    expect(fs.existsSync(join(f.bundle(), "workspace.raw.sqlite"))).toBe(true);
  });

  it("honors current immediately before native copy dispatch", () => {
    const f = fixture();
    f.faults.beforeCopy = () => { f.faults.current = false; };
    expect(f.run()).toBe(1);
    expect(f.output.err).toContain("CURRENT_STALE");
    expect(fs.existsSync(join(f.bundle(), "assets", "nested", "asset.bin"))).toBe(false);
    expect(fs.existsSync(join(f.bundle(), MARKER))).toBe(true);
    expect(f.events).not.toContain("unlink:" + MARKER);
  });

  it.each(["database", "asset", "journal"] as const)("rejects %s changes during the capture before completion", (kind) => {
    const f = fixture();
    f.faults.afterSnapshot = () => {
      if (kind === "database") {
        const before = f.reader!.prepare("PRAGMA data_version").get()?.data_version;
        f.writer.exec("INSERT INTO raw_rows VALUES('concurrent committed WAL')");
        expect(f.reader!.prepare("PRAGMA data_version").get()?.data_version).not.toBe(before);
      }
      else fs.writeFileSync(kind === "asset" ? f.asset : f.journal, "changed source");
    };
    expect(f.run()).toBe(1);
    expect(f.output.err).toContain("ワークスペースが変更");
    expect(f.output.out).toBe("");
    expect(fs.existsSync(join(f.bundle(), MARKER))).toBe(true);
    expect(f.events).not.toContain("unlink:" + MARKER);
  });

  it("rejects a commit after acknowledged marker removal without recreating it", () => {
    const f = fixture();
    f.faults.afterMarkerUnlink = () => f.writer.exec("INSERT INTO raw_rows VALUES('after unlink')");
    expect(f.run()).toBe(1);
    expect(f.output.out).toBe("");
    expect(f.output.err).toContain("ワークスペースが変更");
    expect(fs.existsSync(join(f.bundle(), MARKER))).toBe(false);
    expect(f.events.filter(event => event === "write:" + MARKER)).toHaveLength(1);
    expect(f.events.filter(event => event === "unlink:" + MARKER)).toHaveLength(1);
    expect(f.output.err).toContain("マーカーの有無だけで成功と判断しない");
  });

  it.each(["payload", "manifest"] as const)("requires native final %s proof after portable verification", (kind) => {
    const f = fixture(), before = f.sourceHashes();
    f.faults.afterMarkerUnlink = () => {
      const bundle = f.bundle();
      if (kind === "payload") fs.writeFileSync(join(bundle, "assets", "nested", "asset.bin"), "tampered output");
      else {
        const path = join(bundle, "salvage-manifest.json");
        const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
        manifest.restorable = true; fs.writeFileSync(path, JSON.stringify(manifest));
      }
    };
    expect(f.run()).toBe(1);
    expect(f.output.err).toContain("OUTPUT_UNVERIFIED");
    expect(f.output.out).toBe("");
    expect(f.sourceHashes()).toEqual(before);
    expect(f.events.filter(event => event === "write:" + MARKER)).toHaveLength(1);
    expect(fs.existsSync(join(f.bundle(), MARKER))).toBe(false);
  });

  it.each(["copy", "markerWrite", "markerUnlink"] as const)("preserves an applied UNKNOWN %s without retry, deletion, or marker reconstruction", (kind) => {
    const f = fixture(), before = f.sourceHashes();
    if (kind === "copy") f.faults.copyUnknown = true;
    if (kind === "markerWrite") f.faults.markerWriteUnknown = true;
    if (kind === "markerUnlink") f.faults.markerUnlinkUnknown = true;
    expect(f.run()).toBe(1);
    expect(f.output.err).toContain("UNKNOWN");
    expect(f.output.out).toBe("");
    expect(f.sourceHashes()).toEqual(before);
    const bundle = f.bundle();
    expect(f.events.filter(event => event === "write:" + MARKER)).toHaveLength(1);
    if (kind === "markerWrite") {
      expect(f.events).not.toContain("snapshot");
      expect(fs.existsSync(join(bundle, MARKER))).toBe(true);
    } else {
      expect(fs.existsSync(join(bundle, "workspace.raw.sqlite"))).toBe(true);
      expect(fs.readFileSync(join(bundle, "assets", "nested", "asset.bin"))).toEqual(fs.readFileSync(f.asset));
      expect(f.events.filter(event => event === "copy:asset.bin")).toHaveLength(1);
      expect(fs.existsSync(join(bundle, MARKER))).toBe(kind !== "markerUnlink");
    }
    expect(f.output.err).toContain(bundle);
    expect(f.output.err).toContain("証拠保存先");
    expect(f.output.err).not.toContain("出力は作成していません");
  });

  it.each(["acquire", "open", "sqlClose", "leaseClose", "productClose"] as const)(
    "retains uncertain %s owners and never reports success or retries cleanup", (kind) => {
      const f = fixture();
      if (kind === "acquire") f.faults.acquireUnknown = true;
      if (kind === "open") f.faults.openThrows = true;
      if (kind === "sqlClose") f.faults.sqlClose = "before";
      if (kind === "leaseClose") f.faults.leaseCloseUnknown = true;
      if (kind === "productClose") f.faults.productCloseUnknown = true;
      expect(f.run()).toBe(1);
      expect(f.output.out).toBe("");
      expect(f.output.err).toContain("UNKNOWN");
      expect(() => f.productOptions.assertCurrent()).toThrow("SESSION_CLOSED");
      for (const name of ["lease-acquire", "sql-close", "lease-close", "product-close"])
        expect(f.events.filter(event => event === name).length).toBeLessThanOrEqual(1);
      if (["acquire", "open", "sqlClose"].includes(kind)) {
        expect(f.events).not.toContain("lease-close");
        expect(f.events).not.toContain("product-close");
        expect(f.held).toBe(true);
      }
      if (kind === "leaseClose") expect(f.events).not.toContain("product-close");
      if (["sqlClose", "leaseClose", "productClose"].includes(kind))
        expect(fs.existsSync(join(f.bundle(), "workspace.raw.sqlite"))).toBe(true);
    },
  );

  it("releases the lease after definite SQLite close but still fails on a close error", () => {
    const f = fixture(); f.faults.sqlClose = "after";
    expect(f.run()).toBe(1);
    expect(f.reader?.isOpen).toBe(false);
    expect(f.events.indexOf("lease-close")).toBeGreaterThan(f.events.indexOf("sql-closed"));
    expect(f.events.indexOf("product-close")).toBeGreaterThan(f.events.indexOf("lease-close"));
    expect(f.held).toBe(false);
    expect(f.output.out).toBe("");
  });

  it("keeps the native 256 MiB guard stricter than the CLI 512 MiB file allowance", () => {
    const f = fixture(), fd = fs.openSync(f.asset, "r+");
    try { fs.ftruncateSync(fd, CAP + 1); } finally { fs.closeSync(fd); }
    expect(f.run()).toBe(1);
    expect(f.output.err).toContain("NATIVE_CAP");
    expect(f.events).not.toContain("sql-open");
    expect(f.events).not.toContain("snapshot");
    expect(fs.readdirSync(f.destination)).toEqual([]);
  });
});
