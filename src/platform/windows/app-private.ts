import { CollaborationError } from "../../collaboration/runtime/contract";
import {
  WindowsPrivatePlatform,
  type PrivatePlatform,
  type WindowsPrivateNativeRuntime,
} from "../../sync/private-platform";
import {
  createWindowsHotJournalSnapshot,
  type WindowsHotJournalSnapshotProfile,
} from "./hot-journal-snapshot";
import { createWindowsSourceBindingGuard } from "./source-binding-guard";
import { WindowsRuntimePlatform, type WindowsRuntimeFileIdentity } from "./runtime-platform";
import {
  createNativeAuthorityLeaseAcquirer,
  withPrivateAuthorityLease,
  type AcquirePrivateAuthorityLease,
} from "./authority-lease";
import { withRuntimeAuthorityLease } from "./held-runtime-platform";
import { types as utilTypes } from "node:util";

/** Parent runtime capability: CREATED requires native exclusive creation,
 * same-handle identity and empty-file proof, never an ENOENT inference.
 * EXISTING must inspect without writing/flushing/normalizing an unbound file. */
export type WindowsPrivateFileCreationRuntime = Readonly<{
  createExclusiveDurablyWithReceipt(path: string): Readonly<{
    state: "CREATED" | "EXISTING";
    identity: WindowsRuntimeFileIdentity;
  }>;
}>;

export type WindowsAppPrivateConfig = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
}>;

export type WindowsAppPrivateOptions = Readonly<{
  // Persistent per-source binding ledger. On win32 operational use its
  // absence fails closed; configuration/type construction off-host does
  // not require it. Default behavior is strict identity assertion;
  // enrollExistingSources:true is the only explicit initial-enrollment
  // authority, never an inferred create or open.
  sourceBindings?: Readonly<{
    publicationStateRoot: string;
    publicationStateDirectory: string;
    enrollExistingSources?: boolean;
  }>;
  // Omission selects the small-ledger profile; never inferred.
  hotJournalSnapshotProfile?: WindowsHotJournalSnapshotProfile;
}>;

export type WindowsNativeWorkspaceIdentity = Readonly<{
  canonicalPath: string;
  volumeId: string;
  fileId: string;
}>;

export type WindowsAppPrivate = Readonly<{
  runtimePlatform(
    directory: string,
    name?: string,
    createDirectory?: boolean,
  ): WindowsRuntimePlatform;
  ledgerPlatform(directory: string, name: string): PrivatePlatform;
  workspaceIdentity(databasePath: string): WindowsNativeWorkspaceIdentity;
  privateFileIdentity(path: string): WindowsNativeWorkspaceIdentity;
  assertPrivateDirectory(path: string): void;
  // Node/CLI-callable lifecycle handle: the caller owns closing it and
  // builds inspect/release requests from the bound runtime identities.
  snapshotController(
    directory: string,
    name?: string,
  ): Readonly<{
    runtime: WindowsRuntimePlatform;
    snapshot: ReturnType<typeof createWindowsHotJournalSnapshot>;
    close(): void;
  }>;
}>;

const DEFAULT_RUNTIME_NAME = "shared-runtime.sqlite";

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "root",
  "probeExecutable",
  "expectedHash",
  "systemRoot",
]);

const LEDGER_BASENAME = /^[a-z][a-z0-9-]{0,60}\.sqlite$/;
const HASH = /^[0-9a-f]{64}$/;
const VOLUME_ID = /^[0-9A-Fa-f]{16}$/;
const FILE_ID = /^[0-9A-Fa-f]{32}$/;
const ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function readConfig(value: unknown): WindowsAppPrivateConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("INVALID_WINDOWS_APP_PRIVATE_CONFIG");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!CONFIG_KEYS.has(key)) fail("INVALID_WINDOWS_APP_PRIVATE_CONFIG");
  const expectedHash = text(input.expectedHash, "INVALID_PROBE_HASH");
  if (!HASH.test(expectedHash)) fail("INVALID_PROBE_HASH");
  return Object.freeze({
    root: text(input.root, "INVALID_WINDOWS_ROOT"),
    probeExecutable: text(
      input.probeExecutable,
      "INVALID_PROBE_EXECUTABLE",
    ),
    expectedHash,
    systemRoot: text(input.systemRoot, "INVALID_SYSTEM_ROOT"),
  });
}

function readLedgerName(value: unknown): string {
  if (typeof value !== "string" || !LEDGER_BASENAME.test(value))
    fail("INVALID_DATABASE_NAME");
  return value;
}

function windowsBasename(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index >= 0 ? path.slice(index + 1) : path;
}

function windowsDirname(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (index < 0) fail("INVALID_WINDOWS_DATABASE_PATH");
  if (index === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3);
  if (index === 0) return path.slice(0, 1);
  return path.slice(0, index);
}

type RuntimeWithValidatedIdentity = Readonly<{
  validatedFileIdentity(path: string): unknown;
}>;

function readValidatedIdentity(
  runtime: WindowsRuntimePlatform,
  path: string,
): WindowsNativeWorkspaceIdentity {
  const method = (runtime as unknown as Partial<RuntimeWithValidatedIdentity>)
    .validatedFileIdentity;
  if (typeof method !== "function")
    fail("WINDOWS_VALIDATED_IDENTITY_UNAVAILABLE");
  let raw: unknown;
  try {
    raw = method.call(runtime, path);
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    fail("WINDOWS_VALIDATED_IDENTITY_FAILED");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  const record = raw as Record<string, unknown>;
  const canonicalPath = record.canonicalPath;
  const volumeId = record.volumeId;
  const fileId = record.fileId;
  if (
    typeof canonicalPath !== "string" ||
    !ABSOLUTE_WINDOWS_PATH.test(canonicalPath)
  )
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  if (typeof volumeId !== "string" || !VOLUME_ID.test(volumeId))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  if (typeof fileId !== "string" || !FILE_ID.test(fileId))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  return Object.freeze({ canonicalPath, volumeId, fileId });
}

export function createWindowsAppPrivate(
  value: WindowsAppPrivateConfig,
  options: WindowsAppPrivateOptions = {},
): WindowsAppPrivate {
  const config = readConfig(value);
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => !["sourceBindings", "hotJournalSnapshotProfile"].includes(key)))
    fail("INVALID_WINDOWS_APP_PRIVATE_OPTIONS");
  const supplied = options.sourceBindings;
  if (supplied !== undefined && (!supplied || typeof supplied !== "object" ||
      Object.keys(supplied).some(key => !["publicationStateRoot", "publicationStateDirectory", "enrollExistingSources"].includes(key)) ||
      (supplied.enrollExistingSources !== undefined && typeof supplied.enrollExistingSources !== "boolean")))
    fail("INVALID_WINDOWS_APP_PRIVATE_OPTIONS");
  const bindings = supplied === undefined ? undefined : Object.freeze({
    publicationStateRoot: text(supplied.publicationStateRoot, "INVALID_WINDOWS_BINDING_ROOT"),
    publicationStateDirectory: text(supplied.publicationStateDirectory, "INVALID_WINDOWS_BINDING_DIRECTORY"),
    enrollExistingSources: supplied.enrollExistingSources === true,
  });
  const enrollExisting = bindings?.enrollExistingSources === true;
  const snapshotProfile = options.hotJournalSnapshotProfile;
  if (snapshotProfile !== undefined && !["small-ledger", "recovery-archive", "backup-artifact"].includes(snapshotProfile))
    fail("INVALID_WINDOWS_HOT_JOURNAL_PROFILE");

  function runtimeFor(databaseName: string): WindowsRuntimePlatform {
    return new WindowsRuntimePlatform({
      root: config.root,
      probeExecutable: config.probeExecutable,
      expectedHash: config.expectedHash,
      systemRoot: config.systemRoot,
      databaseName,
      ...(snapshotProfile === undefined ? {} : {snapshotProfile}),
    });
  }

  // Per-runtime persistent source-binding wrapper. Every original method is
  // captured once as a bound function; wrappers forward to the captured
  // originals and never recurse through their own overrides. The guard is
  // lazily created per returned runtime and owned by its close(). Without
  // sourceBindings every guarded operation fails closed with
  // WINDOWS_SOURCE_BINDINGS_REQUIRED, including on win32.
  function boundRuntime(runtime: WindowsRuntimePlatform): WindowsRuntimePlatform {
    const original = {
      bind: runtime.bind.bind(runtime),
      prepareDirectory: runtime.prepareDirectory.bind(runtime),
      assertRoot: runtime.assertRoot.bind(runtime),
      assertFile: runtime.assertFile.bind(runtime),
      assertSidecars: runtime.assertSidecars.bind(runtime),
      createExclusiveDurably: runtime.createExclusiveDurably.bind(runtime),
      assertEmptyFile: runtime.assertEmptyFile.bind(runtime),
      validatedDirectoryIdentity:
        runtime.validatedDirectoryIdentity.bind(runtime),
      validatedFileIdentity: runtime.validatedFileIdentity.bind(runtime),
      validatedPrivateFileIdentity:
        runtime.validatedPrivateFileIdentity.bind(runtime),
      assertDatabase: runtime.assertDatabase.bind(runtime),
      syncCreatedDatabase: runtime.syncCreatedDatabase.bind(runtime),
      createExclusiveDirectory: runtime.createExclusiveDirectory.bind(runtime),
      close: runtime.close.bind(runtime),
    };
    let guard: ReturnType<typeof createWindowsSourceBindingGuard> | undefined;
    const requireGuard = (): ReturnType<
      typeof createWindowsSourceBindingGuard
    > => {
      if (bindings === undefined) fail("WINDOWS_SOURCE_BINDINGS_REQUIRED");
      if (guard === undefined)
        guard = createWindowsSourceBindingGuard(
          {
            root: config.root,
            probeExecutable: config.probeExecutable,
            expectedHash: config.expectedHash,
            systemRoot: config.systemRoot,
            publicationStateRoot: bindings.publicationStateRoot,
            publicationStateDirectory: bindings.publicationStateDirectory,
          },
          enrollExisting,
        );
      return guard;
    };
    const directoryProof = () => requireGuard().directory(original.validatedDirectoryIdentity());
    const fileProof = (path: string) => {
      directoryProof();
      const identity = original.validatedFileIdentity(path);
      requireGuard().file(identity);
      return identity;
    };
    let snapshot: ReturnType<typeof createWindowsHotJournalSnapshot> | undefined;
    const wrapped = {
      bind(directory: string): string {
        requireGuard();
        const bound = original.bind(directory);
        requireGuard().directory(original.validatedDirectoryIdentity());
        return bound;
      },
      prepareDirectory(directory: string): void {
        // Create-or-open is never a new-identity proof: the result is still
        // asserted at bind (or explicitly enrolled). No identity exists on
        // this runtime before bind. Strict preparation never creates a path.
        const current = requireGuard();
        if (enrollExisting) {
          original.prepareDirectory(directory);
        } else {
          const probe = runtimeFor(runtime.databaseName);
          usingRuntime(probe, () => {
            probe.bind(directory);
            current.directory(probe.validatedDirectoryIdentity());
          });
        }
      },
      assertRoot(): void {
        original.assertRoot();
        requireGuard().directory(original.validatedDirectoryIdentity());
      },
      assertFile(path: string): void {
        fileProof(path);
        original.assertFile(path);
      },
      assertSidecars(path: string): void {
        fileProof(path);
        original.assertSidecars(path);
      },
      createExclusiveDurably(path: string): void {
        // Automatic enrollment requires a positive receipt, never via ENOENT inference.
        // The void compatibility path cannot grant it.
        directoryProof();
        const create = (runtime as unknown as Partial<WindowsPrivateFileCreationRuntime>)
          .createExclusiveDurablyWithReceipt;
        if (create !== undefined) {
          if (typeof create !== "function" || utilTypes.isAsyncFunction(create) || utilTypes.isGeneratorFunction(create))
            fail("WINDOWS_CREATE_RECEIPT_INVALID");
          const receipt = create.call(runtime, path);
          if (utilTypes.isPromise(receipt)) {
            Promise.prototype.then.call(receipt, undefined, () => undefined);
            fail("WINDOWS_CREATE_RECEIPT_INVALID");
          }
          if (!receipt || !["CREATED", "EXISTING"].includes(receipt.state) ||
              Object.keys(receipt).some(key => !["state", "identity"].includes(key)))
            fail("WINDOWS_CREATE_RECEIPT_INVALID");
          const identity = original.validatedFileIdentity(path);
          if (!receipt.identity || identity.canonicalPath !== receipt.identity.canonicalPath ||
              identity.fileId !== receipt.identity.fileId || identity.volumeId !== receipt.identity.volumeId)
            fail("WINDOWS_CREATE_RECEIPT_INVALID");
          if (receipt.state === "CREATED") original.assertEmptyFile(path);
          requireGuard().file(identity, receipt.state === "CREATED");
        } else {
          if (!enrollExisting) fileProof(path);
          original.createExclusiveDurably(path);
          requireGuard().file(original.validatedFileIdentity(path));
        }
      },
      assertEmptyFile(path: string): void {
        fileProof(path);
        original.assertEmptyFile(path);
      },
      validatedDirectoryIdentity() {
        const identity = original.validatedDirectoryIdentity();
        requireGuard().directory(identity);
        return identity;
      },
      validatedFileIdentity(path: string) {
        const identity = original.validatedFileIdentity(path);
        requireGuard().file(identity);
        return identity;
      },
      validatedPrivateFileIdentity(path: string) {
        directoryProof();
        const identity = original.validatedPrivateFileIdentity(path);
        requireGuard().file(identity);
        return identity;
      },
      assertDatabase(path: string) {
        fileProof(path);
        original.assertDatabase(path);
        fileProof(path);
      },
      syncCreatedDatabase(path: string) {
        fileProof(path);
        original.syncCreatedDatabase(path);
        fileProof(path);
      },
      createExclusiveDirectory(...args: Parameters<WindowsRuntimePlatform["createExclusiveDirectory"]>) {
        directoryProof();
        const result = original.createExclusiveDirectory(...args);
        directoryProof();
        return result;
      },
      withHotJournalSnapshot(path: string, callback: (snapshotPath: string) => void) {
        fileProof(path); original.assertSidecars(path);
        snapshot ??= createWindowsHotJournalSnapshot({...config, profile: snapshotProfile ?? "small-ledger"});
        snapshot.withSnapshot({path, expectedDirectory: original.validatedDirectoryIdentity(),
          expectedFile: original.validatedFileIdentity(path)}, callback);
        fileProof(path); original.assertSidecars(path);
      },
      close(): void {
        const failures: unknown[] = [];
        try {
          original.close();
        } catch (error) {
          failures.push(error);
        }
        if (guard !== undefined) {
          try {
            guard.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            "Windows private runtime and binding guard close failed",
          );
      },
    };
    // Preserve the entire concrete interface and bind private-field methods
    // to their original receiver; no partial object is cast to the class.
    return new Proxy(runtime, {
      get(target, key) {
        if (Object.prototype.hasOwnProperty.call(wrapped, key))
          return Reflect.get(wrapped, key);
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }

  function usingRuntime<T>(runtime: WindowsRuntimePlatform, work: () => T): T {
    let failed = false, failure: unknown;
    try { return work(); }
    catch (error) { failed = true; failure = error; throw error; }
    finally {
      try { runtime.close(); }
      catch (cleanup) {
        if (failed) throw new AggregateError([failure, cleanup], "Windows private operation and cleanup failed");
        throw cleanup;
      }
    }
  }

  function closePreserving(runtime: WindowsRuntimePlatform, error: unknown): never {
    try {
      runtime.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Windows private runtime construction and cleanup failed",
      );
    }
    throw error;
  }

  /**
   * Mint the RAW authority-lease acquirer for one bound runtime. The
   * source-root identity is proven by a fresh raw probe bound to the actual
   * root BEFORE the target's own bind — never through this target's held
   * proxy or through boundRuntime (which would recurse into the source
   * binding guard). Per-file identities are taken through the bound
   * runtime's persisted SourceBinding wrappers and its actual database name.
   * The factory itself rejects off win32; no test seam is selected here.
   */
  function acquireFor(
    runtime: WindowsRuntimePlatform,
  ): AcquirePrivateAuthorityLease {
    const probe = runtimeFor(runtime.databaseName);
    const root = usingRuntime(probe, () => {
      probe.bind(config.root);
      return probe.validatedDirectoryIdentity();
    });
    return createNativeAuthorityLeaseAcquirer({
      root: config.root,
      probeExecutable: config.probeExecutable,
      expectedHash: config.expectedHash,
      systemRoot: config.systemRoot,
      expectedRoot: {
        rootFileId: root.rootFileId,
        volumeId: root.rootVolumeId,
      },
      identityFor(path: string) {
        const directory = runtime.validatedDirectoryIdentity();
        const file = runtime.validatedFileIdentity(path);
        return {
          directoryFileId: directory.directoryFileId,
          directoryVolumeId: directory.directoryVolumeId,
          fileId: file.fileId,
          volumeId: file.volumeId,
        };
      },
    });
  }

  /**
   * The unheld bound runtime: every source-binding guard, prepareDirectory
   * and profile behavior is unchanged, but no authority hold is wrapped yet.
   * Callers that need the writable-runtime hold wrap it themselves so a
   * ledger platform cannot acquire a second native lease over the same
   * runtime.
   */
  function unheldRuntimePlatform(
    directory: string,
    name: string,
    createDirectory: boolean,
  ): WindowsRuntimePlatform {
    if (typeof directory !== "string" || directory.length === 0)
      fail("INVALID_WINDOWS_PRIVATE_DIRECTORY");
    if (typeof createDirectory !== "boolean")
      fail("INVALID_WINDOWS_PRIVATE_DIRECTORY");
    const databaseName = readLedgerName(name);
    const runtime = boundRuntime(runtimeFor(databaseName));
    if (!createDirectory) return runtime;
    try {
      runtime.prepareDirectory(directory);
    } catch (error) {
      closePreserving(runtime, error);
    }
    return runtime;
  }

  function runtimePlatform(
    directory: string,
    name: string = DEFAULT_RUNTIME_NAME,
    createDirectory: boolean = true,
  ): WindowsRuntimePlatform {
    const runtime = unheldRuntimePlatform(directory, name, createDirectory);
    try {
      return withRuntimeAuthorityLease(runtime, acquireFor(runtime));
    } catch (error) {
      closePreserving(runtime, error);
    }
  }

  function ledgerPlatform(directory: string, name: string): PrivatePlatform {
    const runtime = unheldRuntimePlatform(directory, name, true);
    try {
      // A fresh controller per platform instance, over the already fresh
      // runtime: no global reused runtime, no spread of the class instance.
      const snapshot = createWindowsHotJournalSnapshot(
        snapshotProfile === undefined
          ? config
          : { ...config, profile: snapshotProfile },
      );
      const provider: WindowsPrivateNativeRuntime = {
        bind: (target: string) => runtime.bind(target),
        assertRoot: () => runtime.assertRoot(),
        assertFile: (path: string) => runtime.assertFile(path),
        assertSidecars: (path: string) => runtime.assertSidecars(path),
        createExclusiveDurably: (path: string) =>
          runtime.createExclusiveDurably(path),
        assertEmptyFile: (path: string) => runtime.assertEmptyFile(path),
        withHotJournalSnapshot(path, callback) {
          runtime.assertRoot(); runtime.assertFile(path); runtime.assertSidecars(path);
          snapshot.withSnapshot({path, expectedDirectory:runtime.validatedDirectoryIdentity(), expectedFile:runtime.validatedFileIdentity(path)}, callback);
          runtime.assertRoot(); runtime.assertFile(path); runtime.assertSidecars(path);
        },
        close: () => runtime.close(),
      };
      // The hold is acquired through the RAW branded acquirer inside
      // WindowsPrivatePlatform.createExclusive — after the provider's actual
      // positive create and the source-binding file enrollment, before any
      // writable SQLite open. The runtime itself stays unheld: one lease.
      return withPrivateAuthorityLease(
        new WindowsPrivatePlatform(provider),
        acquireFor(runtime),
      );
    } catch (error) {
      closePreserving(runtime, error);
    }
  }

  function snapshotController(
    directory: string,
    name: string = DEFAULT_RUNTIME_NAME,
  ): Readonly<{
    runtime: WindowsRuntimePlatform;
    snapshot: ReturnType<typeof createWindowsHotJournalSnapshot>;
    close(): void;
  }> {
    // Bound runtime + configured controller for explicit inspect/release
    // calls. Release is only ever reachable through this handle; normal
    // preflight never releases.
    const runtime = boundRuntime(runtimeFor(readLedgerName(name)));
    let snapshot: ReturnType<typeof createWindowsHotJournalSnapshot>;
    try {
      runtime.bind(directory);
      snapshot = createWindowsHotJournalSnapshot(
        snapshotProfile === undefined
          ? config
          : { ...config, profile: snapshotProfile },
      );
    } catch (error) {
      closePreserving(runtime, error);
    }
    return Object.freeze({
      runtime,
      snapshot,
      close: () => runtime.close(),
    });
  }

  function workspaceIdentity(
    databasePath: string,
  ): WindowsNativeWorkspaceIdentity {
    const path = text(databasePath, "INVALID_WINDOWS_DATABASE_PATH");
    const databaseName = readLedgerName(windowsBasename(path));
    const directory = windowsDirname(path);
    const runtime = boundRuntime(runtimeFor(databaseName));
    return usingRuntime(runtime, () => {
      runtime.bind(directory);
      runtime.assertFile(path);
      return readValidatedIdentity(runtime, path);
    });
  }

  function privateFileIdentity(path: string): WindowsNativeWorkspaceIdentity {
    const runtime = boundRuntime(runtimeFor(DEFAULT_RUNTIME_NAME));
    return usingRuntime(runtime, () => { runtime.bind(windowsDirname(path)); return runtime.validatedPrivateFileIdentity(path); });
  }
  function assertPrivateDirectory(path: string): void {
    const runtime = boundRuntime(runtimeFor(DEFAULT_RUNTIME_NAME));
    usingRuntime(runtime, () => {runtime.bind(path);runtime.assertRoot();});
  }
  return Object.freeze({
    runtimePlatform,
    privateFileIdentity,
    assertPrivateDirectory,
    ledgerPlatform,
    workspaceIdentity,
    snapshotController,
  });
}
