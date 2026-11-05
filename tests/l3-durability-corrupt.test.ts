/**
 * L3-C independent G6 checks against the baseline full-backup path.
 *
 * These tests record current fail-closed behavior rather than assuming that a
 * damaged workspace can always be backed up. The source bytes are protected in
 * every case; the rescue route that remains available is Store.pageSource.
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
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { Store } from "../src/persistence/store";

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

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rawPages(store: Store) {
  return store.db
    .prepare("SELECT id,data,body FROM pages ORDER BY id")
    .all();
}

function integrity(store: Store): string {
  const rows = store.db
    .prepare("PRAGMA integrity_check")
    .all() as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  return String(Object.values(rows[0])[0]);
}

it("fails a backup closed when a Page row has invalid JSON, keeps the incomplete marker and source bytes, and leaves the raw rescue route usable", () => {
  const root = tempRoot("folio-l3-corrupt-backup-");
  const sourceDirectory = join(root, "source");
  mkdirSync(sourceDirectory);
  const source = openStore(join(sourceDirectory, "workspace.sqlite"));
  const healthy = source.create(null, "page", "Healthy searchable page");
  const broken = source.create(null, "page", "Broken original");
  const corruptSource = '{"id": "incomplete",\n';
  source.db
    .prepare("UPDATE pages SET data=? WHERE id=?")
    .run(corruptSource, broken.id);
  expect(integrity(source)).toBe("ok");

  const assetsDirectory = join(sourceDirectory, "assets");
  mkdirSync(assetsDirectory);
  const input = join(root, "corrupt-attachment.txt");
  const body = Buffer.from("asset copied before verification\n", "utf8");
  writeFileSync(input, body);
  const asset = attachFile(source.db, assetsDirectory, input) as {
    id: string;
  };
  const pagesBefore = rawPages(source);

  const destination = join(root, "backup");
  expect(() =>
    createFullBackup(source.db, sourceDirectory, destination),
  ).toThrow(/Invalid page document JSON/);

  // The failed backup is never published, but the marker and the copies made
  // before verification remain for diagnosis.
  expect(existsSync(join(destination, MARKER))).toBe(true);
  expect(existsSync(join(destination, "manifest.json"))).toBe(false);
  expect(sha256File(join(destination, "assets", asset.id))).toBe(
    createHash("sha256").update(body).digest("hex"),
  );
  const snapshot = new DatabaseSync(join(destination, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check,
    ).toBe("ok");
  } finally {
    snapshot.close();
  }

  // Source raw bytes are unchanged and the healthy Page stays usable after a
  // reopen. The corrupt Page remains read-only with its exact source available.
  expect(rawPages(source)).toEqual(pagesBefore);
  source.close();
  const reopened = openStore(join(sourceDirectory, "workspace.sqlite"));
  expect(integrity(reopened)).toBe("ok");
  expect(rawPages(reopened)).toEqual(pagesBefore);
  const loaded = reopened.load();
  expect(loaded.pages.find((page) => page.id === healthy.id)?.title).toBe(
    "Healthy searchable page",
  );
  const quarantined = loaded.pages.find((page) => page.id === broken.id);
  expect(quarantined?.documentError).toBeTruthy();
  expect(reopened.handle({ type: "pageSource", id: broken.id })).toBe(
    corruptSource,
  );
  expect(
    (
      reopened.handle({ type: "search", query: "searchable" }) as {
        id: string;
      }[]
    ).map((page) => page.id),
  ).toContain(healthy.id);
  expect(() =>
    reopened.update(broken.id, broken.revision, { title: "forged" }),
  ).toThrow();
  expect(rawPages(reopened)).toEqual(pagesBefore);

  // The marker is authoritative for verification, restore and Store open.
  expect(() => verifyFullBackup(destination)).toThrow(
    /FOLIO-RECOVERY-INCOMPLETE|Unexpected backup entry/,
  );
  const restoreTarget = join(root, "restore-attempt");
  expect(() => restoreFullBackup(destination, restoreTarget)).toThrow();
  expect(existsSync(restoreTarget)).toBe(false);
  expect(() => new Store(join(destination, "workspace.sqlite"))).toThrow(
    /復旧が完了していない/,
  );
}, 30_000);

it("stops a backup of an unknown schema without publishing it or modifying the source database", () => {
  const root = tempRoot("folio-l3-unknown-schema-");
  const sourceDirectory = join(root, "source");
  mkdirSync(sourceDirectory);
  const databasePath = join(sourceDirectory, "workspace.sqlite");
  const source = openStore(databasePath);
  const page = source.create(null, "page", "Future schema page");
  source.db.exec("PRAGMA user_version=5");
  const pagesBefore = rawPages(source);
  source.close();

  expect(() => new Store(databasePath)).toThrow(
    /requires a newer Folio version/,
  );

  const raw = new DatabaseSync(databasePath);
  try {
    expect(
      (raw.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(5);
    const destination = join(root, "backup");
    expect(() =>
      createFullBackup(raw, sourceDirectory, destination),
    ).toThrow(/Unsupported workspace database version/);
    expect(existsSync(join(destination, MARKER))).toBe(true);
    expect(existsSync(join(destination, "manifest.json"))).toBe(false);
    expect(
      (raw.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(5);
    expect(
      raw.prepare("SELECT id,data,body FROM pages ORDER BY id").all(),
    ).toEqual(pagesBefore);
    expect(
      raw.prepare("PRAGMA integrity_check").get()?.integrity_check,
    ).toBe("ok");
    expect(
      raw.prepare("SELECT id FROM pages WHERE id=?").get(page.id),
    ).toEqual({ id: page.id });
  } finally {
    raw.close();
  }
}, 30_000);
