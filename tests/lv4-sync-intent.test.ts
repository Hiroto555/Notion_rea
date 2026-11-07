import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSyncIntentFile } from "../src/main/workspace-sync-intent";
import { durableFs } from "../src/persistence/durable-file";
const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-lv4-intent-"))); roots.push(dir);
  return new WorkspaceSyncIntentFile(dir);
}
const target = {workspaceId: "workspace", clientId: "client", bindingId: "binding", serverEpoch: "epoch", revision: 2, checkpointHash: "a".repeat(64)};
it("persists an exact target, permits idempotent retry and matching cancellation", () => {
  const file = fixture(); expect(file.read()).toEqual({status: "empty"});
  file.create(target); file.create(target);
  expect(fixtureRead(file)).toEqual(target);
  expect(() => file.create({...target, revision: 3})).toThrow("apply-intent-already-exists");
  expect(() => file.cancel({...target, revision: 3})).toThrow("apply-intent-mismatch");
  file.cancel(target); expect(file.read()).toEqual({status: "empty"});
});
function fixtureRead(file: WorkspaceSyncIntentFile) { const value = file.read(); return value.status === "ready" ? value.target : undefined; }
it("blocks on corrupt, foreign-format, or symlink intent and preserves it", () => {
  const file = fixture(); writeFileSync(file.path, '{"format":');
  expect(file.read()).toEqual({status: "blocked"});
  expect(() => file.create(target)).toThrow();
  expect(readFileSync(file.path, "utf8")).toBe('{"format":');
  rmSync(file.path); const other = join(roots[0], "other"); writeFileSync(other, "untouched"); symlinkSync(other, file.path);
  expect(file.read()).toEqual({status: "blocked"});
  expect(() => file.cancel(target)).toThrow(); expect(readFileSync(other, "utf8")).toBe("untouched");
});
it("removes only the exact completed intent and preserves a newer target", () => {
  const file = fixture();
  expect(file.cancelIfMatches(target)).toBe("absent");
  file.create(target);
  expect(file.cancelIfMatches({...target, revision: 3})).toBe("different");
  expect(fixtureRead(file)).toEqual(target);
  expect(file.cancelIfMatches(target)).toBe("removed");
  expect(file.read()).toEqual({status: "empty"});
});
it("flushes the parent when retrying after an uncertain unlink", () => {
  const file = fixture(); file.create(target);
  const fault = vi.spyOn(durableFs, "syncPath").mockImplementationOnce(() => {throw new Error("injected directory fsync failure");});
  try {expect(() => file.cancel(target)).toThrow("injected directory fsync failure");}
  finally {fault.mockRestore();}
  expect(file.read().status).toBe("empty");
  const sync = vi.spyOn(durableFs, "syncPath");
  try {expect(file.cancelIfMatches(target)).toBe("absent"); expect(sync).toHaveBeenCalledTimes(1);}
  finally {sync.mockRestore();}
});
