import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { canonical } from "./canonical";
import type { PublicationResolutionPort } from "../../platform/windows/publication-resolution";
import type { RuntimeStorePlatform } from "../../platform/runtime-store-platform";
import { synchronousPort, synchronousRuntimeStorePlatform, type SynchronousContract } from "../../platform/synchronous-port";
import { SharedAuthority } from "./authority";
import { CollaborationError } from "./contract";
import {
  RuntimeStore,
  SHARED_RUNTIME_FILE,
  type RuntimeStoreOptions,
} from "./store";

/**
 * Native private-file boundary for the headless operators. The production port
 * supplies the OS-native identity, ACL and durability evidence that the POSIX
 * pinned-root path cannot express; injected ports are contract checks, not OS
 * acceptance. This interface makes no proof claim itself — the concrete port
 * implementation supplies the native evidence.
 * Repeated proofs must preserve previously pinned identities; observing a
 * different private object at the same path is not proof of continuity.
 *
 * Method contract:
 * - `assertDirectory` proves the directory is owned by the operator identity,
 *   carries a private ACL, is not a reparse point or hard-linked, and lives
 *   on a local filesystem, and returns the canonical path the operator must
 *   keep using.
 * - `assertNewFile` / `assertNewDirectory` pin a safe parent and prove the
 *   target does not exist and sits neither inside nor above a forbidden root
 *   (both ancestor and descendant), and return the canonical path.
 * - `createDirectory` exclusively creates the previously preflighted private
 *   directory and fails if the target already exists.
 * - `readPrivateFile` returns the complete file contents bounded by
 *   `maxBytes`; the same ownership/private-ACL/no-reparse/no-hardlink/local-
 *   filesystem evidence applies to files. A file that cannot be proven
 *   private, or a requested read limit the port cannot honor, MUST throw:
 *   there is no fallback and no truncation.
 * - `publishNewFile` exclusively publishes the complete bytes — never a
 *   replacement — through private captured pipes (never argv or inherited terminal output), with
 *   private ACL and durable file/name proof. A failure after bytes may have
 *   been produced throws UNKNOWN and preserves the artifact; the operator
 *   never deletes a maybe-published file.
 */
export interface SharedOperatorFilePort {
  readonly kind: "windows";
  assertDirectory(path: string): string;
  assertNewFile(path: string, forbiddenRoots: readonly string[]): string;
  assertNewDirectory(path: string, forbiddenRoots: readonly string[]): string;
  createDirectory(path: string): void;
  readPrivateFile(path: string, maxBytes: number): Buffer;
  publishNewFile(path: string, bytes: Buffer): void;
}

export type SharedOperatorPorts = RuntimeStoreOptions & {
  privateFiles?: SharedOperatorFilePort;
  runtimeStoreOptions?: (directory: string) => RuntimeStoreOptions;
  nativePublication?: PublicationResolutionPort;
  bindPublicationSource?: (source: Readonly<{sourceRoot: string; orgId: string; genesisHash: string}>) => void;
};

const FILE_METHODS = [
  "assertDirectory",
  "assertNewFile",
  "assertNewDirectory",
  "createDirectory",
  "readPrivateFile",
  "publishNewFile",
] as const;
const PLATFORM_METHODS = [
  "bind",
  "assertRoot",
  "assertDatabase",
  "syncCreatedDatabase",
  "close",
] as const;

/** Once-bound adapters own a resource lifetime; reuse is never safe. */
const usedNativeAdapters = new WeakSet<RuntimeStorePlatform>();
const FILE_CONTRACT: SynchronousContract = {
  assertDirectory: { result: "string" }, assertNewFile: { result: "string" },
  assertNewDirectory: { result: "string" }, createDirectory: { result: "void" },
  readPrivateFile: { result: "buffer" }, publishNewFile: { result: "void" },
};
const FACTORY_CONTRACT: SynchronousContract = { get: { result: "object" } };

export function createSharedOperatorContext(
  ports: SharedOperatorPorts,
  unsupportedCode: string,
) {
  const native =
    process.platform === "win32" || ports.privateFiles !== undefined;
  const rawFiles = ports.privateFiles;
  if (
    native &&
    (!rawFiles ||
      rawFiles.kind !== "windows" ||
      FILE_METHODS.some((name) => typeof rawFiles[name] !== "function") ||
      typeof ports.runtimeStoreOptions !== "function")
  )
    throw new CollaborationError(unsupportedCode);
  const files = native ? synchronousPort(rawFiles!, FILE_CONTRACT, {kind: "windows"}) : undefined;
  const factory = ports.runtimeStoreOptions
    ? synchronousPort({get: ports.runtimeStoreOptions}, FACTORY_CONTRACT).get
    : undefined;
  const sourceBinder = ports.bindPublicationSource
    ? synchronousPort({bind: ports.bindPublicationSource}, {bind: {result: "void"}}).bind
    : undefined;
  function bindPublicationSource(authority: SharedAuthority): void {
    if (!sourceBinder) return;
    const orgId = authority.store.get("meta", "primary-org"), genesis = authority.store.get("meta", "genesis");
    if (typeof orgId !== "string" || genesis === null) throw new CollaborationError("PUBLICATION_SOURCE_UNAVAILABLE");
    sourceBinder({sourceRoot: dirname(authority.store.path), orgId, genesisHash: createHash("sha256").update(canonical(genesis)).digest("hex")});
  }
  function storeOptions(
    directory: string,
    existing = false,
  ): RuntimeStoreOptions {
    const factoryOptions = factory?.(directory);
    const options: RuntimeStoreOptions = ports.runtimeStoreOptions
      ? {
          ...factoryOptions,
          maxRows: ports.maxRows ?? factoryOptions?.maxRows,
          maxBytes: ports.maxBytes ?? factoryOptions?.maxBytes,
        }
      : ports;
    if (!native) return existing ? {...options, requiredExistingRole: "authority"} : options;
    const candidate = options?.platformAdapter;
    if (
      !candidate ||
      PLATFORM_METHODS.some((name) => typeof candidate[name] !== "function")
    )
      throw new CollaborationError(unsupportedCode);
    const adapter = synchronousRuntimeStorePlatform(candidate);
    if (usedNativeAdapters.has(adapter))
      throw new CollaborationError("WINDOWS_OPERATOR_ADAPTER_REUSED");
    usedNativeAdapters.add(adapter);
    if (!existing) return {...options, platformAdapter: adapter};
    // Guard source existence BEFORE RuntimeStore can create a missing SQLite file.
    const guarded: RuntimeStorePlatform = {
      bind(directory) {
        const bound = adapter.bind(directory);
        adapter.assertDatabase(join(bound, SHARED_RUNTIME_FILE));
        return bound;
      },
      assertRoot() {
        adapter.assertRoot();
      },
      assertDatabase(path) {
        adapter.assertDatabase(path);
      },
      syncCreatedDatabase(path) {
        adapter.syncCreatedDatabase(path);
      },
      ...(adapter.withHotJournalSnapshot ? {withHotJournalSnapshot(path: string, callback: (snapshotPath: string) => void) {
        adapter.withHotJournalSnapshot!(path, callback);
      }} : {}),
      close() {
        adapter.close();
      },
    };
    return { ...options, requiredExistingRole: "authority", platformAdapter: guarded };
  }
  function openAuthority(
    directory: string,
    options: RuntimeStoreOptions,
  ): SharedAuthority {
    options = {...options, requiredExistingRole: "authority"};
    if (!native) return new SharedAuthority(directory, options);
    const probe = new RuntimeStore(directory, options);
    try {
      if (probe.get("meta", "role") !== "authority")
        throw new CollaborationError("WRONG_STORE_ROLE");
    } finally {
      probe.close();
    }
    const authority = new SharedAuthority(directory, storeOptions(directory, true));
    try {bindPublicationSource(authority); return authority;}
    catch (error) {try {authority.close();} catch (cleanup) {throw new AggregateError([error, cleanup], "Authority binding and cleanup failed");} throw error;}
  }
  return {
    privateFiles: native ? files! : undefined,
    storeOptions,
    openAuthority,
    bindPublicationSource,
  };
}

export function readSharedOperatorFile(
  files: SharedOperatorFilePort,
  path: string,
  maxBytes: number,
  code: string,
): Buffer {
  const bytes = files.readPrivateFile(path, maxBytes);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maxBytes)
    throw new CollaborationError(code);
  return bytes;
}
