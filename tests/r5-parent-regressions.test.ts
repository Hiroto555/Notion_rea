import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/persistence/store";
import { inspectWritableStartup } from "../src/persistence/schema-startup";
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) f();
});
it("closes each successful preflight reader instead of retaining SQLite descriptors", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-r5-preflight-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "workspace.sqlite");
  const store = new Store(path);
  store.close();
  const before = readFileSync(path);
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  for (let i = 0; i < 4; i++)
    expect(inspectWritableStartup(path, 4).version).toBe(3);
  expect(close).toHaveBeenCalledTimes(4);
  expect(readFileSync(path)).toEqual(before);
});
