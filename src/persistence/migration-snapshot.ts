import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as SQLite } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

/**
 * Capture the complete pre-migration SQLite image and flat attachment folder.
 * Caller MUST hold exclusive workspace ownership and prevent all database and
 * asset writes until this returns. SQLite's snapshot and filesystem copying are
 * not atomic together and this function cannot enforce that external condition.
 * The destination must not already exist. An incomplete directory left by a
 * crash or failure is retained and never reused or treated as complete; only a
 * returned, verified snapshot with manifest.json published last is usable.
 * The pending manifest is retained as well. No crash-durability claim or
 * startup integration is made.
 */
export function createMigrationSnapshot(
  db: DatabaseSync,
  assetsPath: string,
  destination: string,
): void {
  if (db.isTransaction)
    throw new Error("Migration snapshot requires no active transaction");
  if (!isAbsolute(assetsPath) || !isAbsolute(destination))
    throw new Error("Snapshot paths must be absolute");
  const assetStat = lstatSync(assetsPath);
  if (!assetStat.isDirectory() || assetStat.isSymbolicLink())
    throw new Error("Assets directory is missing or unsafe");
  const assets = realpathSync(assetsPath),
    parent = realpathSync(dirname(destination));
  const target = resolve(parent, basename(destination));
  const relation = relative(assets, target);
  if (
    !relation ||
    (!relation.startsWith(".." + sep) &&
      relation !== ".." &&
      !isAbsolute(relation))
  )
    throw new Error("Snapshot destination cannot be in assets");
  // Exclusive creation ensures that a previous snapshot (including an aborted
  // attempt) can never be overwritten or silently mistaken for a valid backup.
  mkdirSync(target);
  const snapshotPath = join(target, "workspace.sqlite"),
    outputAssets = join(target, "assets");
  db.prepare("VACUUM INTO ?").run(snapshotPath);
  mkdirSync(outputAssets);
  const snapshot = new SQLite(snapshotPath, { readOnly: true });
  try {
    const checks = snapshot.prepare("PRAGMA integrity_check").all() as {
      integrity_check: string;
    }[];
    if (checks.length !== 1 || checks[0].integrity_check !== "ok")
      throw new Error("Snapshot SQLite integrity check failed");
    const rows = snapshot.prepare("SELECT id,metadata FROM assets").all() as {
      id: string;
      metadata: string;
    }[];
    const registered = new Map<string, { size: number; sha256: string }>();
    for (const row of rows) {
      let value: any;
      try {
        value = JSON.parse(row.metadata);
      } catch {
        throw new Error("Invalid asset metadata; snapshot not completed");
      }
      if (
        !value ||
        typeof row.id !== "string" ||
        !row.id ||
        basename(row.id) !== row.id ||
        value.id !== row.id ||
        value.storageName !== row.id ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sha256)
      )
        throw new Error("Invalid asset metadata; snapshot not completed");
      registered.set(row.id, { size: value.size, sha256: value.sha256 });
    }
    const names = readdirSync(assets).sort();
    for (const name of names) {
      const input = join(assets, name),
        output = join(outputAssets, name),
        info = lstatSync(input);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Unsupported asset entry; snapshot not completed");
      copyFileSync(input, output, constants.COPYFILE_EXCL);
      const sourceBytes = readFileSync(input),
        outputBytes = readFileSync(output);
      const digest = (bytes: Buffer) =>
        createHash("sha256").update(bytes).digest("hex");
      const hash = digest(sourceBytes),
        metadata = registered.get(name);
      if (
        hash !== digest(outputBytes) ||
        (metadata &&
          (metadata.size !== sourceBytes.length || metadata.sha256 !== hash))
      )
        throw new Error("Asset verification failed; snapshot not completed");
      registered.delete(name);
    }
    if (registered.size)
      throw new Error("Registered asset missing; snapshot not completed");
    if (JSON.stringify(readdirSync(assets).sort()) !== JSON.stringify(names))
      throw new Error("Assets changed while snapshotting");
  } finally {
    snapshot.close();
  }
  const pendingManifest = join(target, ".manifest-pending.json");
  writeFileSync(
    pendingManifest,
    JSON.stringify(
      {
        format: "folio-pre-migration-snapshot",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sqlite: "workspace.sqlite",
        assets: "assets",
        consistency: "requires-exclusive-workspace",
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  // Publish only after the complete manifest was written. A hard link is
  // exclusive and does not replace an entry another actor created. Leave
  // the pending file in place so there is no cleanup after publication.
  linkSync(pendingManifest, join(target, "manifest.json"));
}
