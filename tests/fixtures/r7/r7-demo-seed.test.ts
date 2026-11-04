import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, test } from "vitest";
import { seedDemo } from "../../../scripts/r7-demo-seed";
import { Store } from "../../../src/persistence/store";

const fixtureImage = resolve("tests/fixtures/image.png");

describe("R7 synthetic demo seed", () => {
  test("builds a v4 record workspace, four views and a QA manifest without touching a user directory", () => {
    const root = mkdtempSync(join(tmpdir(), "folio-r7-seed-"));
    const database = join(root, "data", "workspace.sqlite");
    const manifestPath = join(root, "manifest.json");
    try {
      const manifest = seedDemo(database, manifestPath, fixtureImage);
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(manifest);
      expect(manifest.format).toBe("folio-r7-demo-manifest-v1");
      expect(manifest.checks).toEqual({
        views: 4,
        properties: 5,
        records: 4,
        nestedPages: 1,
        internalLinks: 3,
        assets: 1,
      });
      expect(manifest.database.views.map((view) => view.type)).toEqual([
        "table",
        "board",
        "calendar",
        "gallery",
      ]);
      expect(manifest.operations.map((operation) => operation.operationId)).toEqual([
        "r7-demo-op-01-create-database",
        "r7-demo-op-record-01-requirements",
        "r7-demo-op-record-02-screens",
        "r7-demo-op-record-03-review",
        "r7-demo-op-record-04-spacing",
        "r7-demo-op-record-body-01",
        "r7-demo-op-record-body-02",
        "r7-demo-op-record-body-03",
        "r7-demo-op-record-body-04",
        "r7-demo-op-page-home",
        "r7-demo-op-page-nested",
        "r7-demo-op-page-regular",
      ]);
      expect(manifest.operations.map((operation) => operation.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(manifest.database.properties.map((property) => property.type)).toEqual([
        "text",
        "number",
        "select",
        "date",
        "checkbox",
      ]);
      expect(manifest.pages.find((page) => page.role === "nested")?.parentId).toBe(
        manifest.pages.find((page) => page.role === "home")?.id,
      );

      const store = new Store(database);
      try {
        expect(
          (store.db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
        ).toBe(4);
        const snapshot = store.load();
        expect(snapshot.recordDatabaseIds).toEqual([manifest.database.id]);
        expect(snapshot.records).toHaveLength(4);
        expect(
          store.db
            .prepare("SELECT COUNT(*) AS count FROM record_memberships WHERE database_page_id=?")
            .get(manifest.database.id),
        ).toEqual({ count: 4 });
        const owner = store.get(manifest.database.id);
        expect(owner.database?.views).toHaveLength(4);
        expect(owner.database?.rows).toEqual([]);
        expect(
          owner.database?.views[0].filter.conditions.some(
            (node) => node.kind === "group",
          ),
        ).toBe(true);
        expect(owner.database?.views[0].sorts).toHaveLength(2);

        const nested = store.get(
          manifest.pages.find((page) => page.role === "nested")!.id,
        );
        const serialized = JSON.stringify(nested.doc);
        expect(serialized).toContain(manifest.asset.url);
        expect(serialized).toContain('"type":"image"');
        const home = store.get(
          manifest.pages.find((page) => page.role === "home")!.id,
        );
        expect(JSON.stringify(home.doc)).toContain(
          "folio-page://" +
            manifest.pages.find((page) => page.role === "nested")!.id,
        );
        expect(statSync(join(root, "data", manifest.asset.storagePath)).size).toBe(
          manifest.asset.size,
        );
        expect(
          (snapshot.settings.activePage ?? "") ===
            manifest.pages.find((page) => page.role === "home")!.id,
        ).toBe(true);
      } finally {
        store.close();
      }

      // The launcher only calls the seed when the database is absent. A second
      // call must fail rather than overwrite the existing synthetic workspace.
      expect(() => seedDemo(database, manifestPath, fixtureImage)).toThrow(
        /empty synthetic workspace/,
      );
      const reopened = new Store(database);
      try {
        expect(reopened.load().records).toHaveLength(4);
      } finally {
        reopened.close();
      }

      writeFileSync(
        join(root, "SYNTHETIC-R7-DEMO"),
        "Folio R7 synthetic demo\n",
        "utf8",
      );
      const verified = execFileSync(
        process.execPath,
        [
          resolve("scripts/verify-r7-workspace.mjs"),
          `--data=${join(root, "data")}`,
          `--manifest=${manifestPath}`,
        ],
        { encoding: "utf8" },
      );
      expect(verified).toContain("R7 synthetic workspace OK");
      expect(() =>
        transformSync(readFileSync(resolve("scripts/r7-demo.mjs"), "utf8"), {
          loader: "js",
          format: "esm",
        }),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
