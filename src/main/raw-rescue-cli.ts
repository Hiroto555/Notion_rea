import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRawWorkspaceSalvage } from "../persistence/raw-workspace-salvage";
import { writeNewFileDurably } from "../persistence/durable-file";
import { assertOutsideFolioData } from "../persistence/output-path";
import { estimateBackupBytes } from "./bulk-storage-budget";
import { WorkspaceStoragePressure } from "./storage-pressure";

/**
 * Headless emergency export for a workspace that cannot start normally.
 *
 * This entry point deliberately avoids Electron, Store and migrations. It
 * opens the explicit `workspace.sqlite` read-only (SQLite itself applies
 * committed WAL frames), then reuses the same raw salvage writer and the same
 * destination-capacity admission as the production maintenance path.
 *
 * Cross-file snapshots cannot be made atomic with SQLite alone. The caller
 * must confirm that the workspace is closed (`--workspace-closed`), and this
 * CLI additionally fingerprints the source before and after the capture. Any
 * change observed during the capture turns the result into a failure and
 * restores the incomplete marker on the bundle. A flag is only a declaration;
 * it is never treated as proof that external processes are stopped.
 */

const INCOMPLETE_MARKER = "FOLIO-RAW-SALVAGE-INCOMPLETE";
const INCOMPLETE_TEXT =
  "Raw diagnostic salvage incomplete; do not use or restore this folder as a workspace.\n";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const JOURNAL_NAME = /^crash-recovery\.json(?:\.stage-[A-Za-z0-9-]{1,64})?$/;
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 64;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_JOURNALS = 101;
const RESCUE_DIRECTORY_PREFIX = "folio-raw-salvage-";

export const RAW_RESCUE_HELP = `Folio 生データ救出 (headless / 診断用・復元不可)

使い方:
  node dist/raw-rescue.cjs --workspace <既存ディレクトリ> \\
    --destination <既存の外部親フォルダ> --workspace-closed

必須:
  --workspace <dir>     Folio ワークスペース (workspace.sqlite を含む既存ディレクトリ)
  --destination <dir>   出力先の既存フォルダ。ワークスペースの外側を指定する
  --workspace-closed    Folio を完全に終了したことの明示的な確認

オプション:
  -h, --help            このヘルプを表示する

動作:
  - workspace.sqlite を読み取り専用の SQLite 接続で開き、確定済み WAL を含む
    consistent な raw snapshot を新しい folio-raw-salvage-<uuid> に保存する。
  - 通常の Store、マイグレーション、画面、Electron は使わない。
  - 出力は完全バックアップではない。salvage-manifest.json は restorable: false で、
    復元には使えません。FOLIO-RAW-SALVAGE-INCOMPLETE がある出力は未完了。
  - --workspace-closed は外部プロセスの終了を証明しない。救出中にソースが
    変化した場合は失敗し、未完了マーカーを付ける。
  - 退避先の空き容量は本番の救出経路と同じ見積もり (DB + assets + journals +
    安全余裕) で確認する。

終了コード:
  0 = 成功 / 1 = 救出失敗 / 2 = 使用方法の誤り
`;

export type RawRescueIo = {
  out(text: string): void;
  err(text: string): void;
  cwd(): string;
};

type RawRescueOptions = {
  workspace: string;
  destination: string;
  workspaceClosed: boolean;
  help: boolean;
};

type PreparedRescue = {
  workspaceRoot: string;
  databasePath: string;
  destinationParent: string;
  initialFingerprint: string;
};

type RescueResult = { directory: string; files: number; bytes: number };

class UsageError extends Error {}

/** Raised only when the source changes during the capture window. */
class SourceChangedError extends Error {
  constructor() {
    super(
      "救出中にワークスペースが変更されました。出力の時点一致を確認できないため、復元には使えません。",
    );
  }
}

const defaultIo: RawRescueIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  cwd: () => process.cwd(),
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lstatOptional(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
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

function statLine(info: BigIntStats): string {
  const kind = info.isFile()
    ? "f"
    : info.isDirectory()
      ? "d"
      : info.isSymbolicLink()
        ? "l"
        : "o";
  return [
    kind,
    info.dev,
    info.ino,
    info.nlink,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
    info.mode,
  ]
    .map(String)
    .join(":");
}

/** Fingerprint the source files that a raw salvage consumes. The transient
 * `-shm` index is deliberately omitted: SQLite rewrites it when a read-only
 * WAL reader opens or closes, and it contains no committed payload. */
function fingerprintWorkspace(root: string): string {
  const hash = createHash("sha256");
  const add = (line: string): void => {
    hash.update(String(Buffer.byteLength(line)));
    hash.update(":");
    hash.update(line);
    hash.update("\n");
  };
  const addOptional = (label: string, path: string): void => {
    const info = lstatOptional(path);
    add(`${label}:${info ? statLine(info) : "missing"}`);
  };

  addOptional("database", join(root, "workspace.sqlite"));
  for (const suffix of SIDECAR_SUFFIXES) {
    if (suffix === "-shm") continue;
    const path = join(root, "workspace.sqlite" + suffix);
    const info = lstatOptional(path);
    // Opening a WAL-mode database for reading can create an empty WAL.
    // It carries no committed payload, as does an absent WAL/journal.
    add(`sidecar${suffix}:${!info || (info.isFile() && !info.isSymbolicLink() && info.size === 0n) ? "empty" : statLine(info)}`);
  }
  addJournals(root, add);
  addAssetTree(join(root, "assets"), add);
  return hash.digest("hex");
}

function addJournals(root: string, add: (line: string) => void): void {
  let visited = 0;
  const names: string[] = [];
  for (const name of readdirSync(root)) {
    if (++visited > MAX_ENTRIES)
      throw new Error("救出元の項目数上限を超えました。");
    if (
      name === "crash-recovery.json" ||
      name.startsWith("crash-recovery.json.stage-")
    )
      names.push(name);
  }
  if (names.length > MAX_JOURNALS)
    throw new Error("クラッシュ復旧ジャーナルの数が上限を超えました。");
  for (const name of names.sort()) {
    if (!JOURNAL_NAME.test(name))
      throw new Error(
        "クラッシュ復旧ジャーナルの名前が想定と異なります: " + name,
      );
    addOptionalFile(join(root, name), "クラッシュ復旧ジャーナル", name, add);
  }
}

function addOptionalFile(
  path: string,
  label: string,
  relativePath: string,
  add: (line: string) => void,
): void {
  const info = lstatOptional(path);
  add(`${label}:${relativePath}:${info ? statLine(info) : "missing"}`);
  if (!info) return;
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n)
    throw new Error(`${label}が通常ファイルではありません: ${relativePath}`);
  if (info.size > BigInt(MAX_FILE_BYTES))
    throw new Error(`${label}がサイズ上限を超えました: ${relativePath}`);
}

function addAssetTree(root: string, add: (line: string) => void): void {
  const rootInfo = lstatOptional(root);
  add(`assets:${rootInfo ? statLine(rootInfo) : "missing"}`);
  if (!rootInfo) return;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("生データ退避元の添付フォルダが安全ではありません。");
  if (realpathSync(root) !== root)
    throw new Error("添付フォルダにシンボリックリンクの経路があります。");

  const pending: { path: string; relativePath: string; depth: number }[] = [
    { path: root, relativePath: "", depth: 0 },
  ];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > MAX_DEPTH)
      throw new Error(
        "添付フォルダの階層が深すぎるため生データ退避を中止しました。",
      );
    const names = readdirSync(current.path).sort();
    for (const name of names) {
      if (++entries > MAX_ENTRIES)
        throw new Error("添付フォルダの項目数上限を超えました。");
      if (
        !name ||
        name === "." ||
        name === ".." ||
        name.length > 255 ||
        /[/\\\u0000]/.test(name)
      )
        throw new Error(
          "安全でないファイル名のため生データ退避を中止しました。",
        );
      const relativePath = current.relativePath
        ? `${current.relativePath}/${name}`
        : name;
      if (relativePath.length > 1024)
        throw new Error("添付ファイルのパスが長すぎます: " + relativePath);
      const path = join(current.path, name);
      const info = lstatOptional(path);
      add(`asset:${relativePath}:${info ? statLine(info) : "missing"}`);
      if (!info) continue;
      if (info.isSymbolicLink())
        throw new Error(
          "添付フォルダにシンボリックリンクがあるため生データ退避を中止しました: " +
            relativePath,
        );
      if (info.isDirectory()) {
        pending.push({
          path,
          relativePath,
          depth: current.depth + 1,
        });
        continue;
      }
      if (!info.isFile() || info.nlink !== 1n)
        throw new Error(
          "添付フォルダに通常ファイル以外の項目があります: " + relativePath,
        );
      if (info.size > BigInt(MAX_FILE_BYTES))
        throw new Error(
          "添付ファイルが1ファイルのサイズ上限を超えました: " + relativePath,
        );
    }
  }
}

function parseRawRescueArgs(argv: readonly string[]): RawRescueOptions {
  let workspace: string | undefined;
  let destination: string | undefined;
  let workspaceClosed = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h")
      return {
        workspace: "",
        destination: "",
        workspaceClosed: false,
        help: true,
      };
    if (!argument.startsWith("--"))
      throw new UsageError(`不明な引数です: ${argument}`);
    const equal = argument.indexOf("=");
    const name = equal === -1 ? argument : argument.slice(0, equal);
    const inlineValue = equal === -1 ? undefined : argument.slice(equal + 1);
    if (name === "--workspace-closed") {
      if (inlineValue !== undefined)
        throw new UsageError("--workspace-closed に値は指定できません。");
      if (workspaceClosed)
        throw new UsageError("--workspace-closed が重複しています。");
      workspaceClosed = true;
      continue;
    }
    if (name !== "--workspace" && name !== "--destination")
      throw new UsageError(`不明なオプションです: ${name}`);
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--"))
        throw new UsageError(`${name} には値が必要です。`);
      value = next;
      index++;
    }
    if (!value) throw new UsageError(`${name} には空でない値が必要です。`);
    if (name === "--workspace") {
      if (workspace !== undefined)
        throw new UsageError("--workspace が重複しています。");
      workspace = value;
    } else {
      if (destination !== undefined)
        throw new UsageError("--destination が重複しています。");
      destination = value;
    }
  }

  if (workspace === undefined)
    throw new UsageError("--workspace を指定してください。");
  if (destination === undefined)
    throw new UsageError("--destination を指定してください。");
  if (!workspaceClosed)
    throw new UsageError(
      "Folio を完全に終了したうえで --workspace-closed を指定してください。",
    );
  return { workspace, destination, workspaceClosed, help: false };
}

function prepareRescue(options: RawRescueOptions, cwd: string): PreparedRescue {
  const requestedWorkspace = resolve(cwd, options.workspace);
  const workspaceInfo = lstatOptional(requestedWorkspace);
  if (!workspaceInfo)
    throw new Error(`ワークスペースが見つかりません: ${requestedWorkspace}`);
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory())
    throw new Error(
      `ワークスペースは通常のディレクトリではありません: ${requestedWorkspace}`,
    );
  const workspaceRoot = realpathSync(requestedWorkspace);

  const databasePath = join(workspaceRoot, "workspace.sqlite");
  const databaseInfo = lstatOptional(databasePath);
  if (!databaseInfo)
    throw new Error(`workspace.sqlite が見つかりません: ${databasePath}`);
  if (
    databaseInfo.isSymbolicLink() ||
    !databaseInfo.isFile() ||
    databaseInfo.nlink !== 1n
  )
    throw new Error(
      "workspace.sqlite は安全な通常ファイルではありません (シンボリックリンク/ハードリンク不可)。",
    );
  assertSafeSidecarsNow(workspaceRoot);

  const requestedDestination = resolve(cwd, options.destination);
  const destinationInfo = lstatOptional(requestedDestination);
  if (!destinationInfo)
    throw new Error(
      `退避先の親フォルダが見つかりません: ${requestedDestination}`,
    );
  let destinationParent: string;
  try {
    destinationParent = realpathSync(requestedDestination);
  } catch {
    throw new Error(
      `退避先の親フォルダを解決できません: ${requestedDestination}`,
    );
  }
  const canonicalDestinationInfo = lstatOptional(destinationParent);
  if (
    !canonicalDestinationInfo ||
    canonicalDestinationInfo.isSymbolicLink() ||
    !canonicalDestinationInfo.isDirectory()
  )
    throw new Error("退避先の親フォルダが通常のディレクトリではありません。");
  if (inside(workspaceRoot, destinationParent))
    throw new Error("ワークスペース内には生データ退避を出力できません。");
  assertOutsideFolioData(destinationParent);

  // Validate the complete source payload and fingerprint it before opening
  // SQLite, so unsafe assets/journals/sidecars fail without creating output.
  const initialFingerprint = fingerprintWorkspace(workspaceRoot);
  return {
    workspaceRoot,
    databasePath,
    destinationParent,
    initialFingerprint,
  };
}

function assertSafeSidecarsNow(root: string): void {
  for (const suffix of SIDECAR_SUFFIXES) {
    const info = lstatOptional(join(root, "workspace.sqlite" + suffix));
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n)
      throw new Error(
        `SQLite の sidecar が安全ではありません: workspace.sqlite${suffix}`,
      );
  }
}

function assertCanonicalConnection(
  connection: DatabaseSync,
  databasePath: string,
): void {
  const rows = connection.prepare("PRAGMA database_list").all() as {
    name?: unknown;
    file?: unknown;
  }[];
  const main = rows.find((row) => row.name === "main");
  if (!main || typeof main.file !== "string" || !main.file)
    throw new Error("読み取り専用 SQLite 接続のファイルを確認できません。");
  let actual: string;
  try {
    actual = realpathSync(main.file);
  } catch {
    throw new Error("読み取り専用 SQLite 接続のファイルを解決できません。");
  }
  if (actual !== databasePath)
    throw new Error(
      "読み取り専用 SQLite 接続が指定ワークスペースの workspace.sqlite と一致しません。",
    );
}

function readDataVersion(connection: DatabaseSync): string {
  const value = connection.prepare("PRAGMA data_version").get()?.data_version;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  throw new Error("SQLite の data_version を確認できません。");
}

function assertSourceUnchanged(
  root: string,
  expectedFingerprint: string,
  expectedDataVersion: string,
  connection: DatabaseSync,
): void {
  if (readDataVersion(connection) !== expectedDataVersion)
    throw new SourceChangedError();
  try {
    assertSafeSidecarsNow(root);
    if (fingerprintWorkspace(root) !== expectedFingerprint)
      throw new SourceChangedError();
  } catch (error) {
    if (error instanceof SourceChangedError) throw error;
    // An unreadable/unsafe source tree can no longer be proven equal to the
    // baseline. Report it as a change so a completed bundle is marked unsafe.
    throw new SourceChangedError();
  }
  if (readDataVersion(connection) !== expectedDataVersion)
    throw new SourceChangedError();
}

function markIncomplete(directory: string): boolean {
  const marker = join(directory, INCOMPLETE_MARKER);
  try {
    writeNewFileDurably(marker, INCOMPLETE_TEXT, {
      mode: 0o600,
      syncParentDirectory: true,
    });
    return true;
  } catch {
    return lstatOptional(marker) !== undefined;
  }
}

function newRescueDirectories(
  parent: string,
  before: ReadonlySet<string>,
): { directory: string; incomplete: boolean }[] {
  const found: { directory: string; incomplete: boolean }[] = [];
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return found;
  }
  for (const name of names.sort()) {
    if (!name.startsWith(RESCUE_DIRECTORY_PREFIX) || before.has(name)) continue;
    const directory = join(parent, name);
    const info = lstatOptional(directory);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    found.push({
      directory,
      incomplete:
        lstatOptional(join(directory, INCOMPLETE_MARKER)) !== undefined,
    });
  }
  return found;
}

function successText(prepared: PreparedRescue, result: RescueResult): string {
  return [
    "Folio 生データ救出（診断用・復元不可）",
    `ワークスペース: ${prepared.workspaceRoot}`,
    `出力先: ${result.directory}`,
    `ファイル数: ${result.files}`,
    `合計サイズ: ${result.bytes} バイト`,
    "状態: 成功（SQLite スナップショットと全ファイルを検証済み）",
    "注意: この出力は完全バックアップではなく、復元には使えません。",
    "元のコミット済みDB・添付・復旧ジャーナルを保全しました。",
    "SQLiteの読取り用インデックス（-shm）が作成・更新される場合があります。",
    "",
  ].join("\n");
}

export function runRawRescueCli(
  argv: readonly string[],
  io: RawRescueIo = defaultIo,
): number {
  let options: RawRescueOptions;
  try {
    options = parseRawRescueArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`使用方法の誤り: ${error.message}\n`);
      io.err("`--help` で使用方法を確認できます。\n");
      return 2;
    }
    throw error;
  }
  if (options.help) {
    io.out(RAW_RESCUE_HELP);
    return 0;
  }

  let prepared: PreparedRescue | undefined;
  let connection: DatabaseSync | undefined;
  let bundle: RescueResult | undefined;
  let destinationBefore: Set<string> | undefined;
  let sourceChanged = false;
  let baselineDataVersion: string | undefined;

  try {
    prepared = prepareRescue(options, io.cwd());
    try {
      connection = new DatabaseSync(prepared.databasePath, {
        readOnly: true,
        timeout: 5_000,
      });
    } catch (error) {
      throw new Error(
        `workspace.sqlite を読み取り専用で開けません: ${errorText(error)}`,
      );
    }
    assertCanonicalConnection(connection, prepared.databasePath);
    const dataVersion = readDataVersion(connection);
    baselineDataVersion = dataVersion;
    const initialFingerprint = prepared.initialFingerprint;
    destinationBefore = new Set(readdirSync(prepared.destinationParent));

    const activeConnection = connection;
    const activePrepared = prepared;
    bundle = createRawWorkspaceSalvage(
      activeConnection,
      activePrepared.workspaceRoot,
      activePrepared.destinationParent,
      (journalBytes) => {
        assertSourceUnchanged(
          activePrepared.workspaceRoot,
          initialFingerprint,
          dataVersion,
          activeConnection,
        );
        // Keep this in lockstep with WorkspaceStorageService's
        // "storage:rawSalvage" admission: DB + assets estimate + journals,
        // plus the shared physical reserve.
        const estimate =
          estimateBackupBytes(activeConnection, activePrepared.workspaceRoot) +
          journalBytes;
        new WorkspaceStoragePressure(
          activePrepared.destinationParent,
        ).assertWritable(estimate);
      },
    );
    assertSourceUnchanged(
      activePrepared.workspaceRoot,
      initialFingerprint,
      dataVersion,
      activeConnection,
    );
    io.out(successText(activePrepared, bundle));
    return 0;
  } catch (error) {
    if (error instanceof SourceChangedError) sourceChanged = true;
    else if (connection && prepared && baselineDataVersion !== undefined) {
      try {
        // The export may have aborted for an unrelated reason after the
        // source changed. Record that before deciding how to word the failure.
        assertSourceUnchanged(
          prepared.workspaceRoot,
          prepared.initialFingerprint,
          baselineDataVersion,
          connection,
        );
      } catch (verificationError) {
        if (verificationError instanceof SourceChangedError)
          sourceChanged = true;
      }
    }

    if (bundle) {
      const marked = markIncomplete(bundle.directory);
      io.err(`救出できませんでした: ${errorText(error)}\n`);
      io.err(`出力: ${bundle.directory}\n`);
      io.err(
        marked
          ? "未完了マーカーを追加しました。この出力は復元には使えません。\n"
          : "未完了マーカーを確認できません。この出力は復元には使えません。\n",
      );
      if (sourceChanged)
        io.err(
          "救出中にワークスペースが変更されました。出力の時点一致を保証できません。\n",
        );
      return 1;
    }

    io.err(`救出できませんでした: ${errorText(error)}\n`);
    if (sourceChanged)
      io.err(
        "救出中にワークスペースが変更されました。出力の時点一致を保証できません。\n",
      );
    const outputs =
      prepared && destinationBefore
        ? newRescueDirectories(prepared.destinationParent, destinationBefore)
        : [];
    if (outputs.length) {
      for (const output of outputs)
        io.err(
          `${output.incomplete ? "未完了の出力" : "出力（状態未確認）"}: ${output.directory}\n`,
        );
      io.err(
        "復元には使えません。FOLIO-RAW-SALVAGE-INCOMPLETE を確認してください。\n",
      );
    } else {
      io.err("出力は作成していません。\n");
    }
    io.err("復元には使えません。\n");
    return 1;
  } finally {
    if (connection) {
      try {
        connection.close();
      } catch {
        // A close failure cannot turn an already reported result into success.
      }
    }
    // SQLite owns source-side WAL/SHM lifetimes. Other readers may still use
    // an index even when this reader originally caused it to appear.

  }
}

const invokedDirectly =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (invokedDirectly) process.exitCode = runRawRescueCli(process.argv.slice(2));
