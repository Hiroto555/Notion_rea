/**
 * CHECKPOINT OWNER PROOF/CLEANUP CONTRACT — NOT Windows OS acceptance.
 *
 * Authored for parent execution only. Real Node HTTP, real disposable SQLite,
 * and the real startCheckpointServer entry through the real
 * createWindowsServerLifecycleHost (never a direct common-owner substitute).
 * Every production module is loaded through vi.resetModules + dynamic import
 * so the SqliteConnectionOwner retention brand and the
 * startupRetainsNativeLease predicate always share one module generation.
 * Synthetic file IDs and POSIX byte IO simulate the untrusted native
 * contracts only; they prove no NTFS/DACL/share-mode/durability behavior and
 * no product native/Worker/helper is invoked on these paths.
 */
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NativePrivateFile, NativePrivateFilesystemPort, NativePrivateIdentity,
} from "../src/platform/private-persistence";
import type { NativeTransferOptions } from "../src/platform/windows/private-transfer";
import type { WindowsServerNativePort } from "../src/platform/windows/server-native";
import type { PrivatePlatform } from "../src/sync/private-platform";
import type { CheckpointServerHandle } from "../src/sync/checkpoint-server";

const roots: string[] = [];
const servers = new Set<CheckpointServerHandle>();
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const VOLUME_ID = "1234567890abcdef";
const MASTER_SQL = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";

/** Bounded own-property traversal of error `errors`/`cause` graphs. */
function containsCause(root: unknown, predicate: (value: unknown) => boolean): boolean {
  const queue: unknown[] = [root], seen = new Set<object>();
  while (queue.length && seen.size <= 256) {
    const value = queue.pop();
    if (predicate(value)) return true;
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    const errors = Object.getOwnPropertyDescriptor(value, "errors")?.value;
    if (Array.isArray(errors)) queue.push(...errors);
    const cause = Object.getOwnPropertyDescriptor(value, "cause");
    if (cause && "value" in cause) queue.push(cause.value);
  }
  return false;
}

/** One isolated module generation: host, owner predicate and the scoped
 * persistence/journal helpers must all come from the same import graph or
 * the retention brand would never match the predicate's WeakSet. */
async function generation() {
  vi.resetModules();
  const host = await import("../src/platform/windows/server-native-host");
  const owner = await import("../src/persistence/startup-connection-owner");
  const persistence = await import("../src/platform/private-persistence");
  const journals = await import("../src/platform/product-private-journals");
  return {
    createWindowsServerLifecycleHost: host.createWindowsServerLifecycleHost,
    startupRetainsNativeLease: owner.startupRetainsNativeLease,
    withPrivatePersistence: persistence.withPrivatePersistence,
    withProductPrivateJournals: journals.withProductPrivateJournals,
  };
}
type Generation = Awaited<ReturnType<typeof generation>>;

function makeFixture(gen: Generation) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-proof-cleanup-")));
  roots.push(root);
  const directory = join(root, "server");
  mkdirSync(directory);
  const databasePath = join(directory, "server.sqlite");
  writeFileSync(databasePath, "");
  const sentinel = new Error("fixture-current-expired");
  const platformSentinel = new Error("fixture-platform-close-failed");
  const notificationSentinel = new Error("fixture-closed-notification-failed");
  const rawCloseSentinel = new Error("fixture-raw-close-failed");
  const ids = new Map<string, string>();
  const events: string[] = [];
  let serial = 0;
  const state = {
    current: true, held: 0, live: 0, disposed: false,
    scopeCalls: 0, requestAssertCalls: 0, requestTripAt: -1,
    platformCloseCalls: 0, platformFaults: 0,
    closedNotifications: 0, notificationFails: false,
    tripOnMaster: false, mainDb: undefined as DatabaseSync | undefined,
  };
  const identity = (path: string): NativePrivateIdentity => {
    lstatSync(path);
    if (!ids.has(path)) ids.set(path, (++serial).toString(16).padStart(32, "0"));
    return { path, fileId: ids.get(path)!, volumeId: VOLUME_ID };
  };
  const file = (path: string, max = 256 * 1024 * 1024): NativePrivateFile => {
    const bytes = readFileSync(path);
    if (bytes.length > max) throw new Error("fixture size limit");
    return { ...identity(path), bytes: bytes.length, sha256: sha(bytes) };
  };
  const same = (a: NativePrivateIdentity, b: NativePrivateIdentity) =>
    a.path === b.path && a.fileId === b.fileId && a.volumeId === b.volumeId;
  /** Every capability this contract never exercises must throw rather than
   * reach any product native/Worker/helper seam. */
  const absent = (name: string) => (): never => {
    throw new Error(`fixture capability not exercised: ${name}`);
  };
  const fs: NativePrivateFilesystemPort = {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory(path) {
      if (!lstatSync(path).isDirectory()) throw new Error("directory required");
      return identity(path);
    },
    inspectFile: (path, max) => file(path, max),
    inspectFileIdentity: path => identity(path),
    read: absent("fs.read"),
    writeNew: absent("fs.writeNew"),
    copyNew: absent("fs.copyNew"),
    renameNew: absent("fs.renameNew"),
    unlinkExact: absent("fs.unlinkExact"),
    proveSync: absent("fs.proveSync"),
    createDirectory(path) { mkdirSync(path); return identity(path); },
    snapshotSqlite: absent("fs.snapshotSqlite"),
  };
  const platform = (): PrivatePlatform => {
    let path = "", pin: NativePrivateIdentity | undefined, leased = false, closed = false;
    const open = () => { if (closed) throw new Error("closed platform"); };
    return {
      kind: "windows",
      bind(value) { open(); path = value; pin = identity(path); return path; },
      assertRoot() { open(); if (!pin || !same(pin, identity(path))) throw new Error("directory drift"); },
      assertFile(value) { open(); identity(value); },
      assertSidecars(value) {
        open();
        for (const suffix of ["-wal", "-shm", "-journal"])
          if (existsSync(value + suffix)) identity(value + suffix);
      },
      createExclusive(value) {
        open();
        if (!existsSync(value)) throw new Error("fixture createExclusive source absent");
        if (!leased) { state.held++; leased = true; events.push("lease-before-sqlite"); }
      },
      assertEmptyFile(value) { open(); expect(lstatSync(value).size).toBe(0); },
      close() {
        if (closed) return;
        state.platformCloseCalls++;
        if (state.platformFaults > 0) { state.platformFaults--; throw platformSentinel; }
        if (leased) state.held--;
        events.push("platform-close"); closed = true;
      },
    };
  };
  const scope = <T>(work: () => T): T => {
    state.scopeCalls++;
    if (state.disposed) throw new Error("fixture native scope disposed");
    return gen.withPrivatePersistence({ nativePrivateFilesystem: fs }, () =>
      gen.withProductPrivateJournals({ privatePlatformFactory: platform }, work));
  };
  // The checkpoint's initial lifetime validateCurrent reaches the second
  // request.assertCurrent call (the first is the host request precheck);
  // requestTripAt lets a case expire exactly there, before any SQLite open.
  const requestAssert = () => {
    state.requestAssertCalls++;
    if (state.requestTripAt === state.requestAssertCalls) state.current = false;
    if (!state.current) throw sentinel;
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
    assertCurrent() { if (!state.current) throw sentinel; },
    assertSourceIdentity(id) { if (!same(id, identity(id.path))) throw new Error("source identity"); },
    poison(error): never { state.current = false; throw error; },
    retainUnknown(_resource, error): never { state.current = false; throw error; },
    inspectDirectory: path => fs.inspectDirectory(path),
    assertDirectory(path, pin) {
      if (!same(fs.inspectDirectory(path), pin)) throw new Error("contract-ID-drift");
    },
    createDirectory: path => fs.createDirectory(path),
    inspectFile: (path, max) => fs.inspectFile(path, max),
    inspectFileIdentity: path => fs.inspectFileIdentity(path),
    assertFileIdentity(path, pin) {
      if (!same(fs.inspectFileIdentity(path), pin)) throw new Error("contract-ID-drift");
    },
    readFile: absent("native.readFile"),
    writeNewFile: absent("native.writeNewFile"),
    copyNewFile: absent("native.copyNewFile"),
    proveSyncFile: absent("native.proveSyncFile"),
    unlinkExact: absent("native.unlinkExact"),
    snapshotSqlite: absent("native.snapshotSqlite"),
    kindOf(path) {
      if (!existsSync(path)) return "absent";
      return lstatSync(path).isDirectory() ? "directory" : "file";
    },
    listNames: absent("native.listNames"),
    assertCapacity() {},
    authorityPlatform: platform,
    acquireSqliteLease: absent("native.acquireSqliteLease"),
  };
  const transfer: NativeTransferOptions = {
    nativePrivateFilesystem: fs,
    nativeTransferIo: {
      platform: "win32", version: 1, synchronous: true, append: absent("transfer.append"),
    },
  };
  const host = gen.createWindowsServerLifecycleHost({
    native: () => native, filesystem: fs, transfer: () => transfer,
    sqlitePlatform: platform, scope,
    opened() { state.live++; },
    closed() {
      state.closedNotifications++;
      if (state.notificationFails) throw notificationSentinel;
      state.live--;
      state.disposed = true;
    },
  });
  const start = async () => {
    // A fresh start re-arms the fixture scope after a prior disposal.
    state.disposed = false;
    const server = await host.start({
      directory, databasePath, port: 0,
      workspaces: [{ workspaceId: "workspace", ownerId: "owner" }],
      assertCurrent: requestAssert,
    });
    servers.add(server);
    return server;
  };
  return {
    root, directory, databasePath, events, state,
    sentinel, platformSentinel, notificationSentinel, rawCloseSentinel,
    start, expire() { state.current = false; },
  };
}
type Fixture = ReturnType<typeof makeFixture>;

/** Raw DatabaseSync spies. `prepare` records the main writable handle when
 * the server's sqlite_master inventory runs and can expire that fixture's
 * current authorization while delegating normally; `close` records every
 * raw close target and can inject a pre-close fault once. */
let armed: Fixture | undefined;
const capturedDbs = new Set<DatabaseSync>();
function installSpies() {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalClose = DatabaseSync.prototype.close;
  const control = {
    closes: [] as DatabaseSync[],
    rawFaults: 0,
    rawFaultDb: undefined as DatabaseSync | undefined,
    rawFaultSentinel: undefined as unknown,
  };
  vi.spyOn(DatabaseSync.prototype, "prepare")
    .mockImplementation(function (this: DatabaseSync, sql: string): StatementSync {
      const statement = Reflect.apply(originalPrepare, this, [sql]) as StatementSync;
      if (sql === MASTER_SQL && armed && armed.state.mainDb === undefined) {
        armed.state.mainDb = this;
        capturedDbs.add(this);
        if (armed.state.tripOnMaster) {
          armed.state.tripOnMaster = false;
          armed.expire();
        }
      }
      return statement;
    });
  vi.spyOn(DatabaseSync.prototype, "close")
    .mockImplementation(function (this: DatabaseSync): void {
      control.closes.push(this);
      if (control.rawFaults > 0 && this === control.rawFaultDb) {
        control.rawFaults--;
        throw control.rawFaultSentinel;
      }
      return Reflect.apply(originalClose, this, []);
    });
  return control;
}

async function startArmed(fixture: Fixture): Promise<CheckpointServerHandle> {
  armed = fixture;
  try { return await fixture.start(); } finally { armed = undefined; }
}
const closesFor = (spies: ReturnType<typeof installSpies>, db: DatabaseSync | undefined) =>
  spies.closes.filter(value => value === db).length;

afterEach(async () => {
  armed = undefined;
  for (const server of [...servers]) {
    try { await server.close(); } catch { /* retained-control cases keep their asserted close error */ }
    servers.delete(server);
  }
  // Disposable fixture DBs are closed directly only after every assertion.
  for (const db of capturedDbs) {
    try { if (db.isOpen) db.close(); } catch { /* best effort */ }
    capturedDbs.delete(db);
  }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("checkpoint owner proof/cleanup contract (NOT OS acceptance)", () => {

  it("releases a fully cleaned owner after a proof-only startup failure, past the 64 reservation cap", async () => {
    const gen = await generation();
    const spies = installSpies();
    for (let index = 0; index < 66; index++) {
      const fixture = makeFixture(gen);
      fixture.state.tripOnMaster = true;
      const failure = await startArmed(fixture).then(() => undefined, (error: unknown) => error);
      expect(failure, `failed start ${index}`).toBeInstanceOf(Error);
      // The post-DB release proof rethrows the sentinel diagnostic, but the
      // raw close, native platform close and host ack all completed — the
      // owner must release its reservation instead of counting the cap.
      expect(gen.startupRetainsNativeLease(failure), `retained ${index}`).toBe(false);
      expect(containsCause(failure, value => value === fixture.sentinel)).toBe(true);
      expect(fixture.state.mainDb, `captured db ${index}`).toBeInstanceOf(DatabaseSync);
      expect(fixture.state.mainDb!.isOpen).toBe(false);
      expect(closesFor(spies, fixture.state.mainDb)).toBe(1);
      expect(fixture.state.platformCloseCalls).toBe(1);
      expect(fixture.state.closedNotifications).toBe(1);
      expect(fixture.state.held).toBe(0);
      expect(fixture.state.live).toBe(0);
    }
    // No reservation was retained, so a healthy positive start still works.
    const healthy = makeFixture(gen);
    const server = await startArmed(healthy);
    await server.close();
    expect(healthy.state.held).toBe(0);
    expect(healthy.state.live).toBe(0);
    expect(healthy.state.platformCloseCalls).toBe(1);
    expect(healthy.state.closedNotifications).toBe(1);
    const scopes = healthy.state.scopeCalls;
    await server.close();
    expect(healthy.state.scopeCalls).toBe(scopes);
  });

  it("keeps the original and proof diagnostics but not ownership when initial current validation fails before any SQLite open", async () => {
    const gen = await generation();
    const spies = installSpies();
    const fixture = makeFixture(gen);
    // Fail the checkpoint's initial native validateCurrent — the second
    // request.assertCurrent call — after the host request precheck.
    fixture.state.requestTripAt = 2;
    const failure = await startArmed(fixture).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(gen.startupRetainsNativeLease(failure)).toBe(false);
    // Both the primary failure and the release-proof diagnostic remain in
    // the cause graph even though no reservation stays behind.
    expect(containsCause(failure, value => value === fixture.sentinel)).toBe(true);
    expect(fixture.state.requestAssertCalls).toBeGreaterThanOrEqual(3);
    expect(fixture.state.mainDb).toBeUndefined();
    expect(spies.closes).toHaveLength(0);
    expect(fixture.state.platformCloseCalls).toBe(1);
    expect(fixture.state.closedNotifications).toBe(1);
    expect(fixture.state.held).toBe(0);
    expect(fixture.state.live).toBe(0);
  });

  it("retains ownership when the raw DatabaseSync close throws before closing", async () => {
    const gen = await generation();
    const spies = installSpies();
    const fixture = makeFixture(gen);
    const server = await startArmed(fixture);
    const main = fixture.state.mainDb!;
    expect(main).toBeInstanceOf(DatabaseSync);
    spies.rawFaults = 1;
    spies.rawFaultDb = main;
    spies.rawFaultSentinel = fixture.rawCloseSentinel;
    const first = await server.close().then(() => undefined, (error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect(gen.startupRetainsNativeLease(first)).toBe(true);
    expect(containsCause(first, value => value === fixture.rawCloseSentinel)).toBe(true);
    // The raw close threw before closing: the handle is still open and no
    // native platform close or host notification may run.
    expect(main.isOpen).toBe(true);
    expect(fixture.state.platformCloseCalls).toBe(0);
    expect(fixture.state.closedNotifications).toBe(0);
    expect(fixture.state.live).toBe(1);
    // The explicit retry closes the raw handle, then native, exactly once.
    await server.close();
    expect(main.isOpen).toBe(false);
    expect(closesFor(spies, main)).toBe(2);
    expect(fixture.state.platformCloseCalls).toBe(1);
    expect(fixture.state.closedNotifications).toBe(1);
    expect(fixture.state.held).toBe(0);
    expect(fixture.state.live).toBe(0);
  });

  it("retains ownership on actual native platform close failure without replaying the raw close", async () => {
    const gen = await generation();
    const spies = installSpies();
    const fixture = makeFixture(gen);
    const server = await startArmed(fixture);
    const main = fixture.state.mainDb!;
    fixture.state.platformFaults = 1;
    const first = await server.close().then(() => undefined, (error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect(gen.startupRetainsNativeLease(first)).toBe(true);
    expect(containsCause(first, value => value === fixture.platformSentinel)).toBe(true);
    expect(main.isOpen).toBe(false);
    expect(fixture.state.platformCloseCalls).toBe(1);
    expect(fixture.state.closedNotifications).toBe(0);
    expect(fixture.state.live).toBe(1);
    // The retry finishes native cleanup and the host ack once; the proven
    // raw connection is never re-closed.
    await server.close();
    expect(closesFor(spies, main)).toBe(1);
    expect(fixture.state.platformCloseCalls).toBe(2);
    expect(fixture.state.closedNotifications).toBe(1);
    expect(fixture.state.held).toBe(0);
    expect(fixture.state.live).toBe(0);
    const scopes = fixture.state.scopeCalls;
    await server.close();
    expect(fixture.state.scopeCalls).toBe(scopes);
    expect(closesFor(spies, main)).toBe(1);
    expect(fixture.state.platformCloseCalls).toBe(2);
  });

  it("keeps a completed-but-unacknowledged close retained without replaying notification, native or raw cleanup", async () => {
    // A retained owner stays reserved for its module generation; this case
    // gets its own generation so the cap is not consumed for other cases.
    const gen = await generation();
    const spies = installSpies();
    const fixture = makeFixture(gen);
    fixture.state.notificationFails = true;
    const server = await startArmed(fixture);
    const main = fixture.state.mainDb!;
    const first = await server.close().then(() => undefined, (error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect(gen.startupRetainsNativeLease(first)).toBe(true);
    expect(containsCause(first, value => value === fixture.notificationSentinel)).toBe(true);
    // DB and native platform are proven closed; only the closed notification
    // failed, so the reservation stays retained.
    expect(main.isOpen).toBe(false);
    expect(fixture.state.platformCloseCalls).toBe(1);
    expect(fixture.state.closedNotifications).toBe(1);
    expect(fixture.state.live).toBe(1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = await server.close().then(() => undefined, (error: unknown) => error);
      expect(again).toBeInstanceOf(Error);
      expect(gen.startupRetainsNativeLease(again)).toBe(true);
    }
    // The pinned notification failure is rethrown, never replayed, and no
    // native or raw cleanup repeats.
    expect(fixture.state.closedNotifications).toBe(1);
    expect(fixture.state.platformCloseCalls).toBe(1);
    expect(closesFor(spies, main)).toBe(1);
    servers.delete(server);
  });

  it("surfaces proof and native cleanup causes together, retains once, and finishes on explicit retry", async () => {
    const gen = await generation();
    const spies = installSpies();
    const fixture = makeFixture(gen);
    const server = await startArmed(fixture);
    const main = fixture.state.mainDb!;
    fixture.expire();
    fixture.state.platformFaults = 1;
    const first = await server.close().then(() => undefined, (error: unknown) => error);
    // The expired current proof and the actual platform close fault are
    // both retained in the thrown cause graph, and the owner is retained
    // because the native cleanup really is unconfirmed.
    expect(first).toBeInstanceOf(Error);
    expect(gen.startupRetainsNativeLease(first)).toBe(true);
    expect(containsCause(first, value => value === fixture.sentinel)).toBe(true);
    expect(containsCause(first, value => value === fixture.platformSentinel)).toBe(true);
    expect(main.isOpen).toBe(false);
    expect(fixture.state.platformCloseCalls).toBe(1);
    expect(fixture.state.closedNotifications).toBe(0);
    expect(closesFor(spies, main)).toBe(1);
    // The explicit retry completes the real cleanup once — the remaining
    // throw is proof-only diagnostics, not retained ownership.
    const second = await server.close().then(() => undefined, (error: unknown) => error);
    expect(second).toBeInstanceOf(Error);
    expect(gen.startupRetainsNativeLease(second)).toBe(false);
    expect(containsCause(second, value => value === fixture.sentinel)).toBe(true);
    expect(closesFor(spies, main)).toBe(1);
    expect(fixture.state.platformCloseCalls).toBe(2);
    expect(fixture.state.closedNotifications).toBe(1);
    expect(fixture.state.held).toBe(0);
    expect(fixture.state.live).toBe(0);
    // Confirmed closed: no disposed-scope re-entry and no replay.
    const scopes = fixture.state.scopeCalls;
    await server.close();
    expect(fixture.state.scopeCalls).toBe(scopes);
    expect(closesFor(spies, main)).toBe(1);
    expect(fixture.state.platformCloseCalls).toBe(2);
  });

});
