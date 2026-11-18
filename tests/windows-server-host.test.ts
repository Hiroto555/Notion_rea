/**
 * UNTRUSTED NATIVE CONTRACT DRIVER — NOT Windows OS acceptance.
 *
 * Authored for parent execution only. Real Node HTTP, real disposable SQLite,
 * real checkpoint/history validators and the real B2 Windows transfer branch.
 * Synthetic file IDs and POSIX byte IO below simulate native contracts only;
 * they prove no NTFS/DACL/share-mode/durability/physical-device behavior.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWindowsServerLifecycleHost,
  createWindowsServerNativeFromEnvironment,
} from "../src/platform/windows/server-native-host";
import type { WindowsServerNativePort } from "../src/platform/windows/server-native";
import { NativePrivatePersistenceError } from "../src/platform/windows/private-persistence";
import type { NativeTransferOptions, NativeTransferIoPort } from "../src/platform/windows/private-transfer";
import { withPrivatePersistence, type NativePrivateFile, type NativePrivateFilesystemPort,
  type NativePrivateIdentity, type NativePrivateReceipt } from "../src/platform/private-persistence";
import { withProductPrivateJournals } from "../src/platform/product-private-journals";
import type { PrivatePlatform } from "../src/sync/private-platform";
import { startCheckpointServer, type CheckpointServerHandle } from "../src/sync/checkpoint-server";
import { hashCheckpoint, SyncError, type Checkpoint, type Commit } from "../src/sync/protocol";
import { WORKSPACE_CONTENT_TABLES } from "../src/sync/workspace-checkpoint";
import { runServerOpsCli } from "../src/sync/server-ops-cli";
import { startupRetainsNativeLease } from "../src/persistence/startup-connection-owner";

const roots: string[] = [];
const handles = new Set<CheckpointServerHandle>();
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const volumeId = "1234567890abcdef";
const receipt = (identity: NativePrivateFile): NativePrivateReceipt => ({
  profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH", identity,
});
const same = (a: NativePrivateIdentity, b: NativePrivateIdentity) =>
  a.path === b.path && a.fileId === b.fileId && a.volumeId === b.volumeId;

/** Bounded own-property traversal of error `errors`/`cause` graphs. */
function errorGraphContains(root: unknown, text: string): boolean {
  const queue: unknown[] = [root], seen = new Set<object>();
  while (queue.length && seen.size <= 256) {
    const value = queue.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) {
      if (typeof value === "string" && value.includes(text)) return true;
      continue;
    }
    seen.add(value);
    if (value instanceof Error && value.message.includes(text)) return true;
    const errors = Object.getOwnPropertyDescriptor(value, "errors")?.value;
    if (Array.isArray(errors)) queue.push(...errors);
    const cause = Object.getOwnPropertyDescriptor(value, "cause");
    if (cause && "value" in cause) queue.push(cause.value);
  }
  return false;
}

function driver() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-native-host-contract-")));
  roots.push(root);
  const directory = join(root, "server");
  mkdirSync(directory);
  const databasePath = join(directory, "server.sqlite");
  writeFileSync(databasePath, "");
  const als = new AsyncLocalStorage<boolean>();
  const ids = new Map<string, string>();
  let serial = 0;
  let current = true;
  let held = 0;
  let closeFaults = 0;
  let live = 0;
  // Once the closed notification completes the fixture's native scope is
  // disposed; a retried close must never enter it again.
  let disposed = false;
  let scopeCalls = 0;
  let currentCalls = 0;
  let fenceObserver: (() => void) | undefined;
  const events: string[] = [];
  const scoped = () => { if (!als.getStore()) throw new Error("HTTP native callback escaped ALS"); };
  const identity = (path: string): NativePrivateIdentity => {
    lstatSync(path);
    if (!ids.has(path)) ids.set(path, (++serial).toString(16).padStart(32, "0"));
    return { path, fileId: ids.get(path)!, volumeId };
  };
  const file = (path: string, max = 256 * 1024 * 1024): NativePrivateFile => {
    const bytes = readFileSync(path);
    if (bytes.length > max) throw new NativePrivatePersistenceError("REJECTED", "LIMIT");
    return { ...identity(path), bytes: bytes.length, sha256: sha(bytes) };
  };
  const expectedFile = (path: string, expected: NativePrivateFile, max: number) => {
    const next = file(path, max);
    if (!same(next, expected) || next.sha256 !== expected.sha256 || next.bytes !== expected.bytes)
      throw new NativePrivatePersistenceError("REJECTED", "STALE");
    return next;
  };
  const fs: NativePrivateFilesystemPort = {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory(path) {
      scoped();
      if (!lstatSync(path).isDirectory()) throw new Error("directory required");
      return identity(path);
    },
    inspectFile(path, max) { scoped(); return file(path, max); },
    inspectFileIdentity(path) { scoped(); return identity(path); },
    read(path, expected, max) { scoped(); expectedFile(path, expected, max); return readFileSync(path); },
    writeNew(path, bytes, max) {
      scoped();
      if (bytes.length > max) throw new NativePrivatePersistenceError("REJECTED", "LIMIT");
      if (existsSync(path)) throw new NativePrivatePersistenceError("EXISTS", "COLLISION");
      writeFileSync(path, bytes, { flag: "wx" });
      return receipt(file(path, max));
    },
    copyNew(source, destination, expected, max) {
      scoped(); expectedFile(source, expected, max);
      return fs.writeNew(destination, readFileSync(source), max);
    },
    renameNew(source, destination, expected, max) {
      scoped(); expectedFile(source, expected, max);
      if (existsSync(destination)) throw new NativePrivatePersistenceError("EXISTS", "COLLISION");
      renameSync(source, destination);
      ids.set(destination, expected.fileId); ids.delete(source);
      return receipt(file(destination, max));
    },
    unlinkExact(path, expected, max) {
      scoped(); expectedFile(path, expected, max); unlinkSync(path); ids.delete(path);
    },
    proveSync(path, expected) {
      scoped(); return receipt(expectedFile(path, expected, 256 * 1024 * 1024));
    },
    createDirectory(path) { scoped(); mkdirSync(path); return identity(path); },
    snapshotSqlite(db, destination) {
      scoped(); expect(held).toBeGreaterThan(0);
      events.push("native-vacuum");
      db.prepare("VACUUM INTO ?").run(destination);
      return receipt(file(destination));
    },
  };
  const append: NativeTransferIoPort = {
    platform: "win32", version: 1, synchronous: true,
    append(path, expected, bytes, max) {
      scoped(); expectedFile(path, expected, max);
      if (expected.bytes + bytes.length > max) throw new NativePrivatePersistenceError("REJECTED", "LIMIT");
      writeFileSync(path, bytes, { flag: "a" });
      events.push("native-append");
      return receipt(file(path, max));
    },
  };
  const platform = (): PrivatePlatform => {
    let path = "", pin: NativePrivateIdentity | undefined, leased = false, closed = false;
    const check = () => { scoped(); if (closed) throw new Error("closed platform"); };
    return {
      kind: "windows",
      bind(value) { check(); path = value; pin = identity(path); return path; },
      assertRoot() { check(); if (!pin || !same(pin, identity(path))) throw new Error("directory drift"); },
      assertFile(value) { check(); identity(value); },
      assertSidecars(value) {
        check();
        for (const suffix of ["-wal", "-shm", "-journal"])
          if (existsSync(value + suffix)) identity(value + suffix);
      },
      createExclusive(value) {
        check();
        if (!existsSync(value)) fs.writeNew(value, new Uint8Array(), 1024);
        if (!leased) { held++; leased = true; events.push("lease-before-sqlite"); }
      },
      assertEmptyFile(value) { check(); expect(lstatSync(value).size).toBe(0); },
      close() {
        scoped();
        if (closed) return;
        if (closeFaults > 0) {closeFaults--; throw new Error("owned platform close fault");}
        if (leased) held--;
        events.push("platform-close"); closed = true;
      },
    };
  };
  const transfer: NativeTransferOptions = { nativePrivateFilesystem: fs, nativeTransferIo: append };
  const scope = <T>(work: () => T): T => {
    scopeCalls++;
    if (disposed) throw new Error("native scope disposed after closed notification");
    return als.run(true, () =>
      withPrivatePersistence({ nativePrivateFilesystem: fs }, () =>
        withProductPrivateJournals({ privatePlatformFactory: platform }, work)));
  };
  const assertCurrent = () => {
    currentCalls++;
    scoped(); fenceObserver?.();
    if (!current) throw new SyncError("contract-current-expired", 503);
  };
  const within = (path: string) => {
    const result = resolve(path), rest = relative(root, result);
    if (rest === ".." || rest.startsWith("../")) throw new Error("outside contract tree");
    return result;
  };
  const native: WindowsServerNativePort = {
    platform: "win32", trust: "untrusted-test", root, lifecycleHost: undefined,
    scope, canonical: within, canonicalAbsolute: within,
    join, parent: dirname, basename: path => path.slice(path.lastIndexOf("/") + 1),
    samePath: (a, b) => resolve(a) === resolve(b),
    overlaps: (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/"),
    sameIdentity: same,
    assertCurrent,
    poison(error): never { current = false; throw error; },
    retainUnknown(_resource, error): never { current = false; throw error; },
    assertSourceIdentity(id) { scoped(); expect(same(id, identity(id.path))).toBe(true); },
    inspectDirectory: path => fs.inspectDirectory(path),
    assertDirectory(path, pin) { if (!same(fs.inspectDirectory(path), pin)) throw new SyncError("contract-ID-drift", 503); },
    createDirectory: path => fs.createDirectory(path),
    inspectFile: (path, max) => fs.inspectFile(path, max),
    inspectFileIdentity: path => fs.inspectFileIdentity(path),
    assertFileIdentity(path, pin) { if (!same(fs.inspectFileIdentity(path), pin)) throw new SyncError("contract-ID-drift", 503); },
    readFile: (path, expected, max) => fs.read(path, expected, max),
    writeNewFile: (path, bytes, max) => fs.writeNew(path, bytes, max).identity,
    copyNewFile: (source, destination, expected, max) => fs.copyNew(source, destination, expected, max).identity,
    proveSyncFile: (path, expected) => fs.proveSync(path, expected).identity,
    unlinkExact: (path, expected) => fs.unlinkExact(path, expected, expected.bytes),
    snapshotSqlite: (db, destination) => fs.snapshotSqlite(db, destination),
    kindOf(path) {
      scoped();
      if (!existsSync(path)) return "absent";
      return lstatSync(path).isDirectory() ? "directory" : "file";
    },
    listNames(path, max) { scoped(); const names = readdirSync(path); if (names.length > max) throw new Error("limit"); return names; },
    assertCapacity() { scoped(); },
    authorityPlatform: platform,
    acquireSqliteLease() {
      scoped(); held++; let closed = false;
      return { trust: "untrusted-test",
        assertHeld() { scoped(); if (closed) throw new Error("lease closed"); },
        close() { scoped(); if (!closed) { held--; closed = true; } } };
    },
  };
  const host = createWindowsServerLifecycleHost({
    native: () => native, filesystem: fs, transfer: () => transfer,
    sqlitePlatform: platform, scope,
    opened() { live++; },
    closed() { live--; disposed = true; },
  });
  return {
    root, directory, databasePath, fs, transfer, native, scope, events,
    get held() { return held; }, get live() { return live; },
    get scopeCalls() { return scopeCalls; }, get currentCalls() { return currentCalls; },
    failPlatformCloseOnce() {closeFaults = 1;},
    expire() { current = false; },
    drift() { ids.set(databasePath, "f".repeat(32)); },
    observeFence(callback: (() => void) | undefined) { fenceObserver = callback; },
    async start() {
      // A fresh start re-arms the fixture scope so the reopen-positive
      // path keeps working after a previous lifetime's disposal.
      disposed = false;
      const server = await host.start({ directory, databasePath, port: 0,
        workspaces: [{ workspaceId: "workspace", ownerId: "owner" }],
        assertCurrent });
      handles.add(server);
      return server;
    },
  };
}

function checkpoint(assets: Checkpoint["assets"] = []): Checkpoint {
  const tables = Object.fromEntries(WORKSPACE_CONTENT_TABLES.map(name => [name, [] as import("../src/sync/protocol").Json[]]));
  tables.assets = assets.map(a => [a.id, JSON.stringify({id: a.id, name: a.id, extension: "bin",
    mime: "application/octet-stream", storageName: a.id, size: a.bytes, sha256: a.sha256})]);
  return { format: "folio-checkpoint/v1", name: "folio-workspace", version: 1, payload: {tables}, assets };
}
const token = () => randomBytes(32).toString("hex");
function operation(server: CheckpointServerHandle, assets: Checkpoint["assets"] = []): Commit {
  const value = checkpoint(assets);
  return { protocol: 1, workspaceId: "workspace", clientId: "client", operationId: "op-1",
    serverEpoch: server.serverEpoch, baseRevision: 0, checkpointHash: hashCheckpoint(value), checkpoint: value };
}
function url(server: CheckpointServerHandle, route: string) {
  return `${server.url}/v1/workspaces/workspace/${route}`;
}
function auth(secret: string) { return { Authorization: `Bearer ${secret}` }; }
async function stop(server: CheckpointServerHandle) {
  try { await server.close(); } finally { handles.delete(server); }
}
afterEach(async () => {
  for (const server of [...handles]) {
    try { await stop(server); } catch { /* negative fence cases retain their asserted close error */ }
  }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("real HTTP/SQLite native host contract (NOT OS acceptance)", () => {
  it("initializes, issues, resumes native blob bytes, commits, snapshots and reopens", async () => {
    const d = driver(), server = await d.start(), secret = token();
    server.registerDevice({ workspaceId: "workspace", ownerId: "owner", clientId: "client", token: secret });
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 7), digest = sha(bytes);
    const split = 1024 * 1024;
    const first = await fetch(url(server, `blobs/${digest}`), {
      method: "PUT", headers: { ...auth(secret), "Content-Type": "application/octet-stream",
        "Content-Range": `bytes 0-${split - 1}/${bytes.length}` }, body: bytes.subarray(0, split),
    });
    expect(first.status).toBe(204);
    const resume = await fetch(url(server, `blobs/${digest}`), {
      method: "HEAD", headers: { ...auth(secret), "X-Folio-Blob-Resume": "1", "X-Folio-Blob-Bytes": String(bytes.length) },
    });
    expect(resume.headers.get("x-folio-blob-received")).toBe(String(split));
    expect(resume.headers.get("x-folio-blob-prefix-sha256")).toBe(sha(bytes.subarray(0, split)));
    const rest = await fetch(url(server, `blobs/${digest}`), {
      method: "PUT", headers: { ...auth(secret), "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${split}-${bytes.length - 1}/${bytes.length}` }, body: bytes.subarray(split),
    });
    expect(rest.status).toBe(201);
    const read = await fetch(url(server, `blobs/${digest}`), { headers: auth(secret) });
    expect(Buffer.from(await read.arrayBuffer()).equals(bytes)).toBe(true);
    const commit = operation(server, [{id: "00000000-0000-4000-8000-000000000001.bin", sha256: digest, bytes: bytes.length}]);
    const submit = () => fetch(url(server, "commits"), { method: "POST",
      headers: { ...auth(secret), "Content-Type": "application/json" }, body: JSON.stringify(commit) });
    const firstCommit = await (await submit()).json();
    expect(firstCommit.status).toBe("applied");
    expect(await (await submit()).json()).toEqual(firstCommit);
    const backup = server.backup(join(d.root, "backup"));
    expect(backup.manifest.counts.operations).toBe(1);
    expect(backup.manifest.serverEpoch).toBe(server.serverEpoch);
    expect(d.events).toContain("native-vacuum");
    expect(d.events).toContain("native-append");
    expect(() => server.backup(join(d.root, "backup"))).toThrow();
    const epoch = server.serverEpoch;
    await stop(server);
    expect(d.held).toBe(0); expect(d.live).toBe(0);
    const reopened = await d.start();
    expect(reopened.serverEpoch).toBe(epoch);
    const head = await (await fetch(url(reopened, "head"), { headers: auth(secret) })).json();
    expect(head.head.revision).toBe(1);
  });

  it.each(["missing", "corrupt"] as const)("rejects %s stored history assets before writable startup and preserves the original catalog", async fault => {
    const d = driver(), server = await d.start(), secret = token();
    server.registerDevice({workspaceId: "workspace", ownerId: "owner", clientId: "client", token: secret});
    const bytes = Buffer.from("durable history asset"), digest = sha(bytes);
    expect((await fetch(url(server, `blobs/${digest}`), {method: "PUT",
      headers: {...auth(secret), "Content-Type": "application/octet-stream"}, body: bytes})).status).toBe(201);
    const commit = operation(server, [{id: "00000000-0000-4000-8000-000000000001.bin", sha256: digest, bytes: bytes.length}]);
    expect((await fetch(url(server, "commits"), {method: "POST", headers: {...auth(secret), "Content-Type": "application/json"},
      body: JSON.stringify(commit)})).status).toBe(200);
    await stop(server);
    const original = sha(readFileSync(d.databasePath));
    const file = join(d.directory, "blobs", sha("workspace"), digest);
    if (fault === "missing") unlinkSync(file); else writeFileSync(file, Buffer.alloc(bytes.length, 9));
    await expect(d.start()).rejects.toThrow("server-asset-missing-or-corrupt");
    expect(sha(readFileSync(d.databasePath))).toBe(original);
    expect(d.held).toBe(0); expect(d.live).toBe(0);
  });

  it("keeps epoch, replay fingerprint and current authentication checks in the real handler", async () => {
    const d = driver(), server = await d.start(), secret = token();
    server.registerDevice({ workspaceId: "workspace", ownerId: "owner", clientId: "client", token: secret });
    const commit = operation(server);
    const post = (value: Commit) => fetch(url(server, "commits"), { method: "POST",
      headers: { ...auth(secret), "Content-Type": "application/json" }, body: JSON.stringify(value) });
    expect((await post({ ...commit, serverEpoch: "foreign-epoch" })).status).toBe(409);
    expect((await post(commit)).status).toBe(200);
    expect((await post({ ...commit, baseRevision: 1 })).status).toBe(409);
    server.revokeDevice("workspace", "client");
    expect((await fetch(url(server, "head"), { headers: auth(secret) })).status).toBe(401);
    expect(() => server.registerDevice({ workspaceId: "workspace", ownerId: "foreign",
      clientId: "new-client", token: token() })).toThrow("workspace-owner-mismatch");
  });

  it("rechecks a rotated credential after an HTTP body await", async () => {
    const d = driver(), server = await d.start(), secret = token();
    server.registerDevice({ workspaceId: "workspace", ownerId: "owner", clientId: "client", token: secret });
    const content = JSON.stringify(operation(server));
    let seen!: () => void;
    const entered = new Promise<void>(resolve => { seen = resolve; });
    d.observeFence(() => { d.observeFence(undefined); seen(); });
    const completed = new Promise<number>((resolve, reject) => {
      const request = httpRequest(url(server, "commits"), { method: "POST",
        headers: { ...auth(secret), "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(content) } }, response => {
        response.resume(); response.once("end", () => resolve(response.statusCode!));
      });
      request.once("error", reject);
      request.write(content.slice(0, 1));
      void entered.then(() => {
        server.registerDevice({ workspaceId: "workspace", ownerId: "owner", clientId: "client", token: token() });
        request.end(content.slice(1));
      }).catch(reject);
    });
    expect(await completed).toBe(401);
  });

  it.each(["identity", "current"] as const)("holds requests on %s drift and still closes SQLite before native resources", async kind => {
    const d = driver(), server = await d.start(), secret = token();
    const rawClose = vi.spyOn(DatabaseSync.prototype, "close");
    server.registerDevice({ workspaceId: "workspace", ownerId: "owner", clientId: "client", token: secret });
    if (kind === "identity") d.drift(); else d.expire();
    expect((await fetch(url(server, "head"), { headers: auth(secret) })).status).toBe(503);
    // The drift/current failure stays a diagnostic; the actual raw SQLite,
    // native platform and closed-notification cleanup all completed, so the
    // owner must not stay retained.
    const failure = await server.close().then(() => undefined, (error: unknown) => error);
    handles.delete(server);
    expect(failure).toBeInstanceOf(Error);
    expect(startupRetainsNativeLease(failure)).toBe(false);
    expect(d.held).toBe(0); expect(d.live).toBe(0);
    expect(errorGraphContains(failure,
      kind === "current" ? "contract-current-expired" : "contract-ID-drift")).toBe(true);
    const rawCloses = rawClose.mock.calls.length;
    const platformCloses = d.events.filter(event => event === "platform-close").length;
    const scopes = d.scopeCalls, currents = d.currentCalls;
    // A confirmed-closed close resolves without entering the disposed native
    // scope, re-proving current, or replaying raw/native cleanup.
    await server.close();
    expect(rawClose.mock.calls.length).toBe(rawCloses);
    expect(d.events.filter(event => event === "platform-close")).toHaveLength(platformCloses);
    expect(d.scopeCalls).toBe(scopes);
    expect(d.currentCalls).toBe(currents);
    expect(d.held).toBe(0); expect(d.live).toBe(0);
  });

  it("does not replace a conflicting final blob or a foreign database", async () => {
    const d = driver(), server = await d.start(), secret = token();
    server.registerDevice({ workspaceId: "workspace", ownerId: "owner", clientId: "client", token: secret });
    const bytes = Buffer.from("requested blob"), digest = sha(bytes);
    const blobDir = join(d.directory, "blobs", sha("workspace"));
    mkdirSync(blobDir);
    const final = join(blobDir, digest);
    writeFileSync(final, "foreign original");
    const response = await fetch(url(server, `blobs/${digest}`), { method: "PUT",
      headers: { ...auth(secret), "Content-Type": "application/octet-stream" }, body: bytes });
    expect(response.status).toBe(409);
    expect(readFileSync(final, "utf8")).toBe("foreign original");
    await stop(server);
    const foreign = new DatabaseSync(d.databasePath);
    foreign.exec("CREATE TABLE foreign_evidence(value TEXT)");
    foreign.close();
    const original = readFileSync(d.databasePath);
    await expect(d.start()).rejects.toThrow();
    expect(readFileSync(d.databasePath)).toEqual(original);
  });

  it("refuses a missing native capability before writable database initialization", async () => {
    const d = driver();
    await expect(startCheckpointServer({ databasePath: d.databasePath, capabilities: [],
      workspaces: [{ workspaceId: "workspace", ownerId: "owner" }],
      validateCheckpoint: () => true, nativePrivateFilesystem: d.fs })).rejects.toThrow("server-native-capability-required");
    expect(lstatSync(d.databasePath).size).toBe(0);
    delete (d.transfer as { nativeTransferIo?: NativeTransferIoPort }).nativeTransferIo;
    await expect(d.start()).rejects.toThrow("native-transfer-append-required");
    expect(lstatSync(d.databasePath).size).toBe(0);
    expect(d.held).toBe(0);
  });

  it("keeps help and unconfigured non-Windows imports side-effect safe", async () => {
    expect(createWindowsServerNativeFromEnvironment({})).toBeUndefined();
    const lines: string[] = [];
    expect(await runServerOpsCli(["--help"], { write: line => lines.push(line), error: line => lines.push(line) })).toBe(0);
    expect(lines).toHaveLength(1);
    expect(() => createWindowsServerNativeFromEnvironment({ FOLIO_WINDOWS_NATIVE_ROOT: "D:\\root" })).toThrow();
  });
  it("retries an unconfirmed owned platform cleanup without false host release", async () => {
    const d = driver(), server = await d.start();
    const rawClose = vi.spyOn(DatabaseSync.prototype, "close");
    d.failPlatformCloseOnce();
    const first = await server.close().then(() => undefined, (error: unknown) => error);
    // An actual native cleanup failure stays classified as retained
    // ownership until an explicit retry proves the platform closed.
    expect(first).toBeInstanceOf(Error);
    expect(String(first)).toContain("owned platform close fault");
    expect(startupRetainsNativeLease(first)).toBe(true);
    expect(d.held).toBeGreaterThan(0); expect(d.live).toBe(1);
    const rawCloses = rawClose.mock.calls.length;
    await server.close();
    expect(d.held).toBe(0); expect(d.live).toBe(0);
    // The platform close completes exactly once and the proven-closed raw
    // connection is never re-closed.
    expect(d.events.filter(event => event === "platform-close")).toHaveLength(1);
    expect(rawClose.mock.calls.length).toBe(rawCloses);
    const scopes = d.scopeCalls, currents = d.currentCalls;
    await server.close();
    expect(d.scopeCalls).toBe(scopes);
    expect(d.currentCalls).toBe(currents);
    expect(d.events.filter(event => event === "platform-close")).toHaveLength(1);
    expect(rawClose.mock.calls.length).toBe(rawCloses);
    expect(d.live).toBe(0);
  });

});
