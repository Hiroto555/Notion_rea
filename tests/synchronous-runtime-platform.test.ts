import { afterEach, expect, it, vi } from "vitest";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore, SHARED_RUNTIME_FILE } from "../src/collaboration/runtime/store";
import type { RuntimeStorePlatform } from "../src/platform/runtime-store-platform";
import { synchronousPort } from "../src/platform/synchronous-port";

// Actual Mac/Node SQLite with explicitly simulated Windows selection. Native OS NOT_RUN.
const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", descriptor); for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-runtime-proof-"))); roots.push(root);
  Object.defineProperty(process, "platform", {...descriptor, value: "win32"});
  let fail = false;
  const fresh = (): RuntimeStorePlatform => ({
    bind: vi.fn(path => path),
    assertRoot: vi.fn(() => { if (fail) throw new Error("native identity changed"); }),
    assertDatabase: vi.fn(path => { if (!lstatSync(path).isFile()) throw new Error("unsafe database"); }),
    createExclusiveDurably: vi.fn(path => { if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600)); }),
    assertEmptyFile: vi.fn(path => { if (lstatSync(path).size !== 0) throw new Error("nonempty database"); }),
    syncCreatedDatabase: vi.fn(), close: vi.fn(),
  });
  return {root, fresh, fail: () => {fail = true;}, reset: () => {fail = false;}};
}

it("requires native exclusive-create capability instead of a POSIX create fallback", () => {
  const f = fixture(), platform = f.fresh(); delete platform.createExclusiveDurably;
  expect(() => new RuntimeStore(f.root, {platformAdapter: platform})).toThrow("WINDOWS_NATIVE_CREATE_REQUIRED");
  expect(existsSync(join(f.root, SHARED_RUNTIME_FILE))).toBe(false);
  expect(platform.close).toHaveBeenCalledOnce();
});

it("rejects known asynchronous native proof before bind or database creation", () => {
  const f = fixture(), platform = f.fresh(); platform.assertRoot = async () => undefined;
  expect(() => new RuntimeStore(f.root, {platformAdapter: platform})).toThrow("SYNCHRONOUS_PORT_UNSUPPORTED");
  expect(platform.bind).not.toHaveBeenCalled(); expect(existsSync(join(f.root, SHARED_RUNTIME_FILE))).toBe(false);
});

it("performs native creation and empty-file proof before opening a new SQLite store", () => {
  const f = fixture(), platform = f.fresh(), store = new RuntimeStore(f.root, {platformAdapter: platform});
  try {
    expect(platform.createExclusiveDurably).toHaveBeenCalledOnce(); expect(platform.assertEmptyFile).toHaveBeenCalledOnce();
    store.transaction(() => store.set("evidence", "raw", "unchanged bytes"));
    expect(store.get("evidence", "raw")).toBe("unchanged bytes");
  } finally {store.close();}
});

it("retains the commit but stops the owner when native proof fails after COMMIT", () => {
  const f = fixture(), store = new RuntimeStore(f.root, {platformAdapter: f.fresh()});
  const original = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    original.call(this, sql); if (sql === "COMMIT") f.fail();
  });
  expect(() => store.transaction(() => store.set("evidence", "raw", {text: "retained"}))).toThrow("UNKNOWN: native proof after COMMIT");
  expect(() => store.get("evidence", "raw")).toThrow("UNKNOWN"); store.close(); spy.mockRestore(); f.reset();
  const reopened = new RuntimeStore(f.root, {platformAdapter: f.fresh()});
  try {expect(reopened.get("evidence", "raw")).toEqual({text: "retained"});} finally {reopened.close();}
});

it("retains both close failures and retries only unresolved cleanup", () => {
  const f = fixture(), platform = f.fresh(), store = new RuntimeStore(f.root, {platformAdapter: platform});
  const dbError = new Error("database remains open"), nativeError = new Error("native cleanup incomplete");
  const close = vi.spyOn(store.db, "close").mockImplementationOnce(() => {throw dbError;});
  vi.mocked(platform.close).mockImplementationOnce(() => {throw nativeError;});
  expect(() => store.close()).toThrow(dbError);
  expect(platform.close).not.toHaveBeenCalled();
  expect(() => store.get("meta", "head")).toThrow("CLOSING");
  expect(() => store.close()).toThrow(nativeError);
  store.close(); store.close(); expect(close).toHaveBeenCalledTimes(2); expect(platform.close).toHaveBeenCalledTimes(2);
});

it("does not turn an asynchronous cleanup outcome into success on a later call", () => {
  const close = vi.fn(() => Promise.resolve());
  const port = synchronousPort({close}, {close: {result: "void", cleanup: true}});
  expect(() => port.close()).toThrow("UNKNOWN"); expect(() => port.close()).toThrow("UNKNOWN"); expect(close).toHaveBeenCalledOnce();
});
