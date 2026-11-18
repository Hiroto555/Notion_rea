import { copyFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { RuntimeStore, SHARED_RUNTIME_FILE } from "../src/collaboration/runtime/store";
import type { RuntimeStorePlatform } from "../src/platform/runtime-store-platform";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function directory() { const p = realpathSync(mkdtempSync(join(tmpdir(), "folio-runtime-hot-"))); chmodSync(p, 0o700); roots.push(p); return p; }
function fixture() {
  const source = directory(), authority = new SharedAuthority(source);
  authority.bootstrap({orgId: "org", userId: "owner", deviceId: "device", workspaceId: "workspace", documentId: "document", document: {type: "doc", content: [{type: "paragraph", attrs: {id: "paragraph"}}]}});
  authority.close();
  const staging = join(directory(), SHARED_RUNTIME_FILE), target = directory(), main = join(target, SHARED_RUNTIME_FILE);
  copyFileSync(join(source, SHARED_RUNTIME_FILE), staging);
  const writer = new DatabaseSync(staging);
  try {
    writer.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE");
    writer.exec("UPDATE runtime_records SET raw='\"client\"' WHERE namespace='meta' AND key='role'; CREATE TABLE _spill(value BLOB); INSERT INTO _spill VALUES(zeroblob(131072))");
    copyFileSync(staging, main); copyFileSync(staging + "-journal", main + "-journal");
    chmodSync(main, 0o600); chmodSync(main + "-journal", 0o600);
    writer.exec("ROLLBACK");
  } finally {writer.close();}
  const before = [readFileSync(main), readFileSync(main + "-journal")];
  let calls = 0;
  const rootPin = lstatSync(target), filePin = lstatSync(main);
  const assertRoot = () => {const now = lstatSync(target); expect([now.dev, now.ino, now.uid, now.mode & 0o777]).toEqual([rootPin.dev, rootPin.ino, rootPin.uid, 0o700]);};
  const assertFile = (path: string) => {
    assertRoot(); const now = lstatSync(path);
    expect(now.isFile() && !now.isSymbolicLink() && now.nlink === 1 && now.uid === rootPin.uid && (now.mode & 0o777) === 0o600).toBe(true);
    expect([now.dev, now.ino]).toEqual([filePin.dev, filePin.ino]);
  };
  // Real disposable SQLite with a labelled simulated native platform. No
  // Windows ACL, sharing, handle, or durability acceptance is claimed.
  const platform: RuntimeStorePlatform = {
    bind: p => {expect(p).toBe(target); assertRoot(); return p;}, assertRoot, assertDatabase: assertFile,
    syncCreatedDatabase: assertFile, close() {},
    withHotJournalSnapshot(path, callback) {
      calls++;
      const snapshot = directory(), copy = join(snapshot, SHARED_RUNTIME_FILE);
      for (const suffix of ["", "-journal", "-wal", "-shm"]) if (existsSync(path + suffix)) {
        copyFileSync(path + suffix, copy + suffix); chmodSync(copy + suffix, 0o600);
      }
      callback(copy);
      expect(readFileSync(path)).toEqual(before[0]); expect(readFileSync(path + "-journal")).toEqual(before[1]);
    },
  };
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  return {target, main, before, platform, calls: () => calls};
}
it("privately validates a hot RuntimeStore before recovering the owned source", () => {
  const f = fixture(), store = new RuntimeStore(f.target, {platformAdapter: f.platform, requiredExistingRole: "authority"});
  try {expect(store.get("meta", "role")).toBe("authority"); expect(f.calls()).toBe(1);} finally {store.close();}
});
it("rejects the wrong semantic role while preserving original main and hot journal", () => {
  const f = fixture();
  expect(() => new RuntimeStore(f.target, {platformAdapter: f.platform, requiredExistingRole: "client"})).toThrow("WRONG_STORE_ROLE");
  expect(readFileSync(f.main)).toEqual(f.before[0]); expect(readFileSync(f.main + "-journal")).toEqual(f.before[1]);
});
it("refuses a native snapshot that skips semantic validation", () => {
  const f = fixture(); f.platform.withHotJournalSnapshot = () => {};
  expect(() => new RuntimeStore(f.target, {platformAdapter: f.platform, requiredExistingRole: "authority"})).toThrow("snapshot did not validate");
  expect(readFileSync(f.main)).toEqual(f.before[0]); expect(readFileSync(f.main + "-journal")).toEqual(f.before[1]);
});
