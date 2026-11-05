/**
 * L3-C independent durability tests for the baseline full-backup path.
 *
 * These tests exercise the real create/verify/restore functions in-process and
 * restore into a separate temporary workspace. They do not claim physical
 * power-loss durability; that requires hardware/OS fault injection and is
 * explicitly NOT_RUN in FAULT-MATRIX.ja.md.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import {
  commitPageOperation,
  resolvePageOperation,
} from "../src/persistence/page-operations";
import { Store } from "../src/persistence/store";
import { preparePageCreation } from "../src/shared/page-operation";

const MARKER = "FOLIO-RECOVERY-INCOMPLETE";
const roots: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function openStore(path: string): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function count(store: Store, table: string): number {
  return (
    store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

function integrity(store: Store): string {
  const rows = store.db
    .prepare("PRAGMA integrity_check")
    .all() as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  return String(Object.values(rows[0])[0]);
}

/** Raw SQLite content, independent of Store projections. */
function captureTables(store: Store) {
  return {
    pages: store.db
      .prepare("SELECT id,data,body FROM pages ORDER BY id")
      .all(),
    versions: store.db
      .prepare(
        "SELECT id,pageId,createdAt,title,doc,database FROM versions ORDER BY id",
      )
      .all(),
    settings: store.db
      .prepare("SELECT key,value FROM settings ORDER BY key")
      .all(),
    receipts: store.db
      .prepare(
        "SELECT operation_id,fingerprint,result_json FROM save_receipts ORDER BY operation_id",
      )
      .all(),
    assets: store.db
      .prepare("SELECT id,metadata FROM assets ORDER BY id")
      .all(),
    userVersion: (
      store.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version,
  };
}

it("creates a verified complete backup and restores it to a different directory with identical logical content and attachment digests", () => {
  const root = tempRoot("folio-l3-durability-backup-");
  const sourceDirectory = join(root, "source");
  mkdirSync(sourceDirectory);
  const source = openStore(join(sourceDirectory, "workspace.sqlite"));
  expect(integrity(source)).toBe("ok");

  const parent = source.create(null, "page", "親ページ");
  const child = source.create(parent.id, "page", "子ページ");
  const operation = preparePageCreation("レシート付きページ", null);
  const applied = commitPageOperation(source, operation);
  expect(applied.status).toBe("applied");
  const edited = source.update(child.id, child.revision, {
    title: "子ページ 更新",
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "履歴に残す本文" }],
        },
      ],
    },
  });
  source.handle({ type: "setting", key: "activePage", value: edited.id });

  const assetsDirectory = join(sourceDirectory, "assets");
  mkdirSync(assetsDirectory);
  const textBody = Buffer.from("durability text attachment\n", "utf8");
  const imagePath = resolve("tests/fixtures/image.png");
  const textInput = join(root, "text.txt");
  writeFileSync(textInput, textBody);
  const textAsset = attachFile(source.db, assetsDirectory, textInput) as {
    id: string;
    sha256: string;
  };
  const imageAsset = attachFile(source.db, assetsDirectory, imagePath) as {
    id: string;
    sha256: string;
  };

  const sourceBefore = captureTables(source);
  const sourceAssetDigests = {
    [textAsset.id]: sha256File(join(assetsDirectory, textAsset.id)),
    [imageAsset.id]: sha256File(join(assetsDirectory, imageAsset.id)),
  };
  expect(sourceAssetDigests[textAsset.id]).toBe(textAsset.sha256);
  expect(sourceAssetDigests[imageAsset.id]).toBe(imageAsset.sha256);

  const destination = join(root, "backup");
  const created = createFullBackup(
    source.db,
    sourceDirectory,
    destination,
  );
  expect(created.directory).toBe(destination);
  expect(existsSync(join(destination, MARKER))).toBe(false);
  expect(created.manifest.inventory).toEqual({
    pages: 3,
    recordDatabases: 0,
    records: 0,
    versions: 1,
    settings: 1,
    saveReceipts: 1,
    registeredAssets: 2,
  });
  expect(created.manifest.database.sha256).toBe(
    sha256File(join(destination, "workspace.sqlite")),
  );
  expect(
    Object.fromEntries(
      created.manifest.assets.map((file) => [file.path, file.sha256]),
    ),
  ).toEqual({
    [`assets/${textAsset.id}`]: textAsset.sha256,
    [`assets/${imageAsset.id}`]: imageAsset.sha256,
  });

  const verified = verifyFullBackup(destination);
  expect(verified.fingerprint).toBe(created.fingerprint);
  expect(verified.manifest).toEqual(created.manifest);

  const restoreDirectory = join(root, "restored");
  const restored = restoreFullBackup(destination, restoreDirectory);
  expect(restored.directory).toBe(restoreDirectory);
  expect(restored.sourceFingerprint).toBe(verified.fingerprint);
  expect(restored.manifest).toEqual(verified.manifest);
  expect(existsSync(join(restoreDirectory, MARKER))).toBe(false);
  expect(sha256File(join(restoreDirectory, "workspace.sqlite"))).toBe(
    verified.manifest.database.sha256,
  );
  for (const file of verified.manifest.assets)
    expect(sha256File(join(restoreDirectory, file.path))).toBe(file.sha256);

  const restoredStore = openStore(
    join(restoreDirectory, "workspace.sqlite"),
  );
  expect(integrity(restoredStore)).toBe("ok");
  expect(captureTables(restoredStore)).toEqual(sourceBefore);
  expect(restoredStore.get(parent.id).title).toBe("親ページ");
  expect(restoredStore.get(edited.id).title).toBe("子ページ 更新");
  expect(resolvePageOperation(restoredStore, operation)).toEqual(applied);
  expect(count(restoredStore, "save_receipts")).toBe(1);
  expect(count(restoredStore, "versions")).toBe(1);

  // Backup creation and restore must not modify the source.
  expect(captureTables(source)).toEqual(sourceBefore);
  expect(sha256File(join(assetsDirectory, textAsset.id))).toBe(
    textAsset.sha256,
  );
  expect(sha256File(join(assetsDirectory, imageAsset.id))).toBe(
    imageAsset.sha256,
  );
  expect(integrity(source)).toBe("ok");
}, 30_000);

it("rejects a restore whose expected fingerprint does not match the verified backup and leaves no destination behind", () => {
  const root = tempRoot("folio-l3-durability-fingerprint-");
  const sourceDirectory = join(root, "source");
  mkdirSync(sourceDirectory);
  const source = openStore(join(sourceDirectory, "workspace.sqlite"));
  source.create(null, "page", "fingerprint source");

  const destination = join(root, "backup");
  createFullBackup(source.db, sourceDirectory, destination);
  const verified = verifyFullBackup(destination);
  const restoreDirectory = join(root, "restore-wrong-fingerprint");
  expect(() =>
    restoreFullBackup(destination, restoreDirectory, "0".repeat(64)),
  ).toThrow(/前回の確認時から変更されています/);
  expect(existsSync(restoreDirectory)).toBe(false);
  expect(verifyFullBackup(destination).fingerprint).toBe(verified.fingerprint);
}, 30_000);
