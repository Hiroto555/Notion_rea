import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { convertLegacyRecordsInTransaction } from "../src/persistence/record-migration";
import { queryRows } from "../src/database/model";

it("measures synthetic record conversion, load, view-model query, search and saves", () => {
  for (const size of [1000, 10000]) {
    const root = mkdtempSync(resolve("output/record-scale-"));
    const path = join(root, "workspace.sqlite");
    let store = new Store(path);
    try {
      const db = store.create(null, "database", "Scale fixture");
      const rows = Array.from({ length: size }, (_, i) => ({
        id: `row-${i}`,
        title: `Synthetic row ${i}`,
        values: { status: `tag-${i}` },
      }));
      store.update(db.id, db.revision, { database: { ...db.database!, rows } });
      const started = performance.now();
      store.transaction(() => convertLegacyRecordsInTransaction(store));
      const migration = performance.now() - started;
      store.close();
      const openAt = performance.now();
      store = new Store(path);
      const open = performance.now() - openAt;
      const repo = new RecordRepository(store);
      const samples: {
        load: number;
        viewModel: number;
        search: number;
        bodySave: number;
        propertySave: number;
      }[] = [];
      for (let n = 0; n < 3; n++) {
        let t = performance.now();
        const snapshot = store.load();
        const load = performance.now() - t;
        t = performance.now();
        const projection = repo.databaseProjection(db.id);
        const model = {
          ...projection.settings,
          rows: projection.records.map((r) => ({
            id: r.pageId,
            title: r.title,
            values: { ...r.values },
          })),
        };
        expect(queryRows(model)).toHaveLength(size);
        const viewModel = performance.now() - t;
        t = performance.now();
        expect(
          (
            store.handle({
              type: "search",
              query: `tag-${size - 1}`,
            }) as unknown[]
          ).length,
        ).toBeGreaterThan(0);
        const search = performance.now() - t;
        const p = snapshot.pages.find(
          (page) => page.id === projection.records[0].pageId,
        )!;
        t = performance.now();
        const saved = store.updateRecordPage(p.id, db.id, p.revision, { title: `edited ${n}` });
        const bodySave = performance.now() - t;
        t = performance.now();
        repo.patch(p.id, db.id, saved.revision, {
          values: { status: `changed-${n}` },
        });
        const propertySave = performance.now() - t;
        samples.push({ load, viewModel, search, bodySave, propertySave });
      }
      console.log(
        "RECORD_SCALE " +
          JSON.stringify({
            size,
            migration,
            open,
            samples,
            scope: "synthetic SQLite + model only; no GUI/startup/input timing",
          }),
      );
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 180000);
