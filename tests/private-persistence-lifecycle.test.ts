import {SqliteConnectionOwner} from "../src/sync/sqlite-connection-owner";
import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {afterEach, expect, it, vi} from "vitest";
import {assertPrivateOperationAuthority, withPrivateOperationAuthority} from "../src/platform/private-operation-authority";
import {createPrivatePersistenceLifecycle} from "../src/main/private-persistence-lifecycle";
import {finishWorkspaceQuit, registerAcceptedQuitCleanup} from "../src/main/workspace-quit";
import {withNativeSqliteReader} from "../src/persistence/native-sqlite-reader";
import {startupHasRetainedNativeLease} from "../src/persistence/startup-connection-owner";
import type {NativePrivateFilesystemPort} from "../src/platform/private-persistence";
const roots: string[] = [], readers: DatabaseSync[] = [];
const realClose = DatabaseSync.prototype.close;
afterEach(() => {vi.restoreAllMocks(); for (const db of readers.splice(0)) if(db.isOpen) realClose.call(db);
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});
function unresolvedReader() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-lifecycle-"))); roots.push(root);
  const path = join(root, "reader.sqlite"), db = new DatabaseSync(path); db.exec("CREATE TABLE proof(value)"); db.close();
  const close = vi.fn(), sentinel = new Error("hidden reader remains open");
  const native = {inspectFileIdentity: () => ({path, fileId: "1".repeat(32), volumeId: "2".repeat(16)}),
    acquireSqliteLease: () => ({assertHeld() {}, close})} as unknown as NativePrivateFilesystemPort;
  const work = () => {
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function(this: DatabaseSync) {readers.push(this); throw sentinel;});
    return withNativeSqliteReader(path, native, reader => reader.prepare("SELECT * FROM proof").all());
  };
  return {work, close, sentinel};
}
it.each([false,true])("latches a retained reader before sync/async IPC error serialization (%s)", async asynchronous => {
  const life = createPrivatePersistenceLifecycle(), f = unresolvedReader(); let failure: unknown;
  try {await life.run(() => asynchronous ? Promise.resolve().then(f.work) : f.work());} catch (error) {failure = error;}
  expect(life.retainedFailure()).toBe(failure); expect(f.close).not.toHaveBeenCalled();
  let redispatches = 0;
  expect(() => life.run(() => {redispatches++;})).toThrow("resources remain held"); expect(redispatches).toBe(0);
  const closeStore = vi.fn(), cleanup = vi.fn(), preventQuit = vi.fn(), reopenWindow = vi.fn();
  let quitListener: (() => void) | undefined;
  registerAcceptedQuitCleanup({once(_event, listener) {quitListener = listener;}}, cleanup);
  const outcome = finishWorkspaceQuit({closeStore() {life.assertUsable(); closeStore();}, preventQuit, reopenWindow});
  if (outcome === "quit") quitListener?.();
  expect(outcome).toBe("held"); expect(preventQuit).toHaveBeenCalledOnce(); expect(reopenWindow).toHaveBeenCalledOnce();
  expect(closeStore).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  expect((failure as AggregateError).errors).toContain(f.sentinel);
});
it("preserves normal results and ordinary rejected requests without latching", async () => {
  const life = createPrivatePersistenceLifecycle(), error = new Error("ordinary validation failure");
  expect(life.run(() => 7)).toBe(7); await expect(life.run(async () => 8)).resolves.toBe(8);
  expect(() => life.run(() => {throw error;})).toThrow(error);
  await expect(life.run(async () => {throw error;})).rejects.toBe(error);
  expect(life.retainedFailure()).toBeUndefined(); expect(life.run(() => 9)).toBe(9);
});

it.each([false, true])("fences an already waiting private continuation while preserving its positive control (%s)", async latch => {
  const life = createPrivatePersistenceLifecycle(), f = unresolvedReader();
  let resume!: () => void, mutations = 0;
  const picker = new Promise<void>(resolve => {resume = resolve;});
  const authorized = () => {if (!life.isUsable()) throw new Error("unauthorized");};
  const pending = life.run(() => withPrivateOperationAuthority(authorized, async () => {
    await picker;
    assertPrivateOperationAuthority();
    mutations++;
  }));
  if (latch) try {life.run(f.work);} catch {}
  expect(life.isUsable()).toBe(!latch); resume();
  if (latch) await expect(pending).rejects.toThrow("unauthorized");
  else await pending;
  expect(mutations).toBe(latch ? 0 : 1); expect(f.close).not.toHaveBeenCalled();
});

it.each([false, true])("recognizes common SQLite-owner retention but permits known-complete cleanup (%s)", closes => {
  const life = createPrivatePersistenceLifecycle();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-common-lifecycle-"))); roots.push(root);
  const db = new DatabaseSync(join(root, "owner.sqlite")); readers.push(db);
  const nativeClose = vi.fn(), owner = new SqliteConnectionOwner(() => nativeClose()); owner.opened(db);
  const original = db.close, sentinel = new Error("owner close fault");
  const spy = vi.spyOn(db, "close").mockImplementationOnce(() => {if (closes) original.call(db); throw sentinel;});
  expect(() => life.run(() => owner.close())).toThrow(sentinel);
  expect(startupHasRetainedNativeLease(life.retainedFailure())).toBe(!closes);
  expect(life.isUsable()).toBe(closes); expect(nativeClose).toHaveBeenCalledTimes(closes ? 1 : 0);
  spy.mockRestore(); owner.close(); expect(db.isOpen).toBe(false); expect(nativeClose).toHaveBeenCalledOnce();
});
