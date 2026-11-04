import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as SQLite } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  BackupFile,
  SnapshotInspection,
  VerifiedWorkspaceBackup,
  WorkspaceBackupManifest,
} from "../shared/workspace-backup";
import { inspectWorkspaceSnapshot, verifyFullBackup } from "./full-backup-verify";

const MARKER = "FOLIO-RECOVERY-INCOMPLETE";
const MANIFEST = "manifest.json";
const DATABASE = "workspace.sqlite";
const ASSETS = "assets";

/** Resolve existing ancestors too. A broken link or inaccessible ancestor is an
 * error, not a reason to allow the write. */
function actualPath(path: string): string {
  const absolute = resolve(path);
  const info = lstatIfExists(absolute);
  if (info) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error("バックアップ先を解決できません");
  return join(actualPath(parent), basename(absolute));
}

function lstatIfExists(path: string) {
  try {
    return lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!relation.startsWith(".." + sep) && relation !== ".." && !isAbsolute(relation))
  );
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type CopiedAsset = { bytes: number; sha256: string };

/**
 * Copy every regular file below the source assets directory without following
 * any symbolic link. Extra, unregistered regular files are intentionally kept.
 */
function copyAssetTree(
  sourceRoot: string,
  outputRoot: string,
  source: string = sourceRoot,
  output: string = outputRoot,
  copied: Map<string, CopiedAsset> = new Map(),
): Map<string, CopiedAsset> {
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const from = join(source, entry.name),
      to = join(output, entry.name),
      info = lstatSync(from);
    if (info.isSymbolicLink())
      throw new Error(
        "添付フォルダにシンボリックリンクがあるためバックアップできません: " +
          entry.name,
      );
    if (info.isDirectory()) {
      mkdirSync(to, { mode: 0o700 });
      copyAssetTree(sourceRoot, outputRoot, from, to, copied);
      continue;
    }
    if (!info.isFile())
      throw new Error(
        "添付フォルダに通常ファイル以外の項目があります: " + entry.name,
      );
    // Read once and write those exact bytes. A concurrent source mutation can
    // therefore never produce a destination assembled from two versions.
    const bytes = readFileSync(from);
    writeFileSync(to, bytes, { flag: "wx", mode: 0o600 });
    const written = readFileSync(to);
    if (!written.equals(bytes))
      throw new Error("添付ファイルのコピーを検証できません: " + entry.name);
    copied.set(
      relative(sourceRoot, from).split(sep).join("/"),
      { bytes: written.length, sha256: digest(written) },
    );
  }
  return copied;
}

/** Validate the copied immutable attachments against the asset registry in the
 * just-created SQLite snapshot, not against the still-live source database. */
function validateRegisteredAssets(
  snapshotPath: string,
  copied: Map<string, CopiedAsset>,
): void {
  const snapshot = new SQLite(snapshotPath, { readOnly: true });
  try {
    const checks = snapshot.prepare("PRAGMA integrity_check").all() as Record<
      string,
      unknown
    >[];
    if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok")
      throw new Error("SQLiteスナップショットの整合性を検証できません");
    if (
      !snapshot
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='assets'",
        )
        .get()
    )
      return;
    const rows = snapshot.prepare("SELECT id,metadata FROM assets").all() as {
      id: string;
      metadata: string;
    }[];
    for (const row of rows) {
      let metadata: any;
      try {
        metadata = JSON.parse(row.metadata);
      } catch {
        throw new Error("添付情報が不正なためバックアップを完了できません");
      }
      if (
        !metadata ||
        typeof row.id !== "string" ||
        !row.id ||
        basename(row.id) !== row.id ||
        metadata.id !== row.id ||
        metadata.storageName !== row.id ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        typeof metadata.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256)
      )
        throw new Error("添付情報が不正なためバックアップを完了できません");
      const file = copied.get(row.id);
      if (!file)
        throw new Error(
          "登録済み添付がスナップショットに存在しません: " + row.id,
        );
      if (file.bytes !== metadata.size || file.sha256 !== metadata.sha256)
        throw new Error("添付ファイルがスナップショットと一致しません: " + row.id);
    }
  } finally {
    snapshot.close();
  }
}

function writeManifest(
  target: string,
  manifest: WorkspaceBackupManifest,
): void {
  const pending = join(target, `.manifest-${randomUUID()}.tmp`),
    published = join(target, MANIFEST);
  writeFileSync(pending, JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  syncPath(pending);
  // A hard link publishes the complete file atomically and fails if the name
  // already exists. It never replaces an earlier manifest.
  linkSync(pending, published);
  syncPath(published);
  syncPath(target);
  unlinkSync(pending);
}

/**
 * Create a verified, self-contained snapshot of a live workspace. The caller
 * must already hold exclusive workspace ownership: SQLite snapshotting and
 * filesystem copying are not atomic together across an external writer.
 * Every failure after reservation leaves the marker and partial directory in
 * place for diagnosis. Source data and unrelated destinations are never
 * removed or rewritten.
 */
export function createFullBackup(
  db: DatabaseSync,
  sourceDir: string,
  destination: string,
): VerifiedWorkspaceBackup {
  if (db.isTransaction !== false)
    throw new Error("未確定のトランザクションではバックアップを作成できません");

  const source = resolve(sourceDir),
    requested = resolve(destination);
  const sourceInfo = lstatSync(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory())
    throw new Error("バックアップ元が安全なディレクトリではありません");
  const root = realpathSync(source);

  const databasePath = join(root, DATABASE),
    databaseInfo = lstatSync(databasePath);
  if (databaseInfo.isSymbolicLink() || !databaseInfo.isFile())
    throw new Error("バックアップ元のSQLiteが安全なファイルではありません");

  const sourceAssets = join(root, ASSETS),
    assetsInfo = lstatIfExists(sourceAssets);
  if (
    assetsInfo &&
    (assetsInfo.isSymbolicLink() || !assetsInfo.isDirectory())
  )
    throw new Error("バックアップ元の添付フォルダが安全ではありません");
  const assetsReal = assetsInfo ? realpathSync(sourceAssets) : undefined;

  if (lstatIfExists(requested))
    throw new Error("バックアップ先が既に存在します");
  const target = actualPath(requested);
  if (lstatIfExists(target))
    throw new Error("バックアップ先が既に存在します");
  if (target === root)
    throw new Error("バックアップ元そのものには出力できません");
  if (
    inside(join(root, ASSETS), target) ||
    (assetsReal && inside(assetsReal, target))
  )
    throw new Error("バックアップ元の添付フォルダ内には出力できません");
  if (target === databasePath)
    throw new Error("バックアップ元のSQLiteには出力できません");

  // Exclusive creation reserves this exact directory. An existing directory,
  // file, dangling symlink, or a racing creator is never reused or replaced.
  mkdirSync(target, { mode: 0o700 });
  const marker = join(target, MARKER);
  writeFileSync(
    marker,
    "Backup incomplete; do not use or open this snapshot.\n",
    { flag: "wx", mode: 0o600 },
  );
  syncPath(marker);
  syncPath(target);

  const snapshotPath = join(target, DATABASE),
    outputAssets = join(target, ASSETS);
  db.prepare("VACUUM INTO ?").run(snapshotPath);

  mkdirSync(outputAssets, { mode: 0o700 });
  const copied = assetsInfo
    ? copyAssetTree(assetsReal!, outputAssets)
    : new Map<string, CopiedAsset>();
  validateRegisteredAssets(snapshotPath, copied);
  syncPath(snapshotPath);
  syncPath(outputAssets);
  syncPath(target);

  // The shared verifier is the only authority for inventory, logical hashes,
  // and attachment file records. Reusing its inspection keeps the manifest and
  // verification byte-for-byte consistent.
  const inspection: SnapshotInspection = inspectWorkspaceSnapshot(target);
  const databaseBytes = readFileSync(snapshotPath);
  const database: BackupFile = {
    path: DATABASE,
    bytes: databaseBytes.length,
    sha256: digest(databaseBytes),
  };
  const manifest: WorkspaceBackupManifest = {
    ...inspection,
    format: "folio-workspace-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    database,
  };
  writeManifest(target, manifest);

  const verified = verifyFullBackup(target, { allowIncomplete: true });
  // Deliberately the final mutation: a crash or failed verification always
  // leaves the incomplete marker behind.
  unlinkSync(marker);
  syncPath(target);
  return verified;
}
