import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {afterEach, expect, it, vi} from "vitest";
import {withNativeSqliteReader} from "../src/persistence/native-sqlite-reader";
import {startupRetainsNativeLease} from "../src/persistence/startup-connection-owner";
import type {NativePrivateFilesystemPort} from "../src/platform/private-persistence";
const roots: string[] = [];
afterEach(() => {vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, {recursive: true, force: true});});
function fixture(readyFailure?: unknown, cleanupFailure?: unknown) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-reader-lease-"))); roots.push(root);
  const path = join(root, "reader.sqlite"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES('retained')"); db.close();
  const identity = {path, fileId: "1".repeat(32), volumeId: "2".repeat(16)};
  const close = vi.fn(() => {if (cleanupFailure) throw cleanupFailure;});
  const native = {inspectFileIdentity: () => identity,
    acquireSqliteLease: () => ({assertHeld() {if (readyFailure) throw readyFailure;}, close})} as unknown as NativePrivateFilesystemPort;
  return {path, native, close};
}
it("closes an acquired protector when READY proof fails before SQLite opens", () => {
  const cause = new Error("READY lost"), f = fixture(cause); let reads = 0;
  expect(() => withNativeSqliteReader(f.path, f.native, () => {reads++;})).toThrow(cause);
  expect(reads).toBe(0); expect(f.close).toHaveBeenCalledOnce();
});
it("retains uncertain READY cleanup and preserves that ownership through outer aggregates", () => {
  const cause = new Error("READY lost"), cleanup = new Error("helper close unknown"), f = fixture(cause, cleanup);
  let failure: unknown; try {withNativeSqliteReader(f.path, f.native, () => undefined);} catch (e) {failure = e;}
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([cause, cleanup]);
  expect(startupRetainsNativeLease(failure)).toBe(true);
  expect(startupRetainsNativeLease(new AggregateError([new Error("outer cleanup"), failure]))).toBe(true);
  expect(f.close).toHaveBeenCalledOnce();
});
it("retains protector cleanup after a successful real SQLite read without re-closing it", () => {
  const cleanup = new Error("helper close unknown"), f = fixture(undefined, cleanup);
  let read = false, failure: unknown;
  try {withNativeSqliteReader(f.path, f.native, db => {expect(db.prepare("SELECT value FROM proof").get()?.value).toBe("retained"); read = true;});}
  catch (e) {failure = e;}
  expect(read).toBe(true); expect(startupRetainsNativeLease(failure)).toBe(true); expect(f.close).toHaveBeenCalledOnce();
});
it("handles cyclic untrusted error metadata without invoking getters", () => {
  let accesses = 0; const failure = new Error("unbranded");
  Object.defineProperty(failure, "cause", {get() {accesses++; return failure;}});
  expect(startupRetainsNativeLease(failure)).toBe(false); expect(accesses).toBe(0);
  const cycle = new AggregateError([]); cycle.errors.push(cycle);
  expect(startupRetainsNativeLease(cycle)).toBe(false);
  const hostile = new AggregateError([]);
  Object.defineProperty(hostile.errors, "0", {get() {accesses++; return failure;}});
  hostile.errors[Symbol.iterator] = () => {accesses++; throw new Error("foreign iterator");};
  expect(startupRetainsNativeLease(hostile)).toBe(true);
  expect(accesses).toBe(0);
});
