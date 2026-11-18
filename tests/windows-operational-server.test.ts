/**
 * windows-operational-server.test.ts
 *
 * UNTRUSTED NATIVE CONTRACT DRIVER — **NOT Windows OS acceptance.**
 *
 * Every test drives `createWindowsServerNativeForTesting` with an in-memory
 * K contract double (`fakeK`), a C lease double (`fakeAuthority`), an
 * injected synchronous root proof (`inspectRoot`), and an injected lifecycle
 * host that NEVER opens a network listener. Node `fs` and `node:sqlite` are
 * mocked over the same in-memory tree; `inspectServerHistory` /
 * `inspectSyncRetention` are narrow semantic-driver mocks (labelled below).
 * Passing means the facades follow the declared synchronous native
 * contracts (identity pinning, source binding, current checks, exclusive
 * creates, held-lease ordering, poison-on-UNKNOWN, marker proof). It proves
 * NOTHING about real NTFS file IDs, DACLs, share modes, SQLite locking,
 * or Windows OS behavior. POSIX-only helpers (realpath/uid/mode/dev/ino/
 * fsync) are trapped where practical and must not be reached on the native
 * branch. This driver is non-Windows-only; actual win32 uses the production
 * factory and separate native acceptance, never this untrusted seam.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type {
  NativePrivateFile,
  NativePrivateFilesystemPort,
  NativePrivateIdentity,
  NativePrivateReceipt,
} from "../src/platform/private-persistence";
import type { PrivateAuthorityLease } from "../src/platform/windows/authority-lease";
import type { CheckpointServerHandle } from "../src/sync/checkpoint-server";
import type { CheckpointServerBackup } from "../src/sync/server-backup";
import type { ServerHistoryInventory } from "../src/sync/server-full-types";

/* ---------------- In-memory tree ---------------- */

const VOLUME = "0123456789abcdef";
const ROOT = "D:\\folio-root";
const SRV = "D:\\folio-root\\srv";
const ROOT_ID = "a".repeat(32);
const LOCK_NAME = ".folio-server-lock.sqlite";

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(32, "0");
const shaOf = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

type TreeFile = { fileId: string; volumeId: string; data: Uint8Array };
const dirs = new Set<string>();
const dirIds = new Map<string, string>();
const files = new Map<string, TreeFile>();
// Labelled persisted-source model. Fixtures enroll explicitly; K creation
// does not enroll until recordCreatedIdentity acknowledges the new output.
const sourceBindings = new Map<string, NativePrivateIdentity>();

function seedDir(path: string, fileId = nextId(), enroll = true) {
  dirs.add(path);
  dirIds.set(path, fileId);
  if (enroll) sourceBindings.set(path, { path, fileId, volumeId: VOLUME });
}
function seedFile(path: string, data: Uint8Array, fileId = nextId(), enroll = true): NativePrivateFile {
  files.set(path, { fileId, volumeId: VOLUME, data: new Uint8Array(data) });
  if (enroll) sourceBindings.set(path, { path, fileId, volumeId: VOLUME });
  return { path, fileId: files.get(path)!.fileId, volumeId: VOLUME, bytes: data.length, sha256: shaOf(data) };
}
function children(dir: string): string[] {
  const names = new Set<string>();
  const prefix = `${dir}\\`;
  const consider = (path: string) => {
    if (!path.startsWith(prefix)) return;
    const rest = path.slice(prefix.length);
    if (rest.length > 0 && !rest.includes("\\")) names.add(rest);
  };
  for (const d of dirs) consider(d);
  for (const f of files.keys()) consider(f);
  return [...names];
}
function resetTree() {
  dirs.clear();
  dirIds.clear();
  files.clear();
  sourceBindings.clear();
  seq = 0;
  seedDir("D:\\", "b".repeat(32));
  seedDir(ROOT, ROOT_ID);
}

/* ---------------- node:fs mock over the tree ----------------
 * Only namespace/capacity hints are functional. POSIX proof/mutation calls
 * throw: a mock POSIX success is not evidence for the native lane. */

const openFds = new Map<number, string>();

function fakeStat(path: string) {
  const file = files.get(path);
  const isDir = dirs.has(path);
  if (!file && !isDir) {
    const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return {
    isFile: () => !!file,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    size: file ? file.data.length : 0,
    nlink: 1,
    dev: 1,
    ino: isDir ? parseInt(dirIds.get(path)!.slice(0, 12), 16) : parseInt(file!.fileId.slice(0, 12), 16),
    uid: 0,
    mode: isDir ? 0o40700 : 0o100600,
    mtimeMs: 1,
    ctimeMs: 1,
  };
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const forbidden = () => { throw new Error("POSIX filesystem reached by native contract driver"); };
  return {
    ...actual,
    lstatSync: vi.fn((p: string) => fakeStat(String(p))),
    statSync: vi.fn((p: string) => fakeStat(String(p))),
    fstatSync: vi.fn((fd: number) => {
      const path = openFds.get(fd);
      if (path === undefined) throw Object.assign(new Error("EBADF"), { code: "EBADF" });
      return fakeStat(path);
    }),
    realpathSync: vi.fn(forbidden),
    statfsSync: vi.fn(() => ({ bavail: 1n << 40n, bfree: 1n << 40n, bsize: 4096n, blocks: 1n << 40n })),
    opendirSync: vi.fn((p: string) => {
      const dir = String(p);
      if (!dirs.has(dir)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      let list = children(dir);
      return {
        readSync: () => {
          const name = list.shift();
          if (name === undefined) return null;
          const child = `${dir}\\${name}`;
          return {
            name,
            isFile: () => files.has(child),
            isDirectory: () => dirs.has(child),
            isSymbolicLink: () => false,
          };
        },
        closeSync: () => undefined,
      };
    }),
    readdirSync: vi.fn(forbidden),
    openSync: vi.fn(forbidden),
    closeSync: vi.fn(forbidden),
    writeSync: vi.fn(forbidden),
    readSync: vi.fn(forbidden),
    fsyncSync: vi.fn(forbidden),
    fchmodSync: vi.fn(forbidden),
    chmodSync: vi.fn(forbidden),
    mkdirSync: vi.fn(forbidden),
    unlinkSync: vi.fn(forbidden),
    linkSync: vi.fn(forbidden),
    renameSync: vi.fn(forbidden),
    existsSync: vi.fn((p: string) => files.has(String(p)) || dirs.has(String(p))),
    readFileSync: vi.fn(forbidden),
    writeFileSync: vi.fn(forbidden),
  };
});

/* ---------------- node:sqlite semantic driver ----------------
 * Narrowly mocked: BEGIN/COMMIT/ROLLBACK/EXCLUSIVE transaction state and a
 * tiny responder table. This is a labelled semantic fixture, not a SQLite
 * engine. `inspectServerHistory`/`inspectSyncRetention` are vi.mock'd so the
 * semantic layer is injected explicitly. */

type SqlResponder = {
  get?: (sql: string, params: unknown[]) => unknown;
  all?: (sql: string, params: unknown[]) => unknown[];
};
let sqlResponder: SqlResponder = {};
const execLog: string[] = [];
let resetTransactions = () => {};
let sqliteCloseFailure: unknown;
const sqliteCloseLog: string[] = [];
const sqliteOpenLog: { path: string; readOnly: boolean }[] = [];

vi.mock("node:sqlite", () => {
  // Cross-connection exclusion model: one open transaction per file path.
  const transactions = new Map<string, FakeDatabaseSync>();
  resetTransactions = () => transactions.clear();
  class FakeDatabaseSync {
    isOpen = true;
    isTransaction = false;
    __epoch: string | undefined;
    __revoked = false;
    constructor(public path: string, public options?: { readOnly?: boolean }) {
      sqliteOpenLog.push({ path, readOnly: options?.readOnly === true });
    }
    private begin() {
      const holder = transactions.get(this.path);
      if (holder !== undefined && holder !== this && holder.isOpen && holder.isTransaction)
        throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      this.isTransaction = true;
      transactions.set(this.path, this);
    }
    exec(sql: string) {
      execLog.push(sql);
      if (/BEGIN/.test(sql)) this.begin();
      if (/^(COMMIT|ROLLBACK)/.test(sql)) {
        this.isTransaction = false;
        if (transactions.get(this.path) === this) transactions.delete(this.path);
      }
    }
    prepare(sql: string) {
      const db = this;
      return {
        run: (...params: unknown[]) => {
          if (/BEGIN/.test(sql)) db["begin"]();
          if (/^(COMMIT|ROLLBACK)/.test(sql)) {
            db.isTransaction = false;
            if (transactions.get(db.path) === db) transactions.delete(db.path);
          }
          if (/SET epoch=\?/.test(sql)) db.__epoch = String(params[0]);
          if (/SET revoked=1/.test(sql)) db.__revoked = true;
          return { changes: 1, lastInsertRowid: 0n };
        },
        get: (...params: unknown[]) => {
          if (/integrity_check/.test(sql)) return { integrity_check: "ok" };
          if (/page_count/.test(sql)) return { page_count: 1 };
          if (/page_size/.test(sql)) return { page_size: 4096 };
          if (/FROM checkpoint_server_identity/.test(sql))
            return { epoch: db.__epoch ?? "epoch-1" };
          if (/COUNT\(\*\) AS n FROM checkpoint_devices/.test(sql)) return { n: 0 };
          if (/FROM sqlite_master/.test(sql)) return { count: 0 };
          return sqlResponder.get?.(sql, params);
        },
        all: (...params: unknown[]) => {
          if (/integrity_check/.test(sql)) return [{ integrity_check: "ok" }];
          return sqlResponder.all?.(sql, params) ?? [];
        },
      };
    }
    close() {
      sqliteCloseLog.push(this.path);
      if (sqliteCloseFailure !== undefined) throw sqliteCloseFailure;
      this.isOpen = false;
      this.isTransaction = false;
      if (transactions.get(this.path) === this) transactions.delete(this.path);
    }
  }
  return { DatabaseSync: FakeDatabaseSync };
});

/* Semantic-driver mock: the ONLY SQL-history surface the native facades
 * consult. Tests set `historyOf` to the fixture inventory; a fake database
 * that observed an epoch/revoke UPDATE reports it back. */
let historyFixture: (db: DatabaseSync) => ServerHistoryInventory;
vi.mock("../src/sync/server-history-validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync/server-history-validation")>();
  return { ...actual, inspectServerHistory: vi.fn((db: DatabaseSync) => historyFixture(db)) };
});
vi.mock("../src/sync/sync-retention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync/sync-retention")>();
  return {
    ...actual,
    inspectSyncRetention: vi.fn(() => ({ entries: 0, bytes: 0, held: false })),
  };
});
vi.mock("../src/persistence/durable-file", () => ({
  syncPath: vi.fn(() => { throw new Error("POSIX sync reached"); }),
  writeNewFileDurably: vi.fn(() => { throw new Error("POSIX write reached"); }),
}));
vi.mock("../src/sync/m3-private-root", () => ({
  pinPrivateRoot: vi.fn(() => { throw new Error("POSIX root reached"); }),
  assertPrivateRoot: vi.fn(() => { throw new Error("POSIX root reached"); }),
  assertSqliteSidecars: vi.fn(() => { throw new Error("POSIX sidecars reached"); }),
}));

const {
  createWindowsServerNativeForTesting,
  withWindowsServerNative,
} = await import("../src/platform/windows/server-native");
const {
  readServerOpsConfig,
  writeServerOpsConfig,
  readIssuedSyncCredential,
  writeIssuedSyncCredential,
} = await import("../src/sync/server-ops-config");
const { inspectVerifiedServerFile, copyVerifiedServerFile } = await import(
  "../src/sync/server-verified-file"
);
const { acquireServerDirectoryLease } = await import("../src/sync/server-directory-lease");
const {
  inspectServerBlobRetention,
  assertServerBlobAdmission,
} = await import("../src/sync/server-blob-retention");
const {
  initializeOperationalServer,
  startOperationalServer,
  issueOperationalCredential,
  inspectOperationalServer,
} = await import("../src/sync/operational-server");
const {
  createServerFullBackup,
  restoreServerFullBackup,
  inspectOperationalServerFullBackup,
} = await import("../src/sync/server-full-backup");
const { SyncError } = await import("../src/sync/protocol");
const { NativePrivatePersistenceError } = await import(
  "../src/platform/windows/private-persistence"
);

/* ---------------- K contract double ---------------- */

function kError(
  reason: string,
  state: "REJECTED" | "EXISTS" | "UNKNOWN" = "REJECTED",
): never {
  throw new NativePrivatePersistenceError(state, `contract driver: ${reason}`);
}

function fileRecord(path: string): NativePrivateFile {
  const file = files.get(path);
  if (!file) kError("private-native-absent");
  return { path, fileId: file.fileId, volumeId: file.volumeId, bytes: file.data.length, sha256: shaOf(file.data) };
}
function dirRecord(path: string): NativePrivateIdentity {
  if (!dirs.has(path)) kError("private-native-absent");
  return { path, fileId: dirIds.get(path)!, volumeId: VOLUME };
}
const receipt = (file: NativePrivateFile): NativePrivateReceipt =>
  Object.freeze({ profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH", identity: file });

const kCalls = { writeNew: 0, unlinkExact: 0, copyNew: 0 };
function makeK(): NativePrivateFilesystemPort {
  return {
    platform: "win32",
    version: 1,
    synchronous: true,
    inspectDirectory: (p) => dirRecord(p),
    inspectFile: (p, max) => {
      const f = fileRecord(p);
      if (f.bytes > max) kError("private-native-limit");
      return f;
    },
    inspectFileIdentity: (p) => fileRecord(p),
    read: (p, expected, max) => {
      const f = fileRecord(p);
      if (f.fileId !== expected.fileId || f.volumeId !== expected.volumeId || f.sha256 !== expected.sha256 || f.bytes !== expected.bytes || f.bytes > max)
        kError("private-native-mismatch");
      return new Uint8Array(files.get(p)!.data);
    },
    writeNew: (p, bytes, max) => {
      kCalls.writeNew++;
      if (files.has(p) || dirs.has(p)) kError("private-native-exists", "EXISTS");
      if (bytes.byteLength > max) kError("private-native-limit");
      return receipt(seedFile(p, bytes, nextId(), false));
    },
    copyNew: (src, dst, expected, max) => {
      kCalls.copyNew++;
      const f = fileRecord(src);
      if (f.fileId !== expected.fileId || f.sha256 !== expected.sha256 || f.bytes !== expected.bytes || f.bytes > max)
        kError("private-native-mismatch");
      if (files.has(dst) || dirs.has(dst)) kError("private-native-exists", "EXISTS");
      return receipt(seedFile(dst, files.get(src)!.data, nextId(), false));
    },
    renameNew: (src, dst, expected, max) => {
      const f = fileRecord(src);
      if (f.fileId !== expected.fileId || f.bytes > max) kError("private-native-mismatch");
      if (files.has(dst) || dirs.has(dst)) kError("private-native-exists", "EXISTS");
      files.set(dst, files.get(src)!);
      files.delete(src);
      return receipt(fileRecord(dst));
    },
    unlinkExact: (p, expected) => {
      kCalls.unlinkExact++;
      const f = fileRecord(p);
      if (f.fileId !== expected.fileId || f.sha256 !== expected.sha256) kError("private-native-mismatch");
      files.delete(p);
    },
    proveSync: (p, expected) => {
      const f = fileRecord(p);
      if (f.fileId !== expected.fileId) kError("private-native-mismatch");
      return receipt(f);
    },
    createDirectory: (p) => {
      if (files.has(p) || dirs.has(p)) kError("private-native-exists", "EXISTS");
      seedDir(p, nextId(), false);
      return dirRecord(p);
    },
    snapshotSqlite: (_db, dst) => {
      if (files.has(dst)) kError("private-native-exists", "EXISTS");
      return receipt(seedFile(dst, new TextEncoder().encode("SNAPSHOT"), nextId(), false));
    },
    acquireSqliteLease: (p, expected) => {
      const f = fileRecord(p);
      if (f.fileId !== expected.fileId) kError("private-native-mismatch");
      return { assertHeld: () => undefined, close: () => undefined };
    },
  };
}

/* ---------------- C lease + authority doubles ---------------- */

let cHeld = true;
const cCloseLog: string[] = [];
function makeAuthorityLease(): { acquire: (path: string) => PrivateAuthorityLease; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    acquire: (path: string) => {
      calls.push(path);
      let closed = false;
      return {
        trust: "untrusted-test",
        assertHeld() {
          if (closed || !cHeld) throw new SyncError("authority-lost", 409);
        },
        close() {
          cCloseLog.push(path);
          closed = true;
        },
      };
    },
  };
}

/* Lifecycle host: returns a guarded-looking handle, NEVER opens a socket. */
function makeHost() {
  const handle = {
    url: "http://127.0.0.1:0",
    serverEpoch: "epoch-1",
    registerDevice: vi.fn(),
    revokeDevice: vi.fn(),
    backup: vi.fn((): CheckpointServerBackup => { throw new Error("Unused catalog-backup contract fixture"); }),
    close: vi.fn(async () => undefined),
  } satisfies CheckpointServerHandle;
  const start = vi.fn(async (args: { assertCurrent(): void; port: number }) => {
    args.assertCurrent();
    return handle;
  });
  return { start, handle };
}

const CONFIG = { format: "folio-server-config/v1" as const, workspaceId: "w1", ownerId: "o1", port: 8765 };

function fixtureInventory(epoch = "epoch-1"): ServerHistoryInventory {
  return {
    serverEpoch: epoch,
    workspaces: [{ workspaceId: "w1", ownerId: "o1", revision: 0, checkpointHash: null }],
    assets: [],
    changes: 0,
    operations: 0,
    devices: 1,
    activeDevices: 1,
    revokedDevices: 0,
  };
}

type Ctx = {
  port: ReturnType<typeof createWindowsServerNativeForTesting>;
  assertCurrent: ReturnType<typeof vi.fn>;
  assertSourceIdentity: ReturnType<typeof vi.fn>;
  recordCreatedIdentity: ReturnType<typeof vi.fn>;
  inspectRoot: ReturnType<typeof vi.fn>;
  authority: ReturnType<typeof makeAuthorityLease>;
  host: ReturnType<typeof makeHost>;
  k: NativePrivateFilesystemPort;
};

function makeCtx(overrides: Partial<{
  assertCurrent: () => void;
  inspectRoot: () => NativePrivateIdentity;
  host: ReturnType<typeof makeHost> | undefined;
  k: NativePrivateFilesystemPort;
}> = {}): Ctx {
  const k = overrides.k ?? makeK();
  const authority = makeAuthorityLease();
  const host = Object.hasOwn(overrides, "host") ? overrides.host : makeHost();
  const ctx: Ctx = {
    k,
    authority,
    host: host ?? makeHost(),
    assertCurrent: vi.fn(overrides.assertCurrent ?? (() => undefined)),
    assertSourceIdentity: vi.fn((identity: NativePrivateIdentity) => {
      const bound = sourceBindings.get(identity.path);
      if (bound === undefined || bound.fileId !== identity.fileId || bound.volumeId !== identity.volumeId)
        throw new SyncError("source-binding-changed", 409);
    }),
    recordCreatedIdentity: vi.fn((identity: NativePrivateIdentity) => {
      const prior = sourceBindings.get(identity.path);
      if (prior !== undefined && (prior.fileId !== identity.fileId || prior.volumeId !== identity.volumeId))
        throw new SyncError("source-binding-changed", 409);
      sourceBindings.set(identity.path, { ...identity });
    }),
    inspectRoot: vi.fn(overrides.inspectRoot ?? (() => ({ path: ROOT, fileId: ROOT_ID, volumeId: VOLUME }))),
    port: undefined as never,
  };
  ctx.port = createWindowsServerNativeForTesting({
    root: ROOT,
    nativePrivateFilesystem: k,
    acquireSqliteLease: authority.acquire,
    assertCurrent: ctx.assertCurrent as unknown as () => void,
    assertSourceIdentity: ctx.assertSourceIdentity as unknown as (i: NativePrivateIdentity) => void,
    recordCreatedIdentity: ctx.recordCreatedIdentity as unknown as (i: NativePrivateIdentity) => void,
    inspectRoot: ctx.inspectRoot as unknown as () => NativePrivateIdentity,
    lifecycleHost: host,
  });
  return ctx;
}

function run<T>(ctx: Ctx, work: () => T): T {
  return withWindowsServerNative(ctx.port, work);
}

beforeEach(() => {
  resetTree();
  openFds.clear();
  execLog.length = 0;
  sqliteCloseLog.length = 0;
  sqliteOpenLog.length = 0;
  cCloseLog.length = 0;
  sqliteCloseFailure = undefined;
  resetTransactions();
  sqlResponder = {};
  cHeld = true;
  kCalls.writeNew = 0;
  kCalls.unlinkExact = 0;
  kCalls.copyNew = 0;
  // Semantic driver: reports the fake database's observed epoch/revoke
  // writes back so restore-time UPDATEs are visible to the fixture.
  historyFixture = (db) => {
    const state = db as unknown as { __epoch?: string; __revoked?: boolean };
    return {
      ...fixtureInventory(state.__epoch ?? "epoch-1"),
      activeDevices: state.__revoked ? 0 : 1,
      revokedDevices: state.__revoked ? 1 : 0,
    };
  };
});

/* ==================== positive contract paths ==================== */

describe.skipIf(process.platform === "win32")("untrusted native contract driver (NOT Windows OS acceptance)", () => {
  it("writes and reads server config through K identities", () => {
    const ctx = makeCtx();
    seedDir(SRV);
    run(ctx, () => {
      writeServerOpsConfig(SRV, CONFIG);
      expect(readServerOpsConfig(SRV)).toEqual(CONFIG);
    });
    // Config was exclusively created; its identity was recorded once.
    expect(ctx.recordCreatedIdentity).toHaveBeenCalled();
    expect(ctx.assertSourceIdentity).toHaveBeenCalled();
  });

  it("writes/reads credentials under the root and rejects managed-root overlap", () => {
    const ctx = makeCtx();
    const credential = {
      format: "folio-sync-credential/v1" as const,
      baseUrl: "http://127.0.0.1:8765",
      workspaceId: "w1",
      clientId: "c1",
      token: "t".repeat(43),
    };
    seedDir(`${ROOT}\\handoff`);
    const credFile = `${ROOT}\\handoff\\cred.json`;
    run(ctx, () => {
      writeIssuedSyncCredential(credFile, credential, [SRV]);
      expect(readIssuedSyncCredential(credFile)).toMatchObject({ clientId: "c1" });
      // Overlap with the server root is a namespace violation, not a retry.
      expect(() =>
        writeIssuedSyncCredential(`${SRV}\\cred.json`, credential, [SRV]),
      ).toThrowError(SyncError);
      expect(() =>
        writeIssuedSyncCredential("D:\\folio-root\\server.sqlite", credential, []),
      ).toThrowError(SyncError);
    });
  });

  it("copies a verified file with receipt + readback identity proof", () => {
    const ctx = makeCtx();
    seedDir(SRV);
    const data = new TextEncoder().encode("blob-bytes");
    const source = seedFile(`${SRV}\\in.bin`, data);
    run(ctx, () => {
      const result = copyVerifiedServerFile(`${SRV}\\in.bin`, `${SRV}\\out.bin`, source);
      expect(result.bytes).toBe(data.length);
      expect(result.sha256).toBe(shaOf(data));
      const inspected = inspectVerifiedServerFile(`${SRV}\\out.bin`);
      expect(inspected.sha256).toBe(shaOf(data));
    });
  });

  it("holds a directory lease: exclusive lock + BEGIN EXCLUSIVE + held asserts", async () => {
    const ctx = makeCtx();
    seedDir(SRV);
    await run(ctx, async () => {
      const lease = acquireServerDirectoryLease(SRV);
      lease.assertOwned();
      lease.close();
      expect(() => lease.assertOwned()).toThrow();
    });
    expect(execLog.join(" ")).toContain("BEGIN EXCLUSIVE");
  });

  it("runs init -> start -> guarded close with the injected lifecycle host", async () => {
    const ctx = makeCtx();
    await run(ctx, async () => {
      const init = await initializeOperationalServer(`${ROOT}\\new-srv`, CONFIG);
      expect(init.serverEpoch).toBe("epoch-1");
      // Marker removed only after exact proof.
      expect(files.has(`${init.directory}\\FOLIO-SERVER-FULL-INCOMPLETE`)).toBe(false);
      const server = await startOperationalServer(init.directory);
      expect(server.serverEpoch).toBe("epoch-1");
      server.registerDevice({ workspaceId: "w1", ownerId: "o1", clientId: "c1", token: "t".repeat(43) });
      expect(ctx.host.handle.registerDevice).toHaveBeenCalledTimes(1);
      await server.close();
      expect(ctx.host.handle.close).toHaveBeenCalled();
    });
    // The host saw the held-C-lease fence; no listener was opened (fake host).
    expect(ctx.host.start).toHaveBeenCalled();
  });

  it("issues a credential through administration without exposing token hashes", async () => {
    const ctx = makeCtx();
    seedDir(SRV);
    seedDir(`${ROOT}\\handoff`);
    run(ctx, () => {
      writeServerOpsConfig(SRV, CONFIG);
      seedFile(`${SRV}\\server.sqlite`, new Uint8Array(0));
    });
    await run(ctx, async () => {
      const issued = await issueOperationalCredential({
        directory: SRV,
        clientId: "c9",
        credentialFile: `${ROOT}\\handoff\\c9.json`,
      });
      expect(issued).toEqual({ clientId: "c9", baseUrl: "http://127.0.0.1:8765" });
      expect(ctx.host.handle.registerDevice).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: "c9" }),
      );
      const persisted = files.get(`${ROOT}\\handoff\\c9.json`);
      expect(persisted).toBeDefined();
      expect(new TextDecoder().decode(persisted!.data)).not.toContain("sha256");
    });
  });

  it("inspects an offline server under held C + directory leases", async () => {
    const ctx = makeCtx();
    seedDir(SRV);
    run(ctx, () => {
      writeServerOpsConfig(SRV, CONFIG);
      seedFile(`${SRV}\\server.sqlite`, new Uint8Array(0));
      seedDir(`${SRV}\\blobs`);
    });
    await run(ctx, async () => {
      const report = inspectOperationalServer(SRV);
      expect(report.serverEpoch).toBe("epoch-1");
      expect(report.maxDevices).toBe(512);
    });
  });

  it("runs full backup -> native inspect -> restore end-to-end", async () => {
    const ctx = makeCtx();
    const wsDigest = createHash("sha256").update("w1").digest("hex");
    const assetData = new TextEncoder().encode("asset");
    const assetSha = shaOf(assetData);
    historyFixture = (db) => {
      const state = db as unknown as { __epoch?: string; __revoked?: boolean };
      return {
        ...fixtureInventory(state.__epoch ?? "epoch-1"),
        assets: [{ workspaceId: "w1", sha256: assetSha, bytes: assetData.length }],
        activeDevices: state.__revoked ? 0 : 1,
        revokedDevices: state.__revoked ? 1 : 0,
      };
    };
    seedDir(SRV);
    run(ctx, () => {
      writeServerOpsConfig(SRV, CONFIG);
      seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
      seedDir(`${SRV}\\blobs`);
      seedDir(`${SRV}\\blobs\\${wsDigest}`);
      seedFile(`${SRV}\\blobs\\${wsDigest}\\${assetSha}`, assetData);
      const lease = acquireServerDirectoryLease(SRV);
      const backup = createServerFullBackup({ sourceDirectory: SRV, destination: `${ROOT}\\bak`, lease });
      expect(backup.manifest.format).toBe("folio-server-full/v1");
      expect(backup.manifest.assets).toHaveLength(1);
      lease.close();
      // Published backup inspects cleanly through the native dispatcher.
      const manifest = inspectOperationalServerFullBackup(`${ROOT}\\bak`);
      expect(manifest.serverEpoch).toBe("epoch-1");
      const restored = restoreServerFullBackup({
        backupDirectory: `${ROOT}\\bak`,
        destination: `${ROOT}\\rst`,
        port: 9876,
      });
      expect(restored.previousEpoch).toBe("epoch-1");
      expect(restored.serverEpoch).not.toBe("epoch-1");
      expect(files.has(`${ROOT}\\rst\\restore-receipt.json`)).toBe(true);
      // Old devices stay revoked evidence-wise; history counts unchanged.
    });
  });

  it("accounts held bytes/entries: unknown regular files and partials included", () => {
    const ctx = makeCtx();
    const wsDigest = "e".repeat(64);
    seedDir(`${ROOT}\\blobs`);
    seedDir(`${ROOT}\\blobs\\${wsDigest}`);
    seedFile(`${ROOT}\\blobs\\${wsDigest}\\${"f".repeat(64)}`, new Uint8Array(10));
    seedFile(`${ROOT}\\blobs\\${wsDigest}\\.partial-${"a".repeat(64)}`, new Uint8Array(5));
    seedFile(`${ROOT}\\blobs\\stray.bin`, new Uint8Array(7));
    run(ctx, () => {
      const held = inspectServerBlobRetention(`${ROOT}\\blobs`);
      expect(held.bytes).toBe(22);
      expect(held.entries).toBe(2); // hash + partial inside the hash dir
      expect(held.held).toBe(false);
      assertServerBlobAdmission(`${ROOT}\\blobs`, 100);
      expect(() => assertServerBlobAdmission(`${ROOT}\\blobs`, 256 * 1024 * 1024)).toThrowError(
        expect.objectContaining({ code: "server-blob-retention-held" }),
      );
    });
  });

  /* ==================== counterexamples ==================== */

  it("rejects foreign semantic history without a writable original open or host start", async () => {
    const ctx = makeCtx();
    seedDir(SRV);
    run(ctx, () => writeServerOpsConfig(SRV, CONFIG));
    seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
    historyFixture = () => ({ ...fixtureInventory(), workspaces: [
      { workspaceId: "foreign", ownerId: "other", revision: 0, checkpointHash: null },
    ] });
    await expect(run(ctx, () => startOperationalServer(SRV))).rejects.toThrow();
    expect(ctx.host.start).not.toHaveBeenCalled();
    expect(sqliteOpenLog.filter(open => open.path === `${SRV}\\server.sqlite`))
      .toEqual([{ path: `${SRV}\\server.sqlite`, readOnly: true }]);
  });

  it("defers only readonly rollback to host preflight, never locally recovers the original", async () => {
    const ctx = makeCtx();
    seedDir(SRV);
    run(ctx, () => writeServerOpsConfig(SRV, CONFIG));
    seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
    seedFile(`${SRV}\\server.sqlite-journal`, new Uint8Array(8));
    sqlResponder.get = (sql) => {
      if (sql.includes("sqlite_schema"))
        throw Object.assign(new Error("contract readonly rollback"), { errcode: 776 });
      return undefined;
    };
    await run(ctx, async () => {
      // This host is a no-listener contract double, not H/SQLite evidence.
      const server = await startOperationalServer(SRV);
      expect(ctx.host.start).toHaveBeenCalledTimes(1);
      expect(sqliteOpenLog.filter(open => open.path === `${SRV}\\server.sqlite`))
        .toEqual([{ path: `${SRV}\\server.sqlite`, readOnly: true }]);
      await server.close();
    });
  });

  it("checks K read bytes against the pinned hash instead of trusting Uint8Array shape", () => {
    const k = makeK();
    k.read = () => new TextEncoder().encode("wrong");
    const ctx = makeCtx({ k });
    seedDir(SRV);
    const file = seedFile(`${SRV}\\in.bin`, new TextEncoder().encode("right"));
    expect(() => run(ctx, () => ctx.port.readFile(file.path, file, 64))).toThrow();
  });

  it("rejects backup destinations below another managed server root", () => {
    const ctx = makeCtx();
    seedDir(SRV);
    seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
    seedDir(`${ROOT}\\other`);
    seedFile(`${ROOT}\\other\\server.sqlite`, new Uint8Array(8));
    run(ctx, () => {
      const lease = acquireServerDirectoryLease(SRV);
      expect(() => createServerFullBackup({
        sourceDirectory: SRV, destination: `${ROOT}\\other\\backup`, lease,
      })).toThrow();
      expect(dirs.has(`${ROOT}\\other\\backup`)).toBe(false);
      lease.close();
    });
  });

  it("refuses a hot lock sidecar before any SQLite open, without deleting it", () => {
    const ctx = makeCtx();
    seedDir(SRV);
    seedFile(`${SRV}\\${LOCK_NAME}`, new Uint8Array(8));
    seedFile(`${SRV}\\${LOCK_NAME}-journal`, new Uint8Array(8));
    expect(() => run(ctx, () => acquireServerDirectoryLease(SRV))).toThrow();
    expect(sqliteOpenLog).toEqual([]);
    expect(files.has(`${SRV}\\${LOCK_NAME}-journal`)).toBe(true);
    expect(kCalls.unlinkExact).toBe(0);
  });

  it("preserves published restore evidence when final directory close fails", () => {
    const k = makeK();
    const unlink = k.unlinkExact;
    const cleanup = new Error("contract published directory close failure");
    k.unlinkExact = (path, expected, max) => {
      unlink(path, expected, max);
      if (path.startsWith(`${ROOT}\\rst\\`)) sqliteCloseFailure = cleanup;
    };
    const ctx = makeCtx({ k });
    seedDir(SRV);
    seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
    run(ctx, () => {
      const lease = acquireServerDirectoryLease(SRV);
      createServerFullBackup({ sourceDirectory: SRV, destination: `${ROOT}\\bak`, lease });
      lease.close();
      let failure: unknown;
      try { restoreServerFullBackup({ backupDirectory: `${ROOT}\\bak`, destination: `${ROOT}\\rst`, port: 9876 }); }
      catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "server-full-published-unverified", cause: cleanup });
      expect(files.has(`${ROOT}\\rst\\restore-receipt.json`)).toBe(true);
      expect(files.has(`${ROOT}\\rst\\FOLIO-SERVER-FULL-INCOMPLETE`)).toBe(false);
      expect(cCloseLog).not.toContain(`${ROOT}\\rst\\${LOCK_NAME}`);
      expect(sqliteCloseLog.filter(path => path === `${ROOT}\\rst\\${LOCK_NAME}`)).toHaveLength(1);
    });
  });

  it("keeps C and directory exclusion held after SQLite close fails, without retry", () => {
    const ctx = makeCtx();
    seedDir(SRV);
    const failure = new Error("contract SQLite close acknowledgement lost");
    run(ctx, () => {
      const lease = acquireServerDirectoryLease(SRV);
      sqliteCloseFailure = failure;
      expect(() => lease.close()).toThrow(failure);
      expect(() => lease.close()).toThrow(failure);
      expect(sqliteCloseLog).toEqual([`${SRV}\\${LOCK_NAME}`]);
      expect(cCloseLog).toEqual([]);
      expect(() => lease.assertOwned()).toThrow();
    });
  });

  it("preserves primary and cleanup error objects without releasing a protector", () => {
    const ctx = makeCtx();
    seedDir(SRV);
    seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
    const primary = new Error("contract history failure");
    const cleanup = new Error("contract SQLite close failure");
    run(ctx, () => {
      const lease = acquireServerDirectoryLease(SRV);
      historyFixture = () => { throw primary; };
      sqliteCloseFailure = cleanup;
      let thrown: unknown;
      try { createServerFullBackup({ sourceDirectory: SRV, destination: `${ROOT}\\bad`, lease }); }
      catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([primary, cleanup]);
      expect(cCloseLog).toEqual([]);
    });
  });

  it("closes init main lease before dropping the scope and closes live host only once", async () => {
    const ctx = makeCtx();
    await run(ctx, async () => {
      const init = await initializeOperationalServer(`${ROOT}\\new`, CONFIG);
      expect(cCloseLog).toContain(`${init.directory}\\server.sqlite`);
      const server = await startOperationalServer(init.directory);
      const before = ctx.host.handle.close.mock.calls.length;
      await Promise.all([server.close(), server.close()]);
      expect(ctx.host.handle.close.mock.calls.length).toBe(before + 1);
    });
  });

  it("closes a returned host handle when the late startup fence fails", async () => {
    const host = makeHost();
    const failure = new SyncError("cut-moved", 409);
    let stale = false;
    host.start.mockImplementation(async () => { stale = true; return host.handle; });
    const ctx = makeCtx({ host, assertCurrent: () => { if (stale) throw failure; } });
    seedDir(SRV);
    run(ctx, () => {
      writeServerOpsConfig(SRV, CONFIG);
      seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
    });
    await expect(run(ctx, () => startOperationalServer(SRV))).rejects.toThrow();
    expect(host.handle.close).toHaveBeenCalledTimes(1);
  });

  it("treats an actual copy EXISTS race as one dispatch, no cleanup and no resend", () => {
    const k = makeK();
    k.copyNew = () => { kCalls.copyNew++; return kError("race", "EXISTS"); };
    const ctx = makeCtx({ k });
    seedDir(SRV);
    const source = seedFile(`${SRV}\\in.bin`, new Uint8Array(9));
    run(ctx, () => {
      expect(() => copyVerifiedServerFile(`${SRV}\\in.bin`, `${SRV}\\out.bin`, source)).toThrow();
      expect(kCalls.copyNew).toBe(1);
      expect(kCalls.unlinkExact).toBe(0);
    });
  });

  it("poisons a wrong new-file hash and retains the dispatched output", () => {
    const k = makeK();
    const write = k.writeNew;
    k.writeNew = (path, data, max) => {
      const result = write(path, data, max);
      return receipt({ ...result.identity, sha256: "0".repeat(64) });
    };
    const ctx = makeCtx({ k });
    seedDir(SRV);
    run(ctx, () => {
      expect(() => writeServerOpsConfig(SRV, CONFIG)).toThrow();
      expect(() => writeServerOpsConfig(SRV, CONFIG)).toThrow();
      expect(kCalls.writeNew).toBe(1);
      expect(kCalls.unlinkExact).toBe(0);
      expect(files.has(`${SRV}\\server-config.json`)).toBe(true);
    });
  });

  it("rejects a wrong root identity returned by the root proof", () => {
    const ctx = makeCtx({ inspectRoot: () => ({ path: ROOT, fileId: "0".repeat(32), volumeId: VOLUME }) });
    seedDir(SRV);
    run(ctx, () => {
      expect(() => acquireServerDirectoryLease(SRV)).toThrowError(SyncError);
    });
  });

  it("rejects a pinned root identity that changes between proofs", () => {
    const roots = [
      { path: ROOT, fileId: ROOT_ID, volumeId: VOLUME },
      { path: ROOT, fileId: "9".repeat(32), volumeId: VOLUME },
    ];
    let i = 0;
    const ctx = makeCtx({ inspectRoot: () => roots[Math.min(i++, 1)] });
    seedDir(SRV);
    expect(() =>
      run(ctx, () => {
        ctx.port.inspectDirectory(ROOT);
        ctx.port.inspectDirectory(ROOT);
      }),
    ).toThrowError(SyncError);
  });

  it("rejects when assertCurrent goes stale before dispatch", () => {
    let stale = false;
    const ctx = makeCtx({
      assertCurrent: () => {
        if (stale) throw new SyncError("server-native-unsafe", 409);
      },
    });
    seedDir(SRV);
    stale = true;
    expect(() => run(ctx, () => readServerOpsConfig(SRV))).toThrowError(SyncError);
  });

  it("poisons stably on post-dispatch proof failure: one dispatch, no delete, no retry", () => {
    const dispatch = { count: 0 };
    let failNext = false;
    const k = makeK();
    const innerWrite = k.writeNew;
    k.writeNew = (p, b, m) => {
      dispatch.count++;
      const out = innerWrite(p, b, m);
      failNext = true; // make the post-dispatch assertCurrent fail
      return out;
    };
    const ctx = makeCtx({
      assertCurrent: () => {
        if (failNext) throw new SyncError("cut-moved", 409);
      },
    });
    // Rewire the poisoned K into a fresh port.
    ctx.port = createWindowsServerNativeForTesting({
      root: ROOT,
      nativePrivateFilesystem: k,
      acquireSqliteLease: ctx.authority.acquire,
      assertCurrent: ctx.assertCurrent as unknown as () => void,
      assertSourceIdentity: ctx.assertSourceIdentity as unknown as (i: NativePrivateIdentity) => void,
      recordCreatedIdentity: ctx.recordCreatedIdentity as unknown as (i: NativePrivateIdentity) => void,
      inspectRoot: ctx.inspectRoot as unknown as () => NativePrivateIdentity,
      lifecycleHost: ctx.host,
    });
    seedDir(SRV);
    run(ctx, () => {
      expect(() => writeServerOpsConfig(SRV, CONFIG)).toThrowError(SyncError);
      expect(dispatch.count).toBe(1); // never resent
      // The dispatched file may exist (UNKNOWN outcome); it was never deleted.
      expect(files.get(`${SRV}\\server-config.json`)).toBeDefined();
      // The adapter stays poisoned: further operations throw the same error.
      expect(() => writeServerOpsConfig(SRV, CONFIG)).toThrowError(SyncError);
      expect(dispatch.count).toBe(1);
    });
  });

  it.each([
    ["async", async () => undefined],
    ["generator", function* () {}],
  ])("rejects a non-synchronous assertCurrent at mint (%s)", (_label, impl) => {
    expect(() =>
      createWindowsServerNativeForTesting({
        root: ROOT,
        nativePrivateFilesystem: makeK(),
        acquireSqliteLease: makeAuthorityLease().acquire,
        assertCurrent: impl as never,
        assertSourceIdentity: () => undefined,
        recordCreatedIdentity: () => undefined,
        inspectRoot: () => ({ path: ROOT, fileId: ROOT_ID, volumeId: VOLUME }),
      }),
    ).toThrowError(SyncError);
  });

  it("rejects a thenable-returning callback on first use, not silently", () => {
    const port = createWindowsServerNativeForTesting({
      root: ROOT,
      nativePrivateFilesystem: makeK(),
      acquireSqliteLease: makeAuthorityLease().acquire,
      assertCurrent: (() => ({ then: (r: () => void) => r() })) as never,
      assertSourceIdentity: () => undefined,
      recordCreatedIdentity: () => undefined,
      inspectRoot: () => ({ path: ROOT, fileId: ROOT_ID, volumeId: VOLUME }),
    });
    seedDir(SRV);
    expect(() => withWindowsServerNative(port, () => port.inspectDirectory(SRV))).toThrowError(
      SyncError,
    );
  });

  it("propagates EEXIST without retry or cleanup", () => {
    const ctx = makeCtx();
    seedDir(SRV);
    seedFile(`${SRV}\\out.bin`, new Uint8Array(1));
    const source = seedFile(`${SRV}\\in.bin`, new Uint8Array(9));
    run(ctx, () => {
      expect(() => copyVerifiedServerFile(`${SRV}\\in.bin`, `${SRV}\\out.bin`, source)).toThrow();
      expect(kCalls.copyNew).toBe(0);
    });
  });

  it("rejects a backup whose manifest hash/database proof fails", async () => {
    const ctx = makeCtx();
    const wsDigest = createHash("sha256").update("w1").digest("hex");
    seedDir(SRV);
    await run(ctx, async () => {
      writeServerOpsConfig(SRV, CONFIG);
      seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
      seedDir(`${SRV}\\blobs`);
      const lease = acquireServerDirectoryLease(SRV);
      createServerFullBackup({ sourceDirectory: SRV, destination: `${ROOT}\\bak`, lease });
      lease.close();
      // Corrupt the manifest bytes AFTER publish: inspection must fail.
      const manifestPath = `${ROOT}\\bak\\full-manifest.json`;
      files.set(manifestPath, { ...files.get(manifestPath)!, data: new TextEncoder().encode("{\"format\":\"folio-server-full/v1\"}") });
      expect(() => inspectOperationalServerFullBackup(`${ROOT}\\bak`)).toThrowError(SyncError);
    });
  });

  it("fails start when the C lease is lost and when the directory lease is busy", async () => {
    const ctx = makeCtx();
    seedDir(SRV);
    run(ctx, () => {
      writeServerOpsConfig(SRV, CONFIG);
      seedFile(`${SRV}\\server.sqlite`, new Uint8Array(0));
    });
    // SQLite BEGIN EXCLUSIVE, not file existence, provides exclusion.
    run(ctx, () => {
      const lease = acquireServerDirectoryLease(SRV);
      expect(() => acquireServerDirectoryLease(SRV)).toThrow();
      lease.close();
    });
    // C lease lost mid-flight: held-scope assertions reject.
    cHeld = false;
    await expect(run(ctx, () => startOperationalServer(SRV))).rejects.toThrowError(SyncError);
  });

  it("rejects a live-database backup without a held directory lease identity", async () => {
    const ctx = makeCtx();
    seedDir(SRV);
    await run(ctx, async () => {
      writeServerOpsConfig(SRV, CONFIG);
      seedFile(`${SRV}\\server.sqlite`, new Uint8Array(8));
      seedDir(`${SRV}\\blobs`);
      seedDir(`${ROOT}\\other`);
      const lease = acquireServerDirectoryLease(`${ROOT}\\other`);
      expect(() =>
        createServerFullBackup({ sourceDirectory: SRV, destination: `${ROOT}\\bak`, lease }),
      ).toThrowError(SyncError);
      lease.close();
    });
  });

  it("counts a retained partial toward the 256MiB/4096 admission accounting", () => {
    const ctx = makeCtx();
    const wsDigest = "e".repeat(64);
    seedDir(`${ROOT}\\blobs`);
    seedDir(`${ROOT}\\blobs\\${wsDigest}`);
    // Partials at the cap force held accounting, never silent GC.
    for (let i = 0; i < 3; i++)
      seedFile(`${ROOT}\\blobs\\${wsDigest}\\.partial-${i.toString(16).padStart(64, "0")}`, new Uint8Array(1));
    run(ctx, () => {
      const held = inspectServerBlobRetention(`${ROOT}\\blobs`, { maxEntries: 2 });
      expect(held.held).toBe(true);
      // No deletion was performed anywhere: the files still exist.
      expect(files.size).toBe(3);
    });
  });
});
