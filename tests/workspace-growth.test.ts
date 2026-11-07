import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  WorkspaceGrowth,
  growthLimitsFromEnv,
  type GrowthLimits,
} from "../src/main/workspace-growth";
import { publishCheckpointAssetsFromStaging } from "../src/sync/workspace-blobs";

type Fixture = {
  root: string;
  workspace: string;
  db: DatabaseSync;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "folio-workspace-growth-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const db = new DatabaseSync(join(workspace, "workspace.sqlite"));
  db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)");
  return { root, workspace, db };
}

function dispose(f: Fixture): void {
  f.db.close();
  rmSync(f.root, { recursive: true, force: true });
}

function write(root: string, path: string, content: string): number {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return Buffer.byteLength(content);
}

function logicalBytes(db: DatabaseSync): number {
  const count = (
    db.prepare("PRAGMA page_count").get() as { page_count: number }
  ).page_count;
  const size = (db.prepare("PRAGMA page_size").get() as { page_size: number })
    .page_size;
  return count * size;
}

it("reads only configured env limits and rejects invalid values", () => {
  expect(growthLimitsFromEnv({})).toEqual({});
  expect(
    growthLimitsFromEnv({
      FOLIO_MAX_DATABASE_BYTES: "1024",
      FOLIO_MAX_ASSET_BYTES: "0",
      FOLIO_MAX_BACKUP_BYTES: String(Number.MAX_SAFE_INTEGER),
      UNRELATED: "ignored",
    }),
  ).toEqual({
    maxDatabaseBytes: 1024,
    maxAssetBytes: 0,
    maxBackupBytes: Number.MAX_SAFE_INTEGER,
  });

  for (const value of [
    "",
    "-1",
    "1.5",
    "1e3",
    " 1",
    "1 ",
    "+1",
    "01",
    "0x10",
    "abc",
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    expect(() => growthLimitsFromEnv({ FOLIO_MAX_ASSET_BYTES: value })).toThrow(
      /workspace-limit-unknown/,
    );
  }
  expect(() =>
    growthLimitsFromEnv({
      FOLIO_MAX_DATABASE_BYTES: 1 as unknown as string,
    }),
  ).toThrow(TypeError);
});

it("rejects malformed constructor limits instead of disabling a budget", () => {
  const f = fixture();
  try {
    const invalid: unknown[] = [
      { maxAssetBytes: -1 },
      { maxAssetBytes: 1.5 },
      { maxAssetBytes: Number.NaN },
      { maxAssetBytes: "1" },
      { maxAssetBytes: Number.MAX_SAFE_INTEGER + 1 },
      { maxEverything: 1 },
    ];
    expect(
      () => new WorkspaceGrowth(f.workspace, f.db, { maxAssetBytes: 1 }),
    ).not.toThrow();
    for (const limits of invalid) {
      expect(
        () =>
          new WorkspaceGrowth(
            f.workspace,
            f.db,
            limits as unknown as GrowthLimits,
          ),
      ).toThrow(TypeError);
    }
    expect(() => new WorkspaceGrowth("", f.db, {})).toThrow(TypeError);
  } finally {
    dispose(f);
  }
});

it("uses the SQLite logical page high-water mark for database growth", () => {
  const f = fixture();
  try {
    f.db
      .prepare("INSERT INTO notes(body) VALUES(?)")
      .run("読み込める既存データ".repeat(500));
    const bytes = logicalBytes(f.db);

    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxDatabaseBytes: bytes,
      }).assertDatabaseWritable(),
    ).toThrow(/workspace-limit-exceeded/);
    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxDatabaseBytes: bytes - 1,
      }).assertDatabaseWritable(),
    ).toThrow(/保存を停止しました/);
    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxDatabaseBytes: bytes + 1,
      }).assertDatabaseWritable(),
    ).not.toThrow();

    expect(
      (f.db.prepare("SELECT body FROM notes").get() as { body: string }).body,
    ).toContain("読み込める既存データ");
    expect(existsSync(join(f.workspace, "workspace.sqlite"))).toBe(true);
  } finally {
    dispose(f);
  }
});

it("avoids SQLite I/O when the database limit is absent", () => {
  const f = fixture();
  f.db.close();
  try {
    const growth = new WorkspaceGrowth(f.workspace, f.db, {});
    expect(() => growth.assertDatabaseWritable()).not.toThrow();
    expect(() => growth.assertAssetGrowth(-1)).toThrow(
      /workspace-limit-unknown/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("fails closed when SQLite cannot report a safe logical size", () => {
  const f = fixture();
  f.db.close();
  try {
    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxDatabaseBytes: 1,
      }).assertDatabaseWritable(),
    ).toThrow(/workspace-limit-unknown/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }

  const fake = {
    prepare: () => ({
      get: () => ({
        page_count: Number.MAX_SAFE_INTEGER,
        page_size: 2,
      }),
    }),
  } as unknown as DatabaseSync;
  expect(() =>
    new WorkspaceGrowth("/virtual/workspace", fake, {
      maxDatabaseBytes: Number.MAX_SAFE_INTEGER,
    }).assertDatabaseWritable(),
  ).toThrow(/workspace-limit-unknown/);
});

it("budgets every regular file under assets, including unregistered ones", () => {
  const f = fixture();
  try {
    const first = write(f.workspace, "assets/a.bin", "abc");
    const second = write(f.workspace, "assets/nested/b.bin", "12345");
    const unregistered = write(
      f.workspace,
      "assets/unregistered.dat",
      "1234567",
    );
    const total = first + second + unregistered;
    expect(total).toBe(15);

    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxAssetBytes: total + 2,
      }).assertAssetGrowth(2),
    ).not.toThrow();
    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxAssetBytes: total + 1,
      }).assertAssetGrowth(2),
    ).toThrow(/workspace-limit-exceeded/);
    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxAssetBytes: total - 1,
      }).assertAssetGrowth(0),
    ).toThrow(/workspace-limit-exceeded/);

    expect(readFileSync(join(f.workspace, "assets/nested/b.bin"), "utf8")).toBe(
      "12345",
    );
    expect(existsSync(join(f.workspace, "assets/unregistered.dat"))).toBe(true);
    expect(existsSync(join(f.workspace, "workspace.sqlite"))).toBe(true);
  } finally {
    dispose(f);
  }
});

it("counts staged and active assets together before downloads and publication", () => {
  const f = fixture();
  try {
    write(f.workspace, "assets/active.bin", "123");
    write(f.workspace, ".folio-sync-assets-staging/complete.bin", "12345");
    write(f.workspace, ".folio-sync-assets-staging/partial.part", "12");
    const growth = new WorkspaceGrowth(f.workspace, f.db, {maxAssetBytes: 15});
    expect(() => growth.assertAssetGrowth(5)).not.toThrow();
    expect(() => growth.assertAssetGrowth(6)).toThrow(/workspace-limit-exceeded/);
    expect(readFileSync(join(f.workspace, ".folio-sync-assets-staging/partial.part"), "utf8")).toBe("12");
  } finally { dispose(f); }
});

it("fails closed if staged attachment usage cannot be measured safely", () => {
  const f = fixture();
  try {
    write(f.root, "outside/keep.bin", "123");
    symlinkSync(join(f.root, "outside"), join(f.workspace, ".folio-sync-assets-staging"));
    expect(() => new WorkspaceGrowth(f.workspace, f.db, {maxAssetBytes: 10}).assertAssetGrowth(0))
      .toThrow(/workspace-limit-unknown/);
    expect(readFileSync(join(f.root, "outside/keep.bin"), "utf8")).toBe("123");
  } finally { dispose(f); }
});

it("reserves space for the active copy without losing the staged asset", () => {
  const f = fixture();
  try {
    const body = "valid staged bytes";
    const asset = {id: randomUUID() + ".bin", bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex")};
    const staging = join(f.workspace, ".folio-sync-assets-staging");
    const active = join(f.workspace, "assets");
    write(f.workspace, `.folio-sync-assets-staging/${asset.id}`, body);
    mkdirSync(active);
    const full = new WorkspaceGrowth(f.workspace, f.db, {maxAssetBytes: asset.bytes});
    expect(() => publishCheckpointAssetsFromStaging(staging, active, [asset],
      (bytes) => full.assertAssetGrowth(bytes))).toThrow(/workspace-limit-exceeded/);
    expect(existsSync(join(active, asset.id))).toBe(false);
    expect(readFileSync(join(staging, asset.id), "utf8")).toBe(body);
    const room = new WorkspaceGrowth(f.workspace, f.db, {maxAssetBytes: asset.bytes * 2});
    publishCheckpointAssetsFromStaging(staging, active, [asset], (bytes) => room.assertAssetGrowth(bytes));
    expect(readFileSync(join(active, asset.id), "utf8")).toBe(body);
  } finally { dispose(f); }
});

it("treats only a genuinely missing managed directory as zero bytes", () => {
  const f = fixture();
  try {
    const assets = new WorkspaceGrowth(f.workspace, f.db, {
      maxAssetBytes: 0,
    });
    expect(() => assets.assertAssetGrowth(0)).not.toThrow();
    expect(() => assets.assertAssetGrowth(1)).toThrow(
      /workspace-limit-exceeded/,
    );

    const backups = new WorkspaceGrowth(f.workspace, f.db, {
      maxBackupBytes: 0,
    });
    expect(() => backups.assertBackupGrowth(0)).not.toThrow();
    expect(() => backups.assertBackupGrowth(1)).toThrow(
      /workspace-limit-exceeded/,
    );

    expect(existsSync(join(f.workspace, "assets"))).toBe(false);
    expect(existsSync(join(f.workspace, "backups"))).toBe(false);
  } finally {
    dispose(f);
  }
});

it("fails closed when a symlink is skipped inside the managed assets tree", () => {
  const f = fixture();
  try {
    write(f.workspace, "assets/real.bin", "abc");
    const external = write(f.root, "outside/huge.bin", "x".repeat(64 * 1024));
    symlinkSync(
      join(f.root, "outside/huge.bin"),
      join(f.workspace, "assets/link.bin"),
    );

    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxAssetBytes: 3,
      }).assertAssetGrowth(0),
    ).toThrow(/workspace-limit-unknown/);
    expect(existsSync(join(f.root, "outside/huge.bin"))).toBe(true);
    expect(statSync(join(f.root, "outside/huge.bin")).size).toBe(external);
    expect(readFileSync(join(f.root, "outside/huge.bin"), "utf8")).toHaveLength(
      64 * 1024,
    );
  } finally {
    dispose(f);
  }
});

it("fails closed when a managed root is a symlink", () => {
  const f = fixture();
  try {
    write(f.root, "outside/huge.bin", "x".repeat(64 * 1024));
    symlinkSync(join(f.root, "outside"), join(f.workspace, "assets"));

    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxAssetBytes: 1,
      }).assertAssetGrowth(0),
    ).toThrow(/workspace-limit-unknown/);
    expect(existsSync(join(f.root, "outside/huge.bin"))).toBe(true);
  } finally {
    dispose(f);
  }
});

it("does not treat a missing workspace root or linked root as zero", () => {
  const f = fixture();
  try {
    const actual = join(f.root, "actual-workspace");
    mkdirSync(actual);
    write(actual, "assets/inside.bin", "x");
    const linked = join(f.root, "linked-workspace");
    symlinkSync(actual, linked);

    const linkedGrowth = new WorkspaceGrowth(linked, f.db, {
      maxAssetBytes: 0,
      maxBackupBytes: 0,
    });
    expect(() => linkedGrowth.assertAssetGrowth(0)).toThrow(
      /workspace-limit-unknown/,
    );
    expect(() => linkedGrowth.assertBackupGrowth(0)).toThrow(
      /workspace-limit-unknown/,
    );

    const absent = new WorkspaceGrowth(join(f.root, "absent-workspace"), f.db, {
      maxAssetBytes: 0,
    });
    expect(() => absent.assertAssetGrowth(0)).toThrow(
      /workspace-limit-unknown/,
    );
    expect(existsSync(join(f.root, "absent-workspace"))).toBe(false);
    expect(existsSync(actual)).toBe(true);
  } finally {
    dispose(f);
  }
});

it("fails closed on unsafe projections and allows exact equality", () => {
  const f = fixture();
  try {
    const growth = new WorkspaceGrowth(f.workspace, f.db, {
      maxAssetBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(() =>
      growth.assertAssetGrowth(Number.MAX_SAFE_INTEGER),
    ).not.toThrow();

    write(f.workspace, "assets/one.byte", "x");
    expect(() => growth.assertAssetGrowth(Number.MAX_SAFE_INTEGER)).toThrow(
      /workspace-limit-unknown/,
    );

    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => growth.assertAssetGrowth(bad)).toThrow(
        /workspace-limit-unknown/,
      );
    }
  } finally {
    dispose(f);
  }
});

it("budgets backups recursively and keeps existing data after a refusal", () => {
  const f = fixture();
  try {
    const database = write(
      f.workspace,
      "backups/one/workspace.sqlite",
      "dbdata",
    );
    const asset = write(f.workspace, "backups/one/assets/a.bin", "asset");
    const extra = write(f.workspace, "backups/two/unregistered.bin", "extra");
    const total = database + asset + extra;

    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxBackupBytes: total + 4,
      }).assertBackupGrowth(4),
    ).not.toThrow();
    expect(() =>
      new WorkspaceGrowth(f.workspace, f.db, {
        maxBackupBytes: total + 3,
      }).assertBackupGrowth(4),
    ).toThrow(/workspace-limit-exceeded/);

    expect(
      readFileSync(join(f.workspace, "backups/one/workspace.sqlite"), "utf8"),
    ).toBe("dbdata");
    expect(
      readFileSync(join(f.workspace, "backups/two/unregistered.bin"), "utf8"),
    ).toBe("extra");
  } finally {
    dispose(f);
  }
});
