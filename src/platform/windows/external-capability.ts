import { win32 } from "node:path";
import { types } from "node:util";
import { CollaborationError } from "../../collaboration/runtime/contract";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";
import type {
  NativePrivateFilesystemPort,
  NativePrivateCurrentCheck,
} from "../private-persistence";
import type { WindowsSelectedSourceAdmission, WindowsSelectedFileAdmission } from "./source-admission";
import { retainStartupProtector } from "../../persistence/startup-connection-owner";

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_EXTERNAL_CAPABILITY_${code}`);
}

/**
 * Explicit one-shot external authority. `capabilityRoot` is the
 * caller-authorized PRIVATE common ancestor of the bound workspace root and
 * the selected external path; `path` is the selected output parent (or the
 * admitted source subtree for `backup-source`). `assertCurrent` is the
 * synchronous picker-continuation fence captured once at request time. A
 * capability is never persisted as callable authority: a restart requires a
 * new explicit request, and replacement native IDs are rejected by the
 * retained source bindings.
 */
export type WindowsExternalCapabilityRequest = Readonly<{
  kind: "raw-rescue" | "backup-archive" | "orphan-archive" | "backup-source" | "restore-target";
  capabilityRoot: string;
  path: string;
  assertCurrent(): void;
  source?: WindowsSelectedSourceAdmission;
  file?: WindowsSelectedFileAdmission;
}>;

export type WindowsExternalCapability = Readonly<{
  kind: WindowsExternalCapabilityRequest["kind"];
  path: string;
  capabilityRoot: string;
  privateFilesystem: NativePrivateFilesystemPort;
  assertCurrent(): void;
}>;

export type WindowsExternalSelectionConfiguration = Readonly<{
  root: string;
  workspace: string;
  stateRoot: string;
  capabilityRoot: string;
  outputParent: string;
}>;

/** Pure lexical validation of an external selection plan. No native proof,
 * no side effects, no authority minting: Main must pass its own trusted
 * configuration (never renderer input), call this at initialization or
 * selection time, then invoke
 * `product.authorizeExternalCapability({...plan, kind, assertCurrent})` so
 * the configured output parent is natively proven as an actually usable
 * private directory. A drive-level common root (for example `C:\` to reach
 * `C:\FolioData` and `C:\Backup`) is explicitly unsupported: the single
 * private-root native protocol cannot safely span arbitrary drive siblings
 * and no automatic migration is attempted. */
export function planWindowsExternalSelection(
  configuration: WindowsExternalSelectionConfiguration,
  selectedPath = configuration.outputParent,
): Readonly<{ capabilityRoot: string; path: string }> {
  if (configuration === null || typeof configuration !== "object") fail("CONFIG");
  const canonical = (path: string): string => {
    if (typeof path !== "string") fail("CANONICAL");
    const c = validateWindowsPath(path, path).canonical;
    if (c !== path) fail("CANONICAL");
    return c;
  };
  const root = canonical(configuration.root), workspace = canonical(configuration.workspace),
    stateRoot = canonical(configuration.stateRoot), capabilityRoot = canonical(configuration.capabilityRoot),
    outputParent = canonical(configuration.outputParent);
  // A common ancestor must be a real private directory, never a drive root.
  if (win32.dirname(capabilityRoot) === capabilityRoot) fail("DRIVE_ROOT");
  const under = (path: string, ancestor: string): boolean =>
    asciiCaseFold(path).startsWith(asciiCaseFold(ancestor) + "\\");
  const inside = (path: string, ancestor: string): boolean =>
    under(path, ancestor) || asciiCaseFold(path) === asciiCaseFold(ancestor);
  const disjoint = (a: string, b: string): boolean => !inside(a, b) && !inside(b, a);
  // The common root spans the base root and the bound workspace; the base
  // root in turn contains the workspace (equality allowed for both).
  if (!inside(root, capabilityRoot)) fail("ROOT");
  if (!inside(workspace, capabilityRoot) || !inside(workspace, root)) fail("WORKSPACE");
  // The private state tree is entirely disjoint from the common root.
  if (!disjoint(stateRoot, capabilityRoot)) fail("STATE_OVERLAP");
  // The configured output parent is a strict descendant of the common root
  // and disjoint from the workspace in both directions.
  if (!under(outputParent, capabilityRoot) || !disjoint(outputParent, workspace)) fail("OUTPUT");
  // The actual selection obeys the same boundary; `outputParent` is still
  // required so a legal default endpoint always exists.
  const selected = canonical(selectedPath);
  if (!under(selected, capabilityRoot) || !disjoint(selected, workspace)) fail("SELECTED");
  return Object.freeze({ capabilityRoot, path: selected });
}

/** Path scope enforced before every delegate dispatch. `readable` subtrees
 * are inspect/read/lease-only, `writable` is the single mutation parent, and
 * `movable` lists exact rename sources (selected archives/orphan files). */
export type WindowsExternalFilesystemScope = Readonly<{
  capabilityRoot: string;
  writable?: string;
  readable: readonly string[];
  movable: readonly string[];
  assertCurrent(): void;
}>;

function synchronous(call: (() => void) | undefined): void {
  if (call === undefined) return;
  if (typeof call !== "function" || types.isAsyncFunction(call) || types.isGeneratorFunction(call))
    fail("CALLBACK");
  const result: unknown = call();
  if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
  if (result !== undefined) fail("CALLBACK_ACK");
}

/** A boundary-checked facade over the capability-rooted native filesystem.
 * Every path is canonicalized inside `capabilityRoot` and classified BEFORE
 * the delegate runs; the scope fence revalidates request authority and the
 * retained native IDs on both sides of the dispatch. */
export function createWindowsExternalFilesystem(
  delegate: NativePrivateFilesystemPort,
  scope: WindowsExternalFilesystemScope,
): NativePrivateFilesystemPort {
  const capabilityRoot = validateWindowsPath(scope.capabilityRoot, scope.capabilityRoot).canonical;
  if (capabilityRoot !== scope.capabilityRoot) fail("ROOT");
  const foldedRoot = asciiCaseFold(capabilityRoot);
  const canon = (path: string): string => {
    const canonical = validateWindowsPath(path, capabilityRoot).canonical;
    if (canonical !== path || asciiCaseFold(canonical) === foldedRoot) fail("PATH");
    return canonical;
  };
  const beneath = (path: string, parent: string): boolean => {
    const a = asciiCaseFold(path), b = asciiCaseFold(parent);
    return a === b || a.startsWith(b + "\\");
  };
  const writable = scope.writable === undefined ? undefined
    : validateWindowsPath(scope.writable, capabilityRoot).canonical;
  const writableKey = writable === undefined ? undefined : asciiCaseFold(writable) + "\\";
  const readable = scope.readable.map(path => validateWindowsPath(path, capabilityRoot).canonical);
  const movable = scope.movable.map(path => asciiCaseFold(validateWindowsPath(path, capabilityRoot).canonical));
  // The picker authority is captured once; later mutation of the request
  // scope object cannot substitute a different callback.
  const assertCurrent = scope.assertCurrent;
  const requireRead = (path: string): string => {
    const canonical = canon(path);
    if (writable !== undefined && beneath(canonical, writable)) return canonical;
    if (!readable.some(parent => beneath(canonical, parent))) fail("SCOPE_READ");
    return canonical;
  };
  const requireWrite = (path: string): string => {
    const canonical = canon(path);
    // Only strict descendants may be mutated: the selected output parent
    // itself can never be renamed, unlinked, or overwritten.
    if (writableKey === undefined || !asciiCaseFold(canonical).startsWith(writableKey)) fail("SCOPE_WRITE");
    return canonical;
  };
  const requireMove = (path: string): string => {
    const canonical = canon(path);
    // Strict descendant of the writable parent, or an exact admitted movable
    // — the selected parent itself can never be moved away.
    if (writableKey !== undefined && asciiCaseFold(canonical).startsWith(writableKey)) return canonical;
    if (!movable.includes(asciiCaseFold(canonical))) fail("SCOPE_MOVE");
    return canonical;
  };
  const fence = (): void => synchronous(assertCurrent);
  const around = <T>(work: () => T): T => {
    fence();
    const result = work();
    fence();
    return result;
  };
  const filesystem: NativePrivateFilesystemPort = {
    platform: "win32",
    version: 1,
    synchronous: true,
    inspectDirectory: path => around(() => delegate.inspectDirectory(requireRead(path))),
    inspectFile: (path, maxBytes) => around(() => delegate.inspectFile(requireRead(path), maxBytes)),
    inspectFileIdentity: path => around(() => delegate.inspectFileIdentity(requireRead(path))),
    read: (path, expected, maxBytes) => {
      const want = {...expected};
      return around(() => delegate.read(requireRead(path), want, maxBytes));
    },
    writeNew: (path, bytes, maxBytes) => {
      const copy = Uint8Array.from(bytes);
      return around(() => delegate.writeNew(requireWrite(path), copy, maxBytes));
    },
    copyNew: (source, destination, expected, maxBytes) => {
      const want = {...expected};
      return around(() => delegate.copyNew(requireRead(source), requireWrite(destination), want, maxBytes));
    },
    renameNew: (source, destination, expected, maxBytes) => {
      const want = {...expected};
      return around(() => delegate.renameNew(requireMove(source), requireWrite(destination), want, maxBytes));
    },
    unlinkExact: (path, expected, maxBytes) => {
      const want = {...expected};
      return around(() => delegate.unlinkExact(requireWrite(path), want, maxBytes));
    },
    proveSync: (path, expected) => {
      const want = {...expected};
      return around(() => delegate.proveSync(requireWrite(path), want));
    },
    createDirectory: path => around(() => delegate.createDirectory(requireWrite(path))),
    snapshotSqlite: (db, destination) =>
      around(() => {
        const rows = db.prepare("PRAGMA database_list").all();
        const main = rows.find(row => row.name === "main");
        if (typeof main?.file !== "string") fail("SQLITE_SOURCE");
        // The SQLite source handle is path-scoped exactly like any read.
        requireRead(main.file);
        return delegate.snapshotSqlite(db, requireWrite(destination));
      }),
  };
  if (delegate.inspectTree !== undefined)
    filesystem.inspectTree = path => around(() => delegate.inspectTree!(requireRead(path)));
  if (delegate.renameDirectoryNew !== undefined)
    filesystem.renameDirectoryNew = (source, destination, expected, check) => {
      // A known-async/generator phase callback is refused before any work.
      if (check !== undefined && (types.isAsyncFunction(check) || types.isGeneratorFunction(check)))
        fail("CALLBACK");
      const want = {...expected};
      return around(() => delegate.renameDirectoryNew!(requireMove(source), requireWrite(destination),
        want, check === undefined ? undefined : ((phase) => {
          fence();
          synchronous(() => (check as NativePrivateCurrentCheck)(phase));
          fence();
        })));
    };
  if (delegate.acquireSqliteLease !== undefined)
    filesystem.acquireSqliteLease = (path, expected) => {
      // An acquired lease is owned: a stale post-acquire fence must close it
      // once and a failed close retains the protector, never drops it.
      const want = {...expected};
      fence();
      const lease = delegate.acquireSqliteLease!(requireRead(path), want);
      try { fence(); }
      catch (primary) {
        try { lease.close(); }
        catch (cleanup) { retainStartupProtector(lease, [primary, cleanup]); }
        throw primary;
      }
      return lease;
    };
  return Object.freeze(filesystem);
}
