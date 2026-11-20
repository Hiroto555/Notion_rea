import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";

it("searches 500 pages and 200 records repeatedly, invalidating after edits and rollback", () => {
  const directory = mkdtempSync(join(tmpdir(), "folio-search-"));
  const store = new Store(join(directory, "workspace.sqlite"));
  onTestFinished(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  const base = store.create(null, "page", "base");
  const owner = store.create(null, "database", "DB");
  const records = new RecordRepository(store);
  store.transaction(() => {
    records.createSchema();
    records.registerDatabase(owner.id);
    for (let i = 0; i < 700; i++) {
      const page = store.write({...base, id: 'item-' + i, title: 'ページ' + i}, true);
      if (i >= 500) store.db.prepare("INSERT INTO record_memberships VALUES(?,?,?,?)")
        .run(page.id, owner.id, i, '{"note":"テスト"}');
    }
  });
  const decode = vi.spyOn(store, "decode");
  const search = () => store.handle({type: "search", query: "テスト"});
  const start = performance.now();
  for (let i = 0; i < 10; i++) expect(search()).toHaveLength(200);
  console.info("700項目・検索10回の平均", ((performance.now() - start) / 10).toFixed(1), "ms");
  expect(decode).toHaveBeenCalledTimes(702);
  store.update(base.id, 0, {title: "テスト"});
  expect(search()).toHaveLength(201);
  expect(() => store.transaction(() => {
    store.db.prepare("UPDATE record_memberships SET values_json='{}'").run();
    expect(search()).toHaveLength(1);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(search()).toHaveLength(201);
  const other = new Store(store.path);
  try {
    other.update(base.id, 1, {title: "external"});
    expect(search()).toHaveLength(200);
  } finally {other.close();}
});
