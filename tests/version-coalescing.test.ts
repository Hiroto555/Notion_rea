import { expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/persistence/store";

it("preserves the pre-edit version, samples the next window and forces the pre-restore version", () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-versions-"));
  onTestFinished(() => rmSync(dir, {recursive: true, force: true}));
  const store = new Store(join(dir, "workspace.sqlite"), {versionMinIntervalMs: 120_000});
  onTestFinished(() => store.close());
  const page = store.create(null, "page", "original");
  const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
  onTestFinished(() => now.mockRestore());
  store.update(page.id, 0, {title: "first"});
  const original = store.versions(page.id)[0];
  now.mockReturnValue(110_000);
  store.update(page.id, 1, {title: "second"});
  expect(store.versions(page.id)).toEqual([original]);
  now.mockReturnValue(280_000);
  store.update(page.id, 2, {title: "third"});
  store.handle({type: "restoreVersion", id: page.id, revision: 3, versionId: original.id});
  expect(store.versions(page.id).map(entry => entry.title)).toEqual(["third", "second", "original"]);
  expect(store.get(page.id).title).toBe("original");
});
