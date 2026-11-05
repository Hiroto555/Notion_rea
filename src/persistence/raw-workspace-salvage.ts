import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync as SQLite, type DatabaseSync } from "node:sqlite";
import { sqliteAllocatedBytes } from "./sqlite-allocation";
import { assertOutsideFolioData } from "./output-path";
import { syncPath, writeNewFileDurably } from "./durable-file";

/**
 * A raw diagnostic export, deliberately distinct from the verified full
 * backup. It is never restorable: the database has another name, the manifest
 * has another format, and it uses its own incomplete marker. No normal backup
 * or restore path may consume this directory.
 */
const FORMAT = "folio-raw-workspace-salvage";
const VERSION = 1;
const MANIFEST = "salvage-manifest.json";
const MARKER = "FOLIO-RAW-SALVAGE-INCOMPLETE";
const DATABASE = "workspace.raw.sqlite";
const SOURCE_DATABASE = "workspace.sqlite";
const ASSETS = "assets";
const MARKER_TEXT =
  "Raw diagnostic salvage incomplete; do not use or restore this folder as a workspace.\n";

const CHUNK_BYTES = 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_ENTRIES = 200_000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_JOURNALS = 101;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const JOURNAL_NAME = /^crash-recovery\.json(?:\.stage-[A-Za-z0-9-]{1,64})?$/;

type SourceFile = { relativePath: string; absolutePath: string; bytes: number };
type ManifestEntry = { path: string; bytes: number; sha256: string };
type Manifest = {
  format: string;
  version: number;
  createdAt: string;
  restorable: false;
  entries: ManifestEntry[];
  files: number;
  bytes: number;
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

function addBytes(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_TOTAL_BYTES)
    throw new Error("生データ退避の合計サイズ上限を超えました");
  return total;
}

function requireSafeName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.length > 255 ||
    /[/\\\u0000]/.test(name)
  )
    throw new Error("安全でないファイル名のため生データ退避を中止しました");
}

function openRegularFile(path: string, label: string) {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
    throw new Error(`${label}が通常ファイルではありません`);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() || opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error(`${label}を開く間にファイルが変化しました`);
    return { descriptor, opened };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function hashRegularFile(
  path: string,
  label: string,
  limit = MAX_TOTAL_BYTES,
): { bytes: number; sha256: string } {
  const { descriptor, opened } = openRegularFile(path, label);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > limit) throw new Error(`${label}がサイズ上限を超えました`);
      hash.update(buffer.subarray(0, read));
    }
    const after = fstatSync(descriptor);
    if (
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.nlink !== 1 || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      after.size !== opened.size ||
      total !== opened.size
    )
      throw new Error(`${label}を読む間にファイルが変化しました`);
    return { bytes: total, sha256: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function copyRegularFile(
  source: string,
  destination: string,
  expectedBytes: number,
  label: string,
): { bytes: number; sha256: string } {
  if (expectedBytes > MAX_FILE_BYTES)
    throw new Error(`${label}が1ファイルのサイズ上限を超えました`);
  const { descriptor: input, opened } = openRegularFile(source, label);
  let output: number | undefined;
  try {
    if (opened.size !== expectedBytes)
      throw new Error(`${label}が走査中に変化しました`);
    output = openSync(
      destination,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(input, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_FILE_BYTES || total > expectedBytes)
        throw new Error(`${label}がサイズ上限を超えました`);
      hash.update(buffer.subarray(0, read));
      let offset = 0;
      while (offset < read) {
        const written = writeSync(output, buffer, offset, read - offset);
        if (written <= 0) throw new Error(`${label}のコピーを書き込めません`);
        offset += written;
      }
    }
    if (total !== expectedBytes)
      throw new Error(`${label}がコピー中に変化しました`);
    const afterInput = fstatSync(input);
    if (
      afterInput.ino !== opened.ino ||
      afterInput.dev !== opened.dev ||
      afterInput.nlink !== 1 || afterInput.mtimeMs !== opened.mtimeMs || afterInput.ctimeMs !== opened.ctimeMs ||
      afterInput.size !== opened.size
    )
      throw new Error(`${label}がコピー中に変化しました`);
    fsyncSync(output);
    const written = fstatSync(output);
    if (!written.isFile() || written.size !== total)
      throw new Error(`${label}のコピーを検証できません`);
    return { bytes: total, sha256: hash.digest("hex") };
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
}

function* directoryNames(path: string) {
  const directory = opendirSync(path);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) yield entry.name;
  } finally { directory.closeSync(); }
}

function scanAssetTree(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  let entries = 0;
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH)
      throw new Error(
        "添付フォルダの階層が深すぎるため生データ退避を中止しました",
      );
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("添付フォルダが通常のディレクトリではありません");
    if (realpathSync(directory) !== directory)
      throw new Error("添付フォルダにシンボリックリンクの経路があります");
    for (const name of directoryNames(directory)) {
      if (++entries > MAX_ENTRIES)
        throw new Error("添付フォルダの項目数上限を超えました");
      requireSafeName(name);
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (relativePath.length > 1024)
        throw new Error(
          "添付ファイルのパスが長すぎるため生データ退避を中止しました: " +
            relativePath,
        );
      const child = lstatSync(path);
      if (child.isSymbolicLink())
        throw new Error(
          "添付フォルダにシンボリックリンクがあるため生データ退避を中止しました: " +
            relativePath,
        );
      if (child.isDirectory()) {
        walk(path, relativePath, depth + 1);
        continue;
      }
      if (!child.isFile() || child.nlink !== 1)
        throw new Error(
          "添付フォルダに通常ファイル以外の項目があります: " + relativePath,
        );
      if (child.size > MAX_FILE_BYTES)
        throw new Error(
          "添付ファイルが1ファイルのサイズ上限を超えました: " + relativePath,
        );
      if (files.length >= MAX_FILES) throw new Error("添付ファイル数の上限を超えました");
      files.push({ relativePath, absolutePath: path, bytes: child.size });
    }
  };
  walk(root, "", 0);
  return files;
}

function scanJournals(root: string): SourceFile[] {
  const names: string[] = [];
  let visited = 0;
  for (const name of directoryNames(root)) {
    if (++visited > MAX_ENTRIES) throw new Error("救出元の項目数上限を超えました");
    if (name === "crash-recovery.json" || name.startsWith("crash-recovery.json.stage-")) {
      if (names.length >= MAX_JOURNALS) throw new Error("クラッシュ復旧ジャーナルの数が上限を超えました");
      names.push(name);
    }
  }
  for (const name of names)
    if (!JOURNAL_NAME.test(name))
      throw new Error(
        "クラッシュ復旧ジャーナルの名前が想定と異なります: " + name,
      );
  return names.map((name) => {
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
      throw new Error(
        "クラッシュ復旧ジャーナルが通常ファイルではありません: " + name,
      );
    if (info.size > MAX_FILE_BYTES)
      throw new Error(
        "クラッシュ復旧ジャーナルがサイズ上限を超えました: " + name,
      );
    return { relativePath: name, absolutePath: path, bytes: info.size };
  });
}

function safeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\\")
  )
    return false;
  return value
    .split("/")
    .every((part) => part && part !== "." && part !== "..");
}

function parseManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("生データ退避マニフェストが不正です");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).sort().join() !==
      "bytes,createdAt,entries,files,format,restorable,version" ||
    value.format !== FORMAT ||
    value.version !== VERSION ||
    value.restorable !== false ||
    typeof value.createdAt !== "string" ||
    !value.createdAt
  )
    throw new Error("生データ退避マニフェストの形式が一致しません");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_FILES)
    throw new Error("生データ退避マニフェストのファイル一覧が不正です");
  const entries: ManifestEntry[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const item of value.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("生データ退避マニフェストの項目が不正です");
    const entry = item as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join() !== "bytes,path,sha256" ||
      !safeRelativePath(entry.path) ||
      entry.path === MANIFEST ||
      entry.path === MARKER ||
      paths.has(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      (entry.bytes as number) >
        (entry.path === DATABASE ? MAX_TOTAL_BYTES : MAX_FILE_BYTES) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error("生データ退避マニフェストの項目が不正です");
    paths.add(entry.path);
    total = addBytes(total, entry.bytes as number);
    entries.push({
      path: entry.path,
      bytes: entry.bytes as number,
      sha256: entry.sha256,
    });
  }
  if (
    value.files !== entries.length ||
    value.bytes !== total ||
    !entries.some((entry) => entry.path === DATABASE)
  )
    throw new Error("生データ退避マニフェストの件数または合計が一致しません");
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: value.createdAt,
    restorable: false,
    entries,
    files: entries.length,
    bytes: total,
  };
}

function readManifest(path: string): Manifest {
  const { descriptor, opened } = openRegularFile(
    path,
    "生データ退避マニフェスト",
  );
  try {
    if (opened.size > MAX_MANIFEST_BYTES)
      throw new Error("生データ退避マニフェストがサイズ上限を超えました");
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(descriptor);
    if (
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.nlink !== 1 || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      after.size !== opened.size ||
      offset !== opened.size
    )
      throw new Error("生データ退避マニフェストが読む間に変化しました");
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error("生データ退避マニフェストを読めません");
    }
    return parseManifest(parsed);
  } finally {
    closeSync(descriptor);
  }
}

function listBundlePayload(root: string): string[] {
  const files: string[] = [];
  const walkAssets = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      requireSafeName(name);
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink())
        throw new Error("生データ退避にシンボリックリンクがあります");
      if (info.isDirectory()) {
        walkAssets(path, `${prefix}/${name}`);
        continue;
      }
      if (!info.isFile())
        throw new Error("生データ退避に通常ファイル以外の項目があります");
      files.push(`${prefix}/${name}`);
    }
  };
  for (const name of readdirSync(root).sort()) {
    if (name === MANIFEST || name === MARKER) continue;
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error("生データ退避にシンボリックリンクがあります");
    if (info.isDirectory()) {
      if (name !== ASSETS)
        throw new Error(
          "生データ退避に想定外のディレクトリがあります: " + name,
        );
      walkAssets(path, ASSETS);
      continue;
    }
    if (!info.isFile() || (name !== DATABASE && !JOURNAL_NAME.test(name)))
      throw new Error("生データ退避に想定外の項目があります: " + name);
    files.push(name);
  }
  return files.sort();
}

function syncTree(root: string): void {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error("生データ退避にシンボリックリンクがあります");
    if (info.isDirectory()) syncTree(path);
  }
  syncPath(root);
}

/** Verify the published bytes, inventory and SQLite snapshot before removing
 * the incomplete marker. Page JSON is deliberately not decoded or validated:
 * malformed Page documents are the reason this raw path exists. */
function verifyBundle(directory: string): Manifest {
  const marker = join(directory, MARKER);
  const markerInfo = lstatSync(marker);
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile())
    throw new Error("生データ退避の未完了マーカーが通常ファイルではありません");
  const manifest = readManifest(join(directory, MANIFEST));
  const expected = new Set(manifest.entries.map((entry) => entry.path));
  const actual = listBundlePayload(directory);
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  )
    throw new Error("生データ退避の実ファイル一覧がマニフェストと一致しません");
  for (const entry of manifest.entries) {
    const path = join(directory, ...entry.path.split("/"));
    if (!inside(directory, path))
      throw new Error("生データ退避のパスが退避先の外を指しています");
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("生データ退避の項目が通常ファイルではありません");
    const hashed = hashRegularFile(path, entry.path);
    if (hashed.bytes !== entry.bytes || hashed.sha256 !== entry.sha256)
      throw new Error(
        "生データ退避のファイル内容がマニフェストと一致しません: " + entry.path,
      );
  }
  const snapshotPath = join(directory, DATABASE);
  const snapshot = new SQLite(snapshotPath, { readOnly: true });
  try {
    const checks = snapshot.prepare("PRAGMA integrity_check").all() as Record<
      string,
      unknown
    >[];
    if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok")
      throw new Error("SQLiteスナップショットの整合性を検証できません");
  } finally {
    snapshot.close();
  }
  return manifest;
}

function reserveDestination(
  workspace: string,
  externalParent: string,
): { directory: string; parent: string } {
  const parent = realpathSync(resolve(externalParent));
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory())
    throw new Error("退避先の親フォルダが通常のディレクトリではありません");
  if (inside(workspace, parent))
    throw new Error("ワークスペース内には生データ退避を出力できません");
  assertOutsideFolioData(parent);
  const directory = join(parent, "folio-raw-salvage-" + randomUUID());
  if (!inside(parent, directory))
    throw new Error("生データ退避先を解決できません");
  if (lstatOptional(directory))
    throw new Error("生データ退避先が既に存在します");
  mkdirSync(directory, { mode: 0o700 });
  const real = realpathSync(directory);
  if (real !== directory)
    throw new Error("生データ退避先の実体を確認できません");
  if (inside(workspace, real)) {
    try {
      rmdirSync(real);
    } catch {}
    throw new Error("ワークスペース内には生データ退避を出力できません");
  }
  return { directory, parent };
}

/**
 * Copy the live SQLite database with `VACUUM INTO` and capture every regular
 * file below `assets` plus existing crash-recovery journals into a new,
 * uniquely named child of `externalParent`.
 *
 * This is a raw diagnostic export, not a restorable workspace backup. It never
 * decodes Page JSON, never reads the database/WAL piecemeal, never follows a
 * symlink, and never copies unlisted root files such as `backups/`. The caller
 * must own the workspace exclusively and must pass an idle database.
 *
 * Any failure after the destination is reserved leaves the unique incomplete
 * marker and the partial bundle in place. The marker is removed only after the
 * manifest, copied bytes and SQLite snapshot have been verified and synced.
 */
export function createRawWorkspaceSalvage(
  db: DatabaseSync,
  workspace: string,
  externalParent: string,
  beforeWrite?: (journalBytes: number) => void,
): { directory: string; files: number; bytes: number } {
  if (db.isTransaction !== false)
    throw new Error("未確定のトランザクションでは生データ退避を作成できません");

  const requestedWorkspace = resolve(workspace);
  const workspaceInfo = lstatSync(requestedWorkspace);
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory())
    throw new Error("生データ退避元が安全なディレクトリではありません");
  const root = realpathSync(requestedWorkspace);

  const databasePath = join(root, SOURCE_DATABASE);
  const databaseInfo = lstatSync(databasePath);
  if (databaseInfo.isSymbolicLink() || !databaseInfo.isFile() || databaseInfo.nlink !== 1)
    throw new Error("生データ退避元のSQLiteが安全なファイルではありません");
  if (databaseInfo.size > MAX_TOTAL_BYTES)
    throw new Error("SQLiteデータベースがサイズ上限を超えています");

  // Ensure the snapshot and filesystem payload belong to the same workspace.
  const main = db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
  if (typeof main?.file !== "string" || realpathSync(main.file) !== databasePath)
    throw new Error("救出元のSQLite接続が指定ワークスペースと一致しません。");
  if (sqliteAllocatedBytes(db) > MAX_TOTAL_BYTES)
    throw new Error("SQLiteスナップショットがサイズ上限を超えます。");

  const journalFiles = scanJournals(root);
  beforeWrite?.(journalFiles.reduce((total, file) => addBytes(total, file.bytes), 0));

  const assetsPath = join(root, ASSETS);
  const assetsInfo = lstatOptional(assetsPath);
  if (assetsInfo && (assetsInfo.isSymbolicLink() || !assetsInfo.isDirectory()))
    throw new Error("生データ退避元の添付フォルダが安全ではありません");
  const assetsReal = assetsInfo ? realpathSync(assetsPath) : undefined;
  if (assetsReal && !inside(root, assetsReal))
    throw new Error("添付フォルダがワークスペースの外を指しています");

  const { directory, parent } = reserveDestination(root, externalParent);
  const marker = join(directory, MARKER);
  writeFileSync(marker, MARKER_TEXT, { flag: "wx", mode: 0o600 });
  syncPath(marker);
  syncPath(directory);
  syncPath(parent);

  const snapshotPath = join(directory, DATABASE);
  // query_only also blocks writing the external VACUUM result. Keep the
  // caller's guard intact and use a separate OS-readonly source connection.
  const snapshotReader = db.prepare("PRAGMA query_only").get()?.query_only === 1
    ? new SQLite(databasePath, {readOnly:true}) : db;
  try { snapshotReader.prepare("VACUUM INTO ?").run(snapshotPath); }
  finally { if (snapshotReader !== db) snapshotReader.close(); }
  const snapshotInfo = lstatSync(snapshotPath);
  if (snapshotInfo.isSymbolicLink() || !snapshotInfo.isFile())
    throw new Error("SQLiteスナップショットが通常ファイルではありません");
  if (snapshotInfo.size > MAX_TOTAL_BYTES)
    throw new Error("SQLiteスナップショットがサイズ上限を超えています");
  syncPath(snapshotPath);

  const assetFiles = assetsReal ? scanAssetTree(assetsReal) : [];
  if (assetFiles.length + journalFiles.length + 1 > MAX_FILES)
    throw new Error("生データ退避のファイル数上限を超えました");
  let totalBytes = addBytes(0, snapshotInfo.size);
  for (const file of [...assetFiles, ...journalFiles])
    totalBytes = addBytes(totalBytes, file.bytes);

  const entries: ManifestEntry[] = [];
  const snapshotHashed = hashRegularFile(
    snapshotPath,
    "SQLiteスナップショット",
    MAX_TOTAL_BYTES,
  );
  if (snapshotHashed.bytes !== snapshotInfo.size)
    throw new Error("SQLiteスナップショットが検証中に変化しました");
  entries.push({ path: DATABASE, ...snapshotHashed });

  const outputAssets = join(directory, ASSETS);
  mkdirSync(outputAssets, { mode: 0o700 });
  for (const file of assetFiles) {
    const sourceParent = dirname(file.absolutePath);
    if (realpathSync(sourceParent) !== sourceParent)
      throw new Error(
        "添付フォルダにシンボリックリンクの経路があるため生データ退避を中止しました: " +
          file.relativePath,
      );
    const destination = join(outputAssets, ...file.relativePath.split("/"));
    if (!inside(outputAssets, destination))
      throw new Error("添付ファイルの退避先が不正です");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const copied = copyRegularFile(
      file.absolutePath,
      destination,
      file.bytes,
      "添付ファイル: " + file.relativePath,
    );
    entries.push({ path: `${ASSETS}/${file.relativePath}`, ...copied });
  }
  for (const file of journalFiles) {
    const destination = join(directory, ...file.relativePath.split("/"));
    if (!inside(directory, destination))
      throw new Error("クラッシュ復旧ジャーナルの退避先が不正です");
    const copied = copyRegularFile(
      file.absolutePath,
      destination,
      file.bytes,
      "クラッシュ復旧ジャーナル: " + file.relativePath,
    );
    entries.push({ path: file.relativePath, ...copied });
  }
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (entries.length !== assetFiles.length + journalFiles.length + 1)
    throw new Error("生データ退避のファイル一覧が一致しません");
  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    restorable: false,
    entries,
    files: entries.length,
    bytes: entries.reduce((total, entry) => addBytes(total, entry.bytes), 0),
  };
  if (manifest.bytes !== totalBytes)
    throw new Error("生データ退避の合計サイズが一致しません");
  writeNewFileDurably(
    join(directory, MANIFEST),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600, syncParentDirectory: true },
  );

  syncTree(directory);
  syncPath(directory);
  syncPath(parent);

  const verified = verifyBundle(directory);
  syncTree(directory);
  syncPath(directory);

  unlinkSync(marker);
  try {
    syncPath(directory);
  } catch (error) {
    // Completion is not durable. Put the guard back before reporting failure
    // so a partially synced bundle can never look complete.
    try {
      writeFileSync(marker, MARKER_TEXT, { flag: "wx", mode: 0o600 });
      syncPath(marker);
      syncPath(directory);
    } catch {
      // Preserve the original sync failure; the caller must not treat this as
      // a completed export.
    }
    throw error;
  }
  return {
    directory,
    files: verified.files,
    bytes: verified.bytes,
  };
}
