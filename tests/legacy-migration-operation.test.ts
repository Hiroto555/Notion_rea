import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { attachFile } from "../src/persistence/assets";
import { commitDatabaseOperation } from "../src/persistence/database-operations";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { prepareLegacyMigration } from "../src/shared/legacy-migration-operation";
import {
  previewLegacyMigration,
  commitLegacyMigration,
  resolveLegacyMigration,
} from "../src/persistence/legacy-migration-operation";

function fixture(mixed = false) {
  mkdirSync(resolve("output"), { recursive: true });
  const root = mkdtempSync(resolve("output/r6-migration-unit-"));
  const path = join(root, "workspace.sqlite"),
    assetsPath = join(root, "assets"),
    snapshotRoot = join(root, "snapshots");
  mkdirSync(assetsPath);
  const store = new Store(path);
  const legacy = store.create(null, "database", "Selected legacy");
  const historical = store.update(legacy.id, legacy.revision, {
    database: {
      ...legacy.database!,
      rows: [
        { id: "same-row", title: "Current row", values: { status: "進行中" } },
        {
          id: "history-only",
          title: "Historical row",
          values: { status: "完了" },
        },
      ],
    },
  });
  const current = store.update(legacy.id, historical.revision, {
    database: {
      ...historical.database!,
      rows: [
        historical.database!.rows[0],
        { id: "second-row", title: "Second row", values: { status: "未着手" } },
      ],
    },
  });
  const other = store.create(null, "database", "Unselected legacy");
  store.update(other.id, other.revision, {
    database: {
      ...other.database!,
      rows: [
        {
          id: "same-row",
          title: "Other scoped row",
          values: { status: "完了" },
        },
      ],
    },
  });
  const file = join(root, "synthetic.txt");
  writeFileSync(file, "R6 attachment bytes");
  const asset = attachFile(store.db, assetsPath, file);
  let registeredId: string | undefined;
  if (mixed)
    registeredId = commitDatabaseOperation(
      store,
      prepareDatabaseCreation("Existing registered"),
    ).page!.id;
  const pages = store.db
    .prepare("SELECT id,data,body FROM pages ORDER BY id")
    .all();
  const versions = store.db.prepare("SELECT * FROM versions ORDER BY id").all();
  const raw = pages.find((row) => row.id === legacy.id)!.data;
  return {
    root,
    path,
    store,
    legacy: current,
    other,
    asset,
    registeredId,
    pages,
    versions,
    raw,
    environment: { assetsPath, snapshotRoot },
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("explicit selected legacy migration", () => {
  it.each([false, true])(
    "previews without writes and converts only its selected DB in mixed=%s",
    (mixed) => {
      const f = fixture(mixed);
      try {
        const preview = previewLegacyMigration(f.store, f.legacy.id);
        expect(preview).toMatchObject({
          canApply: true,
          currentRecords: 2,
          historicalRecords: 1,
          revision: f.legacy.revision,
        });
        expect(
          f.store.db
            .prepare("SELECT id,data,body FROM pages ORDER BY id")
            .all(),
        ).toEqual(f.pages);
        expect(existsSync(f.environment.snapshotRoot)).toBe(false);
        const operation = prepareLegacyMigration(preview);
        const result = commitLegacyMigration(f.store, operation, f.environment);
        expect(result.status).toBe("applied");
        expect(result.records).toBe(2);
        expect(result.page!.revision).toBe(f.legacy.revision + 1);
        expect(result.page!.database!.rows).toEqual([]);
        expect(
          result.database!.records.every(
            (record) =>
              record.databasePageId === f.legacy.id && record.revision === 0,
          ),
        ).toBe(true);
        expect(
          f.store.db
            .prepare(
              "SELECT data FROM legacy_database_archive WHERE database_page_id=?",
            )
            .get(f.legacy.id)?.data,
        ).toBe(f.raw);
        expect(
          f.store.db.prepare("SELECT * FROM versions ORDER BY id").all(),
        ).toEqual(f.versions);
        for (const before of f.pages.filter((row) => row.id !== f.legacy.id))
          expect(
            f.store.db
              .prepare("SELECT id,data,body FROM pages WHERE id=?")
              .get(String(before.id)),
          ).toEqual(before);
        expect(
          f.store.db
            .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
            .get(f.other.id),
        ).toBeUndefined();
        expect(
          f.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM legacy_record_map WHERE database_page_id=?",
            )
            .get(f.legacy.id)?.n,
        ).toBe(3);
        expect(
          f.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM legacy_record_map WHERE database_page_id=?",
            )
            .get(f.other.id)?.n,
        ).toBe(0);
        const copy = new DatabaseSync(
          join(result.snapshotPath!, "workspace.sqlite"),
          { readOnly: true },
        );
        try {
          expect(
            copy.prepare("SELECT id,data,body FROM pages ORDER BY id").all(),
          ).toEqual(f.pages);
          expect(
            copy.prepare("SELECT * FROM versions ORDER BY id").all(),
          ).toEqual(f.versions);
          expect(
            copy.prepare("PRAGMA integrity_check").get()?.integrity_check,
          ).toBe("ok");
        } finally {
          copy.close();
        }
        expect(
          readFileSync(
            join(result.snapshotPath!, "assets", f.asset.id),
            "utf8",
          ),
        ).toBe("R6 attachment bytes");
        expect(existsSync(join(result.snapshotPath!, "manifest.json"))).toBe(
          true,
        );
        expect(() =>
          f.store.update(f.legacy.id, f.legacy.revision, {
            title: "stale legacy writer",
          }),
        ).toThrow(/競合/);
      } finally {
        f.dispose();
      }
    },
  );

  it("queries and repeats a committed operation after reopen without new IDs, revisions or snapshots", () => {
    const f = fixture(true);
    let reopened: Store | undefined;
    try {
      const operation = prepareLegacyMigration(
        previewLegacyMigration(f.store, f.legacy.id),
      );
      const committed = commitLegacyMigration(
        f.store,
        operation,
        f.environment,
      );
      const maps = f.store.db
        .prepare(
          "SELECT * FROM legacy_record_map ORDER BY database_page_id,legacy_row_id",
        )
        .all();
      f.store.close();
      reopened = new Store(f.path);
      expect(resolveLegacyMigration(reopened, operation)).toEqual(committed);
      expect(commitLegacyMigration(reopened, operation, f.environment)).toEqual(
        committed,
      );
      expect(
        reopened.db
          .prepare(
            "SELECT * FROM legacy_record_map ORDER BY database_page_id,legacy_row_id",
          )
          .all(),
      ).toEqual(maps);
      expect(readdirSync(f.environment.snapshotRoot)).toHaveLength(1);
      expect(reopened.get(f.legacy.id).revision).toBe(f.legacy.revision + 1);
      expect(
        commitLegacyMigration(
          reopened,
          { ...operation, revision: operation.revision + 1 },
          f.environment,
        ).status,
      ).toBe("rejected");
      expect(
        resolveLegacyMigration(reopened, {
          ...operation,
          operationId: "absent-operation",
        }).status,
      ).toBe("unknown");
    } finally {
      reopened?.close();
      f.dispose();
    }
  });

  it("rejects a changed current page or history fingerprint before snapshot or conversion", () => {
    const f = fixture();
    try {
      const operation = prepareLegacyMigration(
        previewLegacyMigration(f.store, f.legacy.id),
      );
      const version = f.store.versions(f.legacy.id)[0];
      f.store.db
        .prepare("UPDATE versions SET title=? WHERE id=?")
        .run("external history change", version.id);
      const after = f.store.db
        .prepare("SELECT * FROM versions ORDER BY id")
        .all();
      expect(
        commitLegacyMigration(f.store, operation, f.environment).status,
      ).toBe("rejected");
      expect(
        f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all(),
      ).toEqual(f.pages);
      expect(
        f.store.db.prepare("SELECT * FROM versions ORDER BY id").all(),
      ).toEqual(after);
      expect(existsSync(f.environment.snapshotRoot)).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("ignores unselected malformed legacy data but refuses unknown or wrongly typed selected values", () => {
    const f = fixture(true);
    try {
      const badOther = '{"future":';
      f.store.db
        .prepare("UPDATE pages SET data=? WHERE id=?")
        .run(badOther, f.other.id);
      expect(previewLegacyMigration(f.store, f.legacy.id).canApply).toBe(true);
      const badSelected = JSON.parse(String(f.raw));
      badSelected.database.rows[0].values.status = 17;
      const bad = JSON.stringify(badSelected);
      f.store.db
        .prepare("UPDATE pages SET data=? WHERE id=?")
        .run(bad, f.legacy.id);
      const preview = previewLegacyMigration(f.store, f.legacy.id);
      expect(preview.canApply).toBe(false);
      expect(preview.issues.length).toBeGreaterThan(0);
      expect(
        f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(f.legacy.id)
          ?.data,
      ).toBe(bad);
      expect(
        f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(f.other.id)
          ?.data,
      ).toBe(badOther);
    } finally {
      f.dispose();
    }
  });

  it("rolls back mid-conversion pages, mappings, membership, owner revision and schema while retaining a verified copy", () => {
    const f = fixture();
    try {
      const operation = prepareLegacyMigration(
        previewLegacyMigration(f.store, f.legacy.id),
      );
      const original = f.store.write.bind(f.store);
      let records = 0;
      const failure = vi
        .spyOn(f.store, "write")
        .mockImplementation((page, createOnly) => {
          if (createOnly && ++records === 2)
            throw new Error("synthetic record write interruption");
          return original(page, createOnly);
        });
      const result = commitLegacyMigration(f.store, operation, f.environment);
      failure.mockRestore();
      expect(result.status).toBe("rejected");
      expect(
        f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all(),
      ).toEqual(f.pages);
      expect(
        f.store.db.prepare("SELECT * FROM versions ORDER BY id").all(),
      ).toEqual(f.versions);
      expect(
        f.store.db.prepare("PRAGMA user_version").get()?.user_version,
      ).toBe(3);
      expect(
        f.store.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_record_map'")
          .get(),
      ).toBeUndefined();
      expect(existsSync(join(result.snapshotPath!, "manifest.json"))).toBe(
        true,
      );
      expect(resolveLegacyMigration(f.store, operation)).toEqual(result);
    } finally {
      vi.restoreAllMocks();
      f.dispose();
    }
  });

  it("stops on missing attachments and retains an incomplete snapshot without changing selected source", () => {
    const f = fixture();
    try {
      const operation = prepareLegacyMigration(
        previewLegacyMigration(f.store, f.legacy.id),
      );
      rmSync(join(f.environment.assetsPath, f.asset.id));
      const result = commitLegacyMigration(f.store, operation, f.environment);
      expect(result.status).toBe("rejected");
      expect(result.message).toContain("Registered asset missing");
      expect(
        f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all(),
      ).toEqual(f.pages);
      expect(existsSync(result.snapshotPath!)).toBe(true);
      expect(existsSync(join(result.snapshotPath!, "manifest.json"))).toBe(
        false,
      );
      expect(commitLegacyMigration(f.store, operation, f.environment)).toEqual(
        result,
      );
      expect(readdirSync(f.environment.snapshotRoot)).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });
});
