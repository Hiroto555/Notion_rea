/**
 * Contract simulation for the restored-workspace launch handoff. All native
 * surfaces are injected untrusted transports over a fake Windows world; this
 * is NOT Windows OS acceptance and no helper, child process or real NTFS
 * object is involved. The disposable SQLite Store is a real node:sqlite file
 * on a POSIX temporary directory.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import { canonical } from "../src/collaboration/runtime/canonical";
import { Store } from "../src/persistence/store";
import { startupRetainsNativeLease } from "../src/persistence/startup-connection-owner";
import type {
  NativePrivateFilesystemPort,
  NativePrivateTree,
} from "../src/platform/private-persistence";
import type {
  AcquirePrivateAuthorityLease,
  NativeAuthorityLeaseOptions,
  PrivateAuthorityLease,
} from "../src/platform/windows/authority-lease";
import type {
  WindowsExclusiveDirectoryExecRequest,
  WindowsExclusiveDirectoryExecResult,
} from "../src/platform/windows/exclusive-directory";
import type { WindowsOperatorConfig } from "../src/platform/windows/operator-native";
import {
  createWindowsPrivatePersistenceForTesting,
  type WindowsPrivatePersistenceTestPort,
} from "../src/platform/windows/private-persistence";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeFileStat,
  type WindowsRuntimeFsPort,
  type WindowsRuntimePlatformOptions,
  type WindowsRuntimeProbePort,
} from "../src/platform/windows/runtime-platform";
import {
  createWindowsRestoreHandoffForTesting,
  stripWindowsRestoreHandoffEnvironment,
  WINDOWS_RESTORE_HANDOFF_ENV,
  WindowsRestoreHandoffError,
  type WindowsRestoreHandoff,
  type WindowsRestoreLaunchRequest,
  type WindowsRestoredWorkspaceLaunch,
} from "../src/platform/windows/restored-workspace-handoff";

const ROOT = "C:\\FolioPrivate";
const STATE_ROOT = "C:\\FolioState";
const STATE_CONFIG = STATE_ROOT + "\\state";
const CURRENT_DIR = ROOT + "\\Live";
const DATA_DIR = ROOT + "\\Restored";
const DATABASE = DATA_DIR + "\\workspace.sqlite";
const EXECUTABLE = "C:\\FolioPrivate\\bin\\PrivateRootProbe.exe";
const SYSTEM_ROOT = "C:\\Windows";
const VOL = "1".repeat(16);
const STATE_VOL = "2".repeat(16);
const ROOT_ID = "a".repeat(32);
const STATE_ROOT_ID = "b".repeat(32);
const CURRENT_ID = "c".repeat(32);
const DATA_ID = "d".repeat(32);
const STATE_CONFIG_ID = "e".repeat(32);
const DATABASE_ID = "0a".repeat(16);
const SID = "S-1-5-21-1000-2000-3000-4000";
const HELPER_BYTES = new Uint8Array([0x46, 0x4f, 0x4c, 0x49, 0x4f, 0x2d, 0x50]);
const OTHER_HELPER = new Uint8Array([0x42, 0x41, 0x44]);
const HELPER_HASH = createHash("sha256").update(HELPER_BYTES).digest("hex");
const EMPTY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DATABASE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const FINGERPRINT = "9".repeat(64);
const TREE_HASH = "8".repeat(64);
const WORKSPACE_ID = "ws-restored-1";

const fold = (value: string): string => value.replace(/\//g, "\\").toLowerCase();
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function frame(header: object, payload: Uint8Array = new Uint8Array()): Buffer {
  const json = Buffer.from(JSON.stringify(header), "ascii");
  const bytes = Buffer.alloc(4 + json.length + payload.length);
  bytes.writeUInt32LE(json.length);
  json.copy(bytes, 4);
  bytes.set(payload, 4 + json.length);
  return bytes;
}

type DirEntry = Readonly<{ kind: "file" | "directory" }>;

class FakeFs implements WindowsRuntimeFsPort {
  readonly entries = new Map<string, DirEntry>();
  helperBytes: Uint8Array = HELPER_BYTES;
  addDirectory(path: string): void {
    this.entries.set(fold(path), { kind: "directory" });
  }
  addFile(path: string): void {
    this.entries.set(fold(path), { kind: "file" });
  }
  lstat(path: string): WindowsRuntimeFileStat {
    const entry = this.entries.get(fold(path));
    if (entry === undefined) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return {
      isFile: () => entry.kind === "file",
      isDirectory: () => entry.kind === "directory",
      isSymbolicLink: () => false,
      nlink: 1,
      dev: 1,
      ino: 1,
      size: fold(path) === fold(EXECUTABLE) ? this.helperBytes.length : 0,
      mtimeMs: 0,
    };
  }
  readFile(path: string): Uint8Array {
    if (fold(path) === fold(EXECUTABLE)) return this.helperBytes;
    return new Uint8Array();
  }
  openReadWrite(): number {
    return 1;
  }
  fsync(): void {}
  close(): void {}
}

type World = {
  fs: FakeFs;
  dirIds: Map<string, string>;
  fileIds: Map<string, string>;
  files: Map<string, { id: string; bytes: Uint8Array }>;
  trees: Map<
    string,
    { id: string; entries: number; bytes: number; sha256: string }
  >;
  probe: WindowsRuntimeProbePort;
  leases: { path: string; lease: PrivateAuthorityLease }[];
  probeCalls: number;
  execCalls: number;
  exclusiveCalls: number;
  sid: string;
  nonceCounter: number;
  idCounter: number;
  exclusiveMode: "created" | "exists" | "unknown";
  failLeaseClose: boolean;
};

const volOf = (root: string): string =>
  fold(root) === fold(STATE_ROOT) ? STATE_VOL : VOL;

function evidence(
  world: World,
  path: string,
  root: string,
): Record<string, unknown> {
  const fileId = world.dirIds.get(fold(path)) ?? world.fileIds.get(fold(path));
  const rootId = world.dirIds.get(fold(root));
  if (fileId === undefined || rootId === undefined)
    throw new CollaborationError("FAKE_UNKNOWN_PATH");
  return {
    platform: "win32",
    sid: world.sid,
    ownerSid: world.sid,
    daclPrivate: true,
    reparsePoint: false,
    linkCount: 1,
    localFilesystem: true,
    fileId,
    rootFileId: rootId,
    volumeId: volOf(root),
    rootVolumeId: volOf(root),
    canonicalPath: path,
    canonicalRoot: root,
  };
}

function exclusiveExec(
  world: World,
  request: WindowsExclusiveDirectoryExecRequest,
): WindowsExclusiveDirectoryExecResult {
  const wire = JSON.parse(
    Buffer.from(request.input).toString("utf8"),
  ) as Record<string, unknown>;
  const path = String(wire.path);
  const root = String(wire.root);
  const attemptId = String(wire.attemptId);
  const reply = (
    state: string,
    status: number,
    extra: Record<string, unknown>,
  ): WindowsExclusiveDirectoryExecResult => ({
    status,
    signal: null,
    stderr: "",
    stdout: JSON.stringify({
      contractVersion: 1,
      operation: "create-directory",
      path,
      root,
      attemptId,
      state,
      ...extra,
    }),
  });
  if (world.exclusiveMode === "unknown")
    return reply("UNKNOWN", 3, { reason: "EXCLUSIVE_DIRECTORY_UNKNOWN" });
  if (world.exclusiveMode === "exists" || world.dirIds.has(fold(path)))
    return reply("EXISTS", 2, { reason: "EXCLUSIVE_DIRECTORY_EXISTS" });
  const id = `f${(++world.idCounter).toString(16)}`.padStart(32, "0");
  world.fs.addDirectory(path);
  world.dirIds.set(fold(path), id);
  return reply("CREATED", 0, {
    rootEvidence: evidence(world, root, root),
    parent: evidence(world, win32.dirname(path), root),
    directory: evidence(world, path, root),
    handleFileId: id,
    handleVolumeId: volOf(root),
    filesystem: "NTFS",
    ancestorsHeld: true,
    daclProtected: true,
    namespace: "EXCLUSIVE_CREATE",
  });
}

function kExec(
  world: World,
  request: Parameters<WindowsPrivatePersistenceTestPort["exec"]>[0],
): ReturnType<WindowsPrivatePersistenceTestPort["exec"]> {
  world.execCalls++;
  const input = Buffer.from(request.input);
  const n = input.readUInt32LE();
  const h = JSON.parse(
    input.subarray(4, 4 + n).toString("ascii"),
  ) as Record<string, unknown>;
  const payload = input.subarray(4 + n);
  const root = String(h.root);
  const path = String(h.path);
  const base = {
    contractVersion: 4,
    operation: h.operation,
    path,
    root,
    ...(h.attemptId ? { attemptId: h.attemptId } : {}),
  };
  const output = (
    header: object,
    bytes: Uint8Array = new Uint8Array(),
    status = 0,
  ) => ({
    status,
    signal: null,
    stderr: Buffer.alloc(0),
    stdout: frame(header, bytes),
  });
  const rejected = () =>
    output(
      { ...base, state: "REJECTED", reason: "PRIVATE_PERSISTENCE_REJECTED" },
      undefined,
      1,
    );
  const parentPath = win32.dirname(path);
  if (h.operation === "inspect-directory") {
    if (!world.dirIds.has(fold(path))) return rejected();
    return output({
      ...base,
      state: "OK",
      file: evidence(world, path, root),
      directory: evidence(world, parentPath, root),
    });
  }
  if (h.operation === "inspect-tree") {
    const tree = world.trees.get(fold(path));
    if (!tree) return rejected();
    return output({
      ...base,
      state: "OK",
      file: evidence(world, path, root),
      directory: evidence(world, parentPath, root),
      entries: tree.entries,
      byteLength: tree.bytes,
      sha256: tree.sha256,
      filesystem: "NTFS",
    });
  }
  const file = world.files.get(fold(path));
  if (h.operation === "write-new") {
    if (file !== undefined)
      return output(
        { ...base, state: "EXISTS", reason: "PRIVATE_PERSISTENCE_EXISTS" },
        undefined,
        2,
      );
    const id = `f${(++world.idCounter).toString(16)}`.padStart(32, "0");
    world.files.set(fold(path), { id, bytes: Uint8Array.from(payload) });
    world.fileIds.set(fold(path), id);
    return output(
      {
        ...base,
        state: "APPLIED",
        file: evidence(world, path, root),
        directory: evidence(world, parentPath, root),
        byteLength: payload.length,
        sha256: hash(payload),
        filesystem: "NTFS",
        contentFlushed: true,
        durability: {
          profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",
          scope: "PROCESS_CRASH",
        },
      },
      payload,
    );
  }
  if (!file) return rejected();
  if (
    (typeof h.fileId === "string" && h.fileId.toLowerCase() !== file.id) ||
    (typeof h.sourceFileId === "string" &&
      h.sourceFileId.toLowerCase() !== file.id)
  )
    return rejected();
  if (h.operation === "inspect-file-identity")
    return output({
      ...base,
      state: "OK",
      file: evidence(world, path, root),
      directory: evidence(world, parentPath, root),
    });
  if (h.operation === "inspect-file")
    return output({
      ...base,
      state: "OK",
      file: evidence(world, path, root),
      directory: evidence(world, parentPath, root),
      byteLength: file.bytes.length,
      sha256: hash(file.bytes),
      filesystem: "NTFS",
    });
  if (h.operation === "read")
    return output(
      {
        ...base,
        state: "OK",
        file: evidence(world, path, root),
        directory: evidence(world, parentPath, root),
        byteLength: file.bytes.length,
        sha256: hash(file.bytes),
        filesystem: "NTFS",
      },
      file.bytes,
    );
  return rejected();
}

function makeWorld(): World {
  const fs = new FakeFs();
  const world: World = {
    fs,
    dirIds: new Map(),
    fileIds: new Map(),
    files: new Map(),
    trees: new Map(),
    probe: undefined as unknown as WindowsRuntimeProbePort,
    leases: [],
    probeCalls: 0,
    execCalls: 0,
    exclusiveCalls: 0,
    sid: SID,
    nonceCounter: 0,
    idCounter: 100,
    exclusiveMode: "created",
    failLeaseClose: false,
  };
  for (const dir of [ROOT, CURRENT_DIR, DATA_DIR, STATE_ROOT, STATE_CONFIG])
    fs.addDirectory(dir);
  fs.addFile(EXECUTABLE);
  fs.addFile(DATABASE);
  world.dirIds.set(fold(ROOT), ROOT_ID);
  world.dirIds.set(fold(CURRENT_DIR), CURRENT_ID);
  world.dirIds.set(fold(DATA_DIR), DATA_ID);
  world.dirIds.set(fold(STATE_ROOT), STATE_ROOT_ID);
  world.dirIds.set(fold(STATE_CONFIG), STATE_CONFIG_ID);
  world.fileIds.set(fold(DATABASE), DATABASE_ID);
  world.files.set(fold(DATABASE), { id: DATABASE_ID, bytes: DATABASE_BYTES });
  world.trees.set(fold(DATA_DIR), {
    id: DATA_ID,
    entries: 3,
    bytes: DATABASE_BYTES.length,
    sha256: TREE_HASH,
  });
  world.probe = {
    probe(path, root) {
      world.probeCalls++;
      return evidence(world, path, root);
    },
    create(path, root) {
      if (!fs.entries.has(fold(path))) {
        fs.addFile(path);
        const id = `f${(++world.idCounter).toString(16)}`.padStart(32, "0");
        world.fileIds.set(fold(path), id);
        world.files.set(fold(path), { id, bytes: new Uint8Array(0) });
      }
      const e = evidence(world, path, root) as Record<string, unknown>;
      return {
        ...e,
        state: "CREATED",
        handleFileId: e.fileId,
        handleVolumeId: e.volumeId,
      };
    },
    open(path, root) {
      const e = evidence(world, path, root) as Record<string, unknown>;
      return {
        ...e,
        state: "OPEN",
        handleFileId: e.fileId,
        handleVolumeId: e.volumeId,
      };
    },
    exclusiveDirectory(request) {
      world.exclusiveCalls++;
      return exclusiveExec(world, request);
    },
  };
  return world;
}

const CONFIG: WindowsOperatorConfig = {
  root: ROOT,
  probeExecutable: EXECUTABLE,
  expectedHash: HELPER_HASH,
  systemRoot: SYSTEM_ROOT,
  publicationStateRoot: STATE_ROOT,
  publicationStateDirectory: STATE_CONFIG,
};

function testPort(world: World): WindowsPrivatePersistenceTestPort {
  return {
    fs: {
      lstat(path: string) {
        const entry = world.fs.entries.get(fold(path));
        if (!entry || entry.kind !== "file") throw new Error("ENOENT");
        return {
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          nlink: 1,
          dev: 1,
          ino: 1,
          size: world.fs.helperBytes.length,
          mtimeMs: 0,
        };
      },
      readFile() {
        return world.fs.helperBytes;
      },
    },
    exec: (request) => kExec(world, request),
  };
}

function makeDeps(world: World) {
  const productPort = createWindowsPrivatePersistenceForTesting(
    {
      root: ROOT,
      probeExecutable: EXECUTABLE,
      expectedHash: HELPER_HASH,
      systemRoot: SYSTEM_ROOT,
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOL },
      authority: {
        version: 1 as const,
        independent: true as const,
        reserve() {},
        capture() {},
        terminal() {},
        assertCurrent() {},
      },
      directoryIdentity: (path) => ({
        fileId: world.dirIds.get(fold(path)) ?? "0".repeat(32),
        volumeId: VOL,
      }),
      createDirectory: () => ({ fileId: DATA_ID, volumeId: VOL }),
      acquireSqliteLease: () => ({
        trust: "untrusted-test",
        assertHeld() {},
        close() {},
      }),
      assertCurrent() {},
    },
    testPort(world),
  );
  const deps = {
    runtime: (options: WindowsRuntimePlatformOptions) =>
      new WindowsRuntimePlatform({
        ...options,
        untrustedTestPort: { fs: world.fs, probe: world.probe },
      }),
    privateFilesystem: (
      options: Parameters<typeof createWindowsPrivatePersistenceForTesting>[0],
    ) => createWindowsPrivatePersistenceForTesting(options, testPort(world)),
    authorityLeases: (
      options: NativeAuthorityLeaseOptions,
    ): AcquirePrivateAuthorityLease => {
      return (path) => {
        const identity = options.identityFor(path);
        if (
          !/^[0-9a-fA-F]{32}$/.test(identity.fileId) ||
          !/^[0-9a-fA-F]{32}$/.test(identity.directoryFileId)
        )
          throw new CollaborationError("FAKE_LEASE_IDENTITY");
        const lease: PrivateAuthorityLease & { closed: boolean } = {
          trust: "untrusted-test",
          closed: false,
          assertHeld() {
            if (lease.closed) throw new CollaborationError("FAKE_LEASE_CLOSED");
          },
          close() {
            if (lease.closed) return;
            if (world.failLeaseClose)
              throw new Error("simulated lease close failure");
            lease.closed = true;
          },
        };
        world.leases.push({ path, lease });
        return lease;
      };
    },
    probeEvidence: (_config: WindowsOperatorConfig, path: string, root: string) =>
      evidence(world, path, root) as never,
    nonce: () => (++world.nonceCounter).toString(16).padStart(32, "0"),
  };
  return { deps, productPort };
}

function verifiedTree(): NativePrivateTree {
  return Object.freeze({
    path: DATA_DIR,
    fileId: DATA_ID,
    volumeId: VOL,
    entries: 3,
    bytes: DATABASE_BYTES.length,
    sha256: TREE_HASH,
  });
}

function request(
  world: World,
  ticket: string,
  overrides: Partial<WindowsRestoreLaunchRequest> = {},
): WindowsRestoreLaunchRequest {
  const { productPort } = makeDeps(world);
  return {
    ticket,
    current: {
      directory: CURRENT_DIR,
      workspaceId: WORKSPACE_ID,
      assertCurrent() {},
    },
    directory: DATA_DIR,
    verifiedFingerprint: FINGERPRINT,
    verifiedTree: verifiedTree(),
    nativeFilesystem: productPort,
    ...overrides,
  };
}

function harness(world: World) {
  const { deps, productPort } = makeDeps(world);
  const api = createWindowsRestoreHandoffForTesting(deps);
  return { ...api, productPort };
}

const childConfig = (stateDir: string): WindowsOperatorConfig => ({
  ...CONFIG,
  publicationStateDirectory: stateDir,
});

const createdStores: Store[] = [];
const createdDirs: string[] = [];
function realStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "folio-handoff-test-"));
  createdDirs.push(dir);
  // Explicit off-host path mapping only: SQLite is real disposable POSIX;
  // the simulated native PRIMARY lease/path are never OS acceptance.
  const store = new Store(join(dir, "workspace.sqlite"), {nativeLease: {assertHeld(){}, close(){}}});
  Object.defineProperty(store, "path", {value: DATABASE});
  createdStores.push(store);
  return store;
}
afterEach(() => {
  for (const store of createdStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* disposable fixture */
    }
  }
  for (const dir of createdDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function produce(
  world: World,
  ticket = "ticket-1",
  overrides: Partial<WindowsRestoreLaunchRequest> = {},
): { launch: WindowsRestoredWorkspaceLaunch; env: NodeJS.ProcessEnv } {
  const api = harness(world);
  const launch = api.prepareWindowsRestoredWorkspaceLaunch(
    CONFIG,
    request(world, ticket, overrides),
  );
  const env = launch.childEnvironment({
    FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES: "1",
    FOLIO_DATA_DIR: "C:\\FolioPrivate\\Old",
    PATH: "C:\\Windows",
  });
  return { launch, env };
}

function produceAndRead(
  world: World,
  ticket = "ticket-1",
  envBase?: NodeJS.ProcessEnv,
): {
  launch: WindowsRestoredWorkspaceLaunch;
  env: NodeJS.ProcessEnv;
  envSnapshot: NodeJS.ProcessEnv;
  handoff: WindowsRestoreHandoff;
  stateDir: string;
} {
  const api = harness(world);
  const { launch, env } = produce(world, ticket);
  const envSnapshot = { ...env };
  const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
  const handoff = api.readWindowsRestoreHandoff(
    childConfig(stateDir),
    DATA_DIR,
    envBase ?? env,
  );
  if (handoff === undefined) throw new Error("handoff missing");
  return { launch, env, envSnapshot, handoff, stateDir };
}

function expectHandoffError(
  run: () => unknown,
  state?: "REJECTED" | "EXISTS" | "UNKNOWN",
): WindowsRestoreHandoffError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WindowsRestoreHandoffError);
    const typed = error as WindowsRestoreHandoffError;
    if (state !== undefined) expect(typed.state).toBe(state);
    return typed;
  }
  throw new Error("expected WindowsRestoreHandoffError");
}

describe("restored workspace launch handoff (contract simulation, NOT OS acceptance)", () => {
  it("produces intent+handoff, consumes it, and transfers guards in order", () => {
    const world = makeWorld();
    const { launch, handoff } = produceAndRead(world);
    expect(launch.intent.profile).toBe(
      "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",
    );
    expect(launch.intent.scope).toBe("PROCESS_CRASH");
    expect(launch.handoff.identity.bytes).toBeGreaterThan(0);
    expect(launch.directoryReceipt.state).toBe("CREATED");
    expect(launch.bootstrap.canonicalPath.endsWith("restore-bootstrap.sqlite")).toBe(true);
    launch.assertCurrent();

    expect(handoff.initialEnrollment).toBe(true);
    expect(handoff.directory).toBe(DATA_DIR);
    expect(handoff.verifiedFingerprint).toBe(FINGERPRINT);
    // consumer raw data C + raw state C join the parent's state guard
    expect(world.leases).toHaveLength(3);
    handoff.assertHeld();

    const product = {
      assertRoot() {},
      privateFilesystem: makeDeps(world).productPort,
    };
    expect(() =>
      handoff.workspaceReady(realStore()),
    ).toThrowError(/STATE_ORDER/);
    handoff.stateReady(product);
    handoff.assertHeld();
    const store = realStore();
    handoff.workspaceReady(store);
    handoff.assertHeld();
    // After both transfers every raw consumer guard is released.
    expect(() => world.leases[1].lease.assertHeld()).toThrow("FAKE_LEASE_CLOSED");
    expect(() => world.leases[2].lease.assertHeld()).toThrow("FAKE_LEASE_CLOSED");
    launch.close();
    launch.close(); // once-only
  });

  it("childEnvironment strips ENROLL case-insensitively, plumbs state dir, carries exact receipt scalars", () => {
    const world = makeWorld();
    const api = harness(world);
    const launch = api.prepareWindowsRestoredWorkspaceLaunch(
      CONFIG,
      request(world, "ticket-env"),
    );
    const env = launch.childEnvironment({
      FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES: "1",
      folio_windows_enroll_existing_sources: "0",
      FOLIO_DATA_DIR: "C:\\FolioPrivate\\Old",
      FOLIO_WINDOWS_RESTORE_HANDOFF_PATH: "stale",
      KEEP: "yes",
    });
    const keys = Object.keys(env);
    expect(
      keys.some(
        (k) => k.toLowerCase() === "folio_windows_enroll_existing_sources",
      ),
    ).toBe(false);
    expect(env.FOLIO_DATA_DIR).toBe(DATA_DIR);
    const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    expect(stateDir.startsWith(STATE_ROOT + "\\restore-")).toBe(true);
    for (const name of WINDOWS_RESTORE_HANDOFF_ENV)
      expect(typeof env[name]).toBe("string");
    expect(env[WINDOWS_RESTORE_HANDOFF_ENV[0]]).toBe(
      launch.handoff.identity.path,
    );
    expect(env[WINDOWS_RESTORE_HANDOFF_ENV[1]]).toBe(
      launch.handoff.identity.fileId,
    );
    expect(env[WINDOWS_RESTORE_HANDOFF_ENV[2]]).toBe(
      launch.handoff.identity.volumeId,
    );
    expect(env[WINDOWS_RESTORE_HANDOFF_ENV[3]]).toBe(
      launch.handoff.identity.sha256,
    );
    expect(env[WINDOWS_RESTORE_HANDOFF_ENV[4]]).toBe(
      String(launch.handoff.identity.bytes),
    );
    expect(env[WINDOWS_RESTORE_HANDOFF_ENV[5]]).toBe(`${ROOT_ID}:${VOL}`);
    expect(env.KEEP).toBe("yes");
  });

  it("stripWindowsRestoreHandoffEnvironment deletes only the six handoff keys", () => {
    const env: NodeJS.ProcessEnv = {
      FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES: "1",
      FOLIO_WINDOWS_RESTORE_HANDOFF_PATH: "x",
      folio_windows_restore_handoff_file_id: "y",
      OTHER: "z",
    };
    stripWindowsRestoreHandoffEnvironment(env);
    expect(env.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES).toBe("1");
    expect(env.OTHER).toBe("z");
    expect(env.FOLIO_WINDOWS_RESTORE_HANDOFF_PATH).toBeUndefined();
    expect(env.folio_windows_restore_handoff_file_id).toBeUndefined();
  });

  it("repeat ticket returns/throws the original outcome with no IO and no new nonce", () => {
    const world = makeWorld();
    const api = harness(world);
    api.prepareWindowsRestoredWorkspaceLaunch(CONFIG, request(world, "t1"));
    const probes = world.probeCalls;
    const execs = world.execCalls;
    const nonce = world.nonceCounter;
    const error = expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(CONFIG, request(world, "t1")),
    );
    expect(error.message).toContain("TICKET_CONSUMED");
    expect(world.probeCalls).toBe(probes);
    expect(world.execCalls).toBe(execs);
    expect(world.nonceCounter).toBe(nonce);
  });

  it("stale current before dispatch rejects with zero IO; stale after dispatch is UNKNOWN preserving intent", () => {
    const world = makeWorld();
    const api = harness(world);
    const before = world.execCalls + world.probeCalls;
    const calls = { count: 0 };
    const early = expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(CONFIG, {
        ...request(world, "t-early"),
        current: {
          directory: CURRENT_DIR,
          workspaceId: WORKSPACE_ID,
          assertCurrent() {
            calls.count++;
            throw new Error("stale");
          },
        },
      }),
    );
    expect(early.state).toBe("REJECTED");
    expect(world.execCalls + world.probeCalls).toBe(before);

    const world2 = makeWorld();
    const api2 = harness(world2);
    let count = 0;
    const late = expectHandoffError(() =>
      api2.prepareWindowsRestoredWorkspaceLaunch(CONFIG, {
        ...request(world2, "t-late"),
        current: {
          directory: CURRENT_DIR,
          workspaceId: WORKSPACE_ID,
          assertCurrent() {
            // First two fences pass; the post-intent-dispatch fence fails.
            if (++count > 3) throw new Error("stale-after");
          },
        },
      }),
    );
    expect(late.state).toBe("UNKNOWN");
    expect(late.evidence).toBeDefined();
    // The immutable intent stays published; no retry or delete occurred.
    expect(
      [...world2.files.keys()].some((k) => k.includes(".intent.json")),
    ).toBe(true);
    // Same ticket replays the retained error without new dispatch.
    const execs = world2.execCalls;
    const again = expectHandoffError(() =>
      api2.prepareWindowsRestoredWorkspaceLaunch(CONFIG, request(world2, "t-late")),
    );
    expect(again).toBe(late);
    expect(world2.execCalls).toBe(execs);
  });

  it("EXISTS and UNKNOWN directory outcomes are typed, preserved and never retried", () => {
    const world = makeWorld();
    const api = harness(world);
    world.exclusiveMode = "exists";
    const exists = expectHandoffError(
      () => api.prepareWindowsRestoredWorkspaceLaunch(CONFIG, request(world, "t-e")),
      "EXISTS",
    );
    expect(exists.evidence).toBeDefined();
    const calls = world.exclusiveCalls;
    const again = expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(CONFIG, request(world, "t-e")),
    );
    expect(again).toBe(exists);
    expect(world.exclusiveCalls).toBe(calls);

    const world2 = makeWorld();
    const api2 = harness(world2);
    world2.exclusiveMode = "unknown";
    const unknown_ = expectHandoffError(
      () => api2.prepareWindowsRestoredWorkspaceLaunch(CONFIG, request(world2, "t-u")),
      "UNKNOWN",
    );
    expect((unknown_.evidence as { state: string }).state).toBe("UNKNOWN");
  });

  it.each([
    ["database file id", (world: World) => world.fileIds.set(fold(DATABASE), "9".repeat(32))],
    ["tree hash", (world: World) => {
      const tree = world.trees.get(fold(DATA_DIR))!;
      world.trees.set(fold(DATA_DIR), { ...tree, sha256: "7".repeat(64) });
    }],
    ["restored directory id", (world: World) => world.dirIds.set(fold(DATA_DIR), "9".repeat(32))],
    ["current directory id", (world: World) => world.dirIds.set(fold(CURRENT_DIR), "9".repeat(32))],
    ["root id", (world: World) => world.dirIds.set(fold(ROOT), "9".repeat(32))],
    ["state root id", (world: World) => world.dirIds.set(fold(STATE_ROOT), "9".repeat(32))],
    ["sid", (world: World) => { world.sid = "S-1-5-99"; }],
    ["helper", (world: World) => { world.fs.helperBytes = OTHER_HELPER; }],
  ])("rejects changed %s before enrollment", (_name, mutate) => {
    const world = makeWorld();
    const api = harness(world);
    const { launch, env } = produce(world, "t-mut");
    const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    mutate(world);
    const leasesBefore = world.leases.length;
    const error = expectHandoffError(() =>
      api.readWindowsRestoreHandoff(childConfig(stateDir), DATA_DIR, env),
    );
    expect(error.state).toBe("REJECTED");
    expect(world.leases.length).toBe(leasesBefore); // no consumer raw C retained
    void launch;
  });

  it("rejects a changed bootstrap/state-directory identity before enrollment", () => {
    const world = makeWorld();
    const api = harness(world);
    const { env } = produce(world, "t-state");
    const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    world.dirIds.set(fold(stateDir), "9".repeat(32));
    expectHandoffError(() =>
      api.readWindowsRestoreHandoff(childConfig(stateDir), DATA_DIR, env),
    );
    const world2 = makeWorld();
    const api2 = harness(world2);
    const produced = produce(world2, "t-boot");
    const stateDir2 = String(produced.env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    world2.fileIds.set(
      fold(stateDir2 + "\\restore-bootstrap.sqlite"),
      "9".repeat(32),
    );
    expectHandoffError(() =>
      api2.readWindowsRestoreHandoff(childConfig(stateDir2), DATA_DIR, produced.env),
    );
  });

  it("rejects a mismatched child config and a wrong data dir", () => {
    const world = makeWorld();
    const api = harness(world);
    const { env } = produce(world, "t-cfg");
    const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    expectHandoffError(() =>
      api.readWindowsRestoreHandoff(
        { ...childConfig(stateDir), systemRoot: "C:\\Other" },
        DATA_DIR,
        env,
      ),
    );
    const world2 = makeWorld();
    const api2 = harness(world2);
    const produced2 = produce(world2, "t-dir");
    const stateDir2 = String(produced2.env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    expectHandoffError(() =>
      api2.readWindowsRestoreHandoff(
        childConfig(stateDir2),
        ROOT + "\\Other",
        produced2.env,
      ),
    );
    // Env state dir that disagrees with the payload identity is rejected.
    const world3 = makeWorld();
    const api3 = harness(world3);
    const produced3 = produce(world3, "t-dir2");
    expectHandoffError(() =>
      api3.readWindowsRestoreHandoff(
        { ...CONFIG, publicationStateDirectory: STATE_ROOT + "\\state" },
        DATA_DIR,
        produced3.env,
      ),
    );
  });

  it("replay after workspace writes fails the captured tree attestation", () => {
    const world = makeWorld();
    const api = harness(world);
    const { env } = produce(world, "t-replay");
    const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    const envCopy = { ...env };
    const first = api.readWindowsRestoreHandoff(childConfig(stateDir), DATA_DIR, env);
    if (!first) throw new Error("missing");
    first.stateReady({ assertRoot() {}, privateFilesystem: makeDeps(world).productPort });
    first.workspaceReady(realStore());
    // Workspace writes changed the restored tree; the immutable handoff now
    // attests an old hash so a replayed launch cannot re-enroll silently.
    const tree = world.trees.get(fold(DATA_DIR))!;
    world.trees.set(fold(DATA_DIR), { ...tree, sha256: "6".repeat(64) });
    const replay = expectHandoffError(() =>
      api.readWindowsRestoreHandoff(childConfig(stateDir), DATA_DIR, envCopy),
    );
    expect(replay.state).toBe("REJECTED");
  });

  it("failed raw lease close is retained as a branded startup graph", () => {
    const world = makeWorld();
    const { handoff } = produceAndRead(world, "t-close");
    world.failLeaseClose = true;
    let thrown: unknown;
    try {
      handoff.stateReady({
        assertRoot() {},
        privateFilesystem: makeDeps(world).productPort,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(startupRetainsNativeLease(thrown)).toBe(true);
  });

  it("retainFailure preserves an undefined primary error as a branded graph", () => {
    const world = makeWorld();
    const { handoff } = produceAndRead(world, "t-retain");
    let thrown: unknown;
    try {
      handoff.retainFailure(undefined);
    } catch (error) {
      thrown = error;
    }
    expect(startupRetainsNativeLease(thrown)).toBe(true);
  });

  it("bounded reservations: 64 tickets fill capacity before IO; consumer owners cap at 64", () => {
    const world = makeWorld();
    const api = harness(world);
    for (let i = 0; i < 64; i++) {
      expectHandoffError(() =>
        api.prepareWindowsRestoredWorkspaceLaunch(
          CONFIG,
          request(world, `cap-${i}`, { verifiedFingerprint: "z".repeat(64) }),
        ),
      );
    }
    const probeCalls = world.probeCalls;
    const execCalls = world.execCalls;
    const full = expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(
        CONFIG,
        request(world, "cap-overflow"),
      ),
    );
    expect(full.message).toContain("CAPACITY");
    expect(world.probeCalls).toBe(probeCalls);
    expect(world.execCalls).toBe(execCalls);
  });

  it("consumer owner reservations cap at 64 live handoffs", () => {
    const world = makeWorld();
    const api = harness(world);
    const envs: NodeJS.ProcessEnv[] = [];
    for (let i = 0; i < 64; i++) {
      const { env } = produce(world, `own-${i}`);
      envs.push(env);
    }
    const stale = { ...envs[0] };
    for (let i = 0; i < 64; i++) {
      const stateDir = String(envs[i].FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
      const handoff = api.readWindowsRestoreHandoff(
        childConfig(stateDir),
        DATA_DIR,
        envs[i],
      );
      if (!handoff) throw new Error("missing");
    }
    const error = expectHandoffError(() =>
      api.readWindowsRestoreHandoff(CONFIG, DATA_DIR, stale),
    );
    expect(error.message).toContain("CAPACITY");
  });

  it("refuses async or generator callbacks before any invocation", () => {
    const world = makeWorld();
    const api = harness(world);
    const asyncError = expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(CONFIG, {
        ...request(world, "t-async"),
        current: {
          directory: CURRENT_DIR,
          workspaceId: WORKSPACE_ID,
          async assertCurrent() {},
        },
      }),
    );
    expect(asyncError.state).toBe("REJECTED");
    expect(world.probeCalls).toBe(0);
    expect(world.execCalls).toBe(0);
    const genError = expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(CONFIG, {
        ...request(world, "t-gen"),
        nativeFilesystem: {
          ...makeDeps(world).productPort,
          *inspectTree() {},
        } as unknown as NativePrivateFilesystemPort,
      }),
    );
    expect(genError.state).toBe("REJECTED");
    expect(world.probeCalls).toBe(0);
  });

  it("returns undefined without handoff env; partial env rejects and is consumed", () => {
    const world = makeWorld();
    const api = harness(world);
    expect(
      api.readWindowsRestoreHandoff(CONFIG, DATA_DIR, { KEEP: "1" }),
    ).toBeUndefined();
    const { env } = produce(world, "t-partial");
    delete env[WINDOWS_RESTORE_HANDOFF_ENV[3]];
    expectHandoffError(() =>
      api.readWindowsRestoreHandoff(
        childConfig(String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR)),
        DATA_DIR,
        env,
      ),
    );
    for (const name of WINDOWS_RESTORE_HANDOFF_ENV)
      expect(env[name]).toBeUndefined();
    expect(env.FOLIO_DATA_DIR).toBe(DATA_DIR);
  });

  it("rejects tampered handoff payloads before enrollment", () => {
    const world = makeWorld();
    const api = harness(world);
    const { launch, env } = produce(world, "t-tamper");
    const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    const file = world.files.get(fold(launch.handoff.identity.path))!;
    const original = Buffer.from(file.bytes).toString("utf8");
    const payload = JSON.parse(original) as Record<string, unknown>;
    (payload.database as Record<string, unknown>).fileId = "9".repeat(32);
    file.bytes = new TextEncoder().encode(canonical(payload));
    const refreshed = world.files.get(fold(launch.handoff.identity.path))!;
    env[WINDOWS_RESTORE_HANDOFF_ENV[3]] = hash(refreshed.bytes);
    env[WINDOWS_RESTORE_HANDOFF_ENV[4]] = String(refreshed.bytes.length);
    const error = expectHandoffError(() =>
      api.readWindowsRestoreHandoff(childConfig(stateDir), DATA_DIR, env),
    );
    expect(error.state).toBe("REJECTED");
  });

  it.each([
    ["duplicate keys", '{"version":1,"version":2,"role":"x"}'],
    ["noncanonical order", '{"z":1,"a":2}'],
    ["invalid utf8", "\ud800"],
    ["unsafe integer", '{"version":9007199254740993}'],
    ["noninteger count", '{"version":1,"entries":1.5}'],
    ["wrong schema", "{}"],
  ])("rejects malformed canonical payload: %s", (_name, text) => {
    const world = makeWorld();
    const api = harness(world);
    const { launch, env } = produce(world, "t-bad");
    const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    const file = world.files.get(fold(launch.handoff.identity.path))!;
    file.bytes = new TextEncoder().encode(text);
    env[WINDOWS_RESTORE_HANDOFF_ENV[3]] = hash(file.bytes);
    env[WINDOWS_RESTORE_HANDOFF_ENV[4]] = String(file.bytes.length);
    expectHandoffError(() =>
      api.readWindowsRestoreHandoff(childConfig(stateDir), DATA_DIR, env),
    );
  });

  it("rejects a handoff payload over the 1MiB cap", () => {
    const world = makeWorld();
    const api = harness(world);
    const { env } = produce(world, "t-cap");
    const stateDir = String(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR);
    env[WINDOWS_RESTORE_HANDOFF_ENV[4]] = String(2 * 1024 * 1024);
    expectHandoffError(() =>
      api.readWindowsRestoreHandoff(childConfig(stateDir), DATA_DIR, env),
    );
  });

  it("workspaceReady requires stateReady first and a real primary Store", () => {
    const world = makeWorld();
    const { handoff } = produceAndRead(world, "t-order");
    expect(() =>
      handoff.workspaceReady({} as Store),
    ).toThrowError(/STATE_ORDER/);
    handoff.stateReady({
      assertRoot() {},
      privateFilesystem: makeDeps(world).productPort,
    });
    expect(() => handoff.stateReady({
      assertRoot() {},
      privateFilesystem: makeDeps(world).productPort,
    })).toThrowError(/STATE_ORDER/);
    expect(() =>
      handoff.workspaceReady({} as Store),
    ).toThrowError(/PRIMARY/);
    handoff.workspaceReady(realStore());
  });

  it("changed launch config is rejected at produce-time", () => {
    const world = makeWorld();
    const api = harness(world);
    expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(
        { ...CONFIG, publicationStateRoot: ROOT + "\\nested" },
        request(world, "t-cfg2"),
      ),
    );
    expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(
        { ...CONFIG, expectedHash: "f".repeat(64) },
        request(world, "t-cfg3"),
      ),
    );
    expectHandoffError(() =>
      api.prepareWindowsRestoredWorkspaceLaunch(CONFIG, {
        ...request(world, "t-tree"),
        verifiedTree: { ...verifiedTree(), sha256: "5".repeat(64) },
      }),
    );
  });
});
