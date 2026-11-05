import { DatabaseSync } from "node:sqlite";
import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
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
import { createHash, randomUUID } from "node:crypto";
import { estimateBackupBytes } from "../main/bulk-storage-budget";
import { durableFs, syncPath, writeNewFileDurably } from "./durable-file";

export function workspacePath(userData: string, override?: string) {
  return resolve(override || join(userData, "workspace"));
}

const DATABASE = "workspace.sqlite";
const ASSETS = "assets";
const MANIFEST = "manifest.json";
const MARKER = "FOLIO-RECOVERY-INCOMPLETE";
const MARKER_TEXT =
  "Migration incomplete; do not use or open this workspace.\n";
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
const TRACKED_SIDECARS = ["-wal", "-journal"] as const;
const CHUNK_BYTES = 1024 * 1024;
const MAX_ASSET_ENTRIES = 100_000;
const MAX_TREE_ENTRIES = MAX_ASSET_ENTRIES + 8;
const MAX_TREE_DEPTH = 64;

type FileRecord = { bytes: number; sha256: string };
type Sidecar = (typeof TRACKED_SIDECARS)[number];
type AssetFile = {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  stat: Stats;
};
type AssetTree = { directories: string[]; files: AssetFile[] };
type SourceState = {
  root: string;
  rootStat: Stats;
  databasePath: string;
  databaseStat: Stats;
  sidecars: Partial<Record<Sidecar, Stats>>;
  assetsRoot?: string;
  assets: AssetTree;
};
export type WorkspaceMigrationOptions = {
  beforeCopy?: (targetParent: string, additionalBytes: number) => void;
};

function lstatOptional(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(".." + sep) &&
      !isAbsolute(relation))
  );
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Resolve every existing ancestor. A broken link or inaccessible ancestor is
 * an error, never a reason to allow the write. */
function actualPath(path: string): string {
  const absolute = resolve(path);
  if (lstatOptional(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error("移行先を解決できません");
  return join(actualPath(parent), basename(absolute));
}

/** The closest existing directory, with its existing ancestors canonicalized.
 * Capacity admission needs a real directory to inspect. */
function nearestExistingDirectory(path: string): string {
  let current = resolve(path);
  for (;;) {
    const info = lstatOptional(current);
    if (info) {
      const real = realpathSync(current);
      const realInfo = lstatSync(real);
      if (realInfo.isSymbolicLink() || !realInfo.isDirectory())
        throw new Error("移行先の親フォルダが通常のディレクトリではありません");
      return real;
    }
    const parent = dirname(current);
    if (parent === current)
      throw new Error("移行先の親フォルダを解決できません");
    current = parent;
  }
}

function assertDisjoint(sourceRoot: string, destination: string): void {
  if (destination === sourceRoot || inside(sourceRoot, destination)) {
    // Preserve the original lexical refusal text for the ordinary nested-path
    // case, and explain canonical ancestor symlink aliases separately.
    if (destination.startsWith(sourceRoot + sep))
      throw new Error("移行元の中へは移行できません");
    throw new Error("移行先が移行元と同じ場所または内側を指しています");
  }
  if (inside(destination, sourceRoot))
    throw new Error("移行元が移行先の中にあります");
}

function openRegularFile(path: string, label: string) {
  const before = lstatOptional(path);
  if (!before) throw new Error(label + "が見つかりません");
  if (before.isSymbolicLink())
    throw new Error(label + "にシンボリックリンクがあります");
  if (!before.isFile()) throw new Error(label + "が通常ファイルではありません");
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFileState(before, opened))
      throw new Error(label + "を開く間にファイルが変化しました");
    return { descriptor, opened };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function hashRegularFile(path: string, label: string): FileRecord {
  const { descriptor, opened } = openRegularFile(path, label);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      if (!Number.isSafeInteger(total + read) || total + read > opened.size)
        throw new Error(label + "が読む間に変化しました");
      total += read;
      hash.update(buffer.subarray(0, read));
    }
    const after = fstatSync(descriptor);
    if (total !== opened.size || !sameFileState(opened, after))
      throw new Error(label + "が読む間に変化しました");
    return { bytes: total, sha256: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Copy exactly the bytes read from the source and verify the bytes that reached
 * the destination. The source identity is rechecked on both sides of the read,
 * so a concurrent replacement is a refusal rather than a mixed snapshot.
 */
function copyRegularFile(
  source: string,
  destination: string,
  label: string,
): FileRecord {
  const { descriptor: input, opened } = openRegularFile(source, label);
  let output: number | undefined;
  let created = false;
  try {
    output = durableFs.openSync(destination, "wx", 0o600);
    created = true;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(input, buffer, 0, buffer.length, null);
      if (read === 0) break;
      if (!Number.isSafeInteger(total + read) || total + read > opened.size)
        throw new Error(label + "がコピー中に変化しました");
      total += read;
      hash.update(buffer.subarray(0, read));
      let offset = 0;
      while (offset < read) {
        const written = writeSync(output, buffer, offset, read - offset);
        if (written <= 0) throw new Error(label + "のコピーを書き込めません");
        offset += written;
      }
    }
    if (total !== opened.size)
      throw new Error(label + "がコピー中に変化しました");
    const after = fstatSync(input);
    if (!sameFileState(opened, after))
      throw new Error(label + "がコピー中に変化しました");
    durableFs.fsyncSync(output);
    const written = fstatSync(output);
    if (!written.isFile() || written.size !== total)
      throw new Error(label + "のコピーを検証できません");
    const descriptor = output;
    output = undefined;
    durableFs.closeSync(descriptor);
    const sha256 = hash.digest("hex");
    const readback = hashRegularFile(destination, label + "のコピー");
    if (readback.bytes !== total || readback.sha256 !== sha256)
      throw new Error(label + "のコピー内容が一致しません");
    return { bytes: total, sha256 };
  } catch (error) {
    if (output !== undefined) {
      try {
        durableFs.closeSync(output);
      } catch {}
      output = undefined;
    }
    if (created) {
      try {
        durableFs.unlinkSync(destination);
      } catch {}
    }
    throw error;
  } finally {
    if (output !== undefined) {
      try {
        durableFs.closeSync(output);
      } catch {}
    }
    closeSync(input);
  }
}

function compareNames(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function scanAssetTree(root: string): AssetTree {
  const tree: AssetTree = { directories: [], files: [] };
  let entries = 0;
  const walk = (directory: string, prefix: string, depth: number): void => {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("移行元のassetsが安全なディレクトリではありません");
    for (const entry of readdirSync(directory, {
      withFileTypes: true,
    }).sort(compareNames)) {
      if (++entries > MAX_ASSET_ENTRIES)
        throw new Error("移行元のassetsの項目数上限を超えました");
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = lstatSync(path);
      if (child.isSymbolicLink())
        throw new Error(
          "移行元にシンボリックリンクがあります: " + relativePath,
        );
      if (child.isDirectory()) {
        if (depth >= MAX_TREE_DEPTH)
          throw new Error("移行元のassetsの階層が深すぎます");
        tree.directories.push(relativePath);
        walk(path, relativePath, depth + 1);
        continue;
      }
      if (!child.isFile())
        throw new Error(
          "移行元のassetsに通常ファイル以外の項目があります: " + relativePath,
        );
      if (!Number.isSafeInteger(child.size) || child.size < 0)
        throw new Error("移行元のassetsのファイルサイズが不正です");
      tree.files.push({
        relativePath,
        absolutePath: path,
        bytes: child.size,
        stat: child,
      });
    }
  };
  walk(root, "", 0);
  return tree;
}

function assertAssetTreeUnchanged(state: SourceState): void {
  if (!state.assetsRoot) {
    if (lstatOptional(join(state.root, ASSETS)))
      throw new Error("移行元が移行中に変化しました");
    return;
  }
  if (realpathSync(state.assetsRoot) !== state.assetsRoot)
    throw new Error("移行元にシンボリックリンクがあります: assets");
  const current = scanAssetTree(state.assetsRoot);
  if (
    current.directories.length !== state.assets.directories.length ||
    current.files.length !== state.assets.files.length
  )
    throw new Error("移行元が移行中に変化しました");
  for (let index = 0; index < current.directories.length; index++)
    if (current.directories[index] !== state.assets.directories[index])
      throw new Error("移行元が移行中に変化しました");
  for (let index = 0; index < current.files.length; index++) {
    const before = state.assets.files[index];
    const after = current.files[index];
    if (
      after.relativePath !== before.relativePath ||
      after.bytes !== before.bytes ||
      !sameFileState(before.stat, after.stat)
    )
      throw new Error("移行元が移行中に変化しました");
  }
}

function assertSourceUnchanged(state: SourceState): void {
  const root = lstatOptional(state.root);
  if (
    !root ||
    root.isSymbolicLink() ||
    !root.isDirectory() ||
    !sameIdentity(state.rootStat, root) ||
    realpathSync(state.root) !== state.root ||
    lstatOptional(join(state.root, MARKER))
  )
    throw new Error("移行元が移行中に変化しました");
  const database = lstatOptional(state.databasePath);
  if (
    !database ||
    database.isSymbolicLink() ||
    !database.isFile() ||
    !sameFileState(state.databaseStat, database)
  )
    throw new Error("移行元が移行中に変化しました");
  for (const suffix of TRACKED_SIDECARS) {
    const before = state.sidecars[suffix];
    const current = lstatOptional(state.databasePath + suffix);
    if (before) {
      if (
        !current ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        !sameFileState(before, current)
      )
        throw new Error("移行元が移行中に変化しました");
      continue;
    }
    if (!current) continue;
    // A read-only SQLite close can create an empty WAL file. It contains no
    // committed state; a non-empty newly appeared sidecar is a real change.
    if (current.isSymbolicLink() || !current.isFile() || current.size !== 0)
      throw new Error("移行元が移行中に変化しました");
  }
}

function assertSidecarTypes(state: SourceState): void {
  for (const suffix of SIDECARS) {
    const info = lstatOptional(state.databasePath + suffix);
    if (info && (info.isSymbolicLink() || !info.isFile()))
      throw new Error(
        "移行元にシンボリックリンクまたは不正なSQLite補助ファイルがあります",
      );
  }
}

function validateSource(source: string): SourceState {
  const requested = resolve(source);
  const rootInfo = lstatOptional(requested);
  if (!rootInfo) throw new Error("移行元が見つかりません");
  if (rootInfo.isSymbolicLink())
    throw new Error("移行元にシンボリックリンクがあります: " + requested);
  if (!rootInfo.isDirectory()) throw new Error("移行元の形式が不正です");
  const root = realpathSync(requested);

  if (lstatOptional(join(root, MARKER)))
    throw new Error("未完了の復旧ワークスペースはコピーできません");

  const databasePath = join(root, DATABASE);
  const databaseStat = lstatOptional(databasePath);
  if (!databaseStat) throw new Error("移行元の形式が不正です");
  if (databaseStat.isSymbolicLink())
    throw new Error("移行元にシンボリックリンクがあります: " + DATABASE);
  if (!databaseStat.isFile()) throw new Error("移行元の形式が不正です");

  const sidecars: Partial<Record<Sidecar, Stats>> = {};
  for (const suffix of SIDECARS) {
    const info = lstatOptional(databasePath + suffix);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(
        "移行元にシンボリックリンクまたは不正なSQLite補助ファイルがあります",
      );
    else sidecars[suffix as Sidecar] = info;
  }

  const assetsPath = join(root, ASSETS);
  const assetsInfo = lstatOptional(assetsPath);
  let assetsRoot: string | undefined;
  let assets: AssetTree = { directories: [], files: [] };
  if (assetsInfo) {
    if (assetsInfo.isSymbolicLink())
      throw new Error("移行元にシンボリックリンクがあります: " + ASSETS);
    if (!assetsInfo.isDirectory())
      throw new Error("移行元のassetsがディレクトリではありません");
    assetsRoot = realpathSync(assetsPath);
    if (assetsRoot !== assetsPath)
      throw new Error("移行元にシンボリックリンクがあります: " + ASSETS);
    assets = scanAssetTree(assetsRoot);
  }

  return {
    root,
    rootStat: rootInfo,
    databasePath,
    databaseStat,
    sidecars,
    assetsRoot,
    assets,
  };
}

function assertDatabaseIntegrity(db: DatabaseSync, label: string): void {
  const checks = db.prepare("PRAGMA integrity_check").all() as Record<
    string,
    unknown
  >[];
  if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok")
    throw new Error(label + "のSQLite整合性エラー");
}

function assertDatabaseIntegrityPath(path: string, label: string): void {
  const snapshot = new DatabaseSync(path, { readOnly: true });
  try {
    assertDatabaseIntegrity(snapshot, label);
  } finally {
    snapshot.close();
  }
}

function openSourceDatabase(state: SourceState): DatabaseSync {
  if (realpathSync(state.databasePath) !== state.databasePath)
    throw new Error("移行元にシンボリックリンクがあります: " + DATABASE);
  assertSidecarTypes(state);
  const db = new DatabaseSync(state.databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const main = db
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "main");
    if (
      typeof main?.file !== "string" ||
      realpathSync(main.file) !== state.databasePath
    )
      throw new Error("移行元のSQLiteが指定ワークスペースと一致しません");
    assertDatabaseIntegrity(db, "移行元");
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

function estimateMigrationBytes(db: DatabaseSync, state: SourceState): number {
  const oneCopy = estimateBackupBytes(db, state.root);
  if (
    !Number.isSafeInteger(oneCopy) ||
    oneCopy < 0 ||
    oneCopy > Math.floor(Number.MAX_SAFE_INTEGER / 2)
  )
    throw new Error("移行サイズが対応範囲を超えています");
  // The backup snapshot and the staged copy are both fully written. Each copy
  // includes the logical SQLite pages, every asset file (registered or not),
  // and the estimator's per-entry metadata allowance.
  return oneCopy * 2;
}

function writeIncompleteMarker(directory: string): void {
  writeNewFileDurably(join(directory, MARKER), MARKER_TEXT, { mode: 0o600 });
}

/** Remove the guard only after the completed directory and its parent have
 * been flushed. If the final flush fails, put the guard back before surfacing
 * the original failure. */
function removeIncompleteMarker(directory: string): void {
  unlinkSync(join(directory, MARKER));
  try {
    syncPath(directory);
  } catch (error) {
    try {
      writeIncompleteMarker(directory);
      syncPath(join(directory, MARKER));
      syncPath(directory);
    } catch {}
    throw error;
  }
}

function copyTree(
  sourceRoot: string,
  destinationRoot: string,
): Map<string, FileRecord> {
  const records = new Map<string, FileRecord>();
  let entries = 0;
  const walk = (
    source: string,
    destination: string,
    prefix: string,
    depth: number,
  ): void => {
    const info = lstatSync(source);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("コピー元が通常のディレクトリではありません");
    for (const entry of readdirSync(source, {
      withFileTypes: true,
    }).sort(compareNames)) {
      if (++entries > MAX_TREE_ENTRIES)
        throw new Error("コピー元の項目数上限を超えました");
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = lstatSync(from);
      if (child.isSymbolicLink())
        throw new Error(
          "コピー元にシンボリックリンクがあります: " + relativePath,
        );
      if (child.isDirectory()) {
        if (depth >= MAX_TREE_DEPTH)
          throw new Error("コピー元の階層が深すぎます");
        mkdirSync(to, { mode: 0o700 });
        walk(from, to, relativePath, depth + 1);
        // Flush child names before their containing directory.
        syncPath(to);
        continue;
      }
      if (!child.isFile())
        throw new Error(
          "コピー元に通常ファイル以外の項目があります: " + relativePath,
        );
      records.set(
        relativePath,
        copyRegularFile(from, to, "コピー: " + relativePath),
      );
    }
  };
  walk(sourceRoot, destinationRoot, "", 0);
  syncPath(destinationRoot);
  return records;
}

function verifyTree(
  root: string,
  expected: Map<string, FileRecord>,
  allowMarker = false,
): void {
  const seen = new Set<string>();
  let entries = 0;
  const walk = (directory: string, prefix: string, depth: number): void => {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("検証先が通常のディレクトリではありません");
    for (const entry of readdirSync(directory, {
      withFileTypes: true,
    }).sort(compareNames)) {
      if (++entries > MAX_TREE_ENTRIES)
        throw new Error("検証先の項目数上限を超えました");
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = lstatSync(path);
      if (child.isSymbolicLink())
        throw new Error(
          "検証先にシンボリックリンクがあります: " + relativePath,
        );
      if (child.isDirectory()) {
        if (depth >= MAX_TREE_DEPTH)
          throw new Error("検証先の階層が深すぎます");
        walk(path, relativePath, depth + 1);
        continue;
      }
      if (!child.isFile())
        throw new Error(
          "検証先に通常ファイル以外の項目があります: " + relativePath,
        );
      if (allowMarker && relativePath === MARKER) continue;
      const expectedRecord = expected.get(relativePath);
      if (!expectedRecord)
        throw new Error("検証先に想定外のファイルがあります: " + relativePath);
      const actual = hashRegularFile(path, "検証: " + relativePath);
      if (
        actual.bytes !== expectedRecord.bytes ||
        actual.sha256 !== expectedRecord.sha256
      )
        throw new Error("コピー内容を検証できません: " + relativePath);
      seen.add(relativePath);
    }
  };
  walk(root, "", 0);
  if (seen.size !== expected.size)
    throw new Error("コピー内容の一覧が一致しません");
  for (const path of expected.keys())
    if (!seen.has(path)) throw new Error("コピー内容が不足しています: " + path);
}

function syncTree(root: string): void {
  let entries = 0;
  const walk = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, {
      withFileTypes: true,
    }).sort(compareNames)) {
      if (++entries > MAX_TREE_ENTRIES)
        throw new Error("同期先の項目数上限を超えました");
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink())
        throw new Error("同期先にシンボリックリンクがあります: " + path);
      if (info.isDirectory()) {
        if (depth >= MAX_TREE_DEPTH)
          throw new Error("同期先の階層が深すぎます");
        walk(path, depth + 1);
        continue;
      }
      if (!info.isFile())
        throw new Error("同期先に通常ファイル以外の項目があります: " + path);
    }
    syncPath(directory);
  };
  walk(root, 0);
}

function createSnapshot(
  state: SourceState,
  db: DatabaseSync,
  target: string,
): Map<string, FileRecord> {
  if (lstatOptional(target))
    throw new Error("移行先は未作成のフォルダを指定してください");
  const parent = dirname(target);
  assertDisjoint(state.root, target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const actualParent = realpathSync(parent);
  if (actualParent !== parent)
    throw new Error("移行先の親フォルダを安全に解決できません");
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("移行先は未作成のフォルダを指定してください");
    throw error;
  }
  if (realpathSync(target) !== target)
    throw new Error("移行先を安全に解決できません");

  writeIncompleteMarker(target);
  syncPath(target);
  syncPath(parent);

  const databasePath = join(target, DATABASE);
  db.prepare("VACUUM INTO ?").run(databasePath);
  assertDatabaseIntegrityPath(databasePath, "移行先");
  syncPath(databasePath);
  const records = new Map<string, FileRecord>();
  records.set(DATABASE, hashRegularFile(databasePath, "移行先のSQLite"));

  const outputAssets = join(target, ASSETS);
  mkdirSync(outputAssets, { mode: 0o700 });
  for (const directory of state.assets.directories) {
    const path = join(outputAssets, ...directory.split("/"));
    if (!inside(outputAssets, path))
      throw new Error("添付ファイルの移行先が不正です");
    mkdirSync(path, { mode: 0o700 });
  }
  for (const file of state.assets.files) {
    const sourceParent = dirname(file.absolutePath);
    if (realpathSync(sourceParent) !== sourceParent)
      throw new Error(
        "移行元にシンボリックリンクがあります: " + file.relativePath,
      );
    const destination = join(outputAssets, ...file.relativePath.split("/"));
    if (!inside(outputAssets, destination))
      throw new Error("添付ファイルの移行先が不正です");
    records.set(
      `${ASSETS}/${file.relativePath}`,
      copyRegularFile(
        file.absolutePath,
        destination,
        "添付ファイル: " + file.relativePath,
      ),
    );
  }
  syncTree(outputAssets);
  syncPath(outputAssets);
  syncPath(target);

  assertSourceUnchanged(state);
  assertSidecarTypes(state);
  assertAssetTreeUnchanged(state);

  writeNewFileDurably(
    join(target, MANIFEST),
    JSON.stringify(
      { app: "Folio", format: 1, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  records.set(MANIFEST, hashRegularFile(join(target, MANIFEST), "manifest"));
  syncPath(target);

  verifyTree(target, records, true);
  syncPath(target);
  removeIncompleteMarker(target);
  return records;
}

function createStage(
  state: SourceState,
  source: string,
  target: string,
  expected: Map<string, FileRecord>,
): void {
  if (lstatOptional(join(source, MARKER)))
    throw new Error("バックアップが未完了のため移行できません");
  if (lstatOptional(target))
    throw new Error("移行先は未作成のフォルダを指定してください");
  const parent = dirname(target);
  assertDisjoint(state.root, target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const actualParent = realpathSync(parent);
  if (actualParent !== parent)
    throw new Error("移行先の親フォルダを安全に解決できません");
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("移行先は未作成のフォルダを指定してください");
    throw error;
  }
  if (realpathSync(target) !== target)
    throw new Error("移行先を安全に解決できません");

  writeIncompleteMarker(target);
  syncPath(target);
  syncPath(parent);

  const copied = copyTree(source, target);
  if (copied.size !== expected.size)
    throw new Error("移行内容の一覧が一致しません");
  for (const [path, record] of copied) {
    const wanted = expected.get(path);
    if (
      !wanted ||
      wanted.bytes !== record.bytes ||
      wanted.sha256 !== record.sha256
    )
      throw new Error("移行内容のコピーを検証できません: " + path);
  }
  assertDatabaseIntegrityPath(join(target, DATABASE), "移行先");
  // Verify the final inventory after opening the staged database; a sidecar
  // created by that inspection must fail verification, not be published.
  verifyTree(target, expected, true);
  syncTree(target);
  syncPath(target);
}

function publishStage(
  state: SourceState,
  staging: string,
  destination: string,
  expected: Map<string, FileRecord>,
): void {
  if (lstatOptional(join(staging, MARKER)) === undefined)
    throw new Error("未完了マーカーがない移行内容は公開できません");
  if (lstatOptional(destination))
    throw new Error("移行先は未作成のフォルダを指定してください");
  const parent = dirname(destination);
  assertDisjoint(state.root, destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== parent)
    throw new Error("移行先の親フォルダを安全に解決できません");
  if (lstatOptional(destination))
    throw new Error("移行先は未作成のフォルダを指定してください");
  try {
    mkdirSync(destination, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("移行先は未作成のフォルダを指定してください");
    throw error;
  }
  if (realpathSync(destination) !== destination)
    throw new Error("移行先を安全に解決できません");
  const reserved = lstatSync(destination);
  if (!reserved.isDirectory() || readdirSync(destination).length !== 0)
    throw new Error("移行先を排他的に確保できません");

  let renamed = false;
  try {
    renameSync(staging, destination);
    renamed = true;
  } catch (error) {
    // POSIX can atomically replace our empty reservation. Platforms that
    // cannot rename over a directory fall back to moving the verified entries
    // only while the same empty reservation is still under our control. An
    // existing destination is never reused or replaced.
    const current = lstatOptional(destination);
    if (
      !current ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== reserved.dev ||
      current.ino !== reserved.ino ||
      readdirSync(destination).length !== 0
    )
      throw error;
    const stagingInfo = lstatOptional(staging);
    if (
      !stagingInfo ||
      stagingInfo.isSymbolicLink() ||
      !stagingInfo.isDirectory()
    )
      throw error;
    writeIncompleteMarker(destination);
    syncPath(destination);
    syncPath(parent);
    for (const name of readdirSync(staging).sort()) {
      if (name === MARKER) continue;
      const from = join(staging, name);
      const to = join(destination, name);
      if (lstatOptional(to)) throw new Error("移行先の内容が競合しました");
      renameSync(from, to);
    }
    try {
      unlinkSync(join(staging, MARKER));
      rmdirSync(staging);
    } catch {}
  }

  if (!renamed && lstatOptional(join(destination, MARKER)) === undefined)
    throw new Error("未完了マーカーを確認できません");
  // Reverify the published inventory before removing the guard. This also
  // rejects a file that raced into the staging/destination after the stage
  // check, and it proves a fallback move published the whole verified set.
  verifyTree(destination, expected, true);
  syncTree(destination);
  syncPath(destination);
  // Persist the destination name before claiming completion.
  syncPath(parent);
  removeIncompleteMarker(destination);
}

/**
 * Legacy startup import writes two complete copies: the retained backup
 * snapshot and the staged workspace that is published as the destination.
 * Source and destination are canonicalized before any output exists, and the
 * capacity hook runs before the parent, backup or staging directories are
 * created.
 */
export function migrateWorkspace(
  source: string,
  destination: string,
  options: WorkspaceMigrationOptions = {},
): { destination: string; backup: string } {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Migration options must be an object");
  if (
    options.beforeCopy !== undefined &&
    typeof options.beforeCopy !== "function"
  )
    throw new TypeError("beforeCopy must be a function");

  const requestedDestination = resolve(destination);
  if (lstatOptional(requestedDestination))
    throw new Error("移行先は未作成のフォルダを指定してください");

  const state = validateSource(source);
  const target = actualPath(requestedDestination);
  if (lstatOptional(target))
    throw new Error("移行先は未作成のフォルダを指定してください");
  assertDisjoint(state.root, target);
  const targetParent = nearestExistingDirectory(dirname(target));

  const db = openSourceDatabase(state);
  let completed = false;
  let failed = false;
  try {
    const additionalBytes = estimateMigrationBytes(db, state);
    options.beforeCopy?.(targetParent, additionalBytes);

    // Admission must not leave any output. Recheck the target and source after
    // the hook before creating the first directory or file.
    if (lstatOptional(requestedDestination) || lstatOptional(target))
      throw new Error("移行先は未作成のフォルダを指定してください");
    assertDisjoint(state.root, target);
    assertSidecarTypes(state);
    assertSourceUnchanged(state);
    assertAssetTreeUnchanged(state);
    if (estimateMigrationBytes(db, state) !== additionalBytes)
      throw new Error("移行元が容量確認中に変化しました");

    const backup = requestedDestination + ".backup-" + randomUUID();
    const staging = requestedDestination + ".staging-" + randomUUID();
    const backupTarget = actualPath(backup);
    const stagingTarget = actualPath(staging);
    if (lstatOptional(backupTarget) || lstatOptional(stagingTarget))
      throw new Error("移行用の作業フォルダを確保できません");
    assertDisjoint(state.root, backupTarget);
    assertDisjoint(state.root, stagingTarget);

    const backupRecords = createSnapshot(state, db, backupTarget);
    assertSourceUnchanged(state);
    assertAssetTreeUnchanged(state);

    createStage(state, backupTarget, stagingTarget, backupRecords);
    assertSourceUnchanged(state);
    assertAssetTreeUnchanged(state);

    publishStage(state, stagingTarget, target, backupRecords);
    completed = true;
    return { destination: requestedDestination, backup };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let closeError: unknown;
    try {
      db.close();
    } catch (error) {
      closeError = error;
    }
    // SQLite owns the source WAL/SHM lifecycle; another reader can still
    // have an index open after our connection closes.
    // Preserve the operation's own failure. A close failure after a completed
    // publish does not invalidate the durable destination.
    if (closeError !== undefined && !failed && !completed) throw closeError;
  }
}

export function backupWorkspace(source: string, destination: string) {
  const requestedDestination = resolve(destination);
  if (lstatOptional(requestedDestination))
    throw new Error("バックアップ先が既に存在します");

  const state = validateSource(source);
  const target = actualPath(requestedDestination);
  if (lstatOptional(target)) throw new Error("バックアップ先が既に存在します");
  assertDisjoint(state.root, target);

  const db = openSourceDatabase(state);
  let completed = false;
  let failed = false;
  try {
    createSnapshot(state, db, target);
    completed = true;
    return requestedDestination;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let closeError: unknown;
    try {
      db.close();
    } catch (error) {
      closeError = error;
    }
    if (closeError !== undefined && !failed && !completed) throw closeError;
  }
}
