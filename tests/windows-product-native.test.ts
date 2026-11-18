import {exportSharedBackup} from "../src/main/shared-backup-export";
import {RuntimeStore} from "../src/collaboration/runtime/store";
import {exportBackup} from "../src/collaboration/runtime/backup";
import {canonical} from "../src/collaboration/runtime/canonical";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWindowsProductNativeForTesting,
  RawExportArchive,
  type WindowsProductNative,
  type WindowsProductNativeTestDeps,
} from "../src/platform/windows/product-native";
import { SqliteConnectionOwner } from "../src/sync/sqlite-connection-owner";
import type {
  WindowsRecoveryIoExecRequest,
  WindowsRecoveryIoExecResult,
} from "../src/platform/windows/private-recovery-io";
import type { WindowsRuntimeFileStat } from "../src/platform/windows/runtime-platform";
import type { WindowsOperatorConfig } from "../src/platform/windows/operator-native";
import type { WindowsPrivatePersistenceTestPort } from "../src/platform/windows/private-persistence";
import type { WindowsBackupArtifactTestPort } from "../src/platform/windows/backup-artifact";
import { WINDOWS_BACKUP_ARTIFACT_PROFILE } from "../src/platform/windows/backup-artifact";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import { CrashRecoveryFile } from "../src/persistence/crash-recovery-file";
import { writePendingJournalFileV3 } from "../src/persistence/pending-journal-file-v3";
import { emptyCrashRecoverySnapshot, type CrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { executePrivateMaintenance, parsePrivateMaintenanceArguments, privateMaintenanceSnapshotTarget } from "../src/platform/windows/private-maintenance-cli";
import { WINDOWS_HOT_JOURNAL_PROFILES } from "../src/platform/windows/hot-journal-snapshot";
import type { WindowsPrivatePersistenceInspection } from "../src/platform/windows/private-persistence-journal";
import { decodeWindowsMaintenanceOrigin } from "../src/platform/windows/private-maintenance-scope";
import type { WindowsPrivateTransferInspection } from "../src/platform/windows/private-transfer-journal";
import type { WindowsRecoveryMaintenanceInspection } from "../src/platform/windows/recovery-archive";
import type { NativePrivateFilesystemPort, NativePrivateTree } from "../src/platform/private-persistence";
import { withPrivatePersistence } from "../src/platform/private-persistence";
import { Store } from "../src/persistence/store";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";

// Contract-only composition fixture: relabelled POSIX platform for real
// disposable SQLite journals, a fake runtime probe for scoped native identity
// proofs, and a fake binary transport for the v3 recovery helper. This is
// never Windows OS/filesystem acceptance.
const ROOT = "C:\\Folio";
const STATE_ROOT = "C:\\FolioState";
const STATE_DIR = `${STATE_ROOT}\\current`;
const WS_DIR = `${ROOT}\\workspace-1`;
const LOGICAL = `${WS_DIR}\\crash-recovery.json`;
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("in-memory pinned product fixture executable");
const ROOT_ID = "1".repeat(32);
const STATE_ROOT_ID = "9".repeat(32);
const STATE_DIR_ID = "3".repeat(32);
const WS_ID = "2".repeat(32);
const VOLUME = "4".repeat(16);
const SID = "S-1-5-21-1000";
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
const products: WindowsProductNative[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const product of products.splice(0)) { try { product.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  // Let reporter IPC and timers drain between full synchronous native/SQLite compositions.
  await new Promise<void>(resolve => setImmediate(resolve));
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-product-native-")));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

/** Relabelled "windows" adapter over the POSIX platform — same contract-only
 * stand-in as the io/archive tests: the POSIX 16 MiB ledger bound is dropped
 * while every other file/root proof check stays. Not OS acceptance. */
function testingPlatform(): (directory: string) => PrivatePlatform {
  return () => {
    const inner = new PosixPrivatePlatform();
    return {
      kind: "windows",
      bind: (d: string) => inner.bind(d),
      assertRoot: () => inner.assertRoot(),
      assertFile: (p: string) => {
        inner.assertRoot();
        const stat = lstatSync(p);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
            (stat.mode & 0o777) !== 0o600 ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid()))
          throw new Error("untrusted-file-proof");
      },
      assertSidecars: (p: string) => inner.assertSidecars(p),
      createExclusive: (p: string) => inner.createExclusive(p),
      assertEmptyFile: (p: string) => inner.assertEmptyFile(p),
      close: () => inner.close(),
    };
  };
}

const fileStat = (size: number): WindowsRuntimeFileStat => ({
  isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
  nlink: 1, dev: 7, ino: 42, size, mtimeMs: 1000,
});
const dirStat: WindowsRuntimeFileStat = {
  isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
  nlink: 1, dev: 7, ino: 7, size: 0, mtimeMs: 1000,
};

const idFor = (path: string): string => {
  const folded = path.replace(/\//g, "\\").toLowerCase();
  if (folded === ROOT.toLowerCase()) return ROOT_ID;
  if (folded === STATE_ROOT.toLowerCase()) return STATE_ROOT_ID;
  if (folded === STATE_DIR.toLowerCase()) return STATE_DIR_ID;
  return WS_ID;
};

function runtimeTestPort(stateDirectory: string,
  files: Map<string, {fileId: string; bytes: Uint8Array}>,
  overrides: Map<string, string>, observed: string[], physicalFiles: Map<string, string>,
  directories: ReadonlySet<string> = new Set()) {
  const entry = (path: string) => {
    const file = files.get(path) ?? [...files].find(([p]) => p.toLowerCase() === path.toLowerCase())?.[1];
    const physical = physicalFiles.get(path);
    if (file && physical) file.bytes = readFileSync(physical);
    return file;
  };
  const nativeId = (path: string) => overrides.get(path) ?? entry(path)?.fileId ??
    (path.startsWith(STATE_DIR + "\\") ? hash(Buffer.from(path)).slice(0, 32) : idFor(path));
  return {
    fs: {
      lstat(path: string): WindowsRuntimeFileStat {
        if (path === EXE) return fileStat(EXE_BYTES.byteLength);
        if (entry(path)) return fileStat(entry(path)!.bytes.byteLength);
        if (directories.has(path)) return dirStat;
        if (path.startsWith(STATE_DIR + "\\") && /\.sqlite(?:-(?:wal|shm|journal))?$/.test(path))
          return fileStat(lstatSync(join(stateDirectory, win32.basename(path))).size);
        if (/\.(?:sqlite|bin|json|tmp)(?:-(?:wal|shm|journal))?$/.test(path))
          throw Object.assign(new Error("Missing simulated file"), {code: "ENOENT"});
        return dirStat;
      },
      readFile: (path: string) => entry(path)?.bytes ?? EXE_BYTES,
      openReadWrite: (_path: string) => 3,
      fsync: (_fd: number) => {},
      close: (_fd: number) => {},
    },
    probe: {
      probe: (path: string, root: string) => {
        observed.push(path);
        return {
        platform: "win32", sid: SID, ownerSid: SID, daclPrivate: true,
        reparsePoint: false, linkCount: 1, localFilesystem: true,
        canonicalPath: path, canonicalRoot: root,
        fileId: nativeId(path), rootFileId: nativeId(root),
        rootVolumeId: VOLUME, volumeId: VOLUME,
      }; },
    },
  };
}

type Wire = Record<string, unknown>;
function encode(header: Wire, payload: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(header), "ascii");
  const frame = Buffer.alloc(4 + json.byteLength + payload.byteLength);
  frame.writeUInt32LE(json.byteLength, 0);
  json.copy(frame, 4);
  frame.set(payload, 4 + json.byteLength);
  return frame;
}
function decode(buffer: Uint8Array): { header: Wire; payload: Uint8Array } {
  const length = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
  return {
    header: JSON.parse(Buffer.from(buffer).subarray(4, 4 + length).toString("ascii")) as Wire,
    payload: Uint8Array.from(buffer.subarray(4 + length)),
  };
}
function proof(canonicalPath: string, root: string, fileId: string, rootFileId: string, rootVolumeId: string) {
  return {
    platform: "win32", sid: SID, ownerSid: SID, daclPrivate: true, reparsePoint: false,
    linkCount: 1, localFilesystem: true, canonicalPath, canonicalRoot: root,
    fileId, rootFileId, rootVolumeId, volumeId: rootVolumeId,
  };
}

/** Fake binary v3 helper. `published` persists across product reopens so a
 * fresh factory sees the same physical generation files. */
function recoveryTransport(legacy: { current: boolean } = { current: false }, faults: {unknownCommit?: boolean; unknownPrepare?: boolean;
  afterCommit?: () => void; afterMissing?: () => void} = {}) {
  const calls: { phase: string; wire: Wire; payload: Uint8Array }[] = [];
  const staged = new Map<string, { id: string; bytes: Uint8Array }>();
  const published = new Map<string, { fileId: string; bytes: Uint8Array }>();
  let identities = 0;
  const exec = (request: WindowsRecoveryIoExecRequest): WindowsRecoveryIoExecResult => {
    const parsed = decode(request.input);
    const wire = parsed.header;
    calls.push({ phase: String(wire.operation), wire, payload: parsed.payload });
    const base = {
      contractVersion: wire.contractVersion, operation: wire.operation, path: wire.path, root: wire.root,
      ...(wire.profile ? {profile: wire.profile} : {}),
      ...(wire.attemptId !== undefined ? { attemptId: wire.attemptId, stagingPath: wire.stagingPath } : {}),
    };
    const dir = proof(String(wire.path).slice(0, String(wire.path).lastIndexOf("\\")),
      String(wire.root), String(wire.directoryFileId), String(wire.rootFileId), String(wire.rootVolumeId));
    if (wire.operation === "read-missing") {
      if (legacy.current)
        return { status: 2, signal: null, stderr: new Uint8Array(0),
          stdout: encode({ ...base, state: "EXISTS", reason: "PRIVATE_IO_V3_EXISTS" }, new Uint8Array(0)) };
      faults.afterMissing?.();
      return { status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({ ...base, state: "ABSENT", directory: dir }, new Uint8Array(0)) };
    }
    if (wire.operation === "prepare") {
      const id = (++identities).toString(16).padStart(32, "0");
      staged.set(String(wire.stagingPath), { id, bytes: parsed.payload });
      if (faults.unknownPrepare) return {status: null, signal: null, errorCode: "ACK_LOST", stdout: Buffer.from([255, 0]), stderr: Buffer.alloc(0)};
      return {
        status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({ ...base, state: "PREPARED",
          file: proof(String(wire.stagingPath), String(wire.root), id, String(wire.rootFileId), String(wire.rootVolumeId)),
          directory: dir, byteLength: parsed.payload.byteLength, sha256: hash(parsed.payload),
          contentFlushed: true, filesystem: "NTFS" }, parsed.payload),
      };
    }
    if (wire.operation === "commit-prepared") {
      const stage = staged.get(String(wire.stagingPath))!;
      published.set(String(wire.path), { fileId: stage.id, bytes: stage.bytes });
      faults.afterCommit?.();
      if (faults.unknownCommit)
        return {status: null, signal: null, errorCode: "ACK_LOST", stdout: Buffer.from([0, 255]), stderr: Buffer.alloc(0)};
      return {
        status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({ ...base, state: "PUBLISHED",
          file: proof(String(wire.path), String(wire.root), stage.id, String(wire.rootFileId), String(wire.rootVolumeId)),
          directory: dir, byteLength: stage.bytes.byteLength, sha256: hash(stage.bytes),
          contentFlushed: true, filesystem: "NTFS", stagingDisposition: "RENAMED_TO_FINAL",
          namespace: "EXCLUSIVE_NO_REPLACE",
          durability: { profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH" } }, stage.bytes),
      };
    }
    const file = published.get(String(wire.path))!;
    return {
      status: 0, signal: null, stderr: new Uint8Array(0),
      stdout: encode({ ...base, state: "READ",
        file: proof(String(wire.path), String(wire.root), file.fileId, String(wire.rootFileId), String(wire.rootVolumeId)),
        directory: dir, byteLength: file.bytes.byteLength, sha256: hash(file.bytes), filesystem: "NTFS" }, file.bytes),
    };
  };
  return {
    calls, published,
    port: {
      fs: {
        lstat: (_path: string): WindowsRuntimeFileStat => fileStat(EXE_BYTES.byteLength),
        readFile: (_path: string) => EXE_BYTES,
      },
      exec,
    },
    dispatches: () => calls.filter(c => c.phase === "prepare" || c.phase === "commit-prepared").length,
  };
}

const config: WindowsOperatorConfig = {
  root: ROOT, publicationStateRoot: STATE_ROOT, publicationStateDirectory: STATE_DIR,
  probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
};

function snapshot(tag: string): CrashRecoverySnapshot {
  const s = emptyCrashRecoverySnapshot();
  s.rawDrafts.push({ scope: "record", pageId: "page-1", key: tag, value: `payload-${tag}` });
  return s;
}

function fixture(legacy?: { current: boolean }) {
  const stateDirectory = tempDir();
  const faults: {unknownCommit?: boolean; unknownPrepare?: boolean; unknownAppend?: boolean; fence?: () => void; close?: boolean;
    afterCommit?: () => void; afterMissing?: () => void; afterPrivateMutation?: (operation: string, path: string) => void;
    afterAppend?: () => void; transferHelperChanged?: boolean} = {};
  const transport = recoveryTransport(legacy, faults);
  const overrides = new Map<string, string>(), proofs: string[] = [];
  const profiles: {name: string; profile: string}[] = [];
  const leases: {root: string; path: string; rootFileId: string; fileId: string}[] = [];
  const persistenceCalls: string[] = [];
  const transferCalls: string[] = [], physicalFiles = new Map<string, string>();
  let created = 100;
  const directories = new Set<string>();
  const entries = (parent: string) => {
    const children = new Map<string, boolean>();
    for (const p of [...directories, ...transport.published.keys()]) {
      if (!p.startsWith(parent + "\\")) continue;
      const tail = p.slice(parent.length + 1), name = tail.split("\\")[0];
      children.set(name, tail.includes("\\") || directories.has(p));
    }
    return [...children].map(([name, directory]) => ({name, directory}));
  };
  const tree = (path: string) => {
    const files = [...transport.published].filter(([p]) => p.startsWith(path + "\\"));
    const dirs = new Set([path, ...[...directories].filter(p => p.startsWith(path + "\\"))]);
    for (const [p] of files) {
      let parent = win32.dirname(p);
      while (parent.startsWith(path + "\\")) { dirs.add(parent); parent = win32.dirname(parent); }
    }
    return {entries: dirs.size + files.length, byteLength: files.reduce((n, [, f]) => n + f.bytes.length, 0),
      sha256: hash(Buffer.from(JSON.stringify(files.map(([p, f]) => [p.slice(path.length), f.fileId, hash(f.bytes)]).sort())))};
  };
  const persistenceIo: WindowsPrivatePersistenceTestPort = {
    fs: transport.port.fs,
    exec(request) {
      const {header: h, payload} = decode(request.input);
      const path = String(h.path), operation = String(h.operation);
      const requestRoot = String(h.root), requestRootFileId = String(h.rootFileId), requestRootVolumeId = String(h.rootVolumeId);
      persistenceCalls.push(operation);
      const base = {contractVersion: 4, operation, path, root: requestRoot,
        ...(h.attemptId ? {attemptId: h.attemptId} : {})};
      if (operation === "inspect-tree" || operation === "rename-directory-new") {
        const inventory = tree(path), destination = operation === "rename-directory-new" ? String(h.destination) : path;
        if (operation === "rename-directory-new") {
          for (const [p, file] of [...transport.published]) if (p.startsWith(path + "\\")) {
            transport.published.delete(p); transport.published.set(destination + p.slice(path.length), file);
          }
          faults.afterPrivateMutation?.(operation, destination);
          for (const p of [...directories]) if (p === path || p.startsWith(path + "\\")) {
            directories.delete(p); directories.add(destination + p.slice(path.length));
          }
        }
        return {status: 0, signal: null, stderr: Buffer.alloc(0),
          stdout: encode({...base, state: operation === "inspect-tree" ? "OK" : "APPLIED", ...inventory, filesystem: "NTFS",
            file: proof(destination, requestRoot, idFor(path), requestRootFileId, requestRootVolumeId),
            directory: proof(win32.dirname(destination), requestRoot, idFor(win32.dirname(destination)), requestRootFileId, requestRootVolumeId),
            ...(operation === "rename-directory-new" ? {destination,
              sourceDirectory: proof(win32.dirname(path), requestRoot, idFor(win32.dirname(path)), requestRootFileId, requestRootVolumeId),
              durability: {profile: "WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1", scope: "PROCESS_CRASH"}} : {})}, Buffer.alloc(0))};
      }
      if (operation === "write-new") {
        if (transport.published.has(path) || directories.has(path)) return {status: 2, signal: null, stderr: Buffer.alloc(0),
          stdout: encode({...base, state: "EXISTS", reason: "PRIVATE_PERSISTENCE_EXISTS"}, Buffer.alloc(0))};
        transport.published.set(path, {fileId: (++created).toString(16).padStart(32, "0"), bytes: payload});
        const physical = physicalFiles.get(path);
        if (physical) writeFileSync(physical, payload, {flag: "wx", mode: 0o600});
      }
      let file = transport.published.get(path)!;
      if (physicalFiles.has(path) && file) file.bytes = readFileSync(physicalFiles.get(path)!);
      const destination = operation === "rename-new" || operation === "copy-new" ? String(h.destination) : path;
      if (operation === "rename-new") {
        if (transport.published.has(destination)) throw new Error("fixture rename collision");
        transport.published.delete(path); transport.published.set(destination, file);
      }
      if (operation === "copy-new") {
        if (transport.published.has(destination)) throw new Error("fixture copy collision");
        expect(file.fileId).toBe(h.sourceFileId);
        expect(hash(file.bytes)).toBe(h.sourceSha256);
        file = {fileId: (++created).toString(16).padStart(32, "0"), bytes: Uint8Array.from(file.bytes)};
        transport.published.set(destination, file);
      }
      if (["write-new", "copy-new", "rename-new", "prove-sync"].includes(operation)) faults.afterPrivateMutation?.(operation, destination);
      const fileProof = proof(destination, requestRoot, file.fileId, requestRootFileId, requestRootVolumeId);
      const directory = proof(win32.dirname(destination), requestRoot, idFor(win32.dirname(destination)), requestRootFileId, requestRootVolumeId);
      if (operation === "inspect-file-identity")
        return {status: 0, signal: null, stderr: Buffer.alloc(0),
          stdout: encode({...base, state: "OK", file: fileProof, directory}, Buffer.alloc(0))};
      return {status: 0, signal: null, stderr: Buffer.alloc(0),
        stdout: encode({...base, state: ["write-new", "copy-new", "rename-new", "prove-sync"].includes(operation) ? "APPLIED" : "OK",
          file: fileProof, directory, byteLength: file.bytes.byteLength, sha256: hash(file.bytes), filesystem: "NTFS",
          ...(["write-new", "copy-new", "rename-new", "prove-sync"].includes(operation) ? {contentFlushed: true} : {}),
          ...(["write-new", "copy-new", "rename-new", "prove-sync"].includes(operation) ? {
            durability: {profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH"}} : {}),
          ...(["copy-new", "rename-new"].includes(operation) ? {destination,
            sourceDirectory: proof(win32.dirname(path), requestRoot, idFor(win32.dirname(path)), requestRootFileId, requestRootVolumeId)} : {})},
        operation === "read" || operation === "write-new" ? file.bytes : Buffer.alloc(0))};
    },
  };
  const backupIo: WindowsBackupArtifactTestPort = {
    fs: transport.port.fs,
    exec: request => transport.port.exec({...request, args: ["--private-recovery-io"]}),
  };
  let opens = 0;
  const open = (enrollExistingSources = opens++ === 0, operatorConfig: WindowsOperatorConfig = config) => {
    const deps: WindowsProductNativeTestDeps = {
      platform: (dir, name, profile) => {
        profiles.push({name, profile});
        return testingPlatform()(dir);
      },
      runtimeTestPort: runtimeTestPort(stateDirectory, transport.published, overrides, proofs, physicalFiles, directories),
      acquireLease: options => path => {
        const first = options.identityFor(path);
        leases.push({root: options.root, path, rootFileId: options.expectedRoot.rootFileId, fileId: first.fileId});
        return {trust: "untrusted-test", assertHeld() {
          expect(options.identityFor(path)).toEqual(first);
        }, close() { if (faults.close) throw new Error(`close ${path}`); }};
      },
      recoveryIo: transport.port, persistenceIo, backupIo, stateDirectory, sourceEntries: entries,
      transferIo: {fs: {...transport.port.fs, readFile: path => faults.transferHelperChanged ? Buffer.from("changed helper") : transport.port.fs.readFile(path)}, exec(request) {
        const {header: h, payload} = decode(request.input), path = String(h.path), file = transport.published.get(path)!;
        transferCalls.push(String(h.operation));
        expect(file.fileId).toBe(h.fileId); expect(file.bytes.length).toBe(h.byteLength); expect(hash(file.bytes)).toBe(h.expectedSha256);
        file.bytes = Buffer.concat([file.bytes, payload]);
        faults.afterAppend?.();
        if (faults.unknownAppend) return {status: null, signal: null, errorCode: "ACK_LOST", stdout: Buffer.from([0, 255]), stderr: Buffer.alloc(0)};
        return {status: 0, signal: null, stderr: Buffer.alloc(0), stdout: encode({
          contractVersion: 1, operation: "append", path, root: ROOT, attemptId: h.attemptId, state: "APPLIED",
          file: proof(path, ROOT, file.fileId, ROOT_ID, VOLUME),
          directory: proof(win32.dirname(path), ROOT, idFor(win32.dirname(path)), ROOT_ID, VOLUME),
          byteLength: file.bytes.length, sha256: hash(file.bytes), filesystem: "NTFS", contentFlushed: true,
          durability: {profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH"},
        }, Buffer.alloc(0))};
      }},
    };
    const product = createWindowsProductNativeForTesting(operatorConfig, {
      enrollExistingSources, assertCurrent: () => { faults.fence?.(); },
    }, deps);
    products.push(product);
    return product;
  };
  return { stateDirectory, transport, open, overrides, proofs, profiles, leases, faults, persistenceCalls, transferCalls, directories, physicalFiles };
}

function maintenance(product: WindowsProductNative) {
  return product.maintenancePort({workspace: WS_DIR, workspaceId: "ws-1", workspaceFingerprint: "a".repeat(64),
    writerId: "writer", sessionId: "session", osSid: SID, assertCurrent() {}});
}

describe("windows product-native composition (contract-only, NOT_RUN on Windows)", {timeout: 30_000}, () => {
  it("snapshots real SQLite after ordinary restart with root equal to workspace and binds before the destination lease", () => {
    const f = fixture(), directory = tempDir(), sourcePath = join(directory, "workspace.sqlite"),
      destinationPath = join(directory, "snapshot.sqlite"), source = `${ROOT}\\workspace.sqlite`, destination = `${ROOT}\\snapshot.sqlite`;
    const db = new DatabaseSync(sourcePath);
    try {
      db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('exact snapshot');");
      f.physicalFiles.set(source, sourcePath); f.physicalFiles.set(destination, destinationPath);
      f.transport.published.set(source, {fileId: "e".repeat(32), bytes: readFileSync(sourcePath)});
      const initial = f.open();
      initial.bindWorkspace(ROOT, "ws-root"); initial.privateFilesystem.inspectFileIdentity(source); initial.close();
      const product = f.open(false); product.bindWorkspace(ROOT, "ws-root");
      let vacuum = false;
      // Only native paths are translated. VACUUM and both databases are real
      // temporary SQLite, while all native IDs remain explicitly simulated.
      const mapped = new Proxy(db, {get(target, name) {
        if (name === "prepare") return (sql: string) => {
          if (sql === "PRAGMA database_list") return {all: () => [{name: "main", file: source}]};
          if (sql === "VACUUM INTO ?") return {run(path: string) {
            expect(path).toBe(destination);
            expect(lstatSync(destinationPath).size).toBe(0);
            const pinned = product.privateFilesystem.inspectFileIdentity(destination);
            expect(f.leases).toContainEqual({root: ROOT, path: destination, rootFileId: ROOT_ID, fileId: pinned.fileId});
            vacuum = true; return target.prepare(sql).run(destinationPath);
          }};
          return target.prepare(sql);
        };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      }});
      const receipt = product.privateFilesystem.snapshotSqlite!(mapped, destination);
      expect(vacuum).toBe(true);
      expect(receipt.identity.sha256).toBe(hash(readFileSync(destinationPath)));
      expect([...f.transport.published.keys()].some(p => p.startsWith(ROOT + "\\.folio-sqlite-intent-"))).toBe(true);
      const copied = new DatabaseSync(destinationPath, {readOnly: true});
      try { expect(copied.prepare("SELECT value FROM retained").get()?.value).toBe("exact snapshot"); }
      finally { copied.close(); }
      product.close();
      const reopened = f.open(false); reopened.bindWorkspace(ROOT, "ws-root");
      expect(reopened.privateFilesystem.inspectFile(destination, 1024 * 1024).sha256).toBe(receipt.identity.sha256);
      expect(f.profiles).toContainEqual({name: "source-bindings.sqlite", profile: "small-ledger"});
      expect(WINDOWS_HOT_JOURNAL_PROFILES["small-ledger"]).toEqual({
        mainBytes: 64 * 1024 * 1024, sidecarBytes: 64 * 1024 * 1024, combinedBytes: 256 * 1024 * 1024});
    } finally { db.close(); }
  }, 30_000);

  it("repairs a captured CREATE observation and its exact pending binding after restart", () => {
    const f = fixture(), path = `${WS_DIR}\\created-unknown.bin`, p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    f.faults.afterPrivateMutation = (_op, target) => { f.overrides.set(target, "f".repeat(32)); };
    expect(() => p.privateFilesystem.writeNew(path, Buffer.from("original"), 100)).toThrow();
    f.faults.afterPrivateMutation = undefined; f.overrides.clear(); p.close();
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    expect(() => next.privateFilesystem.inspectFile(path, 100)).toThrow("NOT_ENROLLED");
    const port = maintenance(next), ids = (port.inspect("filesystem") as {result: string[]}).result;
    const item = (port.inspect("filesystem", ids[0]) as {result: WindowsPrivatePersistenceInspection}).result;
    const calls = f.persistenceCalls.filter(op => op === "write-new").length;
    const result = port.resolve("filesystem", item.attemptId, item.fingerprint) as WindowsPrivatePersistenceInspection;
    expect(result.terminal).toEqual(item.terminal); expect(result.original).toEqual(item.original);
    expect(next.privateFilesystem.inspectFile(path, 100).sha256).toBe(hash(Buffer.from("original")));
    next.close();
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    expect(reopened.privateFilesystem.inspectFile(path, 100).bytes).toBe(8);
    expect(f.persistenceCalls.filter(op => op === "write-new")).toHaveLength(calls);
  }, 30_000);

  it("finishes an exact binding event after a crash between K observation and S completion", () => {
    const f = fixture(), path = `${WS_DIR}\\cross-database.bin`, p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    f.faults.afterPrivateMutation = (_op, target) => { f.overrides.set(target, "f".repeat(32)); };
    expect(() => p.privateFilesystem.writeNew(path, Buffer.from("retained"), 100)).toThrow();
    f.faults.afterPrivateMutation = undefined; f.overrides.clear(); p.close();
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const db = new DatabaseSync(join(f.stateDirectory, "private-persistence-v1.sqlite"), {readOnly: true});
    let interrupted = false;
    try {
      const port = next.maintenancePort({workspace: WS_DIR, workspaceId: "ws-1", workspaceFingerprint: "a".repeat(64),
        writerId: "writer", sessionId: "session", osSid: SID, assertCurrent() {
          if (Number(db.prepare("SELECT count(*) AS n FROM resolutions").get()?.n) > 0) { interrupted = true; throw new Error("cut after K commit"); }
        }});
      const id = (port.inspect("filesystem") as {result: string[]}).result[0];
      const item = (port.inspect("filesystem", id) as {result: WindowsPrivatePersistenceInspection}).result;
      expect(() => port.resolve("filesystem", id, item.fingerprint)).toThrow();
      expect(interrupted).toBe(true);
      expect(db.prepare("SELECT count(*) AS n FROM resolutions").get()?.n).toBe(1);
      next.close();
      const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
      expect(() => reopened.privateFilesystem.inspectFile(path, 100)).toThrow("NOT_ENROLLED");
      const after = maintenance(reopened).resolve("filesystem", id, item.fingerprint) as WindowsPrivatePersistenceInspection;
      expect(after.terminal).toEqual(item.terminal);
      expect(reopened.privateFilesystem.inspectFile(path, 100).sha256).toBe(hash(Buffer.from("retained")));
    } finally { db.close(); }
  }, 30_000);

  it("reconciles a retained directory move and descendants without repeating the rename", () => {
    const f = fixture(), from = `${WS_DIR}\\move-source`, to = `${WS_DIR}\\move-retained`, p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1"); f.directories.add(from); p.privateFilesystem.inspectDirectory(from);
    const file = p.privateFilesystem.writeNew(`${from}\\marker.json`, Buffer.from("marker"), 100).identity;
    const tree = p.privateFilesystem.inspectTree!(from);
    f.faults.afterPrivateMutation = (operation, target) => { if (operation === "rename-directory-new") f.overrides.set(target, "f".repeat(32)); };
    expect(() => p.privateFilesystem.renameDirectoryNew!(from, to, tree)).toThrow();
    f.faults.afterPrivateMutation = undefined; f.overrides.clear(); p.close();
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next), ids = (port.inspect("filesystem") as {result: string[]}).result;
    const item = ids.map(id => (port.inspect("filesystem", id) as {result: WindowsPrivatePersistenceInspection}).result)
      .find(i => decode(i.wire).header.operation === "rename-directory-new")!;
    expect(() => next.privateFilesystem.inspectFile(`${to}\\marker.json`, 100)).toThrow();
    port.resolve("filesystem", item.attemptId, item.fingerprint);
    expect(next.privateFilesystem.inspectFile(`${to}\\marker.json`, 100).fileId).toBe(file.fileId);
    next.close();
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    expect(reopened.privateFilesystem.inspectFile(`${to}\\marker.json`, 100).sha256).toBe(file.sha256);
    expect(f.persistenceCalls.filter(op => op === "rename-directory-new")).toHaveLength(1);
  }, 30_000);

  it("recovers an append only from its exact retained v1 ACK and keeps UNKNOWN immutable", () => {
    const f = fixture(), p = f.open(), path = `${WS_DIR}\\append-observed.bin`;
    p.bindWorkspace(WS_DIR, "ws-1");
    const original = p.privateFilesystem.writeNew(path, Buffer.alloc(0), 100).identity;
    f.faults.afterAppend = () => { f.faults.transferHelperChanged = true; };
    expect(() => p.nativeTransferIo.append(path, original, Buffer.from("retained"), 100)).toThrow();
    p.close(); f.faults.afterAppend = undefined; f.faults.transferHelperChanged = false;
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next), id = (port.inspect("transfer") as {result: string[]}).result[0];
    const item = (port.inspect("transfer", id) as {result: WindowsPrivateTransferInspection}).result;
    expect(item.terminal?.state).toBe("UNKNOWN");
    expect(decode(item.wire).header.contractVersion).toBe(1);
    const result = port.resolve("transfer", id, item.fingerprint) as WindowsPrivateTransferInspection;
    expect(result.terminal).toEqual(item.terminal); expect(result.wire).toEqual(item.wire);
    expect(result.captures).toEqual(item.captures); expect(f.transferCalls).toHaveLength(1);
    next.close();
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    const expected = reopened.privateFilesystem.inspectFile(path, 100);
    expect(reopened.nativeTransferIo.append(path, expected, Buffer.from("-next"), 100).identity.bytes).toBe(13);
    expect(f.transferCalls).toHaveLength(2);
  }, 30_000);

  it.each(["stale-fingerprint", "changed-native-id", "missing-ack"] as const)("does not release transfer uncertainty for %s", failure => {
    const f = fixture(), p = f.open(), path = `${WS_DIR}\\append-refused.bin`; p.bindWorkspace(WS_DIR, "ws-1");
    const expected = p.privateFilesystem.writeNew(path, Buffer.alloc(0), 100).identity;
    if (failure === "missing-ack") f.faults.unknownAppend = true;
    else f.faults.afterAppend = () => { f.faults.transferHelperChanged = true; };
    expect(() => p.nativeTransferIo.append(path, expected, Buffer.from("retained"), 100)).toThrow(); p.close();
    f.faults.unknownAppend = false; f.faults.afterAppend = undefined; f.faults.transferHelperChanged = false;
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next), id = (port.inspect("transfer") as {result: string[]}).result[0];
    const item = (port.inspect("transfer", id) as {result: WindowsPrivateTransferInspection}).result;
    if (failure === "changed-native-id") f.transport.published.get(path)!.fileId = "f".repeat(32);
    expect(() => port.resolve("transfer", id, failure === "stale-fingerprint" ? "0".repeat(64) : item.fingerprint)).toThrow();
    expect(f.transferCalls).toHaveLength(1);
    const db = new DatabaseSync(join(f.stateDirectory, "private-transfer-v1.sqlite"), {readOnly: true});
    try { expect(db.prepare("SELECT count(*) AS n FROM releases").get()?.n).toBe(0); }
    finally { db.close(); }
  }, 30_000);

  it("advances an observed checkpoint head, reopens it, and publishes its successor without rewriting UNKNOWN", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1"); f.faults.unknownCommit = true;
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort});
    expect(() => file.write(0, snapshot("observed"))).toThrow(); p.close(); f.faults.unknownCommit = false;
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next), id = (port.inspect("checkpoint") as {result: string[]}).result[0];
    const before = (port.inspect("checkpoint", id) as {result: WindowsRecoveryMaintenanceInspection}).result;
    const result = port.resolve("checkpoint", id, before.fingerprint) as WindowsRecoveryMaintenanceInspection;
    expect(result.terminal).toBe(before.terminal); expect(result.blobs).toEqual(before.blobs);
    expect(JSON.parse(result.resolution!).state).toBe("APPLIED_OBSERVED");
    expect(f.transport.dispatches()).toBe(2); next.close();
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    const recovery = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: reopened.crashRecoveryPort});
    const read = recovery.read();
    expect(read.status).toBe("ready");
    if (read.status !== "ready" || !read.snapshot) throw new Error("Expected observed retained snapshot");
    expect(read.generation).toBe(1); expect(read.snapshot.rawDrafts[0].value).toBe("payload-observed");
    expect(f.transport.dispatches()).toBe(2);
    expect(recovery.write(1, snapshot("successor")).status).toBe("ready");
    const db = new DatabaseSync(join(f.stateDirectory, "windows-recovery-v3.sqlite"), {readOnly: true});
    try {
      expect(db.prepare("SELECT receipt FROM recovery_terminals WHERE attempt_id=?").get(id)?.receipt).toBe(before.terminal);
      expect(JSON.parse(String(db.prepare("SELECT result FROM recovery_pointer_results WHERE attempt_id=?").get(id)?.result)).state)
        .toBe("APPLIED_OBSERVED");
    } finally { db.close(); }
  }, 30_000);

  it("rejects a changed prior native checkpoint during the operator CAS", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1");
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort});
    expect(file.write(0, snapshot("prior")).status).toBe("ready");
    const priorPath = [...f.transport.published.keys()][0];
    f.faults.unknownCommit = true;
    expect(() => file.write(1, snapshot("next"))).toThrow(); p.close(); f.faults.unknownCommit = false;
    f.transport.published.get(priorPath)!.fileId = "f".repeat(32);
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next), ids = (port.inspect("checkpoint") as {result: string[]}).result;
    const item = ids.map(id => (port.inspect("checkpoint", id) as {result: WindowsRecoveryMaintenanceInspection}).result)
      .find(i => JSON.parse(i.metadata).generation === 2)!;
    expect(() => port.resolve("checkpoint", item.attemptId, item.fingerprint)).toThrow("UNKNOWN_UNRESOLVABLE");
    const db = new DatabaseSync(join(f.stateDirectory, "windows-recovery-v3.sqlite"), {readOnly: true});
    try {
      expect(db.prepare("SELECT generation FROM recovery_heads").get()?.generation).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM recovery_blobs WHERE kind='evidence:maintenance'").get()?.n).toBe(0);
    } finally { db.close(); }
  }, 30_000);

  it("completes an S1 observation-only checkpoint without replacing that original observation", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1"); f.faults.unknownCommit = true;
    expect(() => new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort})
      .write(0, snapshot("legacy-observation"))).toThrow(); p.close(); f.faults.unknownCommit = false;
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next), id = (port.inspect("checkpoint") as {result: string[]}).result[0];
    const item = (port.inspect("checkpoint", id) as {result: WindowsRecoveryMaintenanceInspection}).result;
    const observed = port.resolve("checkpoint", id, item.fingerprint) as WindowsRecoveryMaintenanceInspection;
    next.close();
    // Reconstruct only the prior S1 source format in disposable test data:
    // an immutable observation existed, but no pointer result/head was written.
    const old = JSON.parse(observed.resolution!); delete old.evidence.prior;
    const body = JSON.stringify(old);
    const db = new DatabaseSync(join(f.stateDirectory, "windows-recovery-v3.sqlite"));
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM recovery_heads WHERE attempt_id=?").run(id);
      db.prepare("DELETE FROM recovery_pointer_results WHERE attempt_id=?").run(id);
      db.prepare("UPDATE recovery_blobs SET bytes=?,sha256=? WHERE attempt_id=? AND kind='evidence:maintenance'")
        .run(Buffer.from(body), hash(Buffer.from(body)), id);
      db.exec("COMMIT");
    } finally { db.close(); }
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    const result = maintenance(reopened).resolve("checkpoint", id, item.fingerprint) as WindowsRecoveryMaintenanceInspection;
    expect(Buffer.from(result.blobs["evidence:maintenance"]).toString("utf8")).toBe(body);
    expect(JSON.parse(result.resolution!).previousObservationSha256).toBe(hash(Buffer.from(body)));
    const read = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: reopened.crashRecoveryPort}).read();
    expect(read.status).toBe("ready");
    expect(f.transport.dispatches()).toBe(2);
  }, 30_000);

  it("revalidates operator authority after native observation inside the checkpoint CAS", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1"); f.faults.unknownCommit = true;
    expect(() => new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort})
      .write(0, snapshot("held"))).toThrow(); p.close(); f.faults.unknownCommit = false;
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    let expired = false;
    const port = next.maintenancePort({workspace: WS_DIR, workspaceId: "ws-1", workspaceFingerprint: "a".repeat(64),
      writerId: "writer", sessionId: "session", osSid: SID, assertCurrent() { if (expired) throw new Error("operator expired"); }});
    const id = (port.inspect("checkpoint") as {result: string[]}).result[0];
    const item = (port.inspect("checkpoint", id) as {result: WindowsRecoveryMaintenanceInspection}).result;
    f.faults.afterMissing = () => { expired = true; };
    expect(() => port.resolve("checkpoint", id, item.fingerprint)).toThrow("operator expired");
    f.faults.afterMissing = undefined;
    const db = new DatabaseSync(join(f.stateDirectory, "windows-recovery-v3.sqlite"), {readOnly: true});
    try {
      expect(db.prepare("SELECT count(*) AS n FROM recovery_heads").get()?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM recovery_pointer_results").get()?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM recovery_blobs WHERE kind='evidence:maintenance'").get()?.n).toBe(0);
    } finally { db.close(); }
  }, 30_000);

  it("releases raw virtual reservations only after a fully validated observation and retains originals across reopen", () => {
    const f = fixture();
    for (let n = 1; n <= 3; n++) {
      const p = f.open(); p.bindWorkspace(WS_DIR, "ws-1"); f.faults.unknownCommit = true;
      const id = n.toString(16).padStart(32, "0"), bytes = Buffer.from(`retained-${n}`);
      expect(() => p.privateFileV3Port.publish({path: `${WS_DIR}\\observed-${n}.bin`, stagingPath: `${WS_DIR}\\.observed-${n}.tmp`,
        attemptId: id, bytes, beforePublish() {}})).toThrow();
      p.close(); f.faults.unknownCommit = false;
      const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
      const port = maintenance(next), before = (port.inspect("raw-export", id) as {result: WindowsRecoveryMaintenanceInspection}).result;
      port.resolve("raw-export", id, before.fingerprint);
      next.close();
    }
    expect(f.transport.dispatches()).toBe(6);
    const db = new DatabaseSync(join(f.stateDirectory, "raw-export-v3.sqlite"), {readOnly: true});
    try {
      expect(db.prepare("SELECT count(*) AS n FROM raw_blobs WHERE kind='original'").get()?.n).toBe(3);
      expect(db.prepare("SELECT count(*) AS n FROM raw_blobs WHERE kind='evidence:maintenance'").get()?.n).toBe(3);
      expect(db.prepare("SELECT receipt FROM raw_terminals").all().every(r => JSON.parse(String(r.receipt)).outcome === "UNKNOWN")).toBe(true);
    } finally { db.close(); }
  }, 30_000);

  it("does not trust a rehashed but inconsistent persisted raw observation on restart", () => {
    const f = fixture(), p = f.open(), id = "a".repeat(32); p.bindWorkspace(WS_DIR, "ws-1"); f.faults.unknownCommit = true;
    expect(() => p.privateFileV3Port.publish({path: `${WS_DIR}\\tamper.bin`, stagingPath: `${WS_DIR}\\.tamper.tmp`,
      attemptId: id, bytes: Buffer.from("retained"), beforePublish() {}})).toThrow(); p.close(); f.faults.unknownCommit = false;
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next), item = (port.inspect("raw-export", id) as {result: WindowsRecoveryMaintenanceInspection}).result;
    port.resolve("raw-export", id, item.fingerprint); next.close();
    const db = new DatabaseSync(join(f.stateDirectory, "raw-export-v3.sqlite"));
    try {
      const row = db.prepare("SELECT bytes FROM raw_blobs WHERE kind='evidence:maintenance'").get()!;
      const original = Buffer.from(row.bytes as Uint8Array).toString("utf8");
      // Preserve canonical byte ordering and recompute the blob hash, so only
      // full observation/native-ID validation detects this fixture corruption.
      const body = original.replace(/"fileId":"[a-f0-9]{32}"/, `"fileId":"${"f".repeat(32)}"`);
      expect(body).not.toBe(original);
      db.prepare("UPDATE raw_blobs SET bytes=?,sha256=? WHERE kind='evidence:maintenance'").run(Buffer.from(body), hash(Buffer.from(body)));
    } finally { db.close(); }
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    expect(() => maintenance(reopened).inspect("raw-export", id)).toThrow();
    expect(f.transport.dispatches()).toBe(2);
  }, 30_000);

  it("routes transfer and explicit snapshot evidence commands and rejects role/profile overrides", () => {
    const calls: unknown[] = [], context = {workspace: WS_DIR, workspaceId: "ws-1", workspaceFingerprint: "a".repeat(64),
      writerId: "writer", sessionId: "session", osSid: SID};
    const session = {context, assertCurrent() {}, close() {}, maintenance: {
      inspect(family: string) { calls.push(family); return []; }, resolve() { return {}; },
    }, snapshot(command: string, request: unknown) { calls.push({command, request}); return {state: "retained"}; }};
    executePrivateMaintenance("inspect", {family: "transfer"}, session);
    const reference = {attemptId: "a".repeat(32), slot: 0, slotFileId: "b".repeat(32), slotVolumeId: VOLUME};
    const capture = {request: Buffer.from("{}").toString("base64"), response: "", stderr: ""};
    executePrivateMaintenance("snapshot-commit-release-evidence",
      {path: `${STATE_DIR}\\private-transfer-v1.sqlite`, profile: "recovery-archive", reference, capture}, session);
    executePrivateMaintenance("snapshot-capture-inspect",
      {path: `${STATE_DIR}\\private-transfer-v1.sqlite`, profile: "recovery-archive", captureId: "c".repeat(32)}, session);
    expect(calls).toHaveLength(3);
    expect(parsePrivateMaintenanceArguments(["snapshot-capture-inspect", "--workspace", WS_DIR, "--request", "request.json"]))
      .toMatchObject({command: "snapshot-capture-inspect"});
    expect(privateMaintenanceSnapshotTarget(config, WS_DIR, {path: `${STATE_DIR}\\private-transfer-v1.sqlite`, profile: "recovery-archive"}))
      .toMatchObject({state: true, root: STATE_ROOT, role: "append-v1"});
    expect(privateMaintenanceSnapshotTarget(config, WS_DIR, {path: `${WS_DIR}\\workspace.sqlite`, profile: "recovery-archive"}))
      .toMatchObject({state: false, root: ROOT, role: "workspace"});
    expect(() => privateMaintenanceSnapshotTarget(config, WS_DIR, {path: `${STATE_DIR}\\source-bindings.sqlite`, profile: "backup-artifact"})).toThrow();
    expect(() => privateMaintenanceSnapshotTarget(config, WS_DIR, {path: `${STATE_DIR}\\foreign.sqlite`, profile: "recovery-archive"})).toThrow();
    expect(() => executePrivateMaintenance("snapshot-commit-release-evidence",
      {path: `${STATE_DIR}\\private-transfer-v1.sqlite`, profile: "recovery-archive", reference, capture: {...capture, request: "invalid!"}}, session)).toThrow();
  });
  it("retains a sidecar then creates a new exact identity at its old name across ordinary restart", () => {
    const f = fixture(), first = f.open();
    first.bindWorkspace(WS_DIR, "ws-1");
    const path = `${WS_DIR}\\workspace-binding.json`, retained = `${WS_DIR}\\workspace-binding.retained.json`;
    const old = first.privateFilesystem.writeNew(path, Buffer.from("old"), 100).identity;
    first.privateFilesystem.renameNew(path, retained, old, 100);
    first.close();
    const second = f.open(false); second.bindWorkspace(WS_DIR, "ws-1");
    const next = second.privateFilesystem.writeNew(path, Buffer.from("new"), 100).identity;
    expect(next.fileId).not.toBe(old.fileId);
    expect(second.privateFilesystem.inspectFile(retained, 100).fileId).toBe(old.fileId);
    second.close();
    const final = f.open(false); final.bindWorkspace(WS_DIR, "ws-1");
    expect(final.privateFilesystem.inspectFile(path, 100).fileId).toBe(next.fileId);
    expect(final.privateFilesystem.inspectFile(retained, 100).sha256).toBe(old.sha256);
  });

  it("makes moved descendants visible inside success callbacks and persists them after restart", () => {
    const f = fixture(), first = f.open(), from = `${WS_DIR}\\old`, to = `${WS_DIR}\\retained`;
    first.bindWorkspace(WS_DIR, "ws-1");
    f.directories.add(from); first.privateFilesystem.inspectDirectory(from);
    const marker = first.privateFilesystem.writeNew(`${from}\\marker.json`, Buffer.from("marker"), 100).identity;
    const inventory = first.privateFilesystem.inspectTree!(from);
    first.close();
    const second = f.open(false); second.bindWorkspace(WS_DIR, "ws-1");
    let success = false;
    second.privateFilesystem.renameDirectoryNew!(from, to, inventory, phase => {
      if (phase === "success") {
        expect(second.privateFilesystem.inspectFile(`${to}\\marker.json`, 100).fileId).toBe(marker.fileId);
        success = true;
      }
    });
    expect(success).toBe(true); second.close();
    const third = f.open(false); third.bindWorkspace(WS_DIR, "ws-1");
    expect(third.privateFilesystem.inspectFile(`${to}\\marker.json`, 100).sha256).toBe(marker.sha256);
    expect(() => third.privateFilesystem.inspectFile(`${from}\\marker.json`, 100)).toThrow();
  });

  it("admits a selected backup subtree beneath an unenrolled ancestor and refuses known replacement", () => {
    const f = fixture(), initial = f.open();
    initial.bindWorkspace(WS_DIR, "ws-1"); initial.close();
    // `Imported` is never enrolled or picked by the user; only the exact
    // selected subtree beneath it is authorized.
    const path = `${ROOT}\\Imported\\selected`, manifestPath = `${path}\\manifest.json`, bytes = Buffer.from('{"valid":true}');
    f.directories.add(path);
    f.transport.published.set(manifestPath, {fileId: "a".repeat(32), bytes});
    const p = f.open(false); p.bindWorkspace(WS_DIR, "ws-1");
    expect(() => p.privateFilesystem.inspectFile(manifestPath, 100)).toThrow();
    const receipt = p.admitSelectedSource({kind: "backup", path, manifestPath, manifestSha256: hash(bytes), assertCurrent() {}});
    // Ancestors (root + Imported) are enrolled alongside the selected
    // directory and its manifest file.
    expect(receipt.identities.some(i => i.kind === "directory" &&
      i.canonicalPath.toLowerCase() === `${ROOT}\\Imported`.toLowerCase())).toBe(true);
    expect(receipt.identities.filter(i => i.canonicalPath === path || i.canonicalPath.startsWith(path + "\\")))
      .toHaveLength(2);
    // Siblings of the selected subtree remain unadmitted.
    expect(() => p.privateFilesystem.inspectFile(`${ROOT}\\Imported\\sibling.bin`, 100)).toThrow();
    expect(p.privateFilesystem.inspectFile(manifestPath, 100).sha256).toBe(hash(bytes));
    f.transport.published.set(manifestPath, {fileId: "b".repeat(32), bytes});
    expect(() => p.admitSelectedSource({kind: "backup", path, manifestPath, manifestSha256: hash(bytes), assertCurrent() {}})).toThrow("IDENTITY_CHANGED");
    f.transport.published.set(manifestPath, {fileId: "a".repeat(32), bytes});
    p.close();
    // Restart: the retained ancestor+subtree identities remain usable in
    // enrollment-off mode, and a replaced file ID is refused.
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    expect(reopened.privateFilesystem.inspectFile(manifestPath, 100).sha256).toBe(hash(bytes));
    f.transport.published.get(manifestPath)!.fileId = "c".repeat(32);
    expect(() => reopened.privateFilesystem.inspectFile(manifestPath, 100)).toThrow();
  });

  it("appends 20M through the actual factory authority in bounded chunks and reopens normally", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1");
    const path = `${WS_DIR}\\transfer.bin`, bytes = Buffer.alloc(20_000_000, 91);
    let expected = p.privateFilesystem.writeNew(path, Buffer.alloc(0), 20_000_000).identity;
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024)
      expected = p.nativeTransferIo.append(path, expected, bytes.subarray(offset, offset + 1024 * 1024), bytes.length).identity;
    expect(expected.sha256).toBe(hash(bytes)); p.close();
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    expect(reopened.privateFilesystem.inspectFile(path, bytes.length)).toEqual(expected);
    expect(f.profiles).toContainEqual({name: "private-transfer-v1.sqlite", profile: "recovery-archive"});
    expect(f.leases.filter(l => l.path.endsWith("private-transfer-v1.sqlite")).every(l => l.root === STATE_ROOT && l.rootFileId === STATE_ROOT_ID)).toBe(true);
  });

  it("retains raw append captures and refuses redispatch of an UNKNOWN resource after restart", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1");
    const path = `${WS_DIR}\\unknown.bin`;
    const expected = p.privateFilesystem.writeNew(path, Buffer.alloc(0), 100).identity;
    f.faults.unknownAppend = true;
    expect(() => p.nativeTransferIo.append(path, expected, Buffer.from("retain"), 100)).toThrow();
    p.close(); f.faults.unknownAppend = false;
    const reopened = f.open(false); reopened.bindWorkspace(WS_DIR, "ws-1");
    const current = reopened.privateFilesystem.inspectFile(path, 100);
    expect(() => reopened.nativeTransferIo.append(path, current, Buffer.from("never"), 100)).toThrow();
    const db = new DatabaseSync(join(f.stateDirectory, "private-transfer-v1.sqlite"), {readOnly: true});
    try {
      expect(db.prepare("SELECT state FROM terminals").all().map(r => r.state)).toEqual(["UNKNOWN"]);
      expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE kind='original'").get()!.bytes as Uint8Array)).toEqual(Buffer.from("retain"));
      expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE kind='stdout'").get()!.bytes as Uint8Array)).toEqual(Buffer.from([0, 255]));
      expect(db.prepare("SELECT * FROM releases").all()).toEqual([]);
    } finally { db.close(); }
  });

  it("inspects and records a proven raw publication observation without rewriting UNKNOWN bytes", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1");
    f.faults.unknownCommit = true;
    const id = "c".repeat(32), original = Buffer.from("exact original");
    expect(() => p.privateFileV3Port.publish({path: `${WS_DIR}\\raw.bin`, stagingPath: `${WS_DIR}\\.raw.tmp`,
      attemptId: id, bytes: original, beforePublish() {}})).toThrow();
    p.close();
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const maintenance = next.maintenancePort({workspace: WS_DIR, workspaceId: "ws-1", workspaceFingerprint: "a".repeat(64),
      writerId: "writer", sessionId: "session", osSid: SID, assertCurrent() {}});
    const item = (maintenance.inspect("raw-export", id) as {result: {fingerprint: string; blobs: Record<string, Uint8Array>; terminal: string}}).result;
    expect(Buffer.from(item.blobs.original)).toEqual(original);
    const resolved = maintenance.resolve("raw-export", id, item.fingerprint) as {terminal: string; resolution: string};
    expect(resolved.terminal).toBe(item.terminal);
    expect(JSON.parse(resolved.resolution).state).toBe("APPLIED_OBSERVED");
    expect(() => maintenance.resolve("raw-export", id, item.fingerprint)).toThrow("CONFLICT");
  });

  it("leaves missing-original-ID captures explicitly unresolved through the actual maintenance hook", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1"); f.faults.unknownPrepare = true;
    const id = "d".repeat(32), bytes = Buffer.from("original without native target ID");
    expect(() => p.privateFileV3Port.publish({path: `${WS_DIR}\\ambiguous.bin`, stagingPath: `${WS_DIR}\\.ambiguous.tmp`,
      attemptId: id, bytes, beforePublish() {}})).toThrow();
    p.close();
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = next.maintenancePort({workspace: WS_DIR, workspaceId: "ws-1", workspaceFingerprint: "a".repeat(64),
      writerId: "writer", sessionId: "session", osSid: SID, assertCurrent() {}});
    const original = (port.inspect("raw-export", id) as {result: {fingerprint: string; blobs: Record<string, Uint8Array>}}).result;
    expect(() => port.resolve("raw-export", id, original.fingerprint)).toThrow("UNKNOWN_UNRESOLVABLE");
    expect(Buffer.from(original.blobs.original)).toEqual(bytes);
    expect(Buffer.from(original.blobs["capture:prepare:stdout"])).toEqual(Buffer.from([255, 0]));
    expect((port.inspect("raw-export", id) as {result: {resolution: string | null}}).result.resolution).toBeNull();
  });
  it("assertRoot proves the native root lazily without opening state databases", () => {
    const { stateDirectory, open } = fixture();
    const product = open();
    product.assertRoot();
    expect(readdirSync(stateDirectory)).toEqual([]);
  });

  it("binds a workspace once; mismatched rebind and async fences are rejected", () => {
    const product = fixture().open();
    product.bindWorkspace(WS_DIR, "ws-1");
    expect(() => product.bindWorkspace(WS_DIR, "ws-2")).toThrowError(/WINDOWS_PRODUCT_NATIVE_/);
    expect(() => product.bindWorkspace(WS_DIR, "ws-1")).not.toThrow();
    expect(() => product.bindWorkspace(`${ROOT}\\other`, "ws-1")).toThrowError(/WINDOWS_PRODUCT_NATIVE_/);
    const second = fixture().open();
    expect(() => second.bindWorkspace(WS_DIR, "ws-1", async () => {})).toThrowError(/WINDOWS_PRODUCT_NATIVE_/);
  });

  it("writes crash recovery generation 1 then 2 through the composed native port", () => {
    const { transport, open } = fixture();
    const product = open();
    product.bindWorkspace(WS_DIR, "ws-1");
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", { platform: "win32", nativePort: product.crashRecoveryPort });
    const first = file.write(0, snapshot("g1"));
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("unreachable");
    expect(first.generation).toBe(1);
    expect(transport.calls.filter(c => ["prepare", "commit-prepared"].includes(c.phase)).map(c => c.phase))
      .toEqual(["prepare", "commit-prepared"]);
    const second = file.write(1, snapshot("g2"));
    expect(second.status).toBe("ready");
    if (second.status !== "ready") throw new Error("unreachable");
    expect(second.generation).toBe(2);
    // Two publishes: two prepare+commit pairs; prior-proof reads are separate.
    expect(transport.calls.filter(c => c.phase === "prepare").length).toBe(2);
    expect(transport.calls.filter(c => c.phase === "commit-prepared").length).toBe(2);
    const read = file.read();
    expect(read.status).toBe("ready");
    if (read.status !== "ready") throw new Error("unreachable");
    expect(read.generation).toBe(2);
    if (!read.snapshot) throw new Error("Expected retained snapshot");
    expect(read.snapshot.rawDrafts[0]?.value).toBe("payload-g2");
  });

  it("a reopened product proves the applied head without any new publish", () => {
    const { transport, open } = fixture();
    const product = open();
    product.bindWorkspace(WS_DIR, "ws-1");
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", { platform: "win32", nativePort: product.crashRecoveryPort });
    expect(file.write(0, snapshot("g1")).status).toBe("ready");
    const before = transport.dispatches();
    product.close();
    const reopened = open();
    reopened.bindWorkspace(WS_DIR, "ws-1");
    const reread = new CrashRecoveryFile(LOGICAL, "ws-1", { platform: "win32", nativePort: reopened.crashRecoveryPort });
    const read = reread.read();
    expect(read.status).toBe("ready");
    if (read.status !== "ready") throw new Error("unreachable");
    expect(read.generation).toBe(1);
    if (!read.snapshot) throw new Error("Expected retained snapshot");
    expect(read.snapshot.rawDrafts[0]?.value).toBe("payload-g1");
    // Only read-private dispatches — no prepare/commit on reopen.
    expect(transport.dispatches()).toBe(before);
    const next = reread.write(1, snapshot("g2"));
    expect(next.status).toBe("ready");
    if (next.status !== "ready") throw new Error("unreachable");
    expect(next.generation).toBe(2);
  });

  it("refuses a checkpoint call for an unbound or foreign workspace", () => {
    const product = fixture().open();
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", { platform: "win32", nativePort: product.crashRecoveryPort });
    expect(() => file.write(0, snapshot("g1"))).toThrow();
    product.bindWorkspace(WS_DIR, "ws-1");
    const foreign = new CrashRecoveryFile(LOGICAL, "ws-9", { platform: "win32", nativePort: product.crashRecoveryPort });
    expect(() => foreign.write(0, snapshot("g1"))).toThrow();
    const outside = new CrashRecoveryFile(`${ROOT}\\elsewhere\\crash-recovery.json`, "ws-1", { platform: "win32", nativePort: product.crashRecoveryPort });
    expect(() => outside.write(0, snapshot("g1"))).toThrow();
  });

  it("blocks a checkpoint publish while a physical legacy file still exists", () => {
    const legacy = { current: true };
    const { transport, open } = fixture(legacy);
    const product = open();
    product.bindWorkspace(WS_DIR, "ws-1");
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", { platform: "win32", nativePort: product.crashRecoveryPort });
    expect(() => file.write(0, snapshot("g1"))).toThrow();
    // The legacy EXISTS verdict must stop the write BEFORE any mutation.
    expect(transport.calls.every(c => c.phase !== "prepare" && c.phase !== "commit-prepared")).toBe(true);
  });

  it.each([2 * 1024 * 1024 + 4096, 32 * 1024 * 1024])("publishes %i exact raw bytes without a checkpoint intent", (size) => {
    const { transport, open } = fixture();
    const product = open();
    const bytes = new Uint8Array(size);
    for (let index = 0; index < bytes.byteLength; index += 8192) bytes[index] = index & 0xff;
    const receipt = product.privateFileV3Port.publish({
      path: `${WS_DIR}\\exports\\report.bin`,
      stagingPath: `${WS_DIR}\\exports\\.folio-export-${"c".repeat(32)}.tmp`,
      attemptId: "d".repeat(32),
      bytes,
      beforePublish: () => {},
    });
    expect(receipt.state).toBe("PUBLISHED");
    if (receipt.state !== "PUBLISHED") throw new Error("unreachable");
    expect(receipt.contractVersion).toBe(3);
    expect(receipt.stagingDisposition).toBe("RENAMED_TO_FINAL");
    expect(receipt.byteLength).toBe(bytes.byteLength);
    expect(receipt.sha256).toBe(hash(bytes));
    expect(transport.calls.map((c) => c.phase)).toEqual(["prepare", "commit-prepared"]);
  }, 30_000);

  it("uses different source/state IDs and exact journal names; generic K bindings survive late workspace binding", () => {
    const f = fixture(), p = f.open();
    expect(p.privateFilesystem.inspectDirectory(ROOT)).toMatchObject({path: ROOT, fileId: ROOT_ID});
    const before = `${WS_DIR}\\before.bin`, after = `${WS_DIR}\\after.bin`;
    const first = p.privateFilesystem.writeNew(before, Buffer.from("before"), 32);
    p.bindWorkspace(WS_DIR, "ws-1");
    expect(Buffer.from(p.privateFilesystem.read(before, first.identity, 32)).toString()).toBe("before");
    new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort}).write(0, snapshot("one"));
    p.close();
    const reopened = f.open();
    const second = reopened.privateFilesystem.writeNew(after, Buffer.from("after"), 32);
    reopened.bindWorkspace(WS_DIR, "ws-1");
    expect(Buffer.from(reopened.privateFilesystem.read(after, second.identity, 32)).toString()).toBe("after");
    expect(f.persistenceCalls.filter(v => v === "write-new")).toHaveLength(2);
    expect(f.profiles).toEqual(expect.arrayContaining([
      {name: "source-bindings.sqlite", profile: "small-ledger"},
      {name: "private-persistence-v1.sqlite", profile: "recovery-archive"},
      {name: "windows-recovery-v3.sqlite", profile: "recovery-archive"},
    ]));
    expect(f.leases.every(l => l.root === STATE_ROOT && l.rootFileId === STATE_ROOT_ID &&
      l.fileId !== "0".repeat(32))).toBe(true);
    expect(f.proofs.some(path => path.endsWith("\\shared-runtime.sqlite"))).toBe(false);
  });

  it("routes an actual pending raw export larger than v2 through the composed v3 factory", () => {
    const f = fixture(), p = f.open();
    const path = `${WS_DIR}\\pending.json`, content = JSON.stringify({unverified: "x".repeat(2 * 1024 * 1024)});
    let validations = 0;
    const receipt = writePendingJournalFileV3(path, content, {
      platform: "win32", privateFilePortV3: p.privateFileV3Port,
      validate(text) { validations++; expect(JSON.parse(text).unverified.length).toBe(2 * 1024 * 1024); },
      checkDestination(out) { expect(out).toBe(path); },
    });
    expect(receipt.contractVersion).toBe(3);
    expect(receipt.stagingDisposition).toBe("RENAMED_TO_FINAL");
    expect(Buffer.from(f.transport.published.get(path)!.bytes).toString()).toBe(content);
    expect(validations).toBe(2);
    expect(f.transport.dispatches()).toBe(2);
  });

  it("uses the source root lease for a positively created source SQLite file", () => {
    const f = fixture(), p = f.open(), path = `${WS_DIR}\\scratch.sqlite`;
    const file = p.privateFilesystem.writeNew(path, Buffer.alloc(0), 0);
    const lease = p.privateFilesystem.acquireSqliteLease!(path, file.identity);
    lease.assertHeld(); lease.close();
    expect(f.leases).toContainEqual({root: ROOT, path, rootFileId: ROOT_ID, fileId: file.identity.fileId});
  });

  it("rescues an unbound retained native workspace without opening or mutating its invalid source SQLite bytes", () => {
    const f=fixture(),initial=f.open();
    const pin=initial.privateFilesystem.inspectDirectory(WS_DIR),source=`${WS_DIR}\\workspace.sqlite`,bytes=Buffer.from("invalid SQLite source preserved exactly");
    const file=initial.privateFilesystem.writeNew(source,bytes,1024).identity;
    initial.close();
    const p=f.open(false),output=`${ROOT}\\RescueOut`;f.directories.add(output);
    const cap=p.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:pin,capabilityRoot:ROOT,path:output,assertCurrent(){}});
    expect(Buffer.from(cap.privateFilesystem.read(source,file,1024))).toEqual(bytes);
    const saved=cap.privateFilesystem.writeNew(`${output}\\raw.bin`,bytes,1024).identity;
    expect(saved.sha256).toBe(hash(bytes));expect(Buffer.from(f.transport.published.get(source)!.bytes)).toEqual(bytes);
    expect(()=>cap.privateFilesystem.writeNew(`${WS_DIR}\\not-allowed.bin`,Buffer.from("x"),1)).toThrow();
    expect(()=>cap.privateFilesystem.unlinkExact(source,file,1024)).toThrow();
    expect(()=>p.bindWorkspace(WS_DIR,"invented-id")).toThrow("RESCUE_REBIND");
    expect(f.leases.length).toBeGreaterThan(0);
    expect(f.leases.every(lease=>lease.root===STATE_ROOT)).toBe(true);
    p.close();
    const reopened=f.open(false),again=reopened.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:pin,capabilityRoot:ROOT,path:output,assertCurrent(){}});
    expect(Buffer.from(again.privateFilesystem.read(source,file,1024))).toEqual(bytes);
  });
  it("fences stale rescue authority and replaced native workspace IDs before source or destination dispatch", () => {
    const f=fixture(),p=f.open(),pin=p.privateFilesystem.inspectDirectory(WS_DIR),output=`${ROOT}\\RescueOut`;f.directories.add(output);
    let current=true;
    const cap=p.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:pin,capabilityRoot:ROOT,path:output,assertCurrent(){if(!current)throw new Error("stale rescue");}});
    const before=f.persistenceCalls.length;current=false;
    expect(()=>cap.privateFilesystem.writeNew(`${output}\\stale.bin`,Buffer.from("x"),1)).toThrow();expect(f.persistenceCalls.length).toBe(before);
    current=true;f.overrides.set(WS_DIR,"9".repeat(32));
    expect(()=>cap.assertCurrent()).toThrow("RESCUE_WORKSPACE_CHANGED");expect(f.persistenceCalls.length).toBe(before);
    f.overrides.delete(WS_DIR);
    expect(()=>p.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:{...pin,fileId:"8".repeat(32)},capabilityRoot:ROOT,path:output,assertCurrent(){}})).toThrow("RESCUE_REBIND");
  });
  it("keeps unbound selected backup admission read-only and refuses bound callers or unknown rescue sources", () => {
    const f=fixture(),p=f.open(),pin=p.privateFilesystem.inspectDirectory(WS_DIR),path=`${ROOT}\\Imported\\selected`,manifestPath=`${path}\\manifest.json`,bytes=Buffer.from('{"valid":true}');
    f.directories.add(path);f.transport.published.set(manifestPath,{fileId:"a".repeat(32),bytes});
    const cap=p.authorizeReadOnlyRescue({kind:"backup-source",workspaceDirectory:pin,capabilityRoot:ROOT,path,assertCurrent(){},source:{kind:"backup",path,manifestPath,manifestSha256:hash(bytes),assertCurrent(){}}});
    expect(cap.privateFilesystem.inspectFile(manifestPath,100).sha256).toBe(hash(bytes));
    expect(()=>cap.privateFilesystem.writeNew(`${path}\\forbidden.bin`,Buffer.from("x"),1)).toThrow();
    const unknown=`${WS_DIR}\\unknown.bin`;f.transport.published.set(unknown,{fileId:"c".repeat(32),bytes:Buffer.from("unknown")});
    const output=`${ROOT}\\Out`;f.directories.add(output);
    const rescue=p.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:pin,capabilityRoot:ROOT,path:output,assertCurrent(){}});
    expect(()=>rescue.privateFilesystem.inspectFile(unknown,100)).toThrow("NOT_ENROLLED");
    const b=fixture(),bound=b.open();bound.bindWorkspace(WS_DIR,"ws-1");
    expect(()=>bound.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:pin,capabilityRoot:ROOT,path:output,assertCurrent(){}})).toThrow("RESCUE_BOUND");
  });
  it("refuses unretained rescue directories even in enrollment mode and rejects overlapping rescue output", () => {
    const f=fixture(),p=f.open(),pin={path:WS_DIR,fileId:idFor(WS_DIR),volumeId:VOLUME},output=`${ROOT}\\Out`;f.directories.add(output);
    expect(()=>p.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:pin,capabilityRoot:ROOT,path:output,assertCurrent(){}})).toThrow("NOT_ENROLLED");
    p.privateFilesystem.inspectDirectory(WS_DIR);
    expect(()=>p.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:pin,capabilityRoot:ROOT,path:`${WS_DIR}\\Out`,assertCurrent(){}})).toThrow();
    expect(()=>p.authorizeReadOnlyRescue({kind:"raw-rescue",workspaceDirectory:pin,capabilityRoot:"C:\\",path:output,assertCurrent(){}})).toThrow("RESCUE_REQUEST");
  });

  it("exports through the real J factory with Main forbidden workspace/profile roots and a disjoint sibling output", async () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1");
    const output = `${ROOT}\\Exports`, path = `${output}\\shared-backup.json`;
    f.directories.add(output);
    p.authorizeExternalCapability({kind: "raw-rescue", capabilityRoot: ROOT, path: output, assertCurrent(){}});
    const source = new RuntimeStore(tempDir());
    let value: ReturnType<typeof exportBackup>;
    try {
      source.transaction(() => {source.set("meta", "head", {epoch: "epoch-export", seq: 0, hash: "d".repeat(64)}); source.set("meta", "title", "preserve");});
      value = exportBackup(source);
    } finally {source.close();}
    const download = {raw: canonical(value, 256 * 1024 * 1024), hash: value.hash, head: value.head};
    const result = await exportSharedBackup({download: async()=>download, pick:async()=>path,
      isAuthorized:()=>true, forbiddenRoots:[WS_DIR, `${ROOT}\\AppProfile`],
      nativeBackup:p.nativeBackup, revalidateSource:async()=>{}});
    expect(result.state).toBe("EXPORTED");
    expect(Buffer.from(f.transport.published.get(path)!.bytes).toString("utf8")).toBe(download.raw);
    const before = f.transport.calls.length;
    const denied = await p.nativeBackup.publishNew({path:`${WS_DIR}\\forbidden.json`, stagingPath:`${WS_DIR}\\.forbidden.tmp`,attemptId:"f".repeat(32),
      bytes:Buffer.from(download.raw),source:{head:value.head,hash:value.hash},forbiddenRoots:[WS_DIR],assertCurrent(){},beforePublish(){}});
    expect(denied.state).toBe("REJECTED");expect(f.transport.calls.length).toBe(before);
  });

  it("composes J backup publication and retains its separate large-profile journal", async () => {
    const f = fixture(), p = f.open();
    let currentCalls = 0, approvals = 0;
    const bytes = Buffer.from("bounded backup contract payload");
    const receipt = await p.nativeBackup.publishNew({
      path: `${WS_DIR}\\backup.json`, stagingPath: `${WS_DIR}\\.backup.tmp`, attemptId: "e".repeat(32),
      bytes, forbiddenRoots: [], source: {head: {epoch: "epoch-1", seq: 3, hash: "b".repeat(64)}, hash: "c".repeat(64)},
      assertCurrent() { currentCalls++; },
      async beforePublish(readback) { approvals++; expect(Buffer.from(readback).equals(bytes)).toBe(true); },
    });
    expect(receipt.state).toBe("PUBLISHED");
    expect(approvals).toBe(1); expect(currentCalls).toBeGreaterThan(1);
    expect(f.profiles).toContainEqual({name: "windows-backup-artifact-v1.sqlite", profile: "backup-artifact"});
    expect(f.transport.calls.every(c => c.wire.profile === WINDOWS_BACKUP_ARTIFACT_PROFILE)).toBe(true);
  });

  it("rejects an async backup current callback before opening any journal", async () => {
    const f = fixture(), p = f.open();
    await expect(p.nativeBackup.publishNew({
      path: `${WS_DIR}\\backup.json`, stagingPath: `${WS_DIR}\\.backup.tmp`, attemptId: "e".repeat(32),
      bytes: Buffer.alloc(1), forbiddenRoots: [], source: {head: {epoch: "epoch-1", seq: 0, hash: "b".repeat(64)}, hash: "c".repeat(64)},
      async assertCurrent() {}, beforePublish() {},
    })).rejects.toThrow();
    expect(f.transport.calls).toHaveLength(0); expect(f.profiles).toHaveLength(0);
  });

  it("keeps the backup authority held while asynchronous approval is in flight", async () => {
    const f = fixture(), p = f.open();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const approval = new Promise<void>(resolve => { release = resolve; });
    const publishing = p.nativeBackup.publishNew({
      path: `${WS_DIR}\\backup.json`, stagingPath: `${WS_DIR}\\.backup.tmp`, attemptId: "e".repeat(32),
      bytes: Buffer.from("retained"), forbiddenRoots: [],
      source: {head: {epoch: "epoch-1", seq: 0, hash: "b".repeat(64)}, hash: "c".repeat(64)},
      assertCurrent() {}, async beforePublish() { entered(); await approval; },
    });
    await ready;
    expect(() => p.close()).toThrow("BACKUP_IN_FLIGHT");
    release();
    expect((await publishing).state).toBe("PUBLISHED");
    expect(() => p.close()).not.toThrow();
  });

  it("re-proves root and workspace IDs and rejects persistent replacements after reopen", () => {
    const f = fixture(), p = f.open();
    p.assertRoot();
    f.overrides.set(ROOT, "6".repeat(32));
    expect(() => p.assertRoot()).toThrow();
    f.overrides.delete(ROOT);
    p.bindWorkspace(WS_DIR, "ws-1");
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort});
    file.write(0, snapshot("one")); p.close();
    f.overrides.set(WS_DIR, "7".repeat(32));
    expect(() => f.open().bindWorkspace(WS_DIR, "ws-1")).toThrow();
    expect(f.transport.dispatches()).toBe(2);
  });

  it("refuses a replaced state database before a new native publication", () => {
    const f = fixture(), p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort}).write(0, snapshot("one"));
    p.close();
    f.overrides.set(`${STATE_DIR}\\windows-recovery-v3.sqlite`, "8".repeat(32));
    const fresh = f.open(); fresh.bindWorkspace(WS_DIR, "ws-1");
    expect(() => new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: fresh.crashRecoveryPort})
      .write(1, snapshot("two"))).toThrow();
    expect(f.transport.dispatches()).toBe(2);
  });

  it("retains pointer UNKNOWN across reopen without native resend", () => {
    const f = fixture(), p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1"); f.faults.unknownCommit = true;
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort});
    expect(() => file.write(0, snapshot("uncertain"))).toThrow();
    const calls = f.transport.dispatches();
    p.close(); f.faults.unknownCommit = false;
    const fresh = f.open(); fresh.bindWorkspace(WS_DIR, "ws-1");
    expect(() => new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: fresh.crashRecoveryPort})
      .write(0, snapshot("uncertain"))).toThrow();
    expect(f.transport.dispatches()).toBe(calls);
  });

  it("retains exact commit captures when the current session expires after native application", () => {
    const f = fixture(), p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    f.faults.afterCommit = () => { f.faults.fence = () => { throw new Error("expired after commit"); }; };
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: p.crashRecoveryPort});
    expect(() => file.write(0, snapshot("uncertain"))).toThrow();
    f.faults.fence = undefined; f.faults.afterCommit = undefined;
    p.close();
    const db = new DatabaseSync(join(f.stateDirectory, "windows-recovery-v3.sqlite"), {readOnly: true});
    try {
      const row = db.prepare("SELECT bytes FROM recovery_blobs WHERE kind='capture:commit-prepared:stdout'").get()!;
      expect(decode(row.bytes as Uint8Array).header.state).toBe("PUBLISHED");
    } finally { db.close(); }
    const fresh = f.open(); fresh.bindWorkspace(WS_DIR, "ws-1");
    expect(() => new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: fresh.crashRecoveryPort})
      .write(0, snapshot("uncertain"))).toThrow();
    expect(f.transport.dispatches()).toBe(2);
  });

  it("releases only unused raw reservation through six successful small exports", () => {
    const f = fixture(), p = f.open();
    for (let n = 1; n <= 6; n++)
      expect(p.privateFileV3Port.publish({path: `${WS_DIR}\\raw-${n}.bin`, stagingPath: `${WS_DIR}\\.raw-${n}.tmp`,
        attemptId: n.toString(16).padStart(32, "0"), bytes: Buffer.from(`retain-${n}`), beforePublish() {}}).state)
        .toBe("PUBLISHED");
    expect(f.transport.dispatches()).toBe(12);
    p.close();
    const db = new DatabaseSync(join(f.stateDirectory, "raw-export-v3.sqlite"), {readOnly: true});
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM raw_blobs WHERE kind='original'").get()?.n).toBe(6);
    } finally { db.close(); }
  }, 30_000);

  it("snapshots raw bytes before the first caller fence and blocks stale calls before dispatch", () => {
    const f = fixture(), p = f.open(), bytes = Buffer.from("original");
    f.faults.fence = () => { bytes.fill(0); };
    const receipt = p.privateFileV3Port.publish({
      path: `${WS_DIR}\\frozen.bin`, stagingPath: `${WS_DIR}\\.frozen.tmp`, attemptId: "a".repeat(32),
      bytes, beforePublish(readback) { expect(Buffer.from(readback).toString()).toBe("original"); },
    });
    expect(Buffer.from(receipt.readback).toString()).toBe("original");
    const calls = f.transport.dispatches();
    f.faults.fence = () => { throw new Error("session/cut expired"); };
    expect(() => p.privateFileV3Port.publish({
      path: `${WS_DIR}\\later.bin`, stagingPath: `${WS_DIR}\\.later.tmp`, attemptId: "b".repeat(32),
      bytes: Buffer.alloc(1), beforePublish() {},
    })).toThrow();
    expect(f.transport.dispatches()).toBe(calls);
    f.faults.fence = undefined;
  });

  it("does not release raw capacity on a forged hash-only PUBLISHED terminal", () => {
    const f = fixture(), p = f.open(), id = "a".repeat(32);
    p.privateFileV3Port.publish({path: `${WS_DIR}\\first.bin`, stagingPath: `${WS_DIR}\\.first.tmp`,
      attemptId: id, bytes: Buffer.from("retain"), beforePublish() {}});
    p.close();
    const db = new DatabaseSync(join(f.stateDirectory, "raw-export-v3.sqlite"));
    try {
      db.prepare("UPDATE raw_terminals SET receipt=? WHERE attempt_id=?")
        .run(JSON.stringify({attemptId: id, outcome: "PUBLISHED", evidence: {sha256: hash(Buffer.from("retain"))}}), id);
    } finally { db.close(); }
    const calls = f.transport.dispatches();
    expect(() => f.open().privateFileV3Port.publish({path: `${WS_DIR}\\second.bin`, stagingPath: `${WS_DIR}\\.second.tmp`,
      attemptId: "b".repeat(32), bytes: Buffer.from("new"), beforePublish() {}})).toThrow();
    expect(f.transport.dispatches()).toBe(calls);
    const retained = new DatabaseSync(join(f.stateDirectory, "raw-export-v3.sqlite"), {readOnly: true});
    try {
      const row = retained.prepare("SELECT bytes FROM raw_blobs WHERE attempt_id=? AND kind='original'").get(id)!;
      expect(Buffer.from(row.bytes as Uint8Array).toString()).toBe("retain");
    } finally { retained.close(); }
  });

  it("retains every failed close cause and retries only owned unfinished cleanup", () => {
    const f = fixture(), p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    p.privateFileV3Port.publish({path: `${WS_DIR}\\raw.bin`, stagingPath: `${WS_DIR}\\.raw.tmp`,
      attemptId: "a".repeat(32), bytes: Buffer.from("retained"), beforePublish() {}});
    f.faults.close = true;
    let failure: unknown;
    try { p.close(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.length).toBeGreaterThan(1);
    expect(() => p.assertRoot()).toThrow();
    f.faults.close = false;
    expect(() => p.close()).not.toThrow();
  });

  it("reopens the same head after product.close() across factories", () => {
    const { open, transport } = fixture();
    const first = open();
    first.bindWorkspace(WS_DIR, "ws-1");
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", { platform: "win32", nativePort: first.crashRecoveryPort });
    expect(file.write(0, snapshot("persisted")).status).toBe("ready");
    const dispatches = transport.dispatches();
    first.close();
    const second = open();
    second.bindWorkspace(WS_DIR, "ws-1");
    const reread = new CrashRecoveryFile(LOGICAL, "ws-1", { platform: "win32", nativePort: second.crashRecoveryPort });
    const read = reread.read();
    expect(read.status).toBe("ready");
    if (read.status !== "ready") throw new Error("unreachable");
    expect(read.generation).toBe(1);
    // The APPLIED pointer proof is read-only: no new helper dispatch.
    expect(transport.dispatches()).toBe(dispatches);
  });

  it("admits an exact orphan file under unenrolled ancestors only by its pinned native identity", () => {
    const f = fixture(), orphan = `${ROOT}\\orphans\\lost.bin`, bytes = Buffer.from("orphan-bytes");
    const identity = {path: orphan, fileId: "5".repeat(32), volumeId: VOLUME,
      bytes: bytes.byteLength, sha256: hash(bytes)};
    f.transport.published.set(orphan, {fileId: identity.fileId, bytes});
    const initial = f.open(); initial.bindWorkspace(WS_DIR, "ws-1"); initial.close();
    const p = f.open(false); p.bindWorkspace(WS_DIR, "ws-1");
    // Enrollment-off: the unknown parent keeps the orphan unreachable.
    expect(() => p.privateFilesystem.inspectFile(orphan, 1024)).toThrow("NOT_ENROLLED");
    // Authority-gated inspection returns the native proof but enrolls nothing.
    expect(() => p.inspectSelectedFile({kind: "orphan", path: orphan,
      assertCurrent() { throw new Error("stale picker"); }})).toThrow("stale picker");
    const observed = p.inspectSelectedFile({kind: "orphan", path: orphan, assertCurrent() {}});
    expect(observed).toEqual(identity);
    expect(() => p.privateFilesystem.inspectFile(orphan, 1024)).toThrow("NOT_ENROLLED");
    expect(() => p.admitSelectedFile({kind: "orphan", path: orphan,
      expected: {...identity, sha256: "0".repeat(64)}, assertCurrent() {}}))
      .toThrow("ADMISSION_UNPROVEN");
    expect(() => p.admitSelectedFile({kind: "orphan", path: orphan, expected: identity,
      assertCurrent() { throw new Error("stale picker"); }})).toThrow("stale picker");
    expect(() => p.privateFilesystem.inspectFile(orphan, 1024)).toThrow("NOT_ENROLLED");
    const receipt = p.admitSelectedFile({kind: "orphan", path: orphan, expected: identity, assertCurrent() {}});
    expect(receipt.file.fileId).toBe(identity.fileId);
    expect(receipt.identities.some(i => i.kind === "directory" && i.canonicalPath === `${ROOT}\\orphans`)).toBe(true);
    expect(receipt.identities.some(i => i.kind === "file" && i.canonicalPath === orphan)).toBe(true);
    expect(p.privateFilesystem.inspectFile(orphan, 1024).sha256).toBe(identity.sha256);
    // A replaced orphan is rejected against the retained identity.
    f.transport.published.get(orphan)!.fileId = "f".repeat(32);
    expect(() => p.privateFilesystem.inspectFile(orphan, 1024)).toThrow();
  }, 30_000);

  it("lets an explicit lease close retry settle while poison rejects all later use", () => {
    const f = fixture(), p = f.open(); p.bindWorkspace(WS_DIR, "ws-1");
    const live = `${WS_DIR}\\lease.db`;
    const id = p.privateFilesystem.writeNew(live, Buffer.from("db"), 100).identity;
    const lease = p.privateFilesystem.acquireSqliteLease!(live, id);
    f.faults.close = true;
    let first: unknown;
    try { lease.close(); } catch (error) { first = error; }
    expect(first).toBeInstanceOf(AggregateError);
    expect((first as AggregateError).errors).toHaveLength(1);
    // A second failure retains first + latest causes.
    let second: unknown;
    try { lease.close(); } catch (error) { second = error; }
    expect((second as AggregateError).errors).toHaveLength(2);
    // An acknowledged retry still calls the underlying close and settles.
    f.faults.close = false;
    expect(() => lease.close()).not.toThrow();
    expect(() => lease.close()).not.toThrow();
    // Poison is permanent: no lease assertion or mutation ever succeeds again.
    expect(() => lease.assertHeld()).toThrow();
    expect(() => p.privateFilesystem.writeNew(`${WS_DIR}\\after.bin`, Buffer.alloc(1), 16)).toThrow();
  });

  it("holds an independent SQLite lease inside a rename phase while mutations stay rejected", () => {
    const f = fixture(), from = `${WS_DIR}\\rename-phase`, to = `${WS_DIR}\\rename-phase-moved`;
    const live = `${WS_DIR}\\live.sqlite`, p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    f.directories.add(from);
    p.privateFilesystem.inspectDirectory(from);
    p.privateFilesystem.writeNew(`${from}\\marker.json`, Buffer.from("marker"), 100);
    const liveIdentity = p.privateFilesystem.writeNew(live, Buffer.from("live-journal"), 1024).identity;
    const tree = p.privateFilesystem.inspectTree!(from);
    const phases: string[] = [];
    const receipt = p.privateFilesystem.renameDirectoryNew!(from, to, tree, phase => {
      phases.push(phase);
      const lease = p.privateFilesystem.acquireSqliteLease!(live, liveIdentity);
      lease.assertHeld();
      lease.close();
      expect(() => p.privateFilesystem.writeNew(`${WS_DIR}\\phase-writer.bin`, Buffer.alloc(1), 16))
        .toThrow(/REENTRANT_MUTATION|BUSY|REJECTED/);
      expect(p.privateFilesystem.inspectFile(live, 1024).fileId).toBe(liveIdentity.fileId);
    });
    expect(receipt.identity.path).toBe(to);
    expect(phases).toEqual(["reserve", "dispatch", "success"]);
    expect(f.leases.some(l => l.path === live && l.fileId === liveIdentity.fileId)).toBe(true);
  }, 30_000);

  it("scopes an authorized external capability to the selected parent only", () => {
    const f = fixture(), selected = `${ROOT}\\archive-out`, p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    f.directories.add(selected);
    // Stale picker authority rejects before any enrollment.
    expect(() => p.authorizeExternalCapability({kind: "raw-rescue", capabilityRoot: ROOT, path: selected,
      assertCurrent() { throw new Error("revoked"); }})).toThrow("revoked");
    // Unbound state/workspace/sibling scopes are refused at request time.
    expect(() => p.authorizeExternalCapability({kind: "raw-rescue", capabilityRoot: ROOT,
      path: `${STATE_ROOT}\\x`, assertCurrent() {}})).toThrow();
    expect(() => p.authorizeExternalCapability({kind: "raw-rescue", capabilityRoot: ROOT,
      path: WS_DIR, assertCurrent() {}})).toThrow("OUTPUT");
    expect(() => p.authorizeExternalCapability({kind: "raw-rescue", capabilityRoot: "C:\\",
      path: `${ROOT}\\archive-out`, assertCurrent() {}})).toThrow("DRIVE_ROOT");
    const capability = p.authorizeExternalCapability({kind: "raw-rescue", capabilityRoot: ROOT,
      path: selected, assertCurrent() {}});
    expect(capability.kind).toBe("raw-rescue");
    expect(capability.path).toBe(selected);
    const calls = f.persistenceCalls.length;
    const receipt = capability.privateFilesystem.writeNew(`${selected}\\rescued.bin`, Buffer.from("rescued"), 100);
    expect(receipt.identity.path).toBe(`${selected}\\rescued.bin`);
    expect(f.persistenceCalls.filter(op => op === "write-new").length).toBe(1);
    // Sibling/workspace mutations are refused before any native dispatch.
    expect(() => capability.privateFilesystem.writeNew(`${WS_DIR}\\escape.bin`, Buffer.alloc(1), 16)).toThrow("SCOPE_WRITE");
    expect(() => capability.privateFilesystem.unlinkExact(`${WS_DIR}\\escape.bin`,
      {path: `${WS_DIR}\\escape.bin`, fileId: "0".repeat(32), volumeId: VOLUME, bytes: 1, sha256: "0".repeat(64)}, 16))
      .toThrow("SCOPE_WRITE");
    // The selected parent itself cannot be mutated either.
    expect(() => capability.privateFilesystem.createDirectory(selected)).toThrow("SCOPE_WRITE");
    expect(() => capability.privateFilesystem.inspectFile("C:\\Elsewhere\\x.bin", 16)).toThrow();
    expect(f.persistenceCalls.filter(op => op === "write-new").length).toBe(1);
    // The bound workspace remains readable through the capability.
    const written = p.privateFilesystem.writeNew(`${WS_DIR}\\cap-read.bin`, Buffer.from("cap"), 100).identity;
    expect(capability.privateFilesystem.inspectFile(`${WS_DIR}\\cap-read.bin`, 100).fileId).toBe(written.fileId);
    expect(f.persistenceCalls.length).toBeGreaterThan(calls);
  }, 30_000);

  it("composes a distinct capability root for root==workspace sibling output across restart", () => {
    const f = fixture(), selected = `${ROOT}\\archive-out`, capSrc = `${WS_DIR}\\cap-src`;
    const wsConfig: WindowsOperatorConfig = {...config, root: WS_DIR};
    // cap-src must be retained while enrollment is on; the reopened product
    // asserts identities rather than enrolling new ones.
    f.directories.add(capSrc);
    const initial = f.open(true, wsConfig); initial.bindWorkspace(WS_DIR, "ws-1");
    initial.privateFilesystem.inspectDirectory(capSrc);
    initial.close();
    f.directories.add(selected);
    const p = f.open(false, wsConfig); p.bindWorkspace(WS_DIR, "ws-1");
    // capabilityRoot C:\Folio contains the bound workspace root C:\Folio\workspace-1
    // and the external sibling C:\Folio\archive-out on one native volume.
    const capability = p.authorizeExternalCapability({kind: "raw-rescue", capabilityRoot: ROOT,
      path: selected, assertCurrent() {}});
    const receipt = capability.privateFilesystem.writeNew(`${selected}\\rescued.bin`, Buffer.from("rescued"), 100);
    expect(receipt.identity.path).toBe(`${selected}\\rescued.bin`);
    const writtenId = receipt.identity.fileId;
    // An out-of-scope SQLite source handle is rejected before dispatch.
    const foreignDb = {prepare: (sql: string) => ({
      all: () => [{name: "main", file: `${ROOT}\\sibling\\journal.sqlite`}],
    })};
    expect(() => capability.privateFilesystem.snapshotSqlite(foreignDb as never, `${selected}\\snap.sqlite`))
      .toThrow("SCOPE_READ");
    // A native file-ID replacement under the capability root is refused.
    f.transport.published.set(`${selected}\\rescued.bin`, {fileId: "f".repeat(32), bytes: Buffer.from("rescued")});
    expect(() => capability.privateFilesystem.inspectFile(`${selected}\\rescued.bin`, 100)).toThrow();
    f.transport.published.set(`${selected}\\rescued.bin`, {fileId: writtenId, bytes: Buffer.from("rescued")});
    p.close();
    // Restart: a new explicit request reuses the retained common-root binding.
    const reopened = f.open(false, wsConfig); reopened.bindWorkspace(WS_DIR, "ws-1");
    const again = reopened.authorizeExternalCapability({kind: "raw-rescue", capabilityRoot: ROOT,
      path: selected, assertCurrent() {}});
    expect(again.privateFilesystem.inspectFile(`${selected}\\rescued.bin`, 100).fileId).toBe(writtenId);
    // A capability mutation from inside a base K operation callback crosses
    // the product-global mutation gate; the nested write never dispatches.
    const srcTree = reopened.privateFilesystem.inspectTree!(capSrc);
    const nested = () => f.persistenceCalls.filter(o => o === "write-new").length;
    const before = nested();
    expect(() => reopened.privateFilesystem.renameDirectoryNew!(capSrc, `${WS_DIR}\\cap-dst`, srcTree,
      () => { again.privateFilesystem.writeNew(`${selected}\\nested.bin`, Buffer.alloc(1), 16); }))
      .toThrow("REVALIDATE");
    expect(nested()).toBe(before);
  }, 30_000);

  it("runs the real full-backup verifier through independent leases inside actual K rename phases", () => {
    // Real POSIX source + backup outside the native context; the Windows
    // fixture paths are registered so the actual verifier and SQLite readers
    // exercise the product K port and independent leases for real bytes.
    const real = tempDir(), source = join(real, "source"), assets = join(source, "assets");
    mkdirSync(source); mkdirSync(assets);
    const store = new Store(join(source, "workspace.sqlite"));
    writeFileSync(join(assets, "blob.bin"), Buffer.from("physical-asset-bytes"));
    const backup = join(real, "backup"), moved = join(real, "backup-moved");
    createFullBackup(store.db, source, backup);
    store.close();

    const f = fixture(), winSrc = `${WS_DIR}\\backup-stage`, winDst = `${WS_DIR}\\backup-final`;
    const toWin = (winBase: string, physBase: string, p: string): string => {
      const rel = relative(physBase, p);
      return rel === "" ? winBase : `${winBase}\\${rel.split(sep).join("\\")}`;
    };
    const toPhys = (physBase: string, winBase: string, w: string): string =>
      w === winBase ? physBase : join(physBase, w.slice(winBase.length + 1).split("\\").join(sep));
    const register = (physBase: string, winBase: string): void => {
      f.directories.add(winBase);
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name), w = toWin(winBase, physBase, p);
          if (lstatSync(p).isDirectory()) { f.directories.add(w); walk(p); }
          else {
            const bytes = readFileSync(p);
            f.transport.published.set(w, {fileId: hash(Buffer.from(`verify:${w}`)).slice(0, 32), bytes});
            f.physicalFiles.set(w, p);
          }
        }
      };
      walk(physBase);
    };
    register(backup, winSrc);
    // The simulated helper physically renames only at actual dispatch.
    f.faults.afterPrivateMutation = (operation, dest) => {
      if (operation !== "rename-directory-new" || dest !== winDst) return;
      renameSync(backup, moved);
      for (const [w, phys] of [...f.physicalFiles])
        if (w.startsWith(`${winSrc}\\`)) {
          f.physicalFiles.delete(w);
          f.physicalFiles.set(`${winDst}${w.slice(winSrc.length)}`, join(moved, relative(backup, phys)));
        }
    };
    const p = f.open(); p.bindWorkspace(WS_DIR, "ws-1");
    const unmap = <T extends {path: string}>(physBase: string, winBase: string, v: T): T =>
      ({...v, path: toPhys(physBase, winBase, v.path)});
    // Test-only mapping port: physical POSIX arguments are translated to the
    // Windows fixture namespace and every result path is translated back.
    const mapped = (physBase: string, winBase: string): NativePrivateFilesystemPort => ({
      ...p.privateFilesystem,
      inspectDirectory: path => unmap(physBase, winBase,
        p.privateFilesystem.inspectDirectory(toWin(winBase, physBase, path))),
      inspectFile: (path, max) => unmap(physBase, winBase,
        p.privateFilesystem.inspectFile(toWin(winBase, physBase, path), max)),
      inspectFileIdentity: path => unmap(physBase, winBase,
        p.privateFilesystem.inspectFileIdentity(toWin(winBase, physBase, path))),
      read: (path, expected, max) => p.privateFilesystem.read(toWin(winBase, physBase, path),
        {...expected, path: toWin(winBase, physBase, expected.path)}, max),
      acquireSqliteLease: (path, expected) => p.privateFilesystem.acquireSqliteLease!(
        toWin(winBase, physBase, path), {...expected, path: toWin(winBase, physBase, expected.path)}),
    });
    // The real archive picker verifies/admit-binds the entire source before
    // reserving a relocation. A pending move must never enroll unseen files.
    const chosen = withPrivatePersistence({nativePrivateFilesystem: mapped(backup, winSrc)}, () => verifyFullBackup(backup));
    const tree = p.privateFilesystem.inspectTree!(winSrc);
    const fingerprints = new Map<string, string>(), leasesBefore = f.leases.length;
    const receipt = p.privateFilesystem.renameDirectoryNew!(winSrc, winDst, tree, phase => {
      const physBase = phase === "success" ? moved : backup;
      const winBase = phase === "success" ? winDst : winSrc;
      const verified = withPrivatePersistence({nativePrivateFilesystem: mapped(physBase, winBase)},
        () => verifyFullBackup(physBase));
      fingerprints.set(phase, verified.fingerprint);
      // Mutations inside a phase callback hit the global mutation gate.
      expect(() => p.privateFilesystem.writeNew(`${winBase}\\phase.bin`, Buffer.alloc(1), 16))
        .toThrow("REENTRANT_MUTATION");
    });
    expect(receipt.identity.path).toBe(winDst);
    expect(fingerprints.size).toBe(3);
    expect(fingerprints.get("reserve")).toBe(chosen.fingerprint);
    expect(fingerprints.get("reserve")).toBe(fingerprints.get("dispatch"));
    expect(fingerprints.get("dispatch")).toBe(fingerprints.get("success"));
    // The actual verifier opened an independent lease on the staged database.
    expect(f.leases.length).toBeGreaterThan(leasesBefore);
    expect(f.leases.slice(leasesBefore).every(l => l.root === ROOT &&
      (l.path === `${winSrc}\\workspace.sqlite` || l.path === `${winDst}\\workspace.sqlite`))).toBe(true);

    // A stale authority in the reserve phase dispatches nothing.
    const backup2 = join(real, "backup2"), winSrc2 = `${WS_DIR}\\backup-stage2`, winDst2 = `${WS_DIR}\\backup-final2`;
    const store2 = new Store(join(source, "workspace.sqlite"));
    createFullBackup(store2.db, source, backup2);
    store2.close();
    register(backup2, winSrc2);
    const renames = () => f.persistenceCalls.filter(o => o === "rename-directory-new").length;
    const before = renames();
    const tree2 = p.privateFilesystem.inspectTree!(winSrc2);
    expect(() => p.privateFilesystem.renameDirectoryNew!(winSrc2, winDst2, tree2, phase => {
      if (phase === "reserve") throw new Error("stale authority");
    })).toThrow("REVALIDATE");
    expect(renames()).toBe(before);
    expect(lstatSync(backup2).isDirectory()).toBe(true);
  }, 30_000);

  it("retains the raw archive platform on an unacknowledged preflight close and releases it on a proven one", () => {
    const directory = tempDir();
    const instrument = (onClose: () => void): PrivatePlatform => {
      const base = testingPlatform()(directory);
      return {...base, close() { onClose(); base.close(); }};
    };
    // An existing journal on disk is what makes construction run the
    // owner-guarded preflight.
    new RawExportArchive(directory, instrument(() => {}), "binding-v1", []).close();
    let retained: SqliteConnectionOwner | undefined, releases = 0;
    const originalFail = SqliteConnectionOwner.prototype.fail;
    vi.spyOn(SqliteConnectionOwner.prototype, "fail")
      .mockImplementation(function (this: SqliteConnectionOwner, error: unknown): never {
        retained = this;
        return originalFail.call(this, error);
      });
    // Close that throws before closing: the handle stays unconfirmed, the
    // owner retains the platform, and exactly one close is attempted.
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      throw new Error("preflight close unacknowledged");
    });
    expect(() => new RawExportArchive(directory, instrument(() => { releases++; }), "binding-v1", []))
      .toThrow("owner retained");
    expect(vi.mocked(DatabaseSync.prototype.close)).toHaveBeenCalledTimes(1);
    expect(releases).toBe(0);
    expect(retained).toBeDefined();
    vi.restoreAllMocks();
    // The retained owner is the explicit cleanup path: the still-open handle
    // is proven closed first, then the platform release runs exactly once.
    expect(() => retained!.close()).not.toThrow();
    expect(releases).toBe(1);
    // A close that provably closes the handle before throwing surfaces the
    // cause while the ordered platform release still runs.
    let releases2 = 0;
    const real = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      real.call(this);
      throw new Error("preflight close observed");
    });
    expect(() => new RawExportArchive(directory, instrument(() => { releases2++; }), "binding-v1", []))
      .toThrow("preflight close observed");
    expect(releases2).toBe(1);
    vi.restoreAllMocks();
  });

  it.each(["write-new", "copy-new", "rename-new", "rename-directory-new"] as const)(
    "repairs an external %s UNKNOWN from its retained origin scope without redispatch", (operation) => {
    const f = fixture(), EXT = `${ROOT}\\External`, src = `${WS_DIR}\\scope-src.bin`, dst = `${EXT}\\scope-dst.bin`;
    const dirSrc = `${WS_DIR}\\scope-dir`, p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    f.directories.add(EXT); p.privateFilesystem.inspectDirectory(EXT);
    const source = p.privateFilesystem.writeNew(src, Buffer.from("source-bytes"), 100).identity;
    let tree: NativePrivateTree | undefined;
    if (operation === "rename-directory-new") {
      f.directories.add(dirSrc); p.privateFilesystem.inspectDirectory(dirSrc);
      const marker = p.privateFilesystem.writeNew(`${dirSrc}\\marker.json`, Buffer.from("m"), 100).identity;
      tree = {...p.privateFilesystem.inspectTree!(dirSrc)};
      expect(marker.fileId).toBeTruthy();
    }
    const dispatchBefore = f.persistenceCalls.filter(c => c === operation).length;
    f.faults.afterPrivateMutation = (op, target) => { if (op === operation) f.overrides.set(target, "f".repeat(32)); };
    if (operation === "write-new")
      expect(() => p.privateFilesystem.writeNew(dst, Buffer.from("payload"), 100)).toThrow();
    else if (operation === "copy-new")
      expect(() => p.privateFilesystem.copyNew(src, dst, source, 100)).toThrow();
    else if (operation === "rename-new")
      expect(() => p.privateFilesystem.renameNew(src, dst, source, 100)).toThrow();
    else expect(() => p.privateFilesystem.renameDirectoryNew!(dirSrc, dst, tree!)).toThrow();
    f.faults.afterPrivateMutation = undefined; f.overrides.clear(); p.close();
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next);
    const ids = (port.inspect("filesystem") as {result: string[]}).result;
    const item = ids.map(id => (port.inspect("filesystem", id) as {result: WindowsPrivatePersistenceInspection}).result)
      .find(i => { const h = decode(i.wire).header; return h.operation === operation && (h.destination ?? h.path) === dst; })!;
    expect(item.terminal?.state).toBe("UNKNOWN");
    expect(item.origin).toBeInstanceOf(Uint8Array);
    const scope = decodeWindowsMaintenanceOrigin(item.origin!);
    expect(scope.root.path).toBe(ROOT);
    expect(scope.workspace.workspaceId).toBe("ws-1");
    expect(scope.writerId).toBeNull(); expect(scope.sessionId).toBeNull();
    expect(scope.endpoints.map(e => e.path)).toContain(dst);
    const resolved = port.resolve("filesystem", item.attemptId, item.fingerprint) as WindowsPrivatePersistenceInspection;
    expect(resolved.terminal).toEqual(item.terminal);
    expect(resolved.original).toEqual(item.original);
    expect(resolved.wire).toEqual(item.wire);
    // The exact retained scope resolved; the S binding completed and the
    // target is readable with its original native ID — no re-dispatch.
    if (operation === "rename-directory-new")
      expect(next.privateFilesystem.inspectFile(`${dst}\\marker.json`, 100).sha256).toBe(hash(Buffer.from("m")));
    else
      expect(next.privateFilesystem.inspectFile(dst, 100).fileId).toBeTruthy();
    expect(f.persistenceCalls.filter(c => c === operation)).toHaveLength(dispatchBefore + 1);
    // An already-completed resolution is idempotent; a fresh prospective
    // attempt on the consumed destination conflicts, never re-executes.
    const again = port.resolve("filesystem", item.attemptId, item.fingerprint) as WindowsPrivatePersistenceInspection;
    expect(again.resolution).toBe(resolved.resolution);
    expect(() => next.privateFilesystem.writeNew(dst, Buffer.from("replay"), 100)).toThrow();
    expect(f.persistenceCalls.filter(c => c === operation)).toHaveLength(dispatchBefore + 1);
  }, 30_000);

  it("repairs an external raw export UNKNOWN while keeping metadata and terminal immutable", () => {
    const f = fixture(), EXT = `${ROOT}\\Exports`, path = `${EXT}\\x.json`, staging = `${EXT}\\.x.tmp`, p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    f.directories.add(EXT); p.privateFilesystem.inspectDirectory(EXT);
    f.faults.unknownCommit = true;
    const id = "e".repeat(32), original = Buffer.from("external-raw-export");
    expect(() => p.privateFileV3Port.publish({path, stagingPath: staging, attemptId: id,
      bytes: original, beforePublish() {}})).toThrow();
    p.close(); f.faults.unknownCommit = false;
    const next = f.open(false); next.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(next);
    const item = (port.inspect("raw-export", id) as {result: WindowsRecoveryMaintenanceInspection}).result;
    expect(JSON.parse(item.terminal!).outcome).toBe("UNKNOWN");
    expect(item.blobs["origin:scope"]).toBeInstanceOf(Uint8Array);
    const scope = decodeWindowsMaintenanceOrigin(item.blobs["origin:scope"]);
    expect(scope.family).toBe("raw-export"); expect(scope.root.path).toBe(ROOT);
    expect(scope.endpoints.map(e => e.path)).toEqual([path, staging]);
    const dispatches = f.transport.dispatches();
    const resolved = port.resolve("raw-export", id, item.fingerprint) as WindowsRecoveryMaintenanceInspection;
    expect(resolved.terminal).toBe(item.terminal);
    expect(resolved.metadata).toBe(item.metadata);
    expect(JSON.parse(resolved.resolution!).state).toBe("APPLIED_OBSERVED");
    expect(Buffer.from(resolved.blobs.original)).toEqual(original);
    // Resolution never replays native prepare/commit and releases only the
    // unused virtual reservation; a repeated resolve conflicts.
    expect(f.transport.dispatches()).toBe(dispatches);
    expect(() => port.resolve("raw-export", id, item.fingerprint)).toThrow("CONFLICT");
    const fresh = f.open(false); fresh.bindWorkspace(WS_DIR, "ws-1");
    const after = (maintenance(fresh).inspect("raw-export", id) as {result: WindowsRecoveryMaintenanceInspection}).result;
    expect(after.resolution).toBe(resolved.resolution);
  });

  it("denies external UNKNOWN repair under a different workspace binding and for legacy origin-free records", () => {
    const f = fixture(), EXT = `${ROOT}\\External`, dst = `${EXT}\\bound-else.bin`, p = f.open();
    p.bindWorkspace(WS_DIR, "ws-1");
    f.directories.add(EXT); p.privateFilesystem.inspectDirectory(EXT);
    f.faults.afterPrivateMutation = (_op, target) => { f.overrides.set(target, "f".repeat(32)); };
    expect(() => p.privateFilesystem.writeNew(dst, Buffer.from("payload"), 100)).toThrow();
    f.faults.afterPrivateMutation = undefined; f.overrides.clear(); p.close();
    // Reopen under a different semantic workspace: the retained scope pins
    // ws-1, so the same native directory cannot be claimed as ws-2.
    const other = f.open(false); other.bindWorkspace(WS_DIR, "ws-2");
    const wrong = other.maintenancePort({workspace: WS_DIR, workspaceId: "ws-2", workspaceFingerprint: "a".repeat(64),
      writerId: "writer", sessionId: "session", osSid: SID, assertCurrent() {}});
    const ids = (wrong.inspect("filesystem") as {result: string[]}).result;
    const item = ids.map(id => (wrong.inspect("filesystem", id) as {result: WindowsPrivatePersistenceInspection}).result)
      .find(i => { const h = decode(i.wire).header; return h.operation === "write-new" && h.path === dst; })!;
    expect(() => wrong.resolve("filesystem", item.attemptId, item.fingerprint)).toThrow();
    other.close();
    // Deleting the retained origin demotes the same record to the legacy
    // predicate: an external endpoint is permanently UNKNOWN_UNRESOLVABLE.
    const db = new DatabaseSync(join(f.stateDirectory, "private-persistence-v1.sqlite"));
    try { db.prepare("DELETE FROM blobs WHERE kind='origin:scope'").run(); } finally { db.close(); }
    const legacy = f.open(false); legacy.bindWorkspace(WS_DIR, "ws-1");
    const port = maintenance(legacy);
    const demoted = (port.inspect("filesystem", item.attemptId) as {result: WindowsPrivatePersistenceInspection}).result;
    expect(demoted.origin).toBeUndefined();
    const calls = f.persistenceCalls.filter(c => c === "write-new").length;
    expect(() => port.resolve("filesystem", demoted.attemptId, demoted.fingerprint)).toThrow();
    expect(f.persistenceCalls.filter(c => c === "write-new")).toHaveLength(calls);
  });
});
