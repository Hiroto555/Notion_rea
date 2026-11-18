import {startupRetainsNativeLease} from "../persistence/startup-connection-owner";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertOutsideFolioData } from "../persistence/output-path";
import { syncPath } from "../persistence/durable-file";
import { verifyFullBackup } from "../persistence/full-backup-verify";
import type { VerifiedWorkspaceBackup } from "../shared/workspace-backup";
import { privatePersistencePort, type NativePrivateIdentity, type NativePrivateTree,
  type NativePrivateFilesystemPort } from "../platform/private-persistence";

/** Names produced by WorkspaceBackupService.create(prefix) and the page-order
 * repair backup call. The legacy `workspace-<time>` name has no UUID and is
 * deliberately not accepted. */
const GENERATED_BACKUP_NAME =
  /^[a-z0-9][a-z0-9-]{0,126}-\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ARCHIVE_PREFIX = "folio-backup-archive-";

type WorkspaceRoot = {
  workspace: string;
  backups: string;
  workspaceStat: Stats;
  backupsStat: Stats;
  nativeWorkspace?: NativePrivateIdentity;
  nativeBackups?: NativePrivateIdentity;
};

type SourceRef = {
  name: string;
  path: string;
  stat: Stats;
  native?: NativePrivateIdentity;
};

type Source = SourceRef & { verified: VerifiedWorkspaceBackup };

type ExternalParent = { path: string; stat: Stats; native?: NativePrivateIdentity };

function assertNativePin(expected: NativePrivateIdentity, actual: NativePrivateIdentity): void {
  if (expected.path !== actual.path || expected.fileId.toLowerCase() !== actual.fileId.toLowerCase() ||
    expected.volumeId.toLowerCase() !== actual.volumeId.toLowerCase())
    throw new Error("native backup directory identity changed");
}
function assertNativeTree(expected: NativePrivateTree, actual: NativePrivateTree, path = expected.path): void {
  assertNativePin({ ...expected, path }, actual);
  if (expected.sha256 !== actual.sha256 || expected.entries !== actual.entries || expected.bytes !== actual.bytes)
    throw new Error("native backup tree changed");
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Path-component containment, not a string-prefix test: `/data/folio-archive`
 * is outside `/data/folio`, while `/data/folio/backups-archive` is not. */
function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!relation.startsWith(".." + sep) && relation !== ".." && !isAbsolute(relation))
  );
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isGeneratedName(name: string): boolean {
  return name.length <= 255 && GENERATED_BACKUP_NAME.test(name);
}

function readWorkspaceRoot(workspace: string): WorkspaceRoot {
  if (typeof workspace !== "string" || workspace.length === 0)
    throw new Error("ワークスペースが不正です。");
  const requested = resolve(workspace);
  const requestedInfo = fs.lstatSync(requested);
  if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory())
    throw new Error("ワークスペースが安全なディレクトリではありません。");
  const real = fs.realpathSync(requested);
  if (dirname(real) === real)
    throw new Error("ファイルシステムのルートをワークスペースにはできません。");
  const workspaceStat = fs.statSync(real);
  if (!workspaceStat.isDirectory())
    throw new Error("ワークスペースが安全なディレクトリではありません。");

  const backupsPath = join(real, "backups");
  const backupsInfo = fs.lstatSync(backupsPath);
  if (backupsInfo.isSymbolicLink() || !backupsInfo.isDirectory())
    throw new Error("バックアップフォルダーが安全なディレクトリではありません。");
  const backups = fs.realpathSync(backupsPath);
  // The canonical folder must still be the direct child named `backups`.
  if (dirname(backups) !== real || basename(backups) !== "backups")
    throw new Error("バックアップフォルダーがワークスペース直下にありません。");
  const backupsStat = fs.statSync(backups);
  const native = privatePersistencePort();
  return { workspace: real, backups, workspaceStat, backupsStat,
    nativeWorkspace: native?.inspectDirectory(real), nativeBackups: native?.inspectDirectory(backups) };
}

function readSource(root: WorkspaceRoot, source: string): SourceRef {
  if (typeof source !== "string" || source.length === 0)
    throw new Error("バックアップ元が不正です。");
  const requested = resolve(source);
  const requestedInfo = fs.lstatSync(requested);
  if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory())
    throw new Error("バックアップ元が安全なディレクトリではありません。");
  const real = fs.realpathSync(requested);
  if (dirname(real) !== root.backups)
    throw new Error("バックアップ元はバックアップフォルダーの直下だけを対象にできます。");
  const name = basename(real);
  if (!isGeneratedName(name))
    throw new Error("Folioが生成した完全バックアップの名前ではありません。");
  const stat = fs.statSync(real);
  const native = privatePersistencePort();
  if (
    !stat.isDirectory() ||
    (!native && (stat.dev !== requestedInfo.dev || stat.ino !== requestedInfo.ino))
  )
    throw new Error("バックアップ元が検査中に変更されました。");
  return { name, path: join(root.backups, name), stat, native: native?.inspectDirectory(real) };
}

function verifySource(root: WorkspaceRoot, source: string): Source {
  const resolved = readSource(root, source);
  let verified: VerifiedWorkspaceBackup;
  try {
    verified = verifyFullBackup(resolved.path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`完全バックアップとして検証できません: ${detail}`, { cause: error });
  }
  return { ...resolved, verified };
}

function assertNotPinned(
  isPinned: (canonical: string) => boolean,
  canonical: string,
): void {
  if (typeof isPinned !== "function")
    throw new Error("バックアップの使用状態を確認できません。");
  let pinned: boolean;
  try {
    pinned = isPinned(canonical);
  } catch (error) {
    throw new Error("バックアップの使用状態を確認できないため移動しません。", {
      cause: error,
    });
  }
  if (typeof pinned !== "boolean") throw new Error("バックアップの使用状態を確認できません。");
  if (pinned) throw new Error("使用中のバックアップは移動できません。");
}

function backupBytes(verified: VerifiedWorkspaceBackup): number {
  let total = verified.manifest.database.bytes;
  for (const asset of verified.manifest.assets) {
    total += asset.bytes;
    if (!Number.isSafeInteger(total))
      throw new Error("バックアップのサイズを安全に集計できません。");
  }
  return total;
}

// A positive proof needs only one strictly newer verified generation. Bound
// both directory enumeration and full verifications; uncertainty stops a move.
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_GENERATION_CHECKS = 32;
function assertRetention(root: WorkspaceRoot, sourceName: string, source: VerifiedWorkspaceBackup): void {
  const sourceTime = Date.parse(source.manifest.createdAt);
  if (!Number.isFinite(sourceTime)) throw new Error("作成日時を確認できないため退避を停止しました。");
  const names: {name: string; hint: number}[] = [];
  let seen = 0;
  const dir = fs.opendirSync(root.backups);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++seen > MAX_ARCHIVE_ENTRIES) throw new Error("世代の一覧が確認上限を超えています。");
      if (entry.name !== sourceName && isGeneratedName(entry.name) && entry.isDirectory())
        names.push({name: entry.name, hint: Number(entry.name.match(/-(\d{13})-[0-9a-f-]{36}$/)?.[1])});
    }
  } finally { dir.closeSync(); }
  // The name influences the search order only. The verified manifest decides.
  names.sort((a,b) => b.hint - a.hint);
  let anotherValid = false;
  for (const {name} of names.slice(0, MAX_GENERATION_CHECKS)) {
    try {
      const path = join(root.backups, name);
      if (fs.realpathSync(path) !== path) continue;
      const other = verifyFullBackup(path);
      if (Date.parse(other.manifest.createdAt) > sourceTime) return;
      anotherValid = true;
    } catch (error) {
      // A bad generation is skippable; an unconfirmed native SQLite owner
      // must reach Main's lifecycle and retain every protector.
      if (startupRetainsNativeLease(error)) throw error;
    }
  }
  if (names.length > MAX_GENERATION_CHECKS) throw new Error("世代の検証上限内で新しい完全バックアップを確認できません。");
  if (!anotherValid) throw new Error("最後の有効な完全バックアップは移動できません。");
  throw new Error("最新の有効な完全バックアップ（同時刻のものを含む）は移動できません。");
}

function readExternalParent(
  root: WorkspaceRoot,
  externalParent: string,
): ExternalParent {
  if (typeof externalParent !== "string" || externalParent.length === 0)
    throw new Error("移動先フォルダーが不正です。");
  const requested = resolve(externalParent);
  // Resolve the selected folder through symlinks, then use only the canonical
  // path. A final symlink is allowed only if its target is outside the
  // workspace; an alias back into the workspace or its backups is refused.
  const real = fs.realpathSync(requested);
  const stat = fs.statSync(real);
  if (!stat.isDirectory())
    throw new Error("移動先が安全なディレクトリではありません。");
  if (inside(root.workspace, real))
    throw new Error("移動先はワークスペースの外側を指定してください。");
  const native = privatePersistencePort();
  const pin = native?.inspectDirectory(real);
  if (native ? [root.nativeWorkspace!, root.nativeBackups!].some(p =>
    p.fileId.toLowerCase() === pin!.fileId.toLowerCase() && p.volumeId.toLowerCase() === pin!.volumeId.toLowerCase()) :
    sameNode(stat, root.workspaceStat) || sameNode(stat, root.backupsStat))
    throw new Error("移動先がワークスペースまたはバックアップフォルダーを指しています。");
  assertOutsideFolioData(real);
  return { path: real, stat, native: pin };
}

function createWrapper(external: ExternalParent): string {
  const wrapper = fs.mkdtempSync(
    join(external.path, `${ARCHIVE_PREFIX}${Date.now()}-`),
  );
  const info = fs.lstatSync(wrapper);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0
  ) {
    try {
      fs.rmdirSync(wrapper);
    } catch {}
    throw new Error("非公開の移動先フォルダーを作成できません。");
  }
  return wrapper;
}

function cleanupWrapper(wrapper: string, parent: string): void {
  // Only an empty wrapper created by this call is removed, never recursively.
  try {
    fs.rmdirSync(wrapper);
  } catch {}
  try {
    syncPath(parent);
  } catch {}
}

function assertRootUnchanged(
  workspace: string,
  initial: WorkspaceRoot,
): void {
  const current = readWorkspaceRoot(workspace);
  if (
    current.workspace !== initial.workspace ||
    current.backups !== initial.backups ||
    !sameNode(current.workspaceStat, initial.workspaceStat) ||
    !sameNode(current.backupsStat, initial.backupsStat)
  )
    throw new Error(
      "ワークスペースまたはバックアップフォルダーが変更されています。移動しません。",
    );
}

function assertSourceIdentity(root: WorkspaceRoot, initial: SourceRef): void {
  const path = join(root.backups, initial.name);
  const info = fs.lstatSync(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== initial.stat.dev ||
    info.ino !== initial.stat.ino ||
    fs.realpathSync(path) !== path
  )
    throw new Error(
      "バックアップ元が計画後に置き換えまたは変更されています。移動しません。",
    );
}

function recheckSource(root: WorkspaceRoot, initial: Source): VerifiedWorkspaceBackup {
  assertSourceIdentity(root, initial);
  const path = join(root.backups, initial.name);
  let verified: VerifiedWorkspaceBackup;
  try {
    verified = verifyFullBackup(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `バックアップ元が計画後に変更されたため移動しません: ${detail}`,
      { cause: error },
    );
  }
  return verified;
}

function assertExternalUnchanged(external: ExternalParent): void {
  const info = fs.lstatSync(external.path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !sameNode(info, external.stat) ||
    fs.realpathSync(external.path) !== external.path
  )
    throw new Error("移動先フォルダーが変更されています。移動しません。");
}

function assertWrapperReady(
  wrapper: string,
  info: Stats,
  sourceName: string,
): void {
  const current = fs.lstatSync(wrapper);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameNode(current, info) ||
    fs.readdirSync(wrapper).length !== 0 ||
    lstatIfExists(join(wrapper, sourceName))
  )
    throw new Error("移動先の作成状態が変更されています。移動しません。");
}

function movedStateError(wrapper: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `バックアップは移動済みですが、移動後の確定に失敗しました。移動先: ${wrapper}。元の場所には戻していません。${detail}`,
    { cause },
  );
}

function exdevError(cause: unknown): Error {
  const error = new Error(
    "バックアップと移動先が同じファイルシステムにないため移動できません。元のバックアップは残しています。",
    { cause },
  );
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code) (error as NodeJS.ErrnoException).code = code;
  return error;
}

/**
 * Plan the archive of one verified full backup. This reads and verifies only;
 * it never moves or changes anything. `bytes` is the database plus every
 * verified asset (the same amount shown by the backup preview).
 */
export function planBackupArchive(
  workspace: string,
  source: string,
  isPinned: (canonical: string) => boolean,
): { fingerprint: string; name: string; bytes: number } {
  const root = readWorkspaceRoot(workspace);
  const native = privatePersistencePort();
  const initialTree = native?.inspectTree?.(resolve(source));
  const resolved = verifySource(root, source);
  if (native) {
    assertNativePin(root.nativeWorkspace!, native.inspectDirectory(root.workspace));
    assertNativePin(root.nativeBackups!, native.inspectDirectory(root.backups));
    assertNativePin(resolved.native!, native.inspectDirectory(resolved.path));
    if (initialTree) assertNativeTree(initialTree, native.inspectTree!(resolved.path));
  }
  assertNotPinned(isPinned, resolved.path);
  assertRetention(root, resolved.name, resolved.verified);
  return {
    fingerprint: resolved.verified.fingerprint,
    name: resolved.name,
    bytes: backupBytes(resolved.verified),
  };
}

function archiveNativeBackup(
  native: NativePrivateFilesystemPort, workspace: string, source: string, externalParent: string,
  expectedFingerprint: string, isPinned: (canonical: string) => boolean,
): { destination: string } {
  if (!native.inspectTree || !native.renameDirectoryNew) throw new Error("native directory archive capability required");
  if (typeof expectedFingerprint !== "string" || !FINGERPRINT.test(expectedFingerprint))
    throw new Error("期待するバックアップfingerprintが不正です。");
  const root = readWorkspaceRoot(workspace);
  const ref = readSource(root, source);
  const tree = native.inspectTree(ref.path);
  const verified = verifyFullBackup(ref.path);
  assertNativeTree(tree, native.inspectTree(ref.path));
  assertNotPinned(isPinned, ref.path);
  if (verified.fingerprint !== expectedFingerprint) throw new Error("バックアップが計画後に変更されています。");
  assertRetention(root, ref.name, verified);
  const external = readExternalParent(root, externalParent);
  if (external.native!.volumeId.toLowerCase() !== tree.volumeId.toLowerCase()) throw exdevError(undefined);
  const pins = [root.nativeWorkspace!, root.nativeBackups!, ref.native!, external.native!];
  for (const pin of pins) assertNativePin(pin, native.inspectDirectory(pin.path));
  const wrapper = join(external.path, `${ARCHIVE_PREFIX}${Date.now()}-${randomUUID()}`);
  const wrapperPin = native.createDirectory(wrapper);
  const destination = join(wrapper, ref.name);
  let dispatched = false;
  try {
    native.renameDirectoryNew(ref.path, destination, tree, phase => {
      for (const pin of [root.nativeWorkspace!, root.nativeBackups!, external.native!, wrapperPin])
        assertNativePin(pin, native.inspectDirectory(pin.path));
      assertOutsideFolioData(external.path);
      if (inside(root.workspace, external.path)) throw new Error("unsafe archive destination");
      assertNotPinned(isPinned, ref.path);
      if (phase === "success") {
        assertNativeTree(tree, native.inspectTree!(destination), destination);
        if (verifyFullBackup(destination).fingerprint !== expectedFingerprint) throw new Error("moved backup fingerprint changed");
        assertNativeTree(tree, native.inspectTree!(destination), destination);
        return; // The source name has vanished; never re-adopt it here.
      }
      assertNativePin(ref.native!, native.inspectDirectory(ref.path));
      assertRetention(root, ref.name, verified);
      assertNativeTree(tree, native.inspectTree!(ref.path));
      if (verifyFullBackup(ref.path).fingerprint !== expectedFingerprint) throw new Error("backup fingerprint changed");
      assertNativeTree(tree, native.inspectTree!(ref.path));
      if (fs.readdirSync(wrapper).length !== 0 || lstatIfExists(destination)) throw new Error("archive destination collision");
      assertNativePin(wrapperPin, native.inspectDirectory(wrapper));
      if (phase === "dispatch") dispatched = true;
    });
    assertNativeTree(tree, native.inspectTree(destination), destination);
    if (verifyFullBackup(destination).fingerprint !== expectedFingerprint) throw new Error("moved backup fingerprint changed");
    return { destination: wrapper };
  } catch (error) {
    // No directory delete port exists. Even an empty wrapper remains evidence.
    if (dispatched) throw new Error(`バックアップ移動済み/UNKNOWN。保持先: ${wrapper}。元へ戻していません。`, { cause: error });
    throw new Error(`バックアップ退避停止。作業フォルダーを保持: ${wrapper}`, { cause: error });
  }
}

/**
 * Move one planned, verified full backup outside the workspace with an atomic
 * same-filesystem rename. The returned `destination` is a fresh private wrapper
 * directory; the generation remains under `destination/<name>`, which makes a
 * later rename back reversible. No copy-and-delete and no recursive delete is
 * performed.
 *
 * The caller must serialize maintenance with backup creation/restore and make
 * `isPinned` authoritative for active tickets. Every safety check (identity,
 * fingerprint, pin, retention, destination identity, empty wrapper) is repeated
 * immediately before rename, but external filesystem actors can still race the
 * final check. On a pre-rename failure the original stays in place and the
 * empty wrapper is removed. If a directory fsync or post-move verification
 * fails after the rename, the thrown error states that the generation is
 * already at the destination and is not moved back.
 */
export function archiveBackup(
  workspace: string,
  source: string,
  externalParent: string,
  expectedFingerprint: string,
  isPinned: (canonical: string) => boolean,
): { destination: string } {
  const native = privatePersistencePort();
  if (native) return archiveNativeBackup(native, workspace, source, externalParent, expectedFingerprint, isPinned);
  if (
    typeof expectedFingerprint !== "string" ||
    !FINGERPRINT.test(expectedFingerprint)
  )
    throw new Error("期待するバックアップfingerprintが不正です。");

  const root = readWorkspaceRoot(workspace);
  const resolved = verifySource(root, source);
  assertNotPinned(isPinned, resolved.path);
  if (resolved.verified.fingerprint !== expectedFingerprint)
    throw new Error("バックアップが計画後に変更されています。移動しません。");
  assertRetention(root, resolved.name, resolved.verified);

  const external = readExternalParent(root, externalParent);
  const wrapper = createWrapper(external);
  let moved = false;
  try {
    const wrapperInfo = fs.lstatSync(wrapper);
    // Persist the wrapper's new name before anything is moved into it.
    syncPath(external.path);

    assertRootUnchanged(workspace, root);
    // Use the initial verified snapshot for retention, then verify the source
    // bytes again as the last content check before rename. A changed source is
    // rejected by the fingerprint comparison and is never moved.
    assertRetention(root, resolved.name, resolved.verified);
    assertExternalUnchanged(external);
    assertNotPinned(isPinned, resolved.path);
    const rechecked = recheckSource(root, resolved);
    if (rechecked.fingerprint !== expectedFingerprint)
      throw new Error("バックアップが計画後に変更されています。移動しません。");
    assertWrapperReady(wrapper, wrapperInfo, resolved.name);

    const destinationPath = join(wrapper, resolved.name);
    try {
      fs.renameSync(resolved.path, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        throw exdevError(error);
      }
      throw error;
    }
    moved = true;
  } catch (error) {
    if (!moved) cleanupWrapper(wrapper, external.path);
    throw error;
  }

  try {
    // Flush the moved name and the removal on both sides of the rename.
    syncPath(wrapper);
    syncPath(root.backups);
    syncPath(external.path);
    const movedBackup = verifyFullBackup(join(wrapper, resolved.name));
    if (movedBackup.fingerprint !== expectedFingerprint)
      throw new Error("移動後のfingerprintが計画時と異なります。");
    return { destination: wrapper };
  } catch (error) {
    throw movedStateError(wrapper, error);
  }
}
