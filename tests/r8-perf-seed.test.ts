import {
  mkdirSync,
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
import {
  R8_PERF_BODY_TERM,
  R8_PERF_BROAD_QUERY,
  R8_PERF_MARKER,
  R8_PERF_MARKER_FILE,
  R8_PERF_PAGE_COUNT,
  R8_PERF_PROPERTY_TERM,
  R8_PERF_RECORD_COUNT,
  R8_PERF_SESSION_ID,
  R8_PERF_TITLE_TERM,
  seedMediumWorkspace,
} from "../scripts/r8-perf-seed";
import { Store } from "../src/persistence/store";
import type { Page } from "../src/shared/types";

const fixtureImage = resolve("tests/fixtures/image.png");

type SearchHit = Page & { searchMatch?: { kind: string; snippet: string } };

function search(store: Store, query: string): SearchHit[] {
  return store.handle({ type: "search", query }) as SearchHit[];
}

function linkedPages(pages: Page[], targetId: string): Page[] {
  const linked = (doc: Page["doc"]): boolean =>
    !!doc.marks?.some(
      (mark) =>
        mark.type === "link" &&
        mark.attrs?.href === "folio-page://" + targetId,
    ) ||
    !!doc.content?.some((node) => linked(node));
  return pages.filter(
    (page) => !page.documentError && page.id !== targetId && linked(page.doc),
  );
}

describe("R8 synthetic performance fixture", () => {
  test(
    "seeds 300 regular pages and 200 records through Store receipts, then refuses overwrite",
    () => {
      const root = mkdtempSync(join(tmpdir(), "folio-r8-perf-seed-"));
      const database = join(root, "data", "workspace.sqlite");
      const manifestPath = join(root, "manifest.json");
      try {
        const manifest = seedMediumWorkspace(
          database,
          manifestPath,
          fixtureImage,
        );
        expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(manifest);
        expect(manifest.marker).toBe(R8_PERF_MARKER);
        expect(
          readFileSync(join(root, "data", R8_PERF_MARKER_FILE), "utf8"),
        ).toBe(R8_PERF_MARKER + "\n");
        expect(manifest.checks).toEqual({
          regularPages: R8_PERF_PAGE_COUNT,
          records: R8_PERF_RECORD_COUNT,
          databases: 1,
          views: 2,
          properties: 5,
          assets: 1,
          internalLinks: 10,
          knownSearchHits: 3,
        });
        expect(manifest.database.views.map((view) => view.type)).toEqual([
          "table",
          "board",
        ]);
        expect(manifest.database.activeViewId).toBe("r8-view-table");

        // 1 database commit + 200 createRecord commits + 200 record body saves
        // + 300 regular page body saves.
        expect(manifest.operations).toHaveLength(1 + 200 + 200 + 300);
        expect(manifest.operations.map((operation) => operation.seq)).toEqual(
          Array.from(
            { length: manifest.operations.length },
            (_, index) => index + 1,
          ),
        );
        expect(
          new Set(manifest.operations.map((operation) => operation.operationId))
            .size,
        ).toBe(manifest.operations.length);
        expect(
          manifest.operations.every(
            (operation) =>
              operation.status === "applied" &&
              (operation.type === "database:commit" ||
                operation.type === "save:commit"),
          ),
        ).toBe(true);

        const store = new Store(database);
        try {
          expect(
            (
              store.db.prepare("PRAGMA user_version").get() as {
                user_version: number;
              }
            ).user_version,
          ).toBe(4);
          const snapshot = store.load();
          const recordIds = new Set(
            (snapshot.records ?? []).map((record) => record.pageId),
          );
          expect(snapshot.recordDatabaseIds).toEqual([manifest.database.id]);
          expect(snapshot.records).toHaveLength(R8_PERF_RECORD_COUNT);
          expect(recordIds.size).toBe(R8_PERF_RECORD_COUNT);
          expect(
            snapshot.pages.filter(
              (page) => page.kind === "page" && !recordIds.has(page.id),
            ),
          ).toHaveLength(R8_PERF_PAGE_COUNT);
          expect(
            snapshot.pages.filter((page) => page.kind === "database"),
          ).toHaveLength(1);

          expect(
            store.db
              .prepare(
                "SELECT COUNT(*) AS count FROM record_memberships WHERE database_page_id=?",
              )
              .get(manifest.database.id),
          ).toEqual({ count: R8_PERF_RECORD_COUNT });
          expect(
            store.db
              .prepare(
                "SELECT COUNT(*) AS count FROM record_databases WHERE database_page_id=?",
              )
              .get(manifest.database.id),
          ).toEqual({ count: 1 });

          const receiptIds = new Set(
            (
              store.db
                .prepare("SELECT operation_id FROM save_receipts")
                .all() as { operation_id: string }[]
            ).map((row) => row.operation_id),
          );
          for (const operation of manifest.operations)
            expect(receiptIds.has(operation.operationId)).toBe(true);
          expect(receiptIds.size).toBe(manifest.operations.length);
          for (const operation of manifest.operations) {
            const receipt = store.db
              .prepare(
                "SELECT result_json FROM save_receipts WHERE operation_id=?",
              )
              .get(operation.operationId) as { result_json: string };
            expect(JSON.parse(receipt.result_json)).toMatchObject({
              status: "applied",
              operationId: operation.operationId,
              sessionId: R8_PERF_SESSION_ID,
              seq: operation.seq,
            });
          }

          const owner = store.get(manifest.database.id);
          expect(owner.database?.rows).toEqual([]);
          expect(owner.database?.views).toHaveLength(2);

          const titleHits = search(store, R8_PERF_TITLE_TERM);
          expect(titleHits.map((page) => page.id)).toEqual([
            manifest.search.titleHitPageId,
          ]);
          expect(titleHits[0].searchMatch?.kind).toBe("title");

          const bodyHits = search(store, R8_PERF_BODY_TERM);
          expect(bodyHits.map((page) => page.id)).toEqual([
            manifest.search.bodyHitPageId,
          ]);
          expect(bodyHits[0].searchMatch?.kind).toBe("body");
          expect(bodyHits[0].searchMatch?.snippet).toContain(R8_PERF_BODY_TERM);

          const propertyHits = search(store, R8_PERF_PROPERTY_TERM);
          expect(propertyHits.map((page) => page.id)).toEqual([
            manifest.search.propertyHitRecordPageId,
          ]);
          expect(propertyHits[0].searchMatch?.kind).toBe("property");
          expect(propertyHits[0].searchMatch?.snippet).toContain(
            R8_PERF_PROPERTY_TERM,
          );

          const broad = search(store, R8_PERF_BROAD_QUERY);
          expect(broad).toHaveLength(R8_PERF_PAGE_COUNT);
          expect(new Set(broad.map((page) => page.id))).toEqual(
            new Set(manifest.pages.map((page) => page.id)),
          );

          const target = manifest.pages[manifest.pages.length - 1];
          const linked = linkedPages(snapshot.pages, target.id);
          expect(linked).toHaveLength(manifest.checks.internalLinks);
          expect(linked.map((page) => page.id).sort()).toEqual(
            manifest.pages
              .slice(0, manifest.checks.internalLinks)
              .map((page) => page.id)
              .sort(),
          );
          expect(
            manifest.pages
              .slice(0, manifest.checks.internalLinks)
              .every(
                (page) =>
                  page.internalLinkTargets.length === 1 &&
                  page.internalLinkTargets[0] === target.id,
              ),
          ).toBe(true);

          const assetPage = store.get(target.id);
          const serialized = JSON.stringify(assetPage.doc);
          expect(serialized).toContain(manifest.asset.url);
          expect(serialized).toContain('"type":"image"');
          expect(statSync(join(root, "data", manifest.asset.storagePath)).size).toBe(
            manifest.asset.size,
          );
          expect(
            (
              store.db
                .prepare("SELECT metadata FROM assets WHERE id=?")
                .get(manifest.asset.id) as { metadata: string }
            ).metadata,
          ).toContain(manifest.asset.sha256);
          expect(snapshot.settings.activePage).toBe(manifest.pages[0].id);
        } finally {
          store.close();
        }

        // A second seed invocation must never overwrite the existing fixture.
        expect(() =>
          seedMediumWorkspace(database, manifestPath, fixtureImage),
        ).toThrow(/refuses to overwrite|empty data directory/);
        const reopened = new Store(database);
        try {
          expect(reopened.load().records).toHaveLength(R8_PERF_RECORD_COUNT);
        } finally {
          reopened.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test("refuses a non-empty data directory before creating a database", () => {
    const root = mkdtempSync(join(tmpdir(), "folio-r8-perf-nonempty-"));
    const dataDir = join(root, "data");
    const database = join(dataDir, "workspace.sqlite");
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "existing.txt"), "keep me\n", "utf8");
      expect(() =>
        seedMediumWorkspace(database, join(root, "manifest.json"), fixtureImage),
      ).toThrow(/refuses to overwrite|empty data directory/);
      expect(() => statSync(database)).toThrow();
      expect(readFileSync(join(dataDir, "existing.txt"), "utf8")).toBe(
        "keep me\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("performance runner parses and loads as an ESM module", async () => {
    expect(() =>
      transformSync(readFileSync(resolve("scripts/r8-performance.mjs"), "utf8"), {
        loader: "js",
        format: "esm",
      }),
    ).not.toThrow();
    // The runner is an untyped .mjs script; loading it here verifies its real
    // ESM top-level imports without executing main.
    // @ts-expect-error - no declaration file for the .mjs runner
    const runner = await import("../scripts/r8-performance.mjs");
    expect(typeof runner.main).toBe("function");
  }, 30_000);
});
