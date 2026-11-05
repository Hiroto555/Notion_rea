import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import {
  readStorageUsage,
  type StorageUsageOptions,
} from "../src/persistence/storage-usage";
import { evaluateStorageCapacity } from "../src/shared/storage-usage";

type Fixture = {
  root: string;
  workspace: string;
  dbPath: string;
  store: Store;
  dispose(): void;
};

function fixture(): Fixture {
  const root = mkdtempSync(resolve("output/l3-storage-usage-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "assets"));
  const dbPath = join(workspace, "workspace.sqlite");
  const store = new Store(dbPath);
  return {
    root,
    workspace,
    dbPath,
    store,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function insertReceipt(store: Store, id: string, result: unknown): void {
  store.db
    .prepare(
      "INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES(?,?,?)",
    )
    .run(
      id,
      "a".repeat(64),
      typeof result === "string" ? result : JSON.stringify(result),
    );
}

function table(report: ReturnType<typeof readStorageUsage>, name: string) {
  const found = report.database.tables.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing table usage: ${name}`);
  return found;
}

function hashTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile())
        result[path.slice(root.length + 1)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  walk(root);
  return result;
}

function writeManifest(
  directory: string,
  manifest: unknown,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
}

function backupDirectory(
  workspace: string,
  name: string,
): string {
  const directory = join(workspace, "backups", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "workspace.sqlite"), "snapshot-bytes");
  return directory;
}

it("counts stored UTF-8 bytes for Japanese and emoji without decoding content", () => {
  const f = fixture();
  try {
    const data = JSON.stringify({ title: "日本語のページ😀", doc: { text: "絵文字🎉" } });
    const body = JSON.stringify({ text: "本文です🧪" });
    const id = "page-utf8-1";
    f.store.db
      .prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)")
      .run(id, data, body);
    const report = readStorageUsage(f.store);
    const expected =
      Buffer.byteLength(id, "utf8") +
      Buffer.byteLength(data, "utf8") +
      Buffer.byteLength(body, "utf8");
    expect(table(report, "pages").storedBytes).toBe(expected);
    expect(table(report, "pages").rows).toBe(1);
    expect(report.database.storedTextBytes).toBe(expected);
    // The report must not contain the stored body or title.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("日本語のページ");
    expect(serialized).not.toContain("絵文字");
    expect(report.state).toBe("complete");
  } finally {
    f.dispose();
  }
});

it("distinguishes missing optional tables from present tables with zero rows", () => {
  const f = fixture();
  try {
    let report = readStorageUsage(f.store);
    expect(table(report, "record_databases")).toMatchObject({
      role: "optional",
      state: "missing",
      rows: null,
      storedBytes: null,
    });
    expect(table(report, "save_receipts")).toMatchObject({
      role: "required",
      state: "present",
      rows: 0,
      storedBytes: 0,
    });
    expect(report.database.state).toBe("complete");

    f.store.db.exec(
      "CREATE TABLE record_databases(database_page_id TEXT PRIMARY KEY)",
    );
    report = readStorageUsage(f.store);
    expect(table(report, "record_databases")).toMatchObject({
      role: "optional",
      state: "present",
      rows: 0,
      storedBytes: 0,
    });
    expect(report.database.state).toBe("complete");
  } finally {
    f.dispose();
  }
});

it("handles 10k receipts and counts malformed result_json without exposing it", () => {
  const f = fixture();
  try {
    const insert = f.store.db.prepare(
      "INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES(?,?,?)",
    );
    const statuses = ["applied", "rejected", "unknown"];
    const secret = "SECRET-RECEIPT-BODY-4f8c";
    const start = performance.now();
    f.store.transaction(() => {
      for (let index = 0; index < 10_000; index++) {
        const payload =
          index === 7_777
            ? `{"status":"applied","page":{"title":"${secret}"`
            : JSON.stringify({
                status: statuses[index % 3],
                operationId: `op-${index}`,
                page: { title: `title-${index}` },
              });
        insert.run(`op-${index}`, "b".repeat(64), payload);
      }
    });
    const report = readStorageUsage(f.store);
    const elapsed = performance.now() - start;
    console.log(
      `[l3-storage-usage] 10k receipts measured in ${elapsed.toFixed(1)}ms (synthetic fixture; reference only)`,
    );
    expect(report.database.receipts.rows).toBe(10_000);
    expect(report.database.receipts.inspectedRows).toBe(10_000);
    expect(report.database.receipts.state).toBe("complete");
    expect(report.database.receipts.corruptRows).toBe(1);
    expect(report.database.receipts.byStatus).toEqual({
      applied: 3_334,
      rejected: 3_332,
      unknown: 3_333,
      other: 0,
    });
    expect(report.database.receipts.storedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.state).toBe("complete");
  } finally {
    f.dispose();
  }
});

it("never commits or rolls back a caller-owned transaction", () => {
  const f = fixture();
  try {
    f.store.db.exec("BEGIN");
    insertReceipt(f.store, "caller-owned", {
      status: "unknown",
      operationId: "caller-owned",
    });
    const inside = readStorageUsage(f.store);
    expect(inside.database.snapshot.callerOwnedTransaction).toBe(true);
    expect(f.store.db.isTransaction).toBe(true);
    expect(inside.database.receipts.rows).toBe(1);
    f.store.db.exec("ROLLBACK");
    expect(f.store.db.isTransaction).toBe(false);

    const outside = readStorageUsage(f.store);
    expect(outside.database.snapshot.callerOwnedTransaction).toBe(false);
    expect(outside.database.receipts.rows).toBe(0);
  } finally {
    f.dispose();
  }
});

it("does not change raw database, asset or backup bytes", () => {
  const f = fixture();
  try {
    insertReceipt(f.store, "read-only", { status: "applied" });
    writeFileSync(join(f.workspace, "assets", "asset-1"), "添付の内容🎈");
    const backup = backupDirectory(f.workspace, "complete-1");
    const database = statSync(join(backup, "workspace.sqlite")).size;
    writeFileSync(
      join(backup, "manifest.json"),
      JSON.stringify({
        format: "folio-workspace-backup",
        version: 1,
        createdAt: new Date().toISOString(),
        database: { path: "workspace.sqlite", bytes: database, sha256: "c".repeat(64) },
        assets: [],
      }),
    );
    const before = hashTree(f.workspace);
    const report = readStorageUsage(f.store);
    const after = hashTree(f.workspace);
    // SQLite's -shm file carries shared-memory read marks and is updated by a
    // read transaction. It is not workspace data; every data file must match.
    const dataOnly = (tree: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(tree).filter(([name]) => !name.endsWith("-shm")),
      );
    expect(dataOnly(after)).toEqual(dataOnly(before));
    expect(after["workspace.sqlite"]).toBe(before["workspace.sqlite"]);
    expect(after["workspace.sqlite-wal"]).toBe(before["workspace.sqlite-wal"]);
    expect(after["assets/asset-1"]).toBe(before["assets/asset-1"]);
    expect(report.totals.totalFileBytes).not.toBeNull();
    expect(report.workspace.backups.complete).toBe(1);
  } finally {
    f.dispose();
  }
});

it("classifies complete, incomplete and legacy backups without verifying hashes", () => {
  const f = fixture();
  try {
    const createdAt = new Date().toISOString();
    const complete = backupDirectory(f.workspace, "complete-1");
    const completeBytes = statSync(join(complete, "workspace.sqlite")).size;
    writeFileSync(
      join(complete, "manifest.json"),
      JSON.stringify({
        format: "folio-workspace-backup",
        version: 1,
        createdAt,
        database: { path: "workspace.sqlite", bytes: completeBytes, sha256: "d".repeat(64) },
        assets: [],
      }),
    );

    const incomplete = backupDirectory(f.workspace, "incomplete-1");
    writeFileSync(join(incomplete, "FOLIO-RECOVERY-INCOMPLETE"), "incomplete\n");
    writeFileSync(
      join(incomplete, "manifest.json"),
      JSON.stringify({
        format: "folio-workspace-backup",
        version: 1,
        createdAt,
        database: { path: "workspace.sqlite", bytes: statSync(join(incomplete, "workspace.sqlite")).size, sha256: "e".repeat(64) },
        assets: [],
      }),
    );

    const bad = backupDirectory(f.workspace, "bad-manifest");
    writeFileSync(join(bad, "manifest.json"), "{not json");

    const noManifest = backupDirectory(f.workspace, "no-manifest");

    const legacy = backupDirectory(f.workspace, "legacy-1");
    writeFileSync(
      join(legacy, "manifest.json"),
      JSON.stringify({ app: "Folio", schema: 1, createdAt }),
    );

    const migration = backupDirectory(f.workspace, "migration-1");
    writeFileSync(
      join(migration, "manifest.json"),
      JSON.stringify({
        format: "folio-pre-migration-snapshot",
        schemaVersion: 1,
        createdAt,
      }),
    );

    const mismatch = backupDirectory(f.workspace, "size-mismatch");
    writeFileSync(
      join(mismatch, "manifest.json"),
      JSON.stringify({
        format: "folio-workspace-backup",
        version: 1,
        createdAt,
        database: { path: "workspace.sqlite", bytes: 1, sha256: "f".repeat(64) },
        assets: [],
      }),
    );

    const report = readStorageUsage(f.store);
    const entries = new Map(
      report.workspace.backups.entries.map((entry) => [entry.name, entry]),
    );
    expect(entries.get("complete-1")).toMatchObject({
      state: "complete",
      kind: "workspace",
      marker: "missing",
      manifest: "valid",
      declaredDatabaseBytes: completeBytes,
    });
    expect(entries.get("incomplete-1")).toMatchObject({
      state: "incomplete",
      marker: "present",
    });
    expect(entries.get("bad-manifest")).toMatchObject({
      state: "incomplete",
      manifest: "invalid",
    });
    expect(entries.get("no-manifest")).toMatchObject({
      state: "incomplete",
      manifest: "missing",
    });
    expect(entries.get("legacy-1")).toMatchObject({
      state: "complete",
      kind: "legacy",
    });
    expect(entries.get("migration-1")).toMatchObject({
      state: "complete",
      kind: "migration",
    });
    expect(entries.get("size-mismatch")).toMatchObject({
      state: "incomplete",
      manifest: "valid",
    });
    expect(report.workspace.backups).toMatchObject({
      root: "present",
      complete: 3,
      incomplete: 4,
      unknown: 0,
    });
    expect(report.workspace.backups.bytes.bytes).not.toBeNull();
  } finally {
    f.dispose();
  }
});

it("reports a symlink in assets without following it or counting target bytes", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "outside-target-bytes");
    symlinkSync(outside, join(f.workspace, "assets", "linked"));
    const report = readStorageUsage(f.store);
    expect(report.workspace.assets).toMatchObject({
      root: "present",
      symlinks: 1,
      measuredFiles: 0,
      measuredBytes: 0,
      state: "partial",
    });
    expect(report.workspace.assets.bytes).toBe(0);
    expect(report.state).toBe("partial");
    expect(
      report.issues.some((issue) => issue.code === "symlink-skipped"),
    ).toBe(true);
  } finally {
    f.dispose();
  }
});

it("marks unrecognized tables as partial instead of counting them", () => {
  const f = fixture();
  try {
    f.store.db.exec("CREATE TABLE mystery(payload TEXT)");
    f.store.db
      .prepare("INSERT INTO mystery(payload) VALUES(?)")
      .run("not measured");
    const report = readStorageUsage(f.store);
    expect(report.database.unrecognizedTables).toEqual(["mystery"]);
    expect(report.database.state).toBe("partial");
    expect(report.state).toBe("partial");
  } finally {
    f.dispose();
  }
});

it("returns unknown capacity, never writable, when a required source fails", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, "assets", "asset-1"), "12345");
    const report = readStorageUsage(f.store);
    expect(
      evaluateStorageCapacity(report, { maxAssetFileBytes: 4 }),
    ).toMatchObject({ status: "exceeded" });
    expect(
      evaluateStorageCapacity(report, { maxAssetFileBytes: 5 }),
    ).toMatchObject({ status: "within" });
    expect(evaluateStorageCapacity(report, {})).toEqual({
      status: "not-configured",
    });

    // A filesystem operation that cannot stat the assets root yields unknown.
    const operations: NonNullable<StorageUsageOptions["operations"]> = {
      lstatSync: ((path: Parameters<typeof statSync>[0]) => {
        if (String(path).endsWith("/assets")) {
          const error = new Error("denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return statSync(path);
      }) as typeof statSync,
    };
    const partial = readStorageUsage(f.store, { operations });
    expect(partial.workspace.assets.state).toBe("unknown");
    expect(partial.totals.assetFileBytes).toBeNull();
    expect(
      evaluateStorageCapacity(partial, { maxAssetFileBytes: 1_000 }),
    ).toMatchObject({ status: "unknown", unknownLimits: ["maxAssetFileBytes"] });
  } finally {
    f.dispose();
  }
});

it("rejects invalid scan limits and clocks", () => {
  const f = fixture();
  try {
    expect(() =>
      readStorageUsage(f.store, { scanLimits: { maxEntries: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      readStorageUsage(f.store, { scanLimits: { maxDepth: -1 } }),
    ).toThrow(RangeError);
    expect(() =>
      readStorageUsage(f.store, {
        now: () => new Date(Number.NaN),
      }),
    ).toThrow(TypeError);
  } finally {
    f.dispose();
  }
});

it("marks receipt classification partial when its row budget is reached", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 3; index++)
      insertReceipt(f.store, `op-${index}`, { status: "applied" });
    const report = readStorageUsage(f.store, {
      scanLimits: { maxReceiptClassificationRows: 2 },
    });
    expect(report.database.receipts.rows).toBe(3);
    expect(report.database.receipts.inspectedRows).toBe(2);
    expect(report.database.receipts.state).toBe("partial");
    expect(report.database.state).toBe("partial");
    expect(report.state).toBe("partial");
    expect(
      report.issues.some(
        (issue) => issue.code === "receipt-classification-truncated",
      ),
    ).toBe(true);
  } finally {
    f.dispose();
  }
});

it("reports unknown, not writable, when the database cannot be read", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, "assets", "asset-1"), "12345");
    f.store.close();
    const report = readStorageUsage(f.store);
    expect(report.database.state).toBe("unknown");
    expect(report.database.snapshot.callerOwnedTransaction).toBeNull();
    expect(report.state).toBe("unknown");
    expect(
      evaluateStorageCapacity(report, { maxTotalFileBytes: 1_000_000 }),
    ).toMatchObject({
      status: "unknown",
      unknownLimits: ["maxTotalFileBytes"],
    });
  } finally {
    f.dispose();
  }
});

it("measures crash-recovery staging files without reading their content", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.workspace, "crash-recovery.json.stage-abc123"),
      "unsaved input",
    );
    const report = readStorageUsage(f.store);
    const staging = report.workspace.slots.filter(
      (slot) => slot.slot === "recovery-staging",
    );
    expect(staging).toHaveLength(1);
    expect(staging[0]).toMatchObject({
      state: "measured",
      bytes: Buffer.byteLength("unsaved input", "utf8"),
    });
    expect(report.workspace.otherFileBytes).toBe(
      Buffer.byteLength("unsaved input", "utf8"),
    );
    expect(JSON.stringify(report)).not.toContain("unsaved input");
  } finally {
    f.dispose();
  }
});

it("marks a backup containing a symlink as partial, not silently complete", () => {
  const f = fixture();
  try {
    const directory = backupDirectory(f.workspace, "linked-backup");
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        format: "folio-workspace-backup",
        version: 1,
        createdAt: new Date().toISOString(),
        database: {
          path: "workspace.sqlite",
          bytes: statSync(join(directory, "workspace.sqlite")).size,
          sha256: "a".repeat(64),
        },
        assets: [],
      }),
    );
    symlinkSync(
      join(f.workspace, "assets"),
      join(directory, "assets-link"),
    );
    const report = readStorageUsage(f.store);
    const entry = report.workspace.backups.entries.find(
      (item) => item.name === "linked-backup",
    );
    expect(entry).toMatchObject({ state: "unknown" });
    expect(entry?.bytes.state).toBe("partial");
    expect(entry?.issueCodes).toContain("symlink-skipped");
    expect(report.workspace.backups.state).toBe("unknown");
    expect(report.state).toBe("unknown");
  } finally {
    f.dispose();
  }
});

it("treats a valid legacy manifest without its database as incomplete", () => {
  const f = fixture();
  try {
    const directory = join(f.workspace, "backups", "legacy-no-db");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        app: "Folio",
        schema: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    const report = readStorageUsage(f.store);
    const entry = report.workspace.backups.entries.find(
      (item) => item.name === "legacy-no-db",
    );
    expect(entry).toMatchObject({ kind: "legacy", state: "incomplete" });
    expect(entry?.issueCodes).toContain("backup-database-missing");
  } finally {
    f.dispose();
  }
});
