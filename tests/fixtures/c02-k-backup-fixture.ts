import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { attachFile } from "../../src/persistence/assets";
import { Store } from "../../src/persistence/store";
import type {
  NativePrivateFile, NativePrivateFilesystemPort, NativePrivateIdentity, NativePrivateReceipt,
} from "../../src/platform/private-persistence";
import {
  createWindowsPrivatePersistenceForTesting, type NativePrivatePersistenceAuthority,
  type WindowsPrivatePersistenceTestPort,
} from "../../src/platform/windows/private-persistence";
import { WindowsPrivatePersistenceJournal } from "../../src/platform/windows/private-persistence-journal";
import { PosixPrivatePlatform } from "../../src/sync/private-platform";

export const C02_WINDOWS_ROOT = "C:\\Folio";
const PROFILE = "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1";
const SID = "S-1-5-21-1004336348-1177238915-682003330";
const BINDING = "c02-k-backup-fixture-v1";
type Header = Record<string, any>;
type C02Event = Record<string, unknown>;

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const hex32 = (value: number | bigint): string => (typeof value === "bigint" ? value.toString(16) : Math.trunc(value).toString(16)).padStart(32, "0").slice(-32);
const hex16 = (value: number): string => Math.trunc(value).toString(16).padStart(16, "0").slice(-16);

export function frame(header: object, payload: Uint8Array = new Uint8Array()): Buffer {
  const json = Buffer.from(JSON.stringify(header), "ascii");
  const bytes = Buffer.alloc(4 + json.length + payload.length);
  bytes.writeUInt32LE(json.length, 0);
  json.copy(bytes, 4);
  bytes.set(payload, 4 + json.length);
  return bytes;
}

function decode(input: Uint8Array): { header: Header; payload: Uint8Array } {
  const bytes = Buffer.from(input), length = bytes.readUInt32LE(0);
  return {
    header: JSON.parse(bytes.subarray(4, 4 + length).toString("ascii")) as Header,
    payload: bytes.subarray(4 + length),
  };
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createC02Fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-c02-")));
  const data = join(root, "data"), workspace = join(data, "workspace"), assets = join(workspace, "assets");
  const state = join(root, "state"), dbPath = join(workspace, "workspace.sqlite");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(assets, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const store = new Store(dbPath);
  store.create(null, "page", "C02 K fixture page");
  const inputs = join(root, "inputs");
  mkdirSync(inputs);
  const inputA = join(inputs, "seven.bin"), inputB = join(inputs, "eleven.bin");
  writeFileSync(inputA, Buffer.alloc(7, 0x41));
  writeFileSync(inputB, Buffer.alloc(11, 0x42));
  attachFile(store.db, assets, inputA);
  attachFile(store.db, assets, inputB);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");

  const events: C02Event[] = [];
  const dataStat = lstatSync(data);
  const VOLUME = hex16(dataStat.dev), ROOT_ID = hex32(dataStat.ino);
  const EXEC = Buffer.from("synthetic trusted helper"), EXEC_HASH = hash(EXEC);

  const segmentOK = (segment: string): boolean =>
    segment.length > 0 && segment.length <= 255 && segment !== "." && segment !== ".." &&
    /^[\x20-\x7e]+$/.test(segment) && !/[\\/:*?"<>|\x00-\x1f]/.test(segment) && !/[ .]$/.test(segment);

  function toWin(path: string): string {
    if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path))
      throw new Error("C02_POSIX_PATH");
    const absolute = resolve(path);
    if (absolute !== data && !absolute.startsWith(data + sep)) throw new Error("C02_OUTSIDE_DATA");
    const rel = relative(data, absolute);
    if (rel === "") return C02_WINDOWS_ROOT;
    const segments = rel.split(sep);
    if (!segments.every(segmentOK)) throw new Error("C02_UNSAFE_SEGMENT");
    return C02_WINDOWS_ROOT + "\\" + segments.join("\\");
  }

  function toReal(path: string): string {
    if (typeof path !== "string" || path.includes("\0")) throw new Error("C02_WINDOWS_PATH");
    const folded = path.toLowerCase(), rootFold = C02_WINDOWS_ROOT.toLowerCase();
    if (folded === rootFold) return data;
    if (!folded.startsWith(rootFold + "\\")) throw new Error("C02_OUTSIDE_DATA");
    const segments = path.slice(C02_WINDOWS_ROOT.length + 1).split("\\");
    if (!segments.every(segmentOK)) throw new Error("C02_UNSAFE_SEGMENT");
    return join(data, ...segments);
  }

  type Stat = ReturnType<typeof lstatSync>;
  const proof = (canonicalPath: string, stat: Stat = lstatSync(toReal(canonicalPath))) => ({
    platform: "win32", sid: SID, ownerSid: SID, daclPrivate: true, reparsePoint: false,
    linkCount: 1, localFilesystem: true, fileId: hex32(stat.ino), volumeId: VOLUME,
    rootFileId: ROOT_ID, rootVolumeId: VOLUME, canonicalRoot: C02_WINDOWS_ROOT, canonicalPath,
  });
  const base = (header: Header) => ({
    contractVersion: 4, operation: header.operation, path: header.path, root: C02_WINDOWS_ROOT,
    ...(header.attemptId ? { attemptId: header.attemptId } : {}),
  });
  const ok = (header: Header, body: Record<string, unknown>, payload = new Uint8Array()) => ({
    status: 0, signal: null, stdout: frame({ ...base(header), ...body }, payload), stderr: Buffer.alloc(0),
  });
  const no = (header: Header, state: "REJECTED" | "EXISTS", reason: string) => ({
    status: state === "EXISTS" ? 2 : 1, signal: null,
    stdout: frame({ ...base(header), state, reason }), stderr: Buffer.alloc(0),
  });

  const exec: WindowsPrivatePersistenceTestPort["exec"] = request => {
    const { header: h, payload } = decode(request.input);
    events.push({ phase: "exec", operation: h.operation, path: h.path,
      destination: h.destination, attemptId: h.attemptId });
    try {
      const op = h.operation, parent = (path: string) => win32.dirname(path), real = toReal(h.path);
      if (op === "rename-new" || op === "inspect-tree" || op === "rename-directory-new")
        return no(h, "REJECTED", "PRIVATE_PERSISTENCE_UNSUPPORTED");
      if (op === "inspect-directory" || op === "inspect-file-identity") {
        const stat = lstatSync(real);
        return ok(h, { state: "OK", file: proof(h.path, stat), directory: proof(parent(h.path)) });
      }
      if (op === "inspect-file" || op === "read") {
        const stat = lstatSync(real), bytes = Buffer.from(readFileSync(real));
        if (op === "read" && (hex32(stat.ino) !== h.fileId || VOLUME !== h.volumeId ||
          hash(bytes) !== h.expectedSha256)) return no(h, "REJECTED", "PRIVATE_PERSISTENCE_REJECTED");
        return ok(h, { state: "OK", file: proof(h.path, stat), directory: proof(parent(h.path)),
          byteLength: bytes.length, sha256: hash(bytes), filesystem: "NTFS" },
          op === "read" ? bytes : new Uint8Array());
      }
      if (op === "write-new") {
        if (payload.length !== h.byteLength || hash(payload) !== h.sha256)
          return no(h, "REJECTED", "PRIVATE_PERSISTENCE_REJECTED");
        let fd: number;
        try { fd = openSync(real, "wx", 0o600); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            return no(h, "EXISTS", "PRIVATE_PERSISTENCE_EXISTS");
          throw error;
        }
        try { writeSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
        const bytes = Buffer.from(payload), stat = lstatSync(real);
        return ok(h, { state: "APPLIED", file: proof(h.path, stat), directory: proof(parent(h.path)),
          byteLength: bytes.length, sha256: hash(bytes), filesystem: "NTFS", contentFlushed: true,
          durability: { profile: PROFILE, scope: "PROCESS_CRASH" } }, bytes);
      }
      if (op === "copy-new") {
        const sourceReal = toReal(h.path), destinationReal = toReal(h.destination);
        const stat = lstatSync(sourceReal), bytes = Buffer.from(readFileSync(sourceReal));
        if (hex32(stat.ino) !== h.sourceFileId || VOLUME !== h.sourceVolumeId ||
          hash(bytes) !== h.sourceSha256 || bytes.length !== h.byteLength)
          return no(h, "REJECTED", "PRIVATE_PERSISTENCE_REJECTED");
        try { copyFileSync(sourceReal, destinationReal, constants.COPYFILE_EXCL); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            return no(h, "EXISTS", "PRIVATE_PERSISTENCE_EXISTS");
          throw error;
        }
        const fd = openSync(destinationReal, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        const copied = Buffer.from(readFileSync(destinationReal)), copiedStat = lstatSync(destinationReal);
        return ok(h, { state: "APPLIED", file: proof(h.destination, copiedStat),
          directory: proof(parent(h.destination)), byteLength: copied.length, sha256: hash(copied),
          filesystem: "NTFS", contentFlushed: true,
          durability: { profile: PROFILE, scope: "PROCESS_CRASH" }, destination: h.destination,
          sourceDirectory: proof(parent(h.path)) });
      }
      if (op === "unlink-exact") {
        const stat = lstatSync(real), bytes = Buffer.from(readFileSync(real));
        if (hex32(stat.ino) !== h.fileId || VOLUME !== h.volumeId ||
          hash(bytes) !== h.expectedSha256 || bytes.length !== h.byteLength)
          return no(h, "REJECTED", "PRIVATE_PERSISTENCE_REJECTED");
        const file = proof(h.path, stat), directory = proof(parent(h.path));
        unlinkSync(real);
        return ok(h, { state: "APPLIED", file, directory, byteLength: bytes.length,
          sha256: hash(bytes), filesystem: "NTFS", unlinked: true });
      }
      if (op === "prove-sync") {
        const stat = lstatSync(real), bytes = Buffer.from(readFileSync(real));
        if (hex32(stat.ino) !== h.fileId || VOLUME !== h.volumeId ||
          hash(bytes) !== h.expectedSha256 || bytes.length !== h.byteLength)
          return no(h, "REJECTED", "PRIVATE_PERSISTENCE_REJECTED");
        const fd = openSync(real, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        return ok(h, { state: "APPLIED", file: proof(h.path, stat),
          directory: proof(parent(h.path)), byteLength: bytes.length, sha256: hash(bytes),
          filesystem: "NTFS", contentFlushed: true,
          durability: { profile: PROFILE, scope: "PROCESS_CRASH" } });
      }
      return no(h, "REJECTED", "PRIVATE_PERSISTENCE_REJECTED");
    } catch (error) { return no(h, "REJECTED", message(error)); }
  };

  const testPort: WindowsPrivatePersistenceTestPort = {
    fs: {
      lstat: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        nlink: 1, dev: 1, ino: 1, size: EXEC.length, mtimeMs: 1 }),
      readFile: () => EXEC,
    },
    exec,
  };

  let currentJournal: WindowsPrivatePersistenceJournal | undefined;
  const openJournal = (): WindowsPrivatePersistenceJournal => {
    const journal = new WindowsPrivatePersistenceJournal(state, new PosixPrivatePlatform(),
      BINDING, () => {}, [data]);
    events.push({ phase: "journal.open" });
    return journal;
  };
  events.push({ phase: "profile", originProvider: "absent", binding: BINDING });
  currentJournal = openJournal();

  const authority: NativePrivatePersistenceAuthority = {
    version: 1, independent: true,
    assertCurrent() { currentJournal!.assertCurrent(); },
    reserve(intent) {
      try {
        currentJournal!.reserve(intent);
        events.push({ phase: "reserve", ok: true, attemptId: intent.attemptId, targetKey: intent.targetKey });
      } catch (error) {
        events.push({ phase: "reserve", ok: false, attemptId: intent.attemptId,
          targetKey: intent.targetKey, message: message(error) });
        throw error;
      }
    },
    capture(id, capture) {
      currentJournal!.capture(id, capture);
      events.push({ phase: "capture", attemptId: id });
    },
    terminal(id, state, receipt) {
      currentJournal!.terminal(id, state, receipt);
      events.push({ phase: "terminal", attemptId: id, state });
    },
  };

  const port = createWindowsPrivatePersistenceForTesting({
    root: C02_WINDOWS_ROOT,
    probeExecutable: "C:\\tools\\probe.exe",
    expectedHash: EXEC_HASH,
    systemRoot: "C:\\Windows",
    expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
    authority,
    directoryIdentity(path) {
      const stat = lstatSync(toReal(path));
      if (!stat.isDirectory()) throw new Error("C02_NOT_DIRECTORY");
      return { fileId: hex32(stat.ino), volumeId: VOLUME };
    },
    createDirectory(path) {
      const real = toReal(path);
      mkdirSync(real);
      events.push({ phase: "createDirectory", path });
      return { fileId: hex32(lstatSync(real).ino), volumeId: VOLUME };
    },
    acquireSqliteLease(path) {
      const real = toReal(path), id = hex32(lstatSync(real).ino);
      let closed = false;
      events.push({ phase: "lease.acquire", path, fileId: id });
      return {
        trust: "untrusted-test",
        assertHeld() {
          if (hex32(lstatSync(real).ino) !== id) throw new Error("C02_LEASE_ID");
          events.push({ phase: "lease.assert", path });
        },
        close() {
          if (closed) return;
          closed = true;
          events.push({ phase: "lease.close", path });
        },
      };
    },
    assertCurrent() {},
  }, testPort);

  const upFile = (file: NativePrivateFile): NativePrivateFile => ({ ...file, path: toWin(file.path) });
  const downFile = (file: NativePrivateFile): NativePrivateFile => ({ ...file, path: toReal(file.path) });
  const downId = (identity: NativePrivateIdentity): NativePrivateIdentity =>
    ({ ...identity, path: toReal(identity.path) });
  const downReceipt = (receipt: NativePrivateReceipt): NativePrivateReceipt =>
    ({ ...receipt, identity: downFile(receipt.identity) });

  const snapshotProxy = (db: DatabaseSync, destination: string): DatabaseSync => {
    const winDestination = toWin(destination);
    return new Proxy(db, {
      get(target, name) {
        if (name === "prepare") return (sql: string) => {
          if (sql === "PRAGMA database_list") return {
            all: () => (target.prepare(sql).all() as unknown as { name: string; file?: string }[])
              .map(row => row.name === "main" ? { ...row, file: toWin(String(row.file)) } : row),
          };
          if (sql === "VACUUM INTO ?") return {
            run: (winPath: string) => {
              if (winPath !== winDestination) throw new Error("C02_VACUUM_DESTINATION");
              return target.prepare(sql).run(toReal(winPath));
            },
          };
          return target.prepare(sql);
        };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseSync;
  };

  const native: NativePrivateFilesystemPort = {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory(path) {
      if (resolve(path) === data) return { path, fileId: ROOT_ID, volumeId: VOLUME };
      return downId(port.inspectDirectory(toWin(path)));
    },
    inspectFileIdentity(path) {
      if (resolve(path) === data) return { path, fileId: ROOT_ID, volumeId: VOLUME };
      return downId(port.inspectFileIdentity(toWin(path)));
    },
    inspectFile: (path, maxBytes) => downFile(port.inspectFile(toWin(path), maxBytes)),
    read: (path, expected, maxBytes) => port.read(toWin(path), upFile(expected), maxBytes),
    writeNew: (path, bytes, maxBytes) => downReceipt(port.writeNew(toWin(path), bytes, maxBytes)),
    copyNew: (source, destination, expected, maxBytes) =>
      downReceipt(port.copyNew(toWin(source), toWin(destination), upFile(expected), maxBytes)),
    renameNew: (source, destination, expected, maxBytes) =>
      downReceipt(port.renameNew(toWin(source), toWin(destination), upFile(expected), maxBytes)),
    unlinkExact: (path, expected, maxBytes) =>
      port.unlinkExact(toWin(path), upFile(expected), maxBytes),
    proveSync: (path, expected) => downReceipt(port.proveSync(toWin(path), upFile(expected))),
    createDirectory: path => downId(port.createDirectory(toWin(path))),
    snapshotSqlite: (db, destination) =>
      downReceipt(port.snapshotSqlite(snapshotProxy(db, destination), toWin(destination))),
    acquireSqliteLease: (path, expected) =>
      port.acquireSqliteLease!(toWin(path), { ...expected, path: toWin(path) }),
  };

  let storeClosed = false, journalClosed = false;
  const closeJournal = (): void => {
    if (journalClosed) return;
    journalClosed = true;
    try { currentJournal!.close(); events.push({ phase: "journal.close" }); }
    catch (error) {
      events.push({ phase: "journal.close", ok: false, message: message(error) });
      throw error;
    }
  };
  const reopenJournal = (): WindowsPrivatePersistenceJournal => {
    if (!journalClosed) closeJournal();
    journalClosed = false;
    currentJournal = openJournal();
    return currentJournal;
  };
  const closeStore = (): void => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  };
  const profile = Object.freeze({
    name: "c02-k-backup-single-profile",
    originProvider: "absent" as const,
    authority: "real-windows-private-persistence-journal",
    filesystem: "actual-K-factory-with-injected-contract-executor",
    windowsProofs: "simulated-sids-dacls-and-NTFS-labelling",
  });

  return {
    root, data, workspace, assets, state, store, db: store.db, port, native, events,
    get journal(): WindowsPrivatePersistenceJournal { return currentJournal!; },
    closeJournal, reopenJournal, closeStore, toWin, toReal, profile,
  };
}
