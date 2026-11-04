import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
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
import { isDeepStrictEqual } from "node:util";
import type {
  BackupFile,
  RestoredWorkspace,
  WorkspaceBackupManifest,
} from "../shared/workspace-backup";
import { verifyFullBackup } from "./full-backup-verify";

const INCOMPLETE_MARKER = "FOLIO-RECOVERY-INCOMPLETE";
const MANIFEST_FILE = "manifest.json";
const DATABASE_FILE = "workspace.sqlite";
const MARKER_TEXT = "Recovery incomplete; do not open this workspace.\n";
const ASSET_PREFIX = "assets/";
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 50_000_000;
const COPY_CHUNK = 1024 * 1024;

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
  );
}

/** Resolve existing ancestors so a symlinked parent cannot turn a supposedly
 * new destination into an alias of the backup folder. */
function actualPath(path: string): string {
  const absolute = resolve(path);
  try {
    lstatSync(absolute);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(actualPath(parent), basename(absolute));
  }
  return realpathSync(absolute);
}

function resolveInside(root: string, value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value)
  )
    throw new Error("バックアップ内のパスが不正です。");
  const target = resolve(root, value);
  if (!inside(root, target) || target === root)
    throw new Error("バックアップ内のパスが不正です。");
  return target;
}

function assertAssetPath(value: string): void {
  if (!value.startsWith(ASSET_PREFIX) || value.includes("\\"))
    throw new Error("バックアップのassetsパスが不正です。");
  const rest = value.slice(ASSET_PREFIX.length);
  if (
    rest.length === 0 ||
    rest.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("バックアップのassetsパスが不正です。");
}

function assertBackupFile(file: BackupFile, label: string): void {
  if (!file || typeof file !== "object")
    throw new Error(`バックアップの${label}情報が不正です。`);
  if (typeof file.path !== "string" || file.path.length === 0)
    throw new Error(`バックアップの${label}パスが不正です。`);
  if (
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    typeof file.sha256 !== "string" ||
    !SHA256.test(file.sha256)
  )
    throw new Error(`バックアップの${label}情報が不正です。`);
}

function assertManifest(manifest: WorkspaceBackupManifest): void {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.format !== "folio-workspace-backup" ||
    manifest.version !== 1
  )
    throw new Error("バックアップのmanifestが不正です。");
  assertBackupFile(manifest.database, "database");
  if (manifest.database.path !== DATABASE_FILE)
    throw new Error("バックアップのdatabaseパスが不正です。");
  if (!Array.isArray(manifest.assets))
    throw new Error("バックアップのassets一覧が不正です。");
  const paths = new Set<string>([DATABASE_FILE, MANIFEST_FILE, INCOMPLETE_MARKER]);
  for (const asset of manifest.assets) {
    assertBackupFile(asset, "assets");
    assertAssetPath(asset.path);
    if (paths.has(asset.path))
      throw new Error("バックアップ内でファイルパスが重複しています。");
    paths.add(asset.path);
  }
}

function assertNoSymlinkChain(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("バックアップ内のパスが不正です。");
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink())
      throw new Error("バックアップ内にシンボリックリンクがあります。");
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readRegularFile(root: string, value: string, maxBytes: number): Buffer {
  const path = resolveInside(root, value);
  assertNoSymlinkChain(root, path);
  const before = lstatSync(path);
  if (!before.isFile() || before.size > maxBytes)
    throw new Error("バックアップ内のファイルが不正です。");
  const target = realpathSync(path);
  if (!inside(root, target) || target === root)
    throw new Error("バックアップ内のパスが不正です。");
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    if (!after.isFile() || after.size !== before.size || after.size > maxBytes)
      throw new Error("バックアップ内のファイルが不正です。");
    const buffer = Buffer.allocUnsafe(after.size);
    let offset = 0;
    while (offset < after.size) {
      const count = readSync(fd, buffer, offset, after.size - offset, null);
      if (count <= 0) throw new Error("バックアップ内のファイルを読み込めません。");
      offset += count;
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function ensureDirectoryChain(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("復元先のパスが不正です。");
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (entryExists(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("復元先のパスが不正です。");
    } else {
      mkdirSync(cursor, { mode: 0o700 });
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("復元先のパスが不正です。");
    }
  }
}

function writeAll(fd: number, buffer: Buffer, length: number): void {
  let offset = 0;
  while (offset < length) {
    const count = writeSync(fd, buffer, offset, length - offset);
    if (count <= 0) throw new Error("バックアップを書き込めません。");
    offset += count;
  }
}

function copyVerifiedFile(
  sourceRoot: string,
  destinationRoot: string,
  file: BackupFile,
): void {
  const sourcePath = resolveInside(sourceRoot, file.path);
  const destinationPath = resolveInside(destinationRoot, file.path);
  ensureDirectoryChain(destinationRoot, dirname(destinationPath));
  assertNoSymlinkChain(sourceRoot, sourcePath);

  const sourceFd = openSync(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let destinationFd: number | undefined;
  try {
    const stat = fstatSync(sourceFd);
    if (!stat.isFile() || stat.size !== file.bytes)
      throw new Error("バックアップのファイルが検証時と異なります。");
    destinationFd = openSync(
      destinationPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let offset = 0;
    while (offset < stat.size) {
      const count = readSync(
        sourceFd,
        buffer,
        0,
        Math.min(COPY_CHUNK, stat.size - offset),
        null,
      );
      if (count <= 0) throw new Error("バックアップのファイルを読み込めません。");
      hash.update(buffer.subarray(0, count));
      writeAll(destinationFd, buffer, count);
      offset += count;
    }
    if (offset !== file.bytes || hash.digest("hex") !== file.sha256)
      throw new Error("バックアップのファイルが検証時と異なります。");
    fsyncSync(destinationFd);
    closeSync(destinationFd);
    destinationFd = undefined;
    syncPath(dirname(destinationPath));
  } finally {
    closeSync(sourceFd);
    if (destinationFd !== undefined) closeSync(destinationFd);
  }
}

function assertRestoreDestination(source: string, destination: string): void {
  if (entryExists(destination))
    throw new Error("復元先には存在しないフォルダを指定してください。");
  const realSource = realpathSync(source);
  let realDestination: string;
  try {
    realDestination = actualPath(destination);
  } catch (error: any) {
    if (error?.code === "ENOENT")
      throw new Error("復元先の親フォルダが存在しません。");
    throw error;
  }
  if (inside(realSource, realDestination))
    throw new Error("バックアップの中や同じ場所には復元できません。");
}

/**
 * Restore a verified full workspace backup into a new, exclusively reserved
 * folder. The source is verified again before any output is created and after
 * copying; only the database, registered assets and manifest are written.
 * A failure leaves the destination marked incomplete for diagnosis, never
 * deletes it, and never modifies the source backup.
 */
export function restoreFullBackup(
  sourceBackup: string,
  destination: string,
  expectedFingerprint?: string,
): RestoredWorkspace {
  if (
    typeof sourceBackup !== "string" ||
    sourceBackup.length === 0 ||
    typeof destination !== "string" ||
    destination.length === 0
  )
    throw new Error("バックアップ元と復元先を指定してください。");

  const source = resolve(sourceBackup);
  const target = resolve(destination);
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory())
    throw new Error("バックアップ元が不正です。");
  // Canonicalize existing ancestors (for example /var -> /private/var) so the
  // per-file symlink checks and containment checks use one stable root.
  const sourceRoot = realpathSync(source);

  const sourceVerified = verifyFullBackup(sourceRoot);
  assertManifest(sourceVerified.manifest);
  if (
    expectedFingerprint !== undefined &&
    sourceVerified.fingerprint !== expectedFingerprint
  )
    throw new Error(
      "バックアップが前回の確認時から変更されています。復元を中止しました。",
    );

  // Read the exact manifest bytes only after verification. They are copied
  // unchanged, but must still describe the verified object.
  const manifestBytes = readRegularFile(
    sourceRoot,
    MANIFEST_FILE,
    MAX_MANIFEST_BYTES,
  );
  let manifestOnDisk: unknown;
  try {
    manifestOnDisk = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("バックアップのmanifestが不正です。");
  }
  if (!isDeepStrictEqual(manifestOnDisk, sourceVerified.manifest))
    throw new Error("バックアップのmanifestが検証時と異なります。");

  assertRestoreDestination(sourceRoot, target);

  // mkdir without recursive mode is the exclusive reservation. Any existing
  // file, folder or symlink (including a dangling link) was rejected above.
  mkdirSync(target, { mode: 0o700 });
  const markerPath = join(target, INCOMPLETE_MARKER);
  writeFileSync(markerPath, MARKER_TEXT, { flag: "wx", mode: 0o600 });
  syncPath(markerPath);
  syncPath(target);

  copyVerifiedFile(sourceRoot, target, sourceVerified.manifest.database);
  for (const asset of sourceVerified.manifest.assets)
    copyVerifiedFile(sourceRoot, target, asset);

  const destinationManifest = join(target, MANIFEST_FILE);
  writeFileSync(destinationManifest, manifestBytes, {
    flag: "wx",
    mode: 0o600,
  });
  syncPath(destinationManifest);
  syncPath(target);

  // The source may have changed after verification or while bytes were copied.
  // Re-run the full verification and require the same object/fingerprint.
  const sourceAfterCopy = verifyFullBackup(sourceRoot);
  if (
    sourceAfterCopy.fingerprint !== sourceVerified.fingerprint ||
    !isDeepStrictEqual(sourceAfterCopy.manifest, sourceVerified.manifest) ||
    (expectedFingerprint !== undefined &&
      sourceAfterCopy.fingerprint !== expectedFingerprint)
  )
    throw new Error(
      "バックアップがコピー中に変更されました。復元を中止しました。",
    );

  const destinationVerified = verifyFullBackup(target, {
    allowIncomplete: true,
  });
  if (
    destinationVerified.fingerprint !== sourceVerified.fingerprint ||
    !isDeepStrictEqual(destinationVerified.manifest, sourceVerified.manifest)
  )
    throw new Error("復元先の検証に失敗しました。");

  // Complete the workspace only after every byte, manifest and fingerprint
  // has been re-verified. On any earlier failure this marker remains.
  unlinkSync(markerPath);
  syncPath(target);
  return {
    directory: target,
    sourceFingerprint: sourceAfterCopy.fingerprint,
    manifest: destinationVerified.manifest,
  };
}
