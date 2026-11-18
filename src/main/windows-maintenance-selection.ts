/**
 * Windows maintenance selection: trusted external-output configuration and
 * scoped native admission for picker-driven maintenance flows.
 *
 * Trusted configuration contract (validated BEFORE Store/data writes):
 * - `config.root` is the single private native container. It is also the
 *   external `capabilityRoot`; no broadened root, no drive siblings.
 * - `workspace` (FOLIO_DATA_DIR) is a STRICT descendant of root.
 * - `publicationStateRoot` is a disjoint container (the V planner enforces
 *   state disjoint from the entire capability root).
 * - `outputParent` defaults to `root\FolioExports-<sha256(casefold ws)16>`;
 *   `FOLIO_WINDOWS_OUTPUT_PARENT` may override with a canonical strict child
 *   of root that stays disjoint from the workspace.
 * - `root == workspace`, drive roots, state overlap and outside-container
 *   selections are rejected lexically at plan time and natively at
 *   authorization time.
 *
 * Every scope installs the selected capability filesystem INSIDE the ambient
 * withPrivatePersistence context and re-asserts the composed current fence
 * (base product fence + originating request fence + ambient private
 * operation authority) before and after synchronous work. No capability,
 * fence or callback is ever stored on a ticket.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { win32 } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { asciiCaseFold, validateWindowsPath } from "../platform/windows/path-policy";
import {
  planWindowsExternalSelection,
  type WindowsExternalCapability,
  type WindowsExternalSelectionConfiguration,
} from "../platform/windows/external-capability";
import {
  withPrivatePersistence,
  type NativePrivateFile,
  type NativePrivateIdentity,
  type NativePrivateFilesystemPort,
} from "../platform/private-persistence";
import { assertPrivateOperationAuthority } from "../platform/private-operation-authority";
import {
  type WindowsProductNative,
} from "../platform/windows/product-native";
import type { WindowsOperatorConfig } from "../platform/windows/operator-native";
import type { VerifiedWorkspaceBackup } from "../shared/workspace-backup";
import { requireCondition } from "../sync/protocol";
import {prepareWindowsRestoredWorkspaceLaunch, type WindowsRestoredWorkspaceLaunch, type WindowsRestoreLaunchRequest} from "../platform/windows/restored-workspace-handoff";

const OUTPUT_ENV = "FOLIO_WINDOWS_OUTPUT_PARENT";

export type BackupSelection = Readonly<{
  directory: string;
  manifestPath: string;
  manifestSha256: string;
}>;

export type NativeMaintenanceRequest =
  | Readonly<{ kind: "backup-source"; source: BackupSelection }>
  | Readonly<{ kind: "restore-target"; source: BackupSelection; parent: string }>
  | Readonly<{ kind: "backup-archive"; source: BackupSelection; parent: string }>
  | Readonly<{ kind: "orphan-archive"; file: NativePrivateFile; parent: string }>
  | Readonly<{ kind: "raw-rescue"; parent: string }>;

/** Process-local launch owner, consumed by one open operation. It is never
 * stored on a renderer ticket or reused after an uncertain child launch. */
export type PreparedRestoreHandoff = Pick<WindowsRestoredWorkspaceLaunch,
  "childEnvironment" | "assertCurrent" | "close">;

export interface NativeMaintenance {
  withScope<T>(
    request: NativeMaintenanceRequest,
    current: () => void,
    work: () => T,
  ): T;
  admitOrphan(path: string, current: () => void): NativePrivateFile;
  withOrphan<T>(work: () => T): T;
  prepareRestored?(
    verified: VerifiedWorkspaceBackup,
    current: () => void,
    ticket: string,
  ): PreparedRestoreHandoff;
  checkRestored?(handoff: PreparedRestoreHandoff, current: () => void): void;
}

function canonical(path: string): string {
  return validateWindowsPath(path, path).canonical;
}

function under(path: string, ancestor: string): boolean {
  return asciiCaseFold(path).startsWith(asciiCaseFold(ancestor) + "\\");
}

/**
 * Pure trusted-configuration plan for the single-private-container layout.
 * Runs before any Store/data write in Main. `env` is the process
 * environment read at the trusted startup boundary, never renderer input.
 */
export function planWindowsMaintenanceSelection(
  config: WindowsOperatorConfig,
  workspace: string,
  env: NodeJS.ProcessEnv,
  forbiddenRoots: readonly string[] = [],
): WindowsExternalSelectionConfiguration {
  const root = canonical(config.root);
  const stateRoot = canonical(config.publicationStateRoot);
  const stateDirectory = canonical(config.publicationStateDirectory);
  const ws = canonical(workspace);
  if (win32.dirname(root) === root)
    throw new Error(
      "nativeRoot は private コンテナーである必要があります (ドライブルートは不可)。",
    );
  if (asciiCaseFold(ws) === asciiCaseFold(root) || !under(ws, root))
    throw new Error(
      "nativeRoot は private コンテナーである必要があります。ワークスペースは root の厳密な子孫にしてください (root==workspace は不可)。",
    );
  if (!under(stateDirectory, stateRoot))
    throw new Error("publicationStateDirectory は stateRoot 配下にしてください。");
  const configured = env[OUTPUT_ENV];
  const outputParent = configured
    ? canonical(configured)
    : win32.join(
        root,
        `FolioExports-${createHash("sha256")
          .update(asciiCaseFold(ws))
          .digest("hex")
          .slice(0, 16)}`,
      );
  if (
    asciiCaseFold(outputParent) === asciiCaseFold(ws) ||
    under(ws, outputParent) ||
    under(outputParent, ws)
  )
    throw new Error("出力先はワークスペースと分離した root 配下にしてください。");
  requireCondition(Array.isArray(forbiddenRoots) && forbiddenRoots.length <= 64, "maintenance-forbidden-roots", 503);
  for (const value of forbiddenRoots) {
    const forbidden = canonical(value);
    if (asciiCaseFold(outputParent) === asciiCaseFold(forbidden) || under(outputParent, forbidden) || under(forbidden, outputParent))
      throw new Error("出力先は Folio のプロファイル領域とも分離してください。private コンテナー内の別ワークスペースを FOLIO_DATA_DIR に指定してください。");
  }
  const selection: WindowsExternalSelectionConfiguration = {
    root,
    workspace: ws,
    stateRoot,
    capabilityRoot: root,
    outputParent,
  };
  // V lexical adjudication: strict child checks, drive-root and
  // workspace/state-overlap rejection also apply to selected paths later.
  planWindowsExternalSelection(selection);
  return selection;
}

/** Forward every call to the currently selected per-operation port so a
 * consumer may safely capture this object once (constructor-time
 * `privatePersistencePort()`) while each LATER call still resolves the
 * operation's capability port through the ALS store. Optional methods mirror
 * the BASE port's presence and resolve the target exactly once per call. */
function forwardingFilesystem(
  base: NativePrivateFilesystemPort,
  resolve: () => NativePrivateFilesystemPort,
): NativePrivateFilesystemPort {
  const facade: NativePrivateFilesystemPort = {
    platform: "win32",
    version: 1,
    synchronous: true,
    inspectDirectory: (path) => resolve().inspectDirectory(path),
    inspectFile: (path, maxBytes) => resolve().inspectFile(path, maxBytes),
    inspectFileIdentity: (path) => resolve().inspectFileIdentity(path),
    read: (path, expected, maxBytes) => resolve().read(path, expected, maxBytes),
    writeNew: (path, bytes, maxBytes) => resolve().writeNew(path, bytes, maxBytes),
    copyNew: (source, destination, expected, maxBytes) =>
      resolve().copyNew(source, destination, expected, maxBytes),
    renameNew: (source, destination, expected, maxBytes) =>
      resolve().renameNew(source, destination, expected, maxBytes),
    unlinkExact: (path, expected, maxBytes) =>
      resolve().unlinkExact(path, expected, maxBytes),
    proveSync: (path, expected) => resolve().proveSync(path, expected),
    createDirectory: (path) => resolve().createDirectory(path),
    snapshotSqlite: (db, destination) => resolve().snapshotSqlite(db, destination),
  };
  const optional = <K extends "inspectTree" | "renameDirectoryNew" | "acquireSqliteLease">(
    name: K,
  ): NonNullable<NativePrivateFilesystemPort[K]> =>
    ((...args: unknown[]) => {
      const target = resolve();
      const method = target[name];
      if (typeof method !== "function")
        throw new Error(`private-persistence-port-unsupported: ${name}`);
      return Reflect.apply(method, target, args);
    }) as unknown as NonNullable<NativePrivateFilesystemPort[K]>;
  if (typeof base.inspectTree === "function") facade.inspectTree = optional("inspectTree");
  if (typeof base.renameDirectoryNew === "function")
    facade.renameDirectoryNew = optional("renameDirectoryNew");
  if (typeof base.acquireSqliteLease === "function")
    facade.acquireSqliteLease = optional("acquireSqliteLease");
  return facade;
}

/** Real native maintenance port bound to the product and the trusted
 * selection plan. `deps.current` is the base product fence and is composed
 * with each request's originating fence. `available=false` (readOnly /
 * unbound startup) keeps diagnostics usable while every scoped admission
 * fails fast with a precise error before any mutation. */
export function createNativeMaintenance(deps: {
  product: WindowsProductNative;
  operatorConfig: WindowsOperatorConfig;
  selection: WindowsExternalSelectionConfiguration;
  workspace: string;
  current: () => void;
  available?: boolean;
  readOnlyWorkspace?: NativePrivateIdentity;
  workspaceId?: string;
  prepareRestoreLaunch?: (config: WindowsOperatorConfig, request: WindowsRestoreLaunchRequest) => PreparedRestoreHandoff;
}): NativeMaintenance {
  const { product, operatorConfig, selection, workspace } = deps;
  const available = deps.available !== false;
  const orphanPort = new AsyncLocalStorage<NativePrivateFilesystemPort>();
  const facade = forwardingFilesystem(
    product.privateFilesystem,
    () => orphanPort.getStore() ?? product.privateFilesystem,
  );
  const composed = (current: () => void): (() => void) => {
    requireCondition(
      typeof current === "function" &&
        !types.isAsyncFunction(current) &&
        !types.isGeneratorFunction(current),
      "maintenance-current-required",
      503,
    );
    const invoke = (fn: () => void) => {
      const returned = (fn as () => unknown)();
      // An accidental thenable must never become a silently pending await;
      // detach it so a later rejection cannot take the process down, then
      // still reject the nonvoid acknowledgement.
      if (types.isPromise(returned)) {
        Promise.resolve(returned).then(
          () => undefined,
          () => undefined,
        );
      }
      requireCondition(returned === undefined, "maintenance-current-required", 503);
    };
    return () => {
      invoke(deps.current);
      invoke(current);
      assertPrivateOperationAuthority();
    };
  };
  const requireAvailable = () =>
    requireCondition(available, "native-maintenance-unavailable-readonly", 503);
  const sourceAdmission = (source: BackupSelection, current: () => void) => ({
    kind: "backup" as const,
    path: source.directory,
    manifestPath: source.manifestPath,
    manifestSha256: source.manifestSha256,
    assertCurrent: current,
  });
  const scoped = <T>(cap: WindowsExternalCapability, work: () => T): T =>
    orphanPort.run(cap.privateFilesystem, () =>
      withPrivatePersistence(
        { nativePrivateFilesystem: cap.privateFilesystem },
        () => {
          cap.assertCurrent();
          const result = work();
          cap.assertCurrent();
          return result;
        },
      ),
    );

  const authorize = (
    kind:
      | "raw-rescue"
      | "backup-archive"
      | "orphan-archive"
      | "backup-source"
      | "restore-target",
    path: string,
    current: () => void,
    extra: {
      source?: ReturnType<typeof sourceAdmission>;
      file?: {
        kind: "orphan";
        path: string;
        expected: NativePrivateFile;
        assertCurrent(): void;
      };
    } = {},
  ): WindowsExternalCapability => {
    const plan = planWindowsExternalSelection(selection, path);
    if (deps.readOnlyWorkspace) {
      requireCondition(kind === "raw-rescue" || kind === "backup-source", "readonly-maintenance-mutation", 403);
      if (kind === "backup-source") {
        requireCondition(extra.source !== undefined, "readonly-backup-source-required", 503);
        return product.authorizeReadOnlyRescue({...plan, kind, workspaceDirectory: deps.readOnlyWorkspace,
          assertCurrent: current, source: extra.source!});
      }
      return product.authorizeReadOnlyRescue({...plan, kind: "raw-rescue", workspaceDirectory: deps.readOnlyWorkspace, assertCurrent: current});
    }
    return product.authorizeExternalCapability({...plan, kind, assertCurrent: current, ...extra});
  };

  const maintenance: NativeMaintenance = {
    withScope(request, current, work) {
      const fence = composed(current);
      requireAvailable();
      if (deps.readOnlyWorkspace) requireCondition(request.kind === "raw-rescue" || request.kind === "backup-source", "readonly-maintenance-mutation", 403);
      fence();
      switch (request.kind) {
        case "backup-source": {
          const source = request.source;
          // A workspace-owned backup is already inside the bound private
          // tree: admit the exact manifest and keep the base filesystem.
          if (under(canonical(source.directory), canonical(workspace))) {
            product.admitSelectedSource(sourceAdmission(source, fence));
            fence();
            const result = work();
            fence();
            return result;
          }
          const cap = authorize("backup-source", source.directory, fence, {
            source: sourceAdmission(source, fence),
          });
          return scoped(cap, work);
        }
        case "restore-target":
        case "backup-archive": {
          const cap = authorize(request.kind, request.parent, fence, {
            source: sourceAdmission(request.source, fence),
          });
          return scoped(cap, work);
        }
        case "orphan-archive": {
          const file = request.file;
          const cap = authorize("orphan-archive", request.parent, fence, {
            file: {
              kind: "orphan",
              path: file.path,
              expected: file,
              assertCurrent: fence,
            },
          });
          return scoped(cap, work);
        }
        case "raw-rescue": {
          const cap = authorize("raw-rescue", request.parent, fence);
          return scoped(cap, work);
        }
      }
    },
    admitOrphan(path, current) {
      const fence = composed(current);
      requireAvailable();
      fence();
      const expected = product.inspectSelectedFile({
        kind: "orphan",
        path,
        assertCurrent: fence,
      });
      product.admitSelectedFile({
        kind: "orphan",
        path,
        expected,
        assertCurrent: fence,
      });
      fence();
      return expected;
    },
    withOrphan(work) {
      requireAvailable();
      return withPrivatePersistence({ nativePrivateFilesystem: facade }, work);
    },
    prepareRestored(verified, current, ticket) {
      const fence = composed(current);
      requireAvailable(); fence();
      requireCondition(typeof deps.workspaceId === "string" && deps.workspaceId.length > 0,
        "restored-current-workspace-required", 503);
      const native = product.privateFilesystem;
      requireCondition(typeof native.inspectTree === "function", "restored-tree-proof-required", 503);
      const tree = native.inspectTree!(verified.directory);
      fence();
      const prepare = deps.prepareRestoreLaunch ?? prepareWindowsRestoredWorkspaceLaunch;
      return prepare(operatorConfig, {ticket,
        current: {directory: workspace, workspaceId: deps.workspaceId!, assertCurrent: fence},
        directory: verified.directory, verifiedFingerprint: verified.fingerprint,
        verifiedTree: tree, nativeFilesystem: native});
    },
    checkRestored(handoff, current) {
      const fence = composed(current);
      requireAvailable(); fence(); handoff.assertCurrent(); fence();
    },
  };
  return maintenance;
}

/** Startup proof of the configured output parent. An EXISTING directory must
 * be admitted first: the raw-rescue authorization natively proves/enrolls
 * it, then its scoped filesystem inspects the identity. A MISSING final
 * child is positively created through the base filesystem only after its
 * parent is proven (non-root parents are admitted by raw-rescue on the
 * parent first; missing intermediate ancestors reject; no Node mkdir). */
export function proveMaintenanceOutputParent(
  product: WindowsProductNative,
  selection: WindowsExternalSelectionConfiguration,
  current: () => void,
  observations: {
    exists(path: string): boolean;
    directory(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  } = { exists: existsSync, directory: lstatSync },
  readOnlyWorkspace?: NativePrivateIdentity,
): void {
  current();
  const native = product.privateFilesystem;
  const output = selection.outputParent;
  if (observations.exists(output)) {
    const info = observations.directory(output);
    requireCondition(
      info.isDirectory() && !info.isSymbolicLink(),
      "output-parent-not-directory",
      409,
    );
    const cap = authorizeOutputParent(product, selection, output, current, readOnlyWorkspace);
    cap.privateFilesystem.inspectDirectory(output);
    cap.assertCurrent();
    return;
  }
  const parent = win32.dirname(output);
  requireCondition(parent !== output && observations.exists(parent), "output-parent-missing-ancestors", 409);
  if (asciiCaseFold(parent) === asciiCaseFold(selection.root)) {
    native.inspectDirectory(parent);
  } else {
    const parentCap = authorizeOutputParent(product, selection, parent, current, readOnlyWorkspace);
    parentCap.privateFilesystem.inspectDirectory(parent);
    parentCap.assertCurrent();
  }
  native.createDirectory(output);
  const cap = authorizeOutputParent(product, selection, output, current, readOnlyWorkspace);
  cap.assertCurrent();
}

/** Admit the parent directory of a picker-selected output file inside the
 * trusted container. Selections outside the container are rejected by the V
 * planner; J/V3 publication keeps its original in-root ports and is never
 * retargeted by this capability. */
export function admitNativeSaveParent(
  product: WindowsProductNative,
  selection: WindowsExternalSelectionConfiguration,
  filePath: string,
  current: () => void,
  readOnlyWorkspace?: NativePrivateIdentity,
): void {
  const cap = authorizeOutputParent(product, selection, win32.dirname(canonical(filePath)), current, readOnlyWorkspace);
  cap.assertCurrent();
}

/** Admit a picker-selected output DIRECTORY itself (the selected existing
 * parent), for directory-valued picker results such as recovery exports. */
export function admitNativeSaveDirectory(
  product: WindowsProductNative,
  selection: WindowsExternalSelectionConfiguration,
  directory: string,
  current: () => void,
  readOnlyWorkspace?: NativePrivateIdentity,
): void {
  const cap = authorizeOutputParent(product, selection, canonical(directory), current, readOnlyWorkspace);
  cap.assertCurrent();
}

/** Output authority for normal or diagnostic startup. No semantic binding is
 * fabricated for a read-only source; only its retained native directory is used. */
function authorizeOutputParent(product: WindowsProductNative, selection: WindowsExternalSelectionConfiguration,
  path: string, current: () => void, readOnlyWorkspace?: NativePrivateIdentity): WindowsExternalCapability {
  const request = {...planWindowsExternalSelection(selection, path), kind: "raw-rescue" as const, assertCurrent: current};
  return readOnlyWorkspace ? product.authorizeReadOnlyRescue({...request, workspaceDirectory: readOnlyWorkspace})
    : product.authorizeExternalCapability(request);
}
