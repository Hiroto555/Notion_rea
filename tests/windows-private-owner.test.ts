import { chmodSync, closeSync, fsyncSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosixPrivatePlatform } from "../src/sync/private-platform";
import { acquireWindowsPrivateOwnerForTesting, WINDOWS_PRIVATE_OWNER_DATABASE,
  type WindowsPrivateOwner } from "../src/platform/windows/private-owner";

// Native contract driver only: real temporary files and two independent
// Node/SQLite handles, with explicitly synthetic native lease/ID checks.
// These cases are NOT Windows/NTFS acceptance.
const directories: string[] = [], owners: WindowsPrivateOwner[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) owner.close();
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "folio-owner-contract-")));
  chmodSync(directory, 0o700); directories.push(directory);
  const path = join(directory, WINDOWS_PRIVATE_OWNER_DATABASE);
  const fd = openSync(path, "wx", 0o600); fsyncSync(fd); closeSync(fd);
  let nativeCurrent = true, leaseCloses = 0;
  const events: string[] = [];
  const make = (newlyCreated: boolean, binding = "native-contract-driver:root/volume/directory/file") => {
    const platform = new PosixPrivatePlatform(); platform.bind(directory); platform.assertFile(path);
    return acquireWindowsPrivateOwnerForTesting({path, binding, newlyCreated, platform,
      assertCurrent() { if (!nativeCurrent) throw new Error("native ID changed"); },
      acquire() { return {trust: "untrusted-test", assertHeld() {
        if (!nativeCurrent) throw new Error("raw native lease lost");
      }, close() { leaseCloses++; events.push("lease-close"); }}; },
      close() { platform.close(); events.push("driver-close"); },
    });
  };
  const acquire = (created: boolean, binding?: string) => {
    const owner = make(created, binding); owners.push(owner); return owner;
  };
  return {path, acquire, events, stale() {nativeCurrent = false;}, leaseCloses: () => leaseCloses};
}
const flattenedCauses = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors.flatMap(flattenedCauses) : [error];
describe.skipIf(process.platform === "win32")("private owner — Node SQLite/native contract driver (not Windows acceptance)", () => {
  it("blocks a separate SQLite handle and a second owner for the entire lifetime, then preserves writer identity across restart", () => {
    const f = fixture(), first = f.acquire(true);
    first.assertCurrent();
    const other = new DatabaseSync(f.path);
    other.exec("PRAGMA busy_timeout=0");
    expect(() => other.exec("BEGIN EXCLUSIVE")).toThrow();
    other.close();
    expect(() => f.acquire(false)).toThrow();
    first.assertCurrent();
    first.close();
    const second = f.acquire(false);
    expect(second.writerId).toBe(first.writerId);
    expect(second.sessionId).not.toBe(first.sessionId);
    second.assertCurrent();
  });
  it("rejects an ordinary restart with an uninitialized owner or a different persisted native binding", () => {
    const f = fixture();
    expect(() => f.acquire(false)).toThrow(/EMPTY_EXISTING_UNKNOWN/);
    const owner = f.acquire(true); owner.close();
    expect(() => f.acquire(false, "different-directory-native-id")).toThrow(/BINDING/);
    f.acquire(false).assertCurrent();
  });
  it("poisons ownership after native identity changes instead of adopting a new file ID", () => {
    const f = fixture(), owner = f.acquire(true);
    f.stale();
    expect(() => owner.assertCurrent()).toThrow(/native ID changed|raw native lease lost/);
    expect(() => owner.assertCurrent()).toThrow();
  });
  it("keeps the raw native lease on uncertain SQLite close and preserves the close cause", () => {
    const f = fixture(), owner = f.acquire(true), count = f.leaseCloses();
    const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => { throw new Error("close-cut"); });
    expect(() => owner.close()).toThrow(/CLOSE_UNKNOWN/);
    expect(f.leaseCloses()).toBe(count);
    close.mockRestore();
    const other = new DatabaseSync(f.path); other.exec("PRAGMA busy_timeout=0");
    expect(() => other.exec("BEGIN EXCLUSIVE")).toThrow();
    other.close();
    owner.close();
    expect(f.leaseCloses()).toBe(count + 1);
  });
  it("checks that SQLite really remains in the exclusive transaction", () => {
    const f = fixture();
    let connection: DatabaseSync | undefined;
    const original = DatabaseSync.prototype.exec;
    const capture = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      connection = this;
      return original.call(this, sql);
    });
    const owner = f.acquire(true);
    capture.mockRestore();
    expect(connection!.isTransaction).toBe(true);
    connection!.exec("ROLLBACK");
    expect(connection!.isTransaction).toBe(false);
    expect(() => owner.assertCurrent()).toThrow(/NOT_HELD/);
    owner.close();
  });
  it("releases lease+driver in order when a preflight close throws after actual close", () => {
    const f = fixture();
    const first = f.acquire(true); first.close();
    const count = f.leaseCloses();
    // Discard seed-open events so the ordering assertions see only this open.
    f.events.length = 0;
    const sentinel = new Error("post-close report");
    const original = DatabaseSync.prototype.close;
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close")
      .mockImplementationOnce(function (this: DatabaseSync) {
        original.call(this);
        f.events.push("db-close");
        throw sentinel;
      });
    let failure: unknown;
    try { f.acquire(false); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(flattenedCauses(failure)).toContain(sentinel);
    expect(closeSpy).toHaveBeenCalledOnce();
    // The reader provably closed before throwing: ordered lease->driver
    // release is legal even though acquire itself failed.
    expect(f.leaseCloses()).toBe(count + 1);
    expect(f.events.indexOf("db-close")).toBeLessThan(f.events.indexOf("lease-close"));
    expect(f.events.indexOf("lease-close")).toBeLessThan(f.events.indexOf("driver-close"));
  });
  it("keeps the lease held when a preflight close fails before the main assignment", () => {
    const f = fixture();
    const first = f.acquire(true); first.close();
    const count = f.leaseCloses();
    let retained: DatabaseSync | undefined;
    const original = DatabaseSync.prototype.close;
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close")
      .mockImplementationOnce(function (this: DatabaseSync) {
        retained = this;
        throw new Error("preflight close failed");
      });
    expect(() => f.acquire(false)).toThrow();
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(f.leaseCloses()).toBe(count);
    vi.restoreAllMocks();
    if (retained !== undefined) original.call(retained);
  });
  it("never retries the constructor's attempted close and never releases the lease", () => {
    const f = fixture();
    const count = f.leaseCloses();
    let retained: DatabaseSync | undefined;
    const original = DatabaseSync.prototype.close;
    let attempts = 0;
    // The first schema exec fault plus a failing raw close: the owned cleanup
    // may attempt one close — the lease stays held either way.
    vi.spyOn(DatabaseSync.prototype, "exec")
      .mockImplementationOnce(() => { throw new Error("schema exec failed"); });
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close")
      .mockImplementation(function (this: DatabaseSync) {
        attempts++;
        retained = this;
        throw new Error("close-cut");
      });
    expect(() => f.acquire(true)).toThrow();
    expect(attempts).toBe(1);
    expect(f.leaseCloses()).toBe(count);
    vi.restoreAllMocks();
    if (retained !== undefined) original.call(retained);
  });
  // The "post-close getter failure → retry proves closed without a second raw
  // close" case is covered on a real DatabaseSync via a per-instance proof
  // Proxy in tests/private-journal-close-ownership.test.ts ("settles a
  // proven-closed handle on retry without a second raw close"). DatabaseSync
  // instances expose own nonconfigurable isOpen/isTransaction accessors; no
  // prototype getter exists to spy on.
  it("fails a silent close that returns while the handle stays open", () => {
    const f = fixture();
    const owner = f.acquire(true);
    const count = f.leaseCloses();
    const spy = vi.spyOn(DatabaseSync.prototype, "close")
      .mockImplementationOnce(() => {});
    expect(() => owner.close()).toThrow(/CLOSE_UNKNOWN/);
    expect(f.leaseCloses()).toBe(count);
    spy.mockRestore();
    owner.close();
    expect(f.leaseCloses()).toBe(count + 1);
  });
  it("preserves original causes inside the CLOSE_UNKNOWN aggregate", () => {
    const f = fixture();
    const owner = f.acquire(true);
    const dbError = new Error("db-close-unknown");
    const spy = vi.spyOn(DatabaseSync.prototype, "close")
      .mockImplementationOnce(() => { throw dbError; });
    let failure: unknown;
    try { owner.close(); } catch (error) { failure = error; }
    const flattened = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(flattened) : [error];
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain("CLOSE_UNKNOWN");
    expect(flattened(failure)).toContain(dbError);
    spy.mockRestore();
    owner.close();
  });
});
