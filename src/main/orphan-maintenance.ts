import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertOutsideFolioData } from "../persistence/output-path";
import { syncPath } from "../persistence/durable-file";
import { parseAssetURL } from "../shared/assets";

const MAX_BYTES = 20_000_000;
const MAX_REGISTRY_ROWS = 20_000;
const MAX_METADATA_CHARS = 65_536;
const MAX_REGISTRY_CHARS = 32 * 1024 * 1024;
const TICKET_TTL_MS = 10 * 60 * 1000;
const HASH_CHUNK_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const UUID_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

type Registry = { exact: Set<string>; folded: Map<string, string> };
type FileSnapshot = { dev: number; ino: number; size: number; sha256: string };
type Ticket = FileSnapshot & { name: string; path: string; expiresAt: number };
type ExternalParent = { path: string; stat: Stats };
type Wrapper = { path: string; stat: Stats };

function lstatIfExists(path: string): Stats | undefined {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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

function sameNode(left: Stats, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {}
}

function assertPlainName(name: string): void {
  if (
    name.length > 255 ||
    !SAFE_NAME.test(name) ||
    name.endsWith(".") ||
    RESERVED_NAME.test(name)
  )
    throw new Error("安全なASCIIファイル名ではないため保持します。");
}

function assertRegistryName(name: string): void {
  assertPlainName(name);
}

function assertUnreachableName(name: string): void {
  assertPlainName(name);
  if (UUID_PREFIX.test(name)) throw new Error("UUIDで始まる名前は移動できません。");
  if (parseAssetURL(`folio-asset://${name}`) !== null)
    throw new Error("FolioのURLとして到達可能な名前は移動できません。");
}

function hashDescriptor(fd: number, expectedSize: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > expectedSize)
      throw new Error("ファイルが検査中に大きくなりました。");
    hash.update(buffer.subarray(0, read));
  }
  if (total !== expectedSize)
    throw new Error("ファイルが検査中に小さくなりました。");
  return hash.digest("hex");
}

/** Open without following a final symlink, pin the inode, hash the exact bytes,
 * and require a single link. The descriptor stays open for an immediate move. */
function openPinned(
  path: string,
  expected?: FileSnapshot,
): { fd: number; snapshot: FileSnapshot } {
  const before = fs.lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error("通常ファイルではないため保持します。");
  if (before.nlink !== 1)
    throw new Error("ハードリンクされたファイルは移動できません。");
  if (!Number.isSafeInteger(before.size) || before.size > MAX_BYTES)
    throw new Error("サイズ上限を超えたファイルは移動できません。");
  if (
    expected &&
    (before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size !== expected.size)
  )
    throw new Error("計画後にファイルが変更されています。");

  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > MAX_BYTES
    )
      throw new Error("ファイルが検査中に変更されました。");
    const sha256 = hashDescriptor(fd, opened.size);
    const after = fs.fstatSync(fd);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.nlink !== 1 || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
    )
      throw new Error("ファイルが検査中に変更されました。");
    if (expected && sha256 !== expected.sha256)
      throw new Error("計画後にファイル内容が変更されています。");
    return {
      fd,
      snapshot: {
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        sha256,
      },
    };
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function movedStateError(destination: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `orphanファイルはアーカイブ済みですが、移動後の確定に失敗しました。移動先: ${destination}。元の場所には戻していません。${detail}`,
    { cause },
  );
}

function exdevError(cause: unknown): Error {
  const error = new Error(
    "orphanファイルと移動先が同じファイルシステムにないため移動できません。元のファイルは残しています。",
    { cause },
  );
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code) (error as NodeJS.ErrnoException).code = code;
  return error;
}

/**
 * Explicit, ticket-based maintenance for unregistered flat asset files.
 *
 * Only a conservative subset is eligible: safe ASCII names, one link, a
 * regular non-symlink file, no UUID-prefixed (legacy-addressable) basename,
 * and a name that Folio's parser cannot address. A registry that cannot be
 * validated or bounded holds every candidate. This class never changes SQLite:
 * it only reads the assets registry.
 *
 * The caller serializes this with attach/restore work. The final checks run
 * immediately before rename, but external writers can still race after them.
 * `clear()` drops unused tickets; no filesystem GC is implicit.
 */
export class OrphanMaintenance {
  private readonly workspace: string;
  private readonly assets: string;
  private readonly workspaceStat: Stats;
  private readonly assetsStat: Stats;
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly db: DatabaseSync, workspace: string) {
    if (typeof workspace !== "string" || workspace.length === 0)
      throw new Error("ワークスペースが不正です。");
    const requested = resolve(workspace);
    const requestedInfo = fs.lstatSync(requested);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory())
      throw new Error("ワークスペースが安全なディレクトリではありません。");
    this.workspace = fs.realpathSync(requested);
    if (dirname(this.workspace) === this.workspace)
      throw new Error("ファイルシステムのルートは管理対象にできません。");
    this.workspaceStat = fs.statSync(this.workspace);
    if (!sameNode(requestedInfo, this.workspaceStat))
      throw new Error("ワークスペースが検査中に変更されました。");

    const assetsPath = join(this.workspace, "assets");
    const assetsInfo = fs.lstatSync(assetsPath);
    if (assetsInfo.isSymbolicLink() || !assetsInfo.isDirectory())
      throw new Error("assetsが安全なディレクトリではありません。");
    this.assets = fs.realpathSync(assetsPath);
    if (dirname(this.assets) !== this.workspace || basename(this.assets) !== "assets")
      throw new Error("assetsがワークスペース直下にありません。");
    this.assetsStat = fs.statSync(this.assets);
    if (!sameNode(assetsInfo, this.assetsStat))
      throw new Error("assetsが検査中に変更されました。");
  }

  clear(): void {
    this.tickets.clear();
  }

  plan(source: string): { ticket: string; name: string; bytes: number } {
    this.assertRoots();
    const resolved = this.resolveSource(source);
    assertUnreachableName(resolved.name);

    const pinned = openPinned(resolved.path);
    try {
      const registry = this.readRegistry();
      this.assertUnregistered(registry, resolved.name);
      const ticket = randomUUID();
      this.tickets.set(ticket, {
        ...pinned.snapshot,
        name: resolved.name,
        path: resolved.path,
        expiresAt: Date.now() + TICKET_TTL_MS,
      });
      return { ticket, name: resolved.name, bytes: pinned.snapshot.size };
    } finally {
      closeQuietly(pinned.fd);
    }
  }

  move(ticket: string, externalParent: string): { destination: string } {
    const entry = this.tickets.get(ticket);
    if (!entry) throw new Error("このorphanチケットは無効です。");
    this.tickets.delete(ticket);
    if (Date.now() >= entry.expiresAt)
      throw new Error("orphanチケットの有効期限が切れています。");

    this.assertRoots();
    const external = this.readExternalParent(externalParent);
    const wrapper = this.createWrapper(external);
    const destination = join(wrapper.path, entry.name);
    let fd: number | undefined;
    let moved = false;
    try {
      assertUnreachableName(entry.name);
      const pinned = openPinned(entry.path, entry);
      fd = pinned.fd;
      // Re-read the registry after hashing so the addressability check is the
      // latest database read before the rename.
      const registry = this.readRegistry();
      this.assertUnregistered(registry, entry.name);
      this.assertRoots();

      const current = fs.lstatSync(entry.path);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1 ||
        !sameNode(current, pinned.snapshot) ||
        current.size !== pinned.snapshot.size ||
        fs.realpathSync(entry.path) !== entry.path
      )
        throw new Error("計画後にファイルが変更されています。");
      this.assertExternalUnchanged(external);
      this.assertWrapperReady(wrapper, entry.name);

      try {
        fs.renameSync(entry.path, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EXDEV")
          throw exdevError(error);
        throw error;
      }
      moved = true;
    } catch (error) {
      if (fd !== undefined) closeQuietly(fd);
      if (!moved) this.cleanupWrapper(wrapper, external.path);
      throw error;
    }

    try {
      if (fd !== undefined) {
        fs.closeSync(fd);
        fd = undefined;
      }
      // Flush the moved name and the removal on both sides of the rename.
      syncPath(wrapper.path);
      syncPath(this.assets);
      syncPath(external.path);
      const archived = openPinned(destination, entry);
      closeQuietly(archived.fd);
      return { destination };
    } catch (error) {
      throw movedStateError(destination, error);
    } finally {
      if (fd !== undefined) closeQuietly(fd);
    }
  }

  private resolveSource(source: string): { name: string; path: string } {
    if (typeof source !== "string" || source.length === 0)
      throw new Error("対象ファイルが不正です。");
    const requested = resolve(source);
    const requestedInfo = fs.lstatSync(requested);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isFile())
      throw new Error("対象は通常ファイルではありません。");
    const path = fs.realpathSync(requested);
    if (dirname(path) !== this.assets)
      throw new Error("assets直下のファイルだけを対象にできます。");
    const name = basename(path);
    assertPlainName(name);
    const current = fs.statSync(path);
    if (!sameNode(requestedInfo, current))
      throw new Error("対象ファイルが検査中に変更されました。");
    return { name, path };
  }

  private assertRoots(): void {
    const workspace = fs.lstatSync(this.workspace);
    const assets = fs.lstatSync(this.assets);
    if (
      workspace.isSymbolicLink() ||
      !workspace.isDirectory() ||
      assets.isSymbolicLink() ||
      !assets.isDirectory() ||
      !sameNode(workspace, this.workspaceStat) ||
      !sameNode(assets, this.assetsStat) ||
      fs.realpathSync(this.workspace) !== this.workspace ||
      fs.realpathSync(this.assets) !== this.assets
    )
      throw new Error("ワークスペースまたはassetsが変更されています。");
  }

  private readRegistry(): Registry {
    if (this.db.isTransaction)
      throw new Error("未確定のトランザクションではorphanを移動できません。");
    let rows: Iterable<Record<string, unknown>>;
    try {
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM assets LIMIT ?)").get(MAX_REGISTRY_ROWS + 1)?.n;
      if (typeof count !== "number" || count > MAX_REGISTRY_ROWS) throw new Error("添付登録の確認上限を超えています。");
      rows = this.db.prepare("SELECT substr(id,1,256) AS id, substr(metadata,1,?) AS metadata FROM assets ORDER BY id LIMIT ?")
        .iterate(MAX_METADATA_CHARS + 1, MAX_REGISTRY_ROWS + 1);
    } catch (error) {
      throw new Error("添付登録または件数上限を検証できないため保持します。", { cause: error });
    }
    let characters = 0;
    const exact = new Set<string>();
    const folded = new Map<string, string>();
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.metadata !== "string" ||
        row.metadata.length > MAX_METADATA_CHARS
      )
        throw new Error("添付登録に不正なデータがあるため保持します。");
      characters += row.metadata.length;
      if (characters > MAX_REGISTRY_CHARS) throw new Error("添付登録の読取上限を超えています。");
      try {
        assertRegistryName(row.id);
      } catch (error) {
        throw new Error("添付登録に不正なデータがあるため保持します。", {
          cause: error,
        });
      }
      const key = row.id.toLowerCase();
      if (folded.has(key))
        throw new Error("添付登録に大文字小文字の衝突があるため保持します。");
      let metadata: unknown;
      try {
        metadata = JSON.parse(row.metadata);
      } catch (error) {
        throw new Error("添付登録に不正なデータがあるため保持します。", {
          cause: error,
        });
      }
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        (metadata as Record<string, unknown>).id !== row.id ||
        (metadata as Record<string, unknown>).storageName !== row.id ||
        !Number.isSafeInteger((metadata as Record<string, unknown>).size) ||
        ((metadata as Record<string, unknown>).size as number) < 0 ||
        ((metadata as Record<string, unknown>).size as number) > MAX_BYTES ||
        typeof (metadata as Record<string, unknown>).sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(
          (metadata as Record<string, unknown>).sha256 as string,
        )
      )
        throw new Error("添付登録に不正なデータがあるため保持します。");
      exact.add(row.id);
      folded.set(key, row.id);
    }
    return { exact, folded };
  }

  private assertUnregistered(registry: Registry, name: string): void {
    if (registry.exact.has(name))
      throw new Error("添付登録済みのファイルは移動できません。");
    if (registry.folded.has(name.toLowerCase()))
      throw new Error("登録名と大文字小文字だけが異なるため移動できません。");
    const dir = fs.opendirSync(this.assets);
    try {
      let count = 0;
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++count > MAX_REGISTRY_ROWS) throw new Error("添付フォルダーの確認上限を超えています。");
        if (entry.name !== name && entry.name.toLowerCase() === name.toLowerCase())
          throw new Error("大文字小文字だけが異なる同名ファイルがあるため保持します。");
      }
    } finally { dir.closeSync(); }
  }

  /** Keep generated archives outside the workspace and Folio profile data. */
  private readExternalParent(externalParent: string): ExternalParent {
    if (typeof externalParent !== "string" || externalParent.length === 0)
      throw new Error("移動先フォルダーが不正です。");
    const path = fs.realpathSync(resolve(externalParent));
    const stat = fs.statSync(path);
    if (!stat.isDirectory())
      throw new Error("移動先が安全なディレクトリではありません。");
    this.assertOutsideFolioData(path, stat);
    assertOutsideFolioData(path);
    return { path, stat };
  }

  private assertOutsideFolioData(path: string, stat: Stats): void {
    if (inside(this.workspace, path))
      throw new Error("移動先はワークスペースの外側を指定してください。");
    const trees = [
      this.workspace,
      this.assets,
      join(this.workspace, "backups"),
      join(this.workspace, "session"),
    ];
    if (basename(this.workspace) === "workspace") {
      const profile = dirname(this.workspace);
      trees.push(join(profile, "session"), join(profile, "backups"));
    }
    for (const tree of trees) {
      if (!lstatIfExists(tree)) continue;
      let real: string;
      try {
        real = fs.realpathSync(tree);
      } catch {
        continue;
      }
      if (inside(real, path) || sameNode(stat, fs.statSync(real)))
        throw new Error("移動先がFolioのデータツリーを指しています。");
    }
  }

  private createWrapper(external: ExternalParent): Wrapper {
    const path = fs.mkdtempSync(
      join(external.path, `folio-orphan-archive-${Date.now()}-`),
    );
    try {
      const stat = fs.lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("非公開の移動先フォルダーを作成できません。");
      syncPath(external.path);
      return { path, stat };
    } catch (error) {
      try {
        fs.rmdirSync(path);
      } catch {}
      throw error;
    }
  }

  private cleanupWrapper(wrapper: Wrapper, parent: string): void {
    // Only an empty wrapper created by this call is removed, never recursively.
    try {
      fs.rmdirSync(wrapper.path);
    } catch {}
    try {
      syncPath(parent);
    } catch {}
  }

  private assertExternalUnchanged(external: ExternalParent): void {
    const info = fs.lstatSync(external.path);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !sameNode(info, external.stat) ||
      fs.realpathSync(external.path) !== external.path
    )
      throw new Error("移動先フォルダーが変更されています。");
  }

  private assertWrapperReady(wrapper: Wrapper, name: string): void {
    const info = fs.lstatSync(wrapper.path);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !sameNode(info, wrapper.stat) ||
      fs.readdirSync(wrapper.path).length !== 0 ||
      lstatIfExists(join(wrapper.path, name))
    )
      throw new Error("移動先の作成状態が変更されています。");
  }
}
