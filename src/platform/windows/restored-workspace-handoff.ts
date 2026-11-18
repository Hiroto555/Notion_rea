/**
 * Trusted restored-workspace launch handoff (producer/consumer).
 *
 * The PARENT process calls {@link prepareWindowsRestoredWorkspaceLaunch}
 * only AFTER verifyFullBackup produced a real verified fingerprint AND a
 * captured native tree proof of the restored directory, and BEFORE any
 * workspace-owner/source-binding metadata is created. The producer
 * publishes an immutable intent file, creates the new per-workspace
 * publication state directory under the SAME configured disjoint
 * publicationStateRoot with a positive exclusive create + durable empty
 * bootstrap file, acquires a raw native C lease on that bootstrap, then
 * publishes the immutable handoff file directly under the configured
 * private container root (outside every workspace/backup inventory). The
 * private handoff receipt scalars are the ONLY launch authority carried
 * into the child environment; renderer-controlled values are never used.
 *
 * The CHILD calls {@link readWindowsRestoreHandoff} before ANY workspace
 * or state SQLite write. It consumes the six handoff environment scalars
 * locally, re-proves the private container root through the native
 * runtime, reads the handoff + intent payloads through a READ-ONLY
 * private persistence port (reserve/capture/terminal all throw BEFORE
 * mutation), binds intent/payload/configuration/SID/native identities,
 * acquires raw native C leases on the exact workspace.sqlite and the new
 * state bootstrap file, and only then returns `initialEnrollment: true`.
 * No SQLite mutation authority is created by this module; enrollment
 * remains the product's own source-binding operation, merely permitted
 * for this one verified process.
 *
 * Transfer protocol: stateReady(product) runs ONLY after
 * product.privateFilesystem.inspectDirectory(dataDir) caused the actual
 * source-binding SQLite/C owner bootstrap; workspaceReady(primary) runs
 * ONLY after openWorkspaceAtStartup returned the PRIMARY Store whose own
 * native lease asserts held. Raw guards are never released while any new
 * SQLite owner is uncertain; an unknown close retains the composite
 * lease graph through retainStartupProtector so Main sees the brand.
 *
 * Replay: the handoff file's native identity/hash plus the exact tree
 * attestation are bound to one launch. A later replay re-reads the same
 * immutable artifact but the tree/db attestation no longer matches after
 * the child writes, so enrollment cannot be repeated silently.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { types as utilTypes } from "node:util";
import { canonical } from "../../collaboration/runtime/canonical";
import { Store } from "../../persistence/store";
import { retainStartupProtector } from "../../persistence/startup-connection-owner";
import type {
  NativePrivateFile,
  NativePrivateFilesystemPort,
  NativePrivateIdentity,
  NativePrivateReceipt,
  NativePrivateSqliteLease,
  NativePrivateTree,
} from "../private-persistence";
import {
  createNativeAuthorityLeaseAcquirer,
  type AcquirePrivateAuthorityLease,
  type NativeAuthorityLeaseOptions,
  type PrivateAuthorityLease,
} from "./authority-lease";
import type { WindowsExclusiveDirectoryResult } from "./exclusive-directory";
import type { WindowsOperatorConfig } from "./operator-native";
import type { WindowsProductNative } from "./product-native";
import {
  WINDOWS_PROBE_MAX_OUTPUT_BYTES,
  WINDOWS_PROBE_TIMEOUT_MS,
} from "./private-root";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";
import {
  createWindowsPrivatePersistence,
  type WindowsPrivatePersistenceOptions,
} from "./private-persistence";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeFileIdentity,
  type WindowsRuntimePlatformOptions,
  type WindowsRuntimeRootIdentity,
} from "./runtime-platform";

/* ------------------------------------------------------------------ */
/* public surface                                                     */
/* ------------------------------------------------------------------ */

export type WindowsRestoreCurrent = Readonly<{
  directory: string;
  workspaceId: string;
  assertCurrent(): void;
}>;

export type WindowsRestoreLaunchRequest = Readonly<{
  /** Existing parent restored-open ticket; reserved once, never minted here. */
  ticket: string;
  current: WindowsRestoreCurrent;
  directory: string;
  verifiedFingerprint: string;
  verifiedTree: NativePrivateTree;
  nativeFilesystem: NativePrivateFilesystemPort;
}>;

export type WindowsRestoredWorkspaceLaunch = Readonly<{
  config: WindowsOperatorConfig;
  intent: NativePrivateReceipt;
  handoff: NativePrivateReceipt;
  directoryReceipt: WindowsExclusiveDirectoryResult;
  bootstrap: WindowsRuntimeFileIdentity;
  childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  assertCurrent(): void;
  /** Releases the parent's raw guards once; known-close only, never SQL. */
  close(): void;
}>;

export type WindowsRestoreHandoff = Readonly<{
  config: WindowsOperatorConfig;
  initialEnrollment: true;
  directory: string;
  verifiedFingerprint: string;
  assertHeld(): void;
  stateReady(
    product: Pick<WindowsProductNative, "assertRoot" | "privateFilesystem">,
  ): void;
  workspaceReady(primary: Store): void;
  retainFailure(error: unknown): never;
}>;

export const WINDOWS_RESTORE_HANDOFF_ENV = [
  "FOLIO_WINDOWS_RESTORE_HANDOFF_PATH",
  "FOLIO_WINDOWS_RESTORE_HANDOFF_FILE_ID",
  "FOLIO_WINDOWS_RESTORE_HANDOFF_VOLUME_ID",
  "FOLIO_WINDOWS_RESTORE_HANDOFF_SHA256",
  "FOLIO_WINDOWS_RESTORE_HANDOFF_BYTES",
  "FOLIO_WINDOWS_RESTORE_HANDOFF_ROOT_ID",
] as const;

export class WindowsRestoreHandoffError extends Error {
  readonly state: "REJECTED" | "EXISTS" | "UNKNOWN";
  readonly phase: string;
  readonly preserve = true as const;
  readonly evidence: unknown;
  readonly attempt: unknown;
  constructor(
    state: "REJECTED" | "EXISTS" | "UNKNOWN",
    phase: string,
    message: string,
    options: { cause?: unknown; evidence?: unknown; attempt?: unknown } = {},
  ) {
    super(`WINDOWS_RESTORE_${state}:${message}`, {
      cause: options.cause,
    });
    this.name = "WindowsRestoreHandoffError";
    this.state = state;
    this.phase = phase;
    if ("evidence" in options) this.evidence = options.evidence;
    if ("attempt" in options) this.attempt = options.attempt;
  }
}

/* ------------------------------------------------------------------ */
/* constants + small validators                                       */
/* ------------------------------------------------------------------ */

const HANDOFF_MAX_BYTES = 1024 * 1024;
const DATABASE_MAX_BYTES = 256 * 1024 * 1024;
const TREE_MAX_ENTRIES = 4096;
const MAX_RESERVATIONS = 64;
const INTENT_PREFIX = ".folio-restore-";
const STATE_PREFIX = "restore-";
const BOOTSTRAP_BASENAME = "restore-bootstrap.sqlite";
const WORKSPACE_DATABASE = "workspace.sqlite";
const HANDOFF_PROFILE = "WINDOWS_PRIVATE_RESTORE_HANDOFF_V1";
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const FILE_ID_PATTERN = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID_PATTERN = /^[0-9a-fA-F]{16}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SID_PATTERN = /^S-1-[0-9]+(?:-[0-9]+)+$/;
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ASCII_PATH = /^[A-Z]:\\[\x20-\x7e]*$/;
const ENROLL_ENV = "FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES";
const DATA_DIR_ENV = "FOLIO_DATA_DIR";
const STATE_DIR_ENV = "FOLIO_WINDOWS_PUBLICATION_STATE_DIR";

const ENROLL_FOLD = asciiCaseFold(ENROLL_ENV);
const HANDOFF_KEY_FOLDS: ReadonlySet<string> = new Set(
  WINDOWS_RESTORE_HANDOFF_ENV.map((key) => asciiCaseFold(key)),
);

function fail(
  phase: string,
  code: string,
  options: { cause?: unknown; evidence?: unknown; attempt?: unknown } = {},
): never {
  throw new WindowsRestoreHandoffError("REJECTED", phase, code, options);
}

function unknown(
  phase: string,
  code: string,
  options: { cause?: unknown; evidence?: unknown; attempt?: unknown } = {},
): never {
  throw new WindowsRestoreHandoffError("UNKNOWN", phase, code, options);
}

function fold(value: string): string {
  return asciiCaseFold(value).replace(/\\$/, "");
}

function under(path: string, ancestor: string): boolean {
  return asciiCaseFold(path).startsWith(fold(ancestor) + "\\");
}

function overlaps(a: string, b: string): boolean {
  return fold(a) === fold(b) || under(a, b) || under(b, a);
}

function sameId(a: NativePrivateIdentity, b: NativePrivateIdentity): boolean {
  return (
    fold(a.path) === fold(b.path) &&
    asciiCaseFold(a.fileId) === asciiCaseFold(b.fileId) &&
    asciiCaseFold(a.volumeId) === asciiCaseFold(b.volumeId)
  );
}

function sameFile(a: NativePrivateFile, b: NativePrivateFile): boolean {
  return sameId(a, b) && a.bytes === b.bytes && a.sha256 === b.sha256;
}

function sameTree(a: NativePrivateTree, b: NativePrivateTree): boolean {
  return sameFile(a, b) && a.entries === b.entries;
}

/** Canonical absolute Windows path: ASCII, <=240 chars, already normalized. */
function canonicalPath(value: unknown, phase: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    !ASCII_PATH.test(value)
  )
    fail(phase, "WINDOWS_RESTORE_PATH");
  try {
    if (validateWindowsPath(value, `${value[0]}:\\`).canonical !== value)
      fail(phase, "WINDOWS_RESTORE_PATH");
  } catch (error) {
    if (error instanceof WindowsRestoreHandoffError) throw error;
    fail(phase, "WINDOWS_RESTORE_PATH", { cause: error });
  }
  return value;
}

function syncFunction(
  value: unknown,
  phase: string,
): (...args: never[]) => unknown {
  if (
    typeof value !== "function" ||
    utilTypes.isAsyncFunction(value) ||
    utilTypes.isGeneratorFunction(value)
  )
    fail(phase, "WINDOWS_RESTORE_ASYNC_CALLBACK");
  return value as (...args: never[]) => unknown;
}

/** Exact synchronous undefined; a thenable is observed then refused. */
function callVoid(fn: () => unknown, phase: string): void {
  const outcome: unknown = fn();
  if (utilTypes.isPromise(outcome)) {
    try {
      Promise.prototype.then.call(outcome, undefined, () => undefined);
    } catch {
      /* sinking must never surface a transport rejection here */
    }
  }
  if (outcome !== undefined) fail(phase, "WINDOWS_RESTORE_ASYNC_CALLBACK");
}

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value))
    return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

/* ------------------------------------------------------------------ */
/* bounded reservations + strong owners                               */
/* ------------------------------------------------------------------ */

type AttemptRecord =
  | Readonly<{ kind: "reserved" }>
  | Readonly<{ kind: "success"; launch: WindowsRestoredWorkspaceLaunch }>
  | Readonly<{ kind: "failure"; error: unknown }>;

type Reservations = {
  readonly tickets: Map<string, AttemptRecord>;
  readonly producerOwners: Set<Owner>;
  readonly consumerOwners: Set<Owner>;
};

type Owner = {
  readonly leases: PrivateAuthorityLease[];
  primarySeen: boolean;
  released: boolean;
};

function reserveTicket(reservations: Reservations, ticket: string): void {
  const existing = reservations.tickets.get(ticket);
  if (existing !== undefined) {
    // No IO, no new nonce: repeat returns/throws the original outcome.
    if (existing.kind === "failure") throw existing.error;
    if (existing.kind === "success")
      fail("reserve", "WINDOWS_RESTORE_TICKET_CONSUMED", {
        attempt: existing,
      });
    fail("reserve", "WINDOWS_RESTORE_TICKET_CONSUMED", { attempt: existing });
  }
  if (reservations.tickets.size >= MAX_RESERVATIONS)
    fail("reserve", "WINDOWS_RESTORE_TICKET_CAPACITY");
  reservations.tickets.set(ticket, { kind: "reserved" });
}

function reserveOwner(owners: Set<Owner>): Owner {
  if (owners.size >= MAX_RESERVATIONS)
    fail("reserve", "WINDOWS_RESTORE_OWNER_CAPACITY");
  const owner: Owner = { leases: [], primarySeen: false, released: false };
  owners.add(owner);
  return owner;
}

/** Assign a freshly acquired raw lease to the owner BEFORE any held check. */
function ownLease(owner: Owner, lease: PrivateAuthorityLease): PrivateAuthorityLease {
  if (
    lease === null ||
    typeof lease !== "object" ||
    isThenable(lease)
  )
    fail("lease", "WINDOWS_RESTORE_LEASE_SHAPE");
  owner.leases.push(lease);
  return lease;
}

function assertLeaseHeld(lease: PrivateAuthorityLease): void {
  if (
    utilTypes.isAsyncFunction(lease.assertHeld) ||
    utilTypes.isGeneratorFunction(lease.assertHeld)
  )
    fail("lease", "WINDOWS_RESTORE_ASYNC_CALLBACK");
  callVoid(() => lease.assertHeld(), "lease");
}

function compositeLease(leases: readonly PrivateAuthorityLease[]): NativePrivateSqliteLease {
  return Object.freeze({
    assertHeld() {
      for (const lease of leases) lease.assertHeld();
    },
    close() {
      for (const lease of leases) lease.close();
    },
  });
}

/**
 * Close every acquired raw lease exactly once. A failed close retains the
 * whole composite graph through the startup owner brand; the original cause
 * (which may literally be `undefined`) is preserved as the first failure.
 */
function closeOwnedLeases(
  owner: Owner,
  primaryError: unknown,
  primaryErrorSeen: boolean,
): void {
  const failures: unknown[] = primaryErrorSeen ? [primaryError] : [];
  let cleanupFailed = false;
  for (const lease of owner.leases) {
    try {
      lease.close();
    } catch (cleanup) {
      cleanupFailed = true; failures.push(cleanup);
    }
  }
  if (cleanupFailed)
    retainStartupProtector(
      compositeLease(owner.leases),
      failures,
      undefined,
      owner,
    );
  owner.leases.length = 0;
  owner.released = true;
}

/* ------------------------------------------------------------------ */
/* dependency surface (production natives vs untrusted test seam)     */
/* ------------------------------------------------------------------ */

type HandoffDeps = Readonly<{
  readonly label: "native" | "untrusted-test";
  runtime(options: WindowsRuntimePlatformOptions): WindowsRuntimePlatform;
  privateFilesystem(
    options: WindowsPrivatePersistenceOptions,
  ): NativePrivateFilesystemPort;
  authorityLeases(
    options: NativeAuthorityLeaseOptions,
  ): AcquirePrivateAuthorityLease;
  probeEvidence(
    config: WindowsOperatorConfig,
    path: string,
    root: string,
  ): WindowsProbeEvidence;
  nonce(): string;
}>;

/**
 * Production SID/root proof adapter. The runtime port never exposes the
 * current user SID, so this uses the SAME compiled read-only probe protocol
 * as runtime-platform (#probe -> invokeCompiledProbe): bounded spawn of the
 * pinned helper with the restricted SystemRoot environment, evidence
 * validated by assertWindowsProbe. The helper file is pinned by
 * lstat/readFile/hash before and after; dev/ino are only the helper pin,
 * never a Windows source identity. Source authoring only.
 */
function nativeProbeEvidence(
  config: WindowsOperatorConfig,
  path: string,
  root: string,
): WindowsProbeEvidence {
  const executable = canonicalPath(config.probeExecutable, "probe");
  const systemRoot = canonicalPath(config.systemRoot, "probe");
  const pin = (): string => {
    const before = lstatSync(executable);
    const bytes = readFileSync(executable);
    const after = lstatSync(executable);
    const stamp = (s: typeof before) =>
      `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      stamp(before) !== stamp(after) ||
      createHash("sha256").update(bytes).digest("hex") !== config.expectedHash
    )
      fail("probe", "WINDOWS_RESTORE_HELPER_UNTRUSTED");
    return stamp(after);
  };
  const before = pin();
  const result = spawnSync(executable, [path, root], {
    cwd: systemRoot,
    env: {
      SystemRoot: systemRoot,
      windir: systemRoot,
      TEMP: `${systemRoot}\\Temp`,
      TMP: `${systemRoot}\\Temp`,
    },
    timeout: WINDOWS_PROBE_TIMEOUT_MS,
    maxBuffer: WINDOWS_PROBE_MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
    encoding: "utf8",
  });
  if (pin() !== before) fail("probe", "WINDOWS_RESTORE_HELPER_CHANGED");
  const error = result.error;
  if (error !== undefined) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") fail("probe", "PROBE_TIMEOUT");
    if (code === "ENOBUFS") fail("probe", "PROBE_OUTPUT_LIMIT");
    fail("probe", "PROBE_EXEC_FAILED", { cause: error });
  }
  if (result.status !== 0) fail("probe", "PROBE_EXIT");
  if (result.signal !== null) fail("probe", "PROBE_SIGNAL");
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stderr !== "") fail("probe", "PROBE_STDERR");
  if (
    stdout.length === 0 ||
    new TextEncoder().encode(stdout).byteLength > WINDOWS_PROBE_MAX_OUTPUT_BYTES
  )
    fail("probe", "PROBE_OUTPUT");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("probe", "PROBE_JSON");
  }
  assertWindowsProbe(parsed, { canonicalPath: path, canonicalRoot: root });
  return parsed as WindowsProbeEvidence;
}

const nativeDeps: HandoffDeps = Object.freeze({
  label: "native",
  runtime: (options) => new WindowsRuntimePlatform(options),
  privateFilesystem: (options) => createWindowsPrivatePersistence(options),
  authorityLeases: (options) => createNativeAuthorityLeaseAcquirer(options),
  probeEvidence: nativeProbeEvidence,
  nonce: () => randomUUID().replace(/-/g, ""),
});

/* ------------------------------------------------------------------ */
/* payload schema                                                     */
/* ------------------------------------------------------------------ */

type PayloadIdentity = Readonly<{
  path: string;
  fileId: string;
  volumeId: string;
}>;
type PayloadFile = PayloadIdentity & Readonly<{ bytes: number; sha256: string }>;
type PayloadTree = PayloadFile & Readonly<{ entries: number }>;
type PayloadConfig = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  publicationStateRoot: string;
  publicationStateDirectory: string;
}>;
type RestoreIntentPayload = Readonly<{
  version: 1;
  role: "folio-restored-workspace-intent";
  nonce: string;
  configuration: PayloadConfig;
  current: Readonly<{
    directory: string;
    workspaceId: string;
    identity: PayloadIdentity;
  }>;
  root: PayloadIdentity;
  stateRoot: PayloadIdentity;
  directory: PayloadIdentity;
  database: PayloadFile;
  tree: PayloadTree;
  verifiedFingerprint: string;
  plannedStateDirectory: string;
  plannedBootstrap: string;
}>;
type RestoreHandoffPayload = Readonly<{
  version: 1;
  role: "folio-restored-workspace-launch";
  nonce: string;
  configuration: PayloadConfig;
  profile: typeof HANDOFF_PROFILE;
  scope: "PROCESS_CRASH";
  sid: string;
  current: Readonly<{
    directory: string;
    workspaceId: string;
    identity: PayloadIdentity;
  }>;
  root: PayloadIdentity;
  stateRoot: PayloadIdentity;
  directory: PayloadIdentity;
  database: PayloadFile;
  tree: PayloadTree;
  verifiedFingerprint: string;
  stateDirectory: PayloadIdentity;
  bootstrap: PayloadFile;
  intent: NativePrivateReceipt;
  directoryReceipt: WindowsExclusiveDirectoryResult;
}>;

function exactRecord(
  value: unknown,
  keys: readonly string[],
  phase: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  const names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some((name) => typeof name !== "string" || !keys.includes(name))
  )
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  const record_ = value as Record<string, unknown>;
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record_, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail(phase, "WINDOWS_RESTORE_SCHEMA");
  }
  return record_;
}

function hexText(value: unknown, pattern: RegExp, phase: string): string {
  if (typeof value !== "string" || !pattern.test(value))
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  return value;
}

function boundedInt(
  value: unknown,
  min: number,
  max: number,
  phase: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  return value;
}

function payloadIdentity(value: unknown, phase: string): PayloadIdentity {
  const r = exactRecord(value, ["path", "fileId", "volumeId"], phase);
  return deepFreeze({
    path: canonicalPath(r.path, phase),
    fileId: hexText(r.fileId, FILE_ID_PATTERN, phase),
    volumeId: hexText(r.volumeId, VOLUME_ID_PATTERN, phase),
  });
}

function payloadFile(value: unknown, phase: string): PayloadFile {
  const r = exactRecord(
    value,
    ["path", "fileId", "volumeId", "bytes", "sha256"],
    phase,
  );
  return deepFreeze({
    path: canonicalPath(r.path, phase),
    fileId: hexText(r.fileId, FILE_ID_PATTERN, phase),
    volumeId: hexText(r.volumeId, VOLUME_ID_PATTERN, phase),
    bytes: boundedInt(r.bytes, 0, DATABASE_MAX_BYTES, phase),
    sha256: hexText(r.sha256, HASH_PATTERN, phase),
  });
}

function payloadTree(value: unknown, phase: string): PayloadTree {
  const r = exactRecord(
    value,
    ["path", "fileId", "volumeId", "entries", "bytes", "sha256"],
    phase,
  );
  return deepFreeze({
    path: canonicalPath(r.path, phase),
    fileId: hexText(r.fileId, FILE_ID_PATTERN, phase),
    volumeId: hexText(r.volumeId, VOLUME_ID_PATTERN, phase),
    entries: boundedInt(r.entries, 1, TREE_MAX_ENTRIES, phase),
    bytes: boundedInt(r.bytes, 0, DATABASE_MAX_BYTES, phase),
    sha256: hexText(r.sha256, HASH_PATTERN, phase),
  });
}

function payloadReceipt(value: unknown, phase: string): NativePrivateReceipt {
  const r = exactRecord(value, ["identity", "profile", "scope"], phase);
  if (
    r.profile !== "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" ||
    r.scope !== "PROCESS_CRASH"
  )
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  return deepFreeze({
    profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",
    scope: "PROCESS_CRASH",
    identity: payloadFile(r.identity, phase),
  }) as NativePrivateReceipt;
}

function payloadConfig(value: unknown, phase: string): PayloadConfig {
  const r = exactRecord(
    value,
    [
      "expectedHash",
      "probeExecutable",
      "publicationStateDirectory",
      "publicationStateRoot",
      "root",
      "systemRoot",
    ],
    phase,
  );
  return deepFreeze({
    root: canonicalPath(r.root, phase),
    probeExecutable: canonicalPath(r.probeExecutable, phase),
    expectedHash: hexText(r.expectedHash, HASH_PATTERN, phase),
    systemRoot: canonicalPath(r.systemRoot, phase),
    publicationStateRoot: canonicalPath(r.publicationStateRoot, phase),
    publicationStateDirectory: canonicalPath(r.publicationStateDirectory, phase),
  });
}

function payloadCurrent(value: unknown, phase: string) {
  const r = exactRecord(value, ["directory", "identity", "workspaceId"], phase);
  if (
    typeof r.workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(r.workspaceId)
  )
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  return deepFreeze({
    directory: canonicalPath(r.directory, phase),
    workspaceId: r.workspaceId,
    identity: payloadIdentity(r.identity, phase),
  });
}

function payloadDirectoryReceipt(
  value: unknown,
  phase: string,
): WindowsExclusiveDirectoryResult {
  const r = exactRecord(
    value,
    ["attemptId", "evidence", "identity", "path", "preserve", "state"],
    phase,
  );
  if (r.state !== "CREATED" || r.preserve !== true)
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  hexText(r.attemptId, /^[0-9a-f]{32}$/, phase);
  canonicalPath(r.path, phase);
  const identity = exactRecord(
    r.identity,
    [
      "canonicalPath",
      "directoryFileId",
      "directoryVolumeId",
      "rootFileId",
      "rootVolumeId",
    ],
    phase,
  );
  const evidence = exactRecord(r.evidence, ["captured", "exactWire"], phase);
  if (typeof evidence.exactWire !== "string")
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  const captured = exactRecord(
    evidence.captured,
    ["captureEncoding", "signal", "status", "stderr", "stdout"],
    phase,
  );
  if (
    captured.captureEncoding !== "latin1" ||
    typeof captured.stdout !== "string" ||
    typeof captured.stderr !== "string" ||
    (captured.status !== null && !Number.isInteger(captured.status)) ||
    (captured.signal !== null && typeof captured.signal !== "string")
  )
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  return deepFreeze({
    state: "CREATED",
    path: r.path,
    attemptId: r.attemptId,
    preserve: true,
    identity: {
      canonicalPath: canonicalPath(identity.canonicalPath, phase),
      directoryFileId: hexText(identity.directoryFileId, FILE_ID_PATTERN, phase),
      directoryVolumeId: hexText(
        identity.directoryVolumeId,
        VOLUME_ID_PATTERN,
        phase,
      ),
      rootFileId: hexText(identity.rootFileId, FILE_ID_PATTERN, phase),
      rootVolumeId: hexText(identity.rootVolumeId, VOLUME_ID_PATTERN, phase),
    },
    evidence: {
      exactWire: evidence.exactWire,
      captured: {
        stdout: captured.stdout,
        stderr: captured.stderr,
        captureEncoding: "latin1",
        status: captured.status,
        signal: captured.signal,
      },
    },
  }) as WindowsExclusiveDirectoryResult;
}

function parseIntentPayload(value: unknown, phase: string): RestoreIntentPayload {
  const r = exactRecord(
    value,
    [
      "configuration",
      "current",
      "database",
      "directory",
      "nonce",
      "plannedBootstrap",
      "plannedStateDirectory",
      "role",
      "root",
      "stateRoot",
      "tree",
      "verifiedFingerprint",
      "version",
    ],
    phase,
  );
  if (r.version !== 1 || r.role !== "folio-restored-workspace-intent")
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  return deepFreeze({
    version: 1,
    role: "folio-restored-workspace-intent",
    nonce: hexText(r.nonce, NONCE_PATTERN, phase),
    configuration: payloadConfig(r.configuration, phase),
    current: payloadCurrent(r.current, phase),
    root: payloadIdentity(r.root, phase),
    stateRoot: payloadIdentity(r.stateRoot, phase),
    directory: payloadIdentity(r.directory, phase),
    database: payloadFile(r.database, phase),
    tree: payloadTree(r.tree, phase),
    verifiedFingerprint: hexText(r.verifiedFingerprint, HASH_PATTERN, phase),
    plannedStateDirectory: canonicalPath(r.plannedStateDirectory, phase),
    plannedBootstrap: canonicalPath(r.plannedBootstrap, phase),
  }) as RestoreIntentPayload;
}

function parseHandoffPayload(
  value: unknown,
  phase: string,
): RestoreHandoffPayload {
  const r = exactRecord(
    value,
    [
      "bootstrap",
      "configuration",
      "current",
      "database",
      "directory",
      "directoryReceipt",
      "intent",
      "nonce",
      "profile",
      "role",
      "root",
      "scope",
      "sid",
      "stateDirectory",
      "stateRoot",
      "tree",
      "verifiedFingerprint",
      "version",
    ],
    phase,
  );
  if (
    r.version !== 1 ||
    r.role !== "folio-restored-workspace-launch" ||
    r.profile !== HANDOFF_PROFILE ||
    r.scope !== "PROCESS_CRASH"
  )
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  return deepFreeze({
    version: 1,
    role: "folio-restored-workspace-launch",
    nonce: hexText(r.nonce, NONCE_PATTERN, phase),
    configuration: payloadConfig(r.configuration, phase),
    profile: HANDOFF_PROFILE,
    scope: "PROCESS_CRASH",
    sid: hexText(r.sid, SID_PATTERN, phase),
    current: payloadCurrent(r.current, phase),
    root: payloadIdentity(r.root, phase),
    stateRoot: payloadIdentity(r.stateRoot, phase),
    directory: payloadIdentity(r.directory, phase),
    database: payloadFile(r.database, phase),
    tree: payloadTree(r.tree, phase),
    verifiedFingerprint: hexText(r.verifiedFingerprint, HASH_PATTERN, phase),
    stateDirectory: payloadIdentity(r.stateDirectory, phase),
    bootstrap: payloadFile(r.bootstrap, phase),
    intent: payloadReceipt(r.intent, phase),
    directoryReceipt: payloadDirectoryReceipt(r.directoryReceipt, phase),
  }) as RestoreHandoffPayload;
}

/** Strict UTF-8 decode + canonical-equality check: duplicate keys,
 * noncanonical order, Unicode repair and unsafe integers all reject. */
function readCanonicalPayload(
  bytes: Uint8Array,
  phase: string,
): Record<string, unknown> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > HANDOFF_MAX_BYTES)
    fail(phase, "WINDOWS_RESTORE_PAYLOAD_LIMIT");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(phase, "WINDOWS_RESTORE_PAYLOAD_ENCODING", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text as string);
  } catch (error) {
    fail(phase, "WINDOWS_RESTORE_PAYLOAD_JSON", { cause: error });
  }
  let encoded: string;
  try {
    encoded = canonical(parsed, HANDOFF_MAX_BYTES);
  } catch (error) {
    fail(phase, "WINDOWS_RESTORE_PAYLOAD_CANONICAL", { cause: error });
  }
  if (encoded !== text) fail(phase, "WINDOWS_RESTORE_PAYLOAD_CANONICAL");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    fail(phase, "WINDOWS_RESTORE_SCHEMA");
  return parsed as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* configuration / request validation                                 */
/* ------------------------------------------------------------------ */

function validateConfig(
  config: WindowsOperatorConfig,
  phase: string,
): PayloadConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config))
    fail(phase, "WINDOWS_RESTORE_CONFIG");
  const parsed = payloadConfig(
    {
      root: config.root,
      probeExecutable: config.probeExecutable,
      expectedHash: config.expectedHash,
      systemRoot: config.systemRoot,
      publicationStateRoot: config.publicationStateRoot,
      publicationStateDirectory: config.publicationStateDirectory,
    },
    phase,
  );
  if (overlaps(parsed.root, parsed.publicationStateRoot))
    fail(phase, "WINDOWS_RESTORE_STATE_OVERLAP");
  if (!under(parsed.publicationStateDirectory, parsed.publicationStateRoot))
    fail(phase, "WINDOWS_RESTORE_STATE_LAYOUT");
  return parsed;
}

function compareConfig(a: PayloadConfig, b: PayloadConfig, phase: string): void {
  if (
    fold(a.root) !== fold(b.root) ||
    fold(a.probeExecutable) !== fold(b.probeExecutable) ||
    a.expectedHash !== b.expectedHash ||
    fold(a.systemRoot) !== fold(b.systemRoot) ||
    fold(a.publicationStateRoot) !== fold(b.publicationStateRoot) ||
    fold(a.publicationStateDirectory) !== fold(b.publicationStateDirectory)
  )
    fail(phase, "WINDOWS_RESTORE_CONFIG_CHANGED");
}

function readOnlyAuthority(current: () => void) {
  return Object.freeze({
    version: 1 as const,
    independent: true as const,
    reserve() {
      fail("authority", "WINDOWS_RESTORE_READ_ONLY_AUTHORITY");
    },
    capture() {
      fail("authority", "WINDOWS_RESTORE_READ_ONLY_AUTHORITY");
    },
    terminal() {
      fail("authority", "WINDOWS_RESTORE_READ_ONLY_AUTHORITY");
    },
    assertCurrent() {
      current();
    },
  });
}

/** Tracks bound runtime proof handles so an error path can close them all. */
type ProofScope = {
  bound(
    root: string,
    dir: string,
    databaseName: string,
    expectedRoot?: WindowsRuntimeRootIdentity,
    expectedDirectory?: { fileId: string; volumeId: string },
  ): WindowsRuntimePlatform;
  release(runtime: WindowsRuntimePlatform): void;
  closeAll(): void;
};

function makeProofScope(deps: HandoffDeps, cfg: PayloadConfig): ProofScope {
  const runtimes: WindowsRuntimePlatform[] = [];
  return {
    bound(root, dir, databaseName, expectedRoot, expectedDirectory) {
      const runtime = deps.runtime({
        root,
        probeExecutable: cfg.probeExecutable,
        expectedHash: cfg.expectedHash,
        systemRoot: cfg.systemRoot,
        databaseName,
        ...(expectedRoot !== undefined ? { expectedRoot } : {}),
        ...(expectedDirectory !== undefined ? { expectedDirectory } : {}),
      });
      runtimes.push(runtime);
      try {
        runtime.bind(dir);
      } catch (error) {
        try {
          runtime.close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "bind and close failed");
        }
        const at = runtimes.indexOf(runtime);
        if (at >= 0) runtimes.splice(at, 1);
        throw error;
      }
      return runtime;
    },
    release(runtime) {
      const at = runtimes.indexOf(runtime);
      if (at >= 0) runtimes.splice(at, 1);
    },
    closeAll() {
      const failures: unknown[] = [];
      for (const runtime of runtimes.splice(0)) {
        try {
          runtime.close();
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Native proof cleanup failed");
    },
  };
}

/* ------------------------------------------------------------------ */
/* producer                                                           */
/* ------------------------------------------------------------------ */

function prepareAttempt(
  deps: HandoffDeps,
  reservations: Reservations,
  config: WindowsOperatorConfig,
  request: WindowsRestoreLaunchRequest,
  owner: Owner,
  scope: ProofScope,
  dispatched: { value: boolean },
): WindowsRestoredWorkspaceLaunch {
  const cfg = validateConfig(config, "validate");

  // --- captured request validation BEFORE any callback or native IO ---
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  )
    fail("validate", "WINDOWS_RESTORE_REQUEST");
  const current_ = request.current;
  if (
    typeof current_ !== "object" ||
    current_ === null ||
    Array.isArray(current_)
  )
    fail("validate", "WINDOWS_RESTORE_REQUEST");
  const assertCurrent = syncFunction(current_.assertCurrent, "validate");
  const currentDirectory = canonicalPath(current_.directory, "validate");
  if (
    typeof current_.workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(current_.workspaceId)
  )
    fail("validate", "WINDOWS_RESTORE_WORKSPACE");
  const workspaceId = current_.workspaceId;
  const directory = canonicalPath(request.directory, "validate");
  const verifiedFingerprint = hexText(
    request.verifiedFingerprint,
    HASH_PATTERN,
    "validate",
  );
  const verifiedTree = payloadTree(request.verifiedTree, "validate");
  const port = request.nativeFilesystem;
  if (typeof port !== "object" || port === null || Array.isArray(port))
    fail("validate", "WINDOWS_RESTORE_REQUEST");
  for (const name of [
    "inspectDirectory",
    "inspectFile",
    "inspectTree",
    "read",
    "writeNew",
  ] as const)
    syncFunction(port[name], "validate");
  const fs = port as Required<
    Pick<
      NativePrivateFilesystemPort,
      "inspectDirectory" | "inspectFile" | "inspectTree" | "read" | "writeNew"
    >
  >;

  // Trusted layout: restored dir + current dir strict descendants of the
  // private container, disjoint from each other and from the state root.
  if (!under(directory, cfg.root) || !under(currentDirectory, cfg.root))
    fail("validate", "WINDOWS_RESTORE_LAYOUT");
  if (overlaps(directory, currentDirectory))
    fail("validate", "WINDOWS_RESTORE_LAYOUT");

  const fence = (): void => {
    callVoid(assertCurrent, "current");
  };
  fence();

  // Detached identity records for the payload.
  const identity = (
    path: string,
    fileId: string,
    volumeId: string,
  ): PayloadIdentity =>
    deepFreeze({ path, fileId, volumeId });

  const stage = <T>(phase: string, work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (!dispatched.value) throw error;
      if (error instanceof WindowsRestoreHandoffError) {
        if (error.state === "UNKNOWN") throw error;
        unknown(phase, error.message, { cause: error });
      }
      // Preserve a typed persistence verdict exactly; every other
      // post-dispatch exception is UNKNOWN, never "nothing happened".
      const state = (error as { state?: unknown }).state;
      if (state === "REJECTED" || state === "EXISTS" || state === "UNKNOWN")
        throw new WindowsRestoreHandoffError(state, phase,
          "WINDOWS_RESTORE_POST_DISPATCH", { cause: error });
      unknown(phase, "WINDOWS_RESTORE_POST_DISPATCH", { cause: error });
    }
  };
  const dispatchFence = (phase: string, evidence?: unknown): void => {
    try {
      fence();
    } catch (error) {
      unknown(phase, "WINDOWS_RESTORE_STALE_AFTER_DISPATCH", {
        cause: error,
        evidence,
      });
    }
  };

  // --- native proofs: root, stateRoot, current + restored directory ---
  const bound = scope.bound;

  const rootRuntime = bound(cfg.root, cfg.root, WORKSPACE_DATABASE);
  const rootProof = rootRuntime.validatedDirectoryIdentity();
  const rootIdentity = identity(
    rootProof.canonicalPath,
    rootProof.rootFileId,
    rootProof.rootVolumeId,
  );
  const expectedRoot: WindowsRuntimeRootIdentity = Object.freeze({
    rootFileId: rootProof.rootFileId,
    volumeId: rootProof.rootVolumeId,
  });

  const stateRootRuntime = bound(
    cfg.publicationStateRoot,
    cfg.publicationStateRoot,
    BOOTSTRAP_BASENAME,
  );
  const stateRootProof = stateRootRuntime.validatedDirectoryIdentity();
  const stateRootIdentity = identity(
    stateRootProof.canonicalPath,
    stateRootProof.rootFileId,
    stateRootProof.rootVolumeId,
  );
  const expectedStateRoot: WindowsRuntimeRootIdentity = Object.freeze({
    rootFileId: stateRootProof.rootFileId,
    volumeId: stateRootProof.rootVolumeId,
  });

  const currentRuntime = bound(
    cfg.root,
    currentDirectory,
    WORKSPACE_DATABASE,
    expectedRoot,
  );
  const currentProof = currentRuntime.validatedDirectoryIdentity();
  if (
    asciiCaseFold(currentProof.rootFileId) !==
      asciiCaseFold(rootIdentity.fileId) ||
    asciiCaseFold(currentProof.rootVolumeId) !==
      asciiCaseFold(rootIdentity.volumeId)
  )
    fail("proof", "WINDOWS_RESTORE_ROOT_CHANGED");
  const currentIdentity = identity(
    currentProof.canonicalPath,
    currentProof.directoryFileId,
    currentProof.directoryVolumeId,
  );

  const dataRuntime = bound(
    cfg.root,
    directory,
    WORKSPACE_DATABASE,
    expectedRoot,
  );
  const directoryProof = dataRuntime.validatedDirectoryIdentity();
  if (
    asciiCaseFold(directoryProof.rootFileId) !==
      asciiCaseFold(rootIdentity.fileId) ||
    asciiCaseFold(directoryProof.rootVolumeId) !==
      asciiCaseFold(rootIdentity.volumeId)
  )
    fail("proof", "WINDOWS_RESTORE_ROOT_CHANGED");
  const directoryIdentity = identity(
    directoryProof.canonicalPath,
    directoryProof.directoryFileId,
    directoryProof.directoryVolumeId,
  );
  const databasePath = win32.join(directory, WORKSPACE_DATABASE);
  const databaseProof = dataRuntime.validatedFileIdentity(databasePath);

  // Current-SID proof through the pinned read-only helper; root ids must
  // match the runtime proof on BOTH proofs.
  const sidEvidence = deps.probeEvidence(
    config,
    cfg.root,
    cfg.root,
  );
  if (
    !SID_PATTERN.test(sidEvidence.sid) ||
    asciiCaseFold(sidEvidence.rootFileId) !==
      asciiCaseFold(rootIdentity.fileId) ||
    asciiCaseFold(sidEvidence.rootVolumeId) !==
      asciiCaseFold(rootIdentity.volumeId) ||
    asciiCaseFold(sidEvidence.volumeId) !==
      asciiCaseFold(rootIdentity.volumeId)
  )
    fail("proof", "WINDOWS_RESTORE_ROOT_CHANGED");
  const sid = sidEvidence.sid;

  // Supplied tree attestation must match a fresh native tree proof exactly.
  const treeNow = fs.inspectTree(directory);
  if (!sameTree(treeNow, verifiedTree) || fold(treeNow.path) !== fold(directory))
    fail("proof", "WINDOWS_RESTORE_TREE_CHANGED");
  if (
    asciiCaseFold(treeNow.fileId) !== asciiCaseFold(directoryIdentity.fileId) ||
    asciiCaseFold(treeNow.volumeId) !==
      asciiCaseFold(directoryIdentity.volumeId)
  )
    fail("proof", "WINDOWS_RESTORE_TREE_CHANGED");
  const database = fs.inspectFile(databasePath, DATABASE_MAX_BYTES);
  if (
    asciiCaseFold(database.fileId) !== asciiCaseFold(databaseProof.fileId) ||
    asciiCaseFold(database.volumeId) !== asciiCaseFold(databaseProof.volumeId) ||
    asciiCaseFold(database.path) !== asciiCaseFold(databasePath)
  )
    fail("proof", "WINDOWS_RESTORE_DATABASE_CHANGED");
  fence();

  const nonce = deps.nonce();
  if (!NONCE_PATTERN.test(nonce)) fail("nonce", "WINDOWS_RESTORE_NONCE");
  const stateDirectoryPath = win32.join(
    cfg.publicationStateRoot,
    `${STATE_PREFIX}${nonce}`,
  );
  const bootstrapPath = win32.join(stateDirectoryPath, BOOTSTRAP_BASENAME);
  if (
    overlaps(stateDirectoryPath, cfg.publicationStateDirectory) ||
    overlaps(stateDirectoryPath, directory) ||
    overlaps(stateDirectoryPath, currentDirectory)
  )
    fail("validate", "WINDOWS_RESTORE_STATE_LAYOUT");
  const intentPath = win32.join(
    cfg.root,
    `${INTENT_PREFIX}${nonce}.intent.json`,
  );
  const handoffPath = win32.join(
    cfg.root,
    `${INTENT_PREFIX}${nonce}.handoff.json`,
  );
  if (under(intentPath, directory) || under(handoffPath, directory))
    fail("validate", "WINDOWS_RESTORE_LAYOUT");

  const payloadCurrent_ = deepFreeze({
    directory: currentDirectory,
    workspaceId,
    identity: currentIdentity,
  });
  const payloadDatabase = deepFreeze({
    path: database.path,
    fileId: database.fileId,
    volumeId: database.volumeId,
    bytes: database.bytes,
    sha256: database.sha256,
  });
  const payloadTree_ = deepFreeze({
    path: verifiedTree.path,
    fileId: verifiedTree.fileId,
    volumeId: verifiedTree.volumeId,
    entries: verifiedTree.entries,
    bytes: verifiedTree.bytes,
    sha256: verifiedTree.sha256,
  });

  // --- immutable intent BEFORE any new-state creation ---
  const intentPayload: RestoreIntentPayload = deepFreeze({
    version: 1,
    role: "folio-restored-workspace-intent",
    nonce,
    configuration: cfg,
    current: payloadCurrent_,
    root: rootIdentity,
    stateRoot: stateRootIdentity,
    directory: directoryIdentity,
    database: payloadDatabase,
    tree: payloadTree_,
    verifiedFingerprint,
    plannedStateDirectory: stateDirectoryPath,
    plannedBootstrap: bootstrapPath,
  });
  const intentText = canonical(intentPayload, HANDOFF_MAX_BYTES);
  const intentBytes = new TextEncoder().encode(intentText);
  fence();
  dispatched.value = true;
  const intentReceipt = stage("intent", () =>
    fs.writeNew(intentPath, intentBytes, HANDOFF_MAX_BYTES),
  );
  dispatchFence("intent", intentReceipt);
  stage("intent", () => {
    const back = fs.read(intentPath, intentReceipt.identity, HANDOFF_MAX_BYTES);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(back);
    if (decoded !== intentText) fail("intent", "WINDOWS_RESTORE_READBACK");
  });

  // --- new exclusive state directory under the existing state root ---
  const stateParentRuntime = bound(
    cfg.publicationStateRoot,
    cfg.publicationStateRoot,
    BOOTSTRAP_BASENAME,
    expectedStateRoot,
  );
  const directoryReceipt = stage("state", () =>
    stateParentRuntime.createExclusiveDirectory(stateDirectoryPath),
  );
  dispatchFence("state", directoryReceipt);
  if (directoryReceipt.state !== "CREATED") {
    const state =
      directoryReceipt.state === "UNKNOWN"
        ? "UNKNOWN"
        : directoryReceipt.state === "EXISTS"
          ? "EXISTS"
          : "REJECTED";
    throw new WindowsRestoreHandoffError(
      state,
      "state",
      `WINDOWS_RESTORE_STATE_${directoryReceipt.state}`,
      { evidence: directoryReceipt },
    );
  }
  const newStateIdentity = directoryReceipt.identity;

  const stateRuntime = bound(
    cfg.publicationStateRoot,
    stateDirectoryPath,
    BOOTSTRAP_BASENAME,
    expectedStateRoot,
    {
      fileId: newStateIdentity.directoryFileId,
      volumeId: newStateIdentity.directoryVolumeId,
    },
  );
  const stateProof = stateRuntime.validatedDirectoryIdentity();
  if (
    asciiCaseFold(stateProof.directoryFileId) !==
      asciiCaseFold(newStateIdentity.directoryFileId) ||
    asciiCaseFold(stateProof.directoryVolumeId) !==
      asciiCaseFold(newStateIdentity.directoryVolumeId)
  )
    unknown("state", "WINDOWS_RESTORE_STATE_IDENTITY", {
      evidence: directoryReceipt,
    });
  const stateDirectoryIdentity = identity(
    stateProof.canonicalPath,
    stateProof.directoryFileId,
    stateProof.directoryVolumeId,
  );
  const bootstrapReceipt = stage("bootstrap", () =>
    stateRuntime.createExclusiveDurablyWithReceipt(bootstrapPath),
  );
  dispatchFence("bootstrap", bootstrapReceipt);
  if (bootstrapReceipt.state !== "CREATED")
    unknown("bootstrap", "WINDOWS_RESTORE_BOOTSTRAP_NOT_CREATED", {
      evidence: bootstrapReceipt,
    });
  const bootstrap = bootstrapReceipt.identity;

  // Read-only state K establishes the pinned zero-byte EMPTY bootstrap hash.
  const stateAcquirer = deps.authorityLeases({
    root: cfg.publicationStateRoot,
    probeExecutable: cfg.probeExecutable,
    expectedHash: cfg.expectedHash,
    systemRoot: cfg.systemRoot,
    expectedRoot: expectedStateRoot,
    identityFor(path) {
      if (fold(path) !== fold(bootstrapPath))
        fail("lease", "WINDOWS_RESTORE_LEASE_PATH");
      const dir = stateRuntime.validatedDirectoryIdentity();
      const file = stateRuntime.validatedFileIdentity(bootstrapPath);
      return {
        directoryFileId: dir.directoryFileId,
        directoryVolumeId: dir.directoryVolumeId,
        fileId: file.fileId,
        volumeId: file.volumeId,
      };
    },
  });
  const stateReadOnly = deps.privateFilesystem({
    root: cfg.publicationStateRoot,
    probeExecutable: cfg.probeExecutable,
    expectedHash: cfg.expectedHash,
    systemRoot: cfg.systemRoot,
    expectedRoot: expectedStateRoot,
    authority: readOnlyAuthority(fence),
    directoryIdentity(path) {
      const parent = bound(
        cfg.publicationStateRoot,
        path,
        BOOTSTRAP_BASENAME,
        expectedStateRoot,
      );
      try {
        const dir = parent.validatedDirectoryIdentity();
        return {
          fileId: dir.directoryFileId,
          volumeId: dir.directoryVolumeId,
        };
      } finally {
        try {
          parent.close();
        } finally {
          scope.release(parent);
        }
      }
    },
    createDirectory() {
      return fail("authority", "WINDOWS_RESTORE_READ_ONLY_AUTHORITY");
    },
    acquireSqliteLease: stateAcquirer,
    assertCurrent: fence,
  });
  const bootstrapFile = stage("bootstrap", () =>
    stateReadOnly.inspectFile(bootstrapPath, 0),
  );
  if (
    bootstrapFile.bytes !== 0 ||
    bootstrapFile.sha256 !== EMPTY_SHA256 ||
    asciiCaseFold(bootstrapFile.fileId) !== asciiCaseFold(bootstrap.fileId) ||
    asciiCaseFold(bootstrapFile.volumeId) !== asciiCaseFold(bootstrap.volumeId)
  )
    unknown("bootstrap", "WINDOWS_RESTORE_BOOTSTRAP_NOT_EMPTY", {
      evidence: bootstrapReceipt,
    });

  // Raw state C lease: pins expected root/dir/file BEFORE handoff publish.
  const stateLease = stage("lease", () =>
    ownLease(owner, stateAcquirer(bootstrapPath)),
  );
  assertLeaseHeld(stateLease);

  // --- re-attest source tree/db/current after creation, then publish ---
  const treeAfter = fs.inspectTree(directory);
  if (!sameTree(treeAfter, verifiedTree))
    unknown("publish", "WINDOWS_RESTORE_TREE_CHANGED", {
      evidence: directoryReceipt,
    });
  const databaseAfter = fs.inspectFile(databasePath, DATABASE_MAX_BYTES);
  if (!sameFile(databaseAfter, payloadDatabase))
    unknown("publish", "WINDOWS_RESTORE_DATABASE_CHANGED", {
      evidence: directoryReceipt,
    });
  const currentAfter = currentRuntime.validatedDirectoryIdentity();
  if (
    asciiCaseFold(currentAfter.directoryFileId) !==
      asciiCaseFold(currentIdentity.fileId) ||
    asciiCaseFold(currentAfter.directoryVolumeId) !==
      asciiCaseFold(currentIdentity.volumeId)
  )
    unknown("publish", "WINDOWS_RESTORE_CURRENT_CHANGED", {
      evidence: directoryReceipt,
    });
  dispatchFence("publish", directoryReceipt);

  const handoffPayload: RestoreHandoffPayload = deepFreeze({
    version: 1,
    role: "folio-restored-workspace-launch",
    nonce,
    configuration: cfg,
    profile: HANDOFF_PROFILE,
    scope: "PROCESS_CRASH",
    sid,
    current: payloadCurrent_,
    root: rootIdentity,
    stateRoot: stateRootIdentity,
    directory: directoryIdentity,
    database: payloadDatabase,
    tree: payloadTree_,
    verifiedFingerprint,
    stateDirectory: stateDirectoryIdentity,
    bootstrap: bootstrapFile,
    intent: intentReceipt,
    directoryReceipt,
  });
  const handoffText = canonical(handoffPayload, HANDOFF_MAX_BYTES);
  const handoffBytes = new TextEncoder().encode(handoffText);
  const handoffReceipt = stage("publish", () =>
    fs.writeNew(handoffPath, handoffBytes, HANDOFF_MAX_BYTES),
  );
  dispatchFence("publish", handoffReceipt);
  stage("publish", () => {
    const back = fs.read(
      handoffPath,
      handoffReceipt.identity,
      HANDOFF_MAX_BYTES,
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(back);
    if (decoded !== handoffText) fail("publish", "WINDOWS_RESTORE_READBACK");
  });
  fence();
  assertLeaseHeld(stateLease);
  scope.closeAll();

  let closed = false;
  const heldNow = (): void => {
    fence();
    assertLeaseHeld(stateLease);
  };
  const launch: WindowsRestoredWorkspaceLaunch = Object.freeze({
    config: deepFreeze({ ...cfg }) as WindowsOperatorConfig,
    intent: intentReceipt,
    handoff: handoffReceipt,
    directoryReceipt,
    bootstrap,
    childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      const out: NodeJS.ProcessEnv = {};
      for (const key of Object.keys(env)) {
        const folded = asciiCaseFold(key);
        if (HANDOFF_KEY_FOLDS.has(folded) || folded === ENROLL_FOLD) continue;
        out[key] = env[key];
      }
      out[DATA_DIR_ENV] = directory;
      out[STATE_DIR_ENV] = stateDirectoryPath;
      out[WINDOWS_RESTORE_HANDOFF_ENV[0]] = handoffReceipt.identity.path;
      out[WINDOWS_RESTORE_HANDOFF_ENV[1]] = handoffReceipt.identity.fileId;
      out[WINDOWS_RESTORE_HANDOFF_ENV[2]] = handoffReceipt.identity.volumeId;
      out[WINDOWS_RESTORE_HANDOFF_ENV[3]] = handoffReceipt.identity.sha256;
      out[WINDOWS_RESTORE_HANDOFF_ENV[4]] = String(
        handoffReceipt.identity.bytes,
      );
      out[WINDOWS_RESTORE_HANDOFF_ENV[5]] =
        `${rootIdentity.fileId}:${rootIdentity.volumeId}`;
      return out;
    },
    assertCurrent(): void {
      if (closed) fail("close", "WINDOWS_RESTORE_CLOSED");
      heldNow();
    },
    close(): void {
      if (closed) return;
      closed = true;
      // Once-only known close of the parent's raw guards; never SQL.
      closeOwnedLeases(owner, undefined, false);
      reservations.producerOwners.delete(owner);
    },
  });
  return launch;
}

/* ------------------------------------------------------------------ */
/* consumer                                                           */
/* ------------------------------------------------------------------ */

function envValue(
  env: NodeJS.ProcessEnv,
  folded: string,
): { key: string; value: string } | undefined {
  for (const key of Object.keys(env)) {
    if (asciiCaseFold(key) !== folded) continue;
    const value = env[key];
    if (typeof value === "string" && value.length > 0)
      return { key, value };
    return undefined;
  }
  return undefined;
}

function readAttempt(
  deps: HandoffDeps,
  reservations: Reservations,
  config: WindowsOperatorConfig,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  owner: Owner,
  scope: ProofScope,
): WindowsRestoreHandoff {
  const cfg = validateConfig(config, "env");
  const directory = canonicalPath(dataDir, "env");

  const scalars: string[] = [];
  try {
    const keys: string[] = [];
    for (const name of WINDOWS_RESTORE_HANDOFF_ENV) {
      const found = envValue(env, asciiCaseFold(name));
      if (found === undefined)
        fail("env", "WINDOWS_RESTORE_HANDOFF_ENV_INCOMPLETE");
      keys.push(found.key);
      scalars.push(found.value);
    }
    const [handoffPath, fileId, volumeId, sha256, bytesText, rootId] = scalars;
    const path = canonicalPath(handoffPath, "env");
    if (!under(path, cfg.root) || win32.dirname(path) !== cfg.root)
      fail("env", "WINDOWS_RESTORE_HANDOFF_PATH");
    const name = path.slice(cfg.root.length + 1);
    const match = /^\.folio-restore-([0-9a-f]{32})\.handoff\.json$/.exec(name);
    if (!match) fail("env", "WINDOWS_RESTORE_HANDOFF_PATH");
    const nonce = match[1];
    const rootIds = /^([0-9a-fA-F]{32}):([0-9a-fA-F]{16})$/.exec(rootId);
    if (!rootIds) fail("env", "WINDOWS_RESTORE_ROOT_ID");
    const expectedRoot: WindowsRuntimeRootIdentity = Object.freeze({
      rootFileId: rootIds[1],
      volumeId: rootIds[2],
    });
    const expectedFile: PayloadFile = deepFreeze({
      path,
      fileId: hexText(fileId, FILE_ID_PATTERN, "env"),
      volumeId: hexText(volumeId, VOLUME_ID_PATTERN, "env"),
      bytes: boundedInt(
        /^[0-9]+$/.test(bytesText) ? Number(bytesText) : -1,
        0,
        HANDOFF_MAX_BYTES,
        "env",
      ),
      sha256: hexText(sha256, HASH_PATTERN, "env"),
    });

    const bound = scope.bound;

    // Real read-only guard: the bound root proof is the current check.
    const rootRuntime = bound(
      cfg.root,
      cfg.root,
      WORKSPACE_DATABASE,
      expectedRoot,
    );
    const current = (): void => {
      rootRuntime.assertRoot();
    };

    // Raw C acquirers pinned to the published identities. identityFor returns
    // the payload's expected ids; the helper reply is compared against them
    // by the acquirer itself, so a replaced file can never be held silently.
    const dataAcquirer = deps.authorityLeases({
      root: cfg.root,
      probeExecutable: cfg.probeExecutable,
      expectedHash: cfg.expectedHash,
      systemRoot: cfg.systemRoot,
      expectedRoot,
      identityFor() {
        fail("lease", "WINDOWS_RESTORE_LEASE_UNUSED");
      },
    });
    const directoryIdentityFor =
      (runtimeRoot: string, root_: WindowsRuntimeRootIdentity) =>
      (path: string) => {
        const parent = bound(runtimeRoot, path, BOOTSTRAP_BASENAME, root_);
        try {
          const dir = parent.validatedDirectoryIdentity();
          return { fileId: dir.directoryFileId, volumeId: dir.directoryVolumeId };
        } finally {
          try {
            parent.close();
          } finally {
            scope.release(parent);
          }
        }
      };
    const readOnly = deps.privateFilesystem({
      root: cfg.root,
      probeExecutable: cfg.probeExecutable,
      expectedHash: cfg.expectedHash,
      systemRoot: cfg.systemRoot,
      expectedRoot,
      authority: readOnlyAuthority(current),
      directoryIdentity: directoryIdentityFor(cfg.root, expectedRoot),
      createDirectory() {
        return fail("authority", "WINDOWS_RESTORE_READ_ONLY_AUTHORITY");
      },
      acquireSqliteLease: dataAcquirer,
      assertCurrent: current,
    });

    const observedFile = readOnly.inspectFile(path, HANDOFF_MAX_BYTES);
    if (!sameFile(observedFile, expectedFile))
      fail("handoff", "WINDOWS_RESTORE_HANDOFF_FILE_CHANGED");
    const payload = parseHandoffPayload(
      readCanonicalPayload(
        readOnly.read(path, observedFile, HANDOFF_MAX_BYTES),
        "handoff",
      ),
      "handoff",
    );
    if (payload.nonce !== nonce)
      fail("handoff", "WINDOWS_RESTORE_NONCE_MISMATCH");

    // Child env config fields are pinned: helper/root/stateRoot/hash/systemRoot
    // equal the ORIGINAL captured config; the child's actual stateDirectory
    // override is proven through the payload identity, never the env alone.
    const captured = payload.configuration;
    if (
      fold(cfg.root) !== fold(captured.root) ||
      fold(cfg.probeExecutable) !== fold(captured.probeExecutable) ||
      cfg.expectedHash !== captured.expectedHash ||
      fold(cfg.systemRoot) !== fold(captured.systemRoot) ||
      fold(cfg.publicationStateRoot) !== fold(captured.publicationStateRoot)
    )
      fail("handoff", "WINDOWS_RESTORE_CONFIG_CHANGED");
    if (
      fold(cfg.publicationStateDirectory) !== fold(payload.stateDirectory.path)
    )
      fail("handoff", "WINDOWS_RESTORE_STATE_DIRECTORY");
    if (fold(directory) !== fold(payload.directory.path))
      fail("handoff", "WINDOWS_RESTORE_DIRECTORY");
    if (overlaps(payload.stateDirectory.path, captured.publicationStateDirectory))
      fail("handoff", "WINDOWS_RESTORE_STATE_LAYOUT");
    if (
      !under(payload.stateDirectory.path, captured.publicationStateRoot) ||
      !under(payload.directory.path, captured.root) ||
      !under(payload.current.directory, captured.root) ||
      overlaps(payload.directory.path, payload.current.directory) ||
      fold(payload.tree.path) !== fold(payload.directory.path) ||
      fold(payload.current.identity.path) !== fold(payload.current.directory) ||
      fold(payload.database.path) !==
        fold(win32.join(payload.directory.path, WORKSPACE_DATABASE))
    )
      fail("handoff", "WINDOWS_RESTORE_LAYOUT");

    // Immutable intent readback and binding to this exact launch.
    const intentExpected = payload.intent.identity;
    const intentName = `${INTENT_PREFIX}${nonce}.intent.json`;
    const intentPath = win32.join(captured.root, intentName);
    if (fold(intentExpected.path) !== fold(intentPath))
      fail("intent", "WINDOWS_RESTORE_INTENT_PATH");
    const observedIntent = readOnly.inspectFile(intentPath, HANDOFF_MAX_BYTES);
    if (!sameFile(observedIntent, intentExpected))
      fail("intent", "WINDOWS_RESTORE_INTENT_CHANGED");
    const intent = parseIntentPayload(
      readCanonicalPayload(
        readOnly.read(intentPath, observedIntent, HANDOFF_MAX_BYTES),
        "intent",
      ),
      "intent",
    );
    if (
      intent.nonce !== nonce ||
      fold(intent.plannedStateDirectory) !==
        fold(payload.stateDirectory.path) ||
      fold(intent.plannedBootstrap) !== fold(payload.bootstrap.path) ||
      !sameId(intent.root, payload.root) ||
      !sameId(intent.stateRoot, payload.stateRoot) ||
      !sameId(intent.directory, payload.directory) ||
      !sameId(intent.current.identity, payload.current.identity) ||
      intent.current.workspaceId !== payload.current.workspaceId ||
      fold(intent.current.directory) !== fold(payload.current.directory) ||
      !sameFile(intent.database, payload.database) ||
      !sameTree(intent.tree, payload.tree) ||
      intent.verifiedFingerprint !== payload.verifiedFingerprint
    )
      fail("intent", "WINDOWS_RESTORE_INTENT_MISMATCH");
    compareConfig(intent.configuration, captured, "intent");

    // Receipt identity binding for the new state directory.
    const receipt = payload.directoryReceipt;
    if (
      receipt.state !== "CREATED" ||
      fold(receipt.path) !== fold(payload.stateDirectory.path) ||
      fold(receipt.identity.canonicalPath) !==
        fold(payload.stateDirectory.path) ||
      asciiCaseFold(receipt.identity.directoryFileId) !==
        asciiCaseFold(payload.stateDirectory.fileId) ||
      asciiCaseFold(receipt.identity.directoryVolumeId) !==
        asciiCaseFold(payload.stateDirectory.volumeId) ||
      asciiCaseFold(receipt.identity.rootFileId) !==
        asciiCaseFold(payload.stateRoot.fileId) ||
      asciiCaseFold(receipt.identity.rootVolumeId) !==
        asciiCaseFold(payload.stateRoot.volumeId)
    )
      fail("state", "WINDOWS_RESTORE_STATE_RECEIPT");
    if (
      payload.bootstrap.bytes !== 0 ||
      payload.bootstrap.sha256 !== EMPTY_SHA256 ||
      fold(payload.bootstrap.path) !==
        fold(
          win32.join(payload.stateDirectory.path, BOOTSTRAP_BASENAME),
        )
    )
      fail("state", "WINDOWS_RESTORE_BOOTSTRAP");

    // Root proof must equal the env-pinned root.
    const rootProof = rootRuntime.validatedDirectoryIdentity();
    if (
      asciiCaseFold(rootProof.rootFileId) !==
        asciiCaseFold(payload.root.fileId) ||
      asciiCaseFold(rootProof.rootVolumeId) !==
        asciiCaseFold(payload.root.volumeId) ||
      asciiCaseFold(rootProof.rootFileId) !==
        asciiCaseFold(expectedRoot.rootFileId) ||
      asciiCaseFold(rootProof.rootVolumeId) !==
        asciiCaseFold(expectedRoot.volumeId)
    )
      fail("proof", "WINDOWS_RESTORE_ROOT_CHANGED");

    const stateExpectedRoot: WindowsRuntimeRootIdentity = Object.freeze({
      rootFileId: payload.stateRoot.fileId,
      volumeId: payload.stateRoot.volumeId,
    });
    const dataRuntime = bound(
      cfg.root,
      directory,
      WORKSPACE_DATABASE,
      expectedRoot,
      {
        fileId: payload.directory.fileId,
        volumeId: payload.directory.volumeId,
      },
    );
    const dirProof = dataRuntime.validatedDirectoryIdentity();
    if (
      asciiCaseFold(dirProof.directoryFileId) !==
        asciiCaseFold(payload.directory.fileId) ||
      asciiCaseFold(dirProof.directoryVolumeId) !==
        asciiCaseFold(payload.directory.volumeId)
    )
      fail("proof", "WINDOWS_RESTORE_DIRECTORY_CHANGED");
    const databasePath = win32.join(directory, WORKSPACE_DATABASE);
    const databaseProof = dataRuntime.validatedFileIdentity(databasePath);
    if (
      asciiCaseFold(databaseProof.fileId) !==
        asciiCaseFold(payload.database.fileId) ||
      asciiCaseFold(databaseProof.volumeId) !==
        asciiCaseFold(payload.database.volumeId) ||
      fold(databaseProof.canonicalPath) !== fold(payload.database.path)
    )
      fail("proof", "WINDOWS_RESTORE_DATABASE_CHANGED");
    if (typeof readOnly.inspectTree !== "function")
      fail("proof", "WINDOWS_RESTORE_TREE_UNAVAILABLE");
    const treeProof = readOnly.inspectTree(directory);
    if (!sameTree(treeProof, payload.tree))
      fail("proof", "WINDOWS_RESTORE_TREE_CHANGED");

    const currentRuntime = bound(
      cfg.root,
      payload.current.directory,
      WORKSPACE_DATABASE,
      expectedRoot,
      {
        fileId: payload.current.identity.fileId,
        volumeId: payload.current.identity.volumeId,
      },
    );
    const currentProof = currentRuntime.validatedDirectoryIdentity();
    if (
      asciiCaseFold(currentProof.directoryFileId) !==
        asciiCaseFold(payload.current.identity.fileId) ||
      asciiCaseFold(currentProof.directoryVolumeId) !==
        asciiCaseFold(payload.current.identity.volumeId)
    )
      fail("proof", "WINDOWS_RESTORE_CURRENT_CHANGED");

    const stateRuntime = bound(
      captured.publicationStateRoot,
      payload.stateDirectory.path,
      BOOTSTRAP_BASENAME,
      stateExpectedRoot,
      {
        fileId: payload.stateDirectory.fileId,
        volumeId: payload.stateDirectory.volumeId,
      },
    );
    const stateProof = stateRuntime.validatedDirectoryIdentity();
    if (
      asciiCaseFold(stateProof.directoryFileId) !==
        asciiCaseFold(payload.stateDirectory.fileId) ||
      asciiCaseFold(stateProof.directoryVolumeId) !==
        asciiCaseFold(payload.stateDirectory.volumeId) ||
      asciiCaseFold(stateProof.rootFileId) !==
        asciiCaseFold(payload.stateRoot.fileId)
    )
      fail("proof", "WINDOWS_RESTORE_STATE_CHANGED");
    const bootstrapProof = stateRuntime.validatedFileIdentity(
      payload.bootstrap.path,
    );
    if (
      asciiCaseFold(bootstrapProof.fileId) !==
        asciiCaseFold(payload.bootstrap.fileId) ||
      asciiCaseFold(bootstrapProof.volumeId) !==
        asciiCaseFold(payload.bootstrap.volumeId)
    )
      fail("proof", "WINDOWS_RESTORE_BOOTSTRAP");
    stateRuntime.assertEmptyFile(payload.bootstrap.path);

    // Current SID proof via the pinned read-only helper, bound to root ids.
    const sidEvidence = deps.probeEvidence(config, cfg.root, cfg.root);
    if (
      sidEvidence.sid !== payload.sid ||
      asciiCaseFold(sidEvidence.rootFileId) !==
        asciiCaseFold(expectedRoot.rootFileId) ||
      asciiCaseFold(sidEvidence.rootVolumeId) !==
        asciiCaseFold(expectedRoot.volumeId)
    )
      fail("proof", "WINDOWS_RESTORE_SID_CHANGED");

    // --- raw C leases BEFORE returning: data then state bootstrap ---
    const pinnedData = deps.authorityLeases({
      root: cfg.root,
      probeExecutable: cfg.probeExecutable,
      expectedHash: cfg.expectedHash,
      systemRoot: cfg.systemRoot,
      expectedRoot,
      identityFor(path) {
        if (fold(path) !== fold(databasePath))
          fail("lease", "WINDOWS_RESTORE_LEASE_PATH");
        const dir = dataRuntime.validatedDirectoryIdentity();
        const file = dataRuntime.validatedFileIdentity(databasePath);
        return {
          directoryFileId: dir.directoryFileId,
          directoryVolumeId: dir.directoryVolumeId,
          fileId: file.fileId,
          volumeId: file.volumeId,
        };
      },
    });
    const stateAcquirer = deps.authorityLeases({
      root: captured.publicationStateRoot,
      probeExecutable: cfg.probeExecutable,
      expectedHash: cfg.expectedHash,
      systemRoot: cfg.systemRoot,
      expectedRoot: stateExpectedRoot,
      identityFor(path) {
        if (fold(path) !== fold(payload.bootstrap.path))
          fail("lease", "WINDOWS_RESTORE_LEASE_PATH");
        const dir = stateRuntime.validatedDirectoryIdentity();
        const file = stateRuntime.validatedFileIdentity(payload.bootstrap.path);
        return {
          directoryFileId: dir.directoryFileId,
          directoryVolumeId: dir.directoryVolumeId,
          fileId: file.fileId,
          volumeId: file.volumeId,
        };
      },
    });
    const dataLease = ownLease(owner, pinnedData(databasePath));
    assertLeaseHeld(dataLease);
    const stateLease = ownLease(owner, stateAcquirer(payload.bootstrap.path));
    assertLeaseHeld(stateLease);

    // Repeat the identity comparisons under holds; the tree can legitimately
    // change AFTER enrollment, so these checks only run before return.
    rootRuntime.assertRoot();
    const dirHeld = dataRuntime.validatedDirectoryIdentity();
    if (
      asciiCaseFold(dirHeld.directoryFileId) !==
        asciiCaseFold(payload.directory.fileId) ||
      asciiCaseFold(dirHeld.directoryVolumeId) !==
        asciiCaseFold(payload.directory.volumeId)
    )
      fail("proof", "WINDOWS_RESTORE_DIRECTORY_CHANGED");
    const dbHeld = dataRuntime.validatedFileIdentity(databasePath);
    if (
      asciiCaseFold(dbHeld.fileId) !== asciiCaseFold(payload.database.fileId) ||
      asciiCaseFold(dbHeld.volumeId) !==
        asciiCaseFold(payload.database.volumeId)
    )
      fail("proof", "WINDOWS_RESTORE_DATABASE_CHANGED");
    const treeHeld = readOnly.inspectTree(directory);
    if (!sameTree(treeHeld, payload.tree))
      fail("proof", "WINDOWS_RESTORE_TREE_CHANGED");
    const stateHeld = stateRuntime.validatedDirectoryIdentity();
    const bootHeld = stateRuntime.validatedFileIdentity(payload.bootstrap.path);
    if (
      asciiCaseFold(stateHeld.directoryFileId) !==
        asciiCaseFold(payload.stateDirectory.fileId) ||
      asciiCaseFold(bootHeld.fileId) !==
        asciiCaseFold(payload.bootstrap.fileId)
    )
      fail("proof", "WINDOWS_RESTORE_STATE_CHANGED");

    scope.closeAll();

    let phase: "validated" | "state" | "workspace" | "done" = "validated";
    const held = (): void => {
      for (const lease of owner.leases) assertLeaseHeld(lease);
    };
    const handoff: WindowsRestoreHandoff = Object.freeze({
      config: deepFreeze({ ...cfg }) as WindowsOperatorConfig,
      initialEnrollment: true,
      directory,
      verifiedFingerprint: payload.verifiedFingerprint,
      assertHeld(): void {
        held();
      },
      stateReady(product) {
        if (phase !== "validated")
          fail("state", "WINDOWS_RESTORE_STATE_ORDER");
        if (
          product === null ||
          typeof product !== "object" ||
          typeof product.assertRoot !== "function" ||
          typeof product.privateFilesystem !== "object" ||
          product.privateFilesystem === null
        )
          fail("state", "WINDOWS_RESTORE_PRODUCT");
        held();
        // The product's own root fence, THEN the inspectDirectory that
        // triggers the source-binding SQLite/C owner bootstrap.
        product.assertRoot();
        const observed = product.privateFilesystem.inspectDirectory(directory);
        if (!sameId(observed, payload.directory))
          fail("state", "WINDOWS_RESTORE_DIRECTORY_CHANGED");
        held();
        // Release ONLY the state bootstrap guard after the S-binding
        // owner exists; a failed close retains the whole graph.
        try {
          stateLease.close();
        } catch (cleanup) {
          handoff.retainFailure(cleanup);
        }
        owner.leases.splice(owner.leases.indexOf(stateLease), 1);
        phase = "state";
      },
      workspaceReady(primary) {
        if (phase !== "state")
          fail("workspace", "WINDOWS_RESTORE_STATE_ORDER");
        if (!(primary instanceof Store))
          fail("workspace", "WINDOWS_RESTORE_PRIMARY");
        owner.primarySeen = true;
        let primaryError: unknown;
        let primaryErrorSeen = false;
        try {
          if (fold(primary.path) !== fold(payload.database.path)) fail("workspace", "WINDOWS_RESTORE_PRIMARY_PATH");
          primary.assertNativeStartupLease();
        } catch (error) {
          primaryError = error;
          primaryErrorSeen = true;
          throw error;
        } finally {
          if (primaryErrorSeen)
            handoff.retainFailure(primaryError);
        }
        held();
        try {
          dataLease.close();
        } catch (cleanup) {
          handoff.retainFailure(cleanup);
        }
        owner.leases.splice(owner.leases.indexOf(dataLease), 1);
        phase = "done";
        reservations.consumerOwners.delete(owner);
      },
      retainFailure(error: unknown): never {
        retainStartupProtector(
          compositeLease(owner.leases),
          [error],
          undefined,
          owner,
        );
      },
    });
    return handoff;
  } finally {
    // Consume the handoff env locally whether validation succeeded or not.
    for (const key of Object.keys(env))
      if (HANDOFF_KEY_FOLDS.has(asciiCaseFold(key))) delete env[key];
  }
}

/* ------------------------------------------------------------------ */
/* factory                                                            */
/* ------------------------------------------------------------------ */

function implementation(deps: HandoffDeps, reservations: Reservations) {
  const prepare = (
    config: WindowsOperatorConfig,
    request: WindowsRestoreLaunchRequest,
  ): WindowsRestoredWorkspaceLaunch => {
    if (deps.label === "native" && process.platform !== "win32")
      fail("platform", "WINDOWS_RESTORE_UNSUPPORTED_PLATFORM");
    const ticket =
      typeof request === "object" && request !== null
        ? request.ticket
        : undefined;
    if (typeof ticket !== "string" || !TICKET_PATTERN.test(ticket))
      fail("reserve", "WINDOWS_RESTORE_TICKET");
    reserveTicket(reservations, ticket);
    const owner = reserveOwner(reservations.producerOwners);
    const dispatched = { value: false };
    let scope: ProofScope | undefined;
    try {
      scope = makeProofScope(deps, validateConfig(config, "validate"));
      const launch = prepareAttempt(
        deps, reservations, config, request, owner, scope, dispatched);
      reservations.tickets.set(ticket, { kind: "success", launch });
      return launch;
    } catch (error) {
      try {
        scope?.closeAll();
      } catch (cleanup) {
        error = new AggregateError([error, cleanup], "proof cleanup failed");
      }
      // Post-dispatch: a local REJECTED is never proof of non-application;
      // a typed K verdict (REJECTED/EXISTS/UNKNOWN) is preserved exactly.
      let typed: unknown;
      if (error instanceof WindowsRestoreHandoffError) {
        typed = dispatched.value && error.state === "REJECTED"
          ? new WindowsRestoreHandoffError("UNKNOWN", error.phase,
              error.message, { cause: error })
          : error;
      } else {
        const st = (error as { state?: unknown }).state;
        const state = dispatched.value
          ? st === "REJECTED" || st === "EXISTS" ? st : "UNKNOWN"
          : st === "REJECTED" || st === "EXISTS" || st === "UNKNOWN"
            ? st
            : "REJECTED";
        typed = new WindowsRestoreHandoffError(state, "attempt",
          "WINDOWS_RESTORE_ATTEMPT", { cause: error });
      }
      // Known-close attempt for acquired raw guards; an uncertain close is
      // retained as the branded startup protector graph.
      try {
        closeOwnedLeases(owner, error, true);
      } catch (retained) {
        reservations.tickets.set(ticket, { kind: "failure", error: retained });
        throw retained;
      }
      // Every acquired raw guard closed cleanly: known-unopened cleanup
      // releases the strong reservation.
      reservations.producerOwners.delete(owner);
      reservations.tickets.set(ticket, { kind: "failure", error: typed });
      throw typed;
    }
  };

  const read = (
    config: WindowsOperatorConfig,
    dataDir: string,
    env: NodeJS.ProcessEnv,
  ): WindowsRestoreHandoff | undefined => {
    if (deps.label === "native" && process.platform !== "win32")
      fail("platform", "WINDOWS_RESTORE_UNSUPPORTED_PLATFORM");
    const any = Object.keys(env).some((key) =>
      HANDOFF_KEY_FOLDS.has(asciiCaseFold(key)),
    );
    if (!any) return undefined;
    try {
      const owner = reserveOwner(reservations.consumerOwners);
      let scope: ProofScope | undefined;
      try {
        scope = makeProofScope(deps, validateConfig(config, "env"));
        return readAttempt(
          deps, reservations, config, dataDir, env, owner, scope);
      } catch (error) {
        try {
          scope?.closeAll();
        } catch (cleanup) {
          error = new AggregateError([error, cleanup], "proof cleanup failed");
        }
        try {
          closeOwnedLeases(owner, error, true);
        } catch (retained) {
          throw retained;
        }
        reservations.consumerOwners.delete(owner);
        if (error instanceof WindowsRestoreHandoffError) throw error;
        throw new WindowsRestoreHandoffError("REJECTED", "read",
          "WINDOWS_RESTORE_REJECTED", { cause: error });
      }
    } finally {
      // The handoff env is consumed locally on every outcome, even invalid;
      // other variables (including the parent ENROLL flag) are untouched.
      stripWindowsRestoreHandoffEnvironment(env);
    }
  };
  return { prepare, read };
}

const productionReservations: Reservations = {
  tickets: new Map(),
  producerOwners: new Set(),
  consumerOwners: new Set(),
};
const production = implementation(nativeDeps, productionReservations);

export function prepareWindowsRestoredWorkspaceLaunch(
  config: WindowsOperatorConfig,
  request: WindowsRestoreLaunchRequest,
): WindowsRestoredWorkspaceLaunch {
  return production.prepare(config, request);
}

export function readWindowsRestoreHandoff(
  config: WindowsOperatorConfig,
  dataDir: string,
  env: NodeJS.ProcessEnv,
): WindowsRestoreHandoff | undefined {
  return production.read(config, dataDir, env);
}

/** Deletes ONLY the six handoff keys (case-insensitive on Windows); the
 * parent's FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES flag is never touched. */
export function stripWindowsRestoreHandoffEnvironment(
  env: NodeJS.ProcessEnv,
): void {
  for (const key of Object.keys(env))
    if (HANDOFF_KEY_FOLDS.has(asciiCaseFold(key))) delete env[key];
}

/* ------------------------------------------------------------------ */
/* untrusted off-host test seam                                       */
/* ------------------------------------------------------------------ */

export type WindowsRestoreHandoffTestDeps = Readonly<{
  runtime(options: WindowsRuntimePlatformOptions): WindowsRuntimePlatform;
  privateFilesystem(
    options: WindowsPrivatePersistenceOptions,
  ): NativePrivateFilesystemPort;
  authorityLeases(
    options: NativeAuthorityLeaseOptions,
  ): AcquirePrivateAuthorityLease;
  probeEvidence(
    config: WindowsOperatorConfig,
    path: string,
    root: string,
  ): WindowsProbeEvidence;
  nonce(): string;
}>;

/**
 * Off-host contract seam only. Forbidden on a real win32 host: injected
 * transports are explicitly untrusted and never native Windows proof or OS
 * acceptance. Every injected raw lease must carry trust "untrusted-test".
 */
export function createWindowsRestoreHandoffForTesting(
  deps: WindowsRestoreHandoffTestDeps,
): {
  prepareWindowsRestoredWorkspaceLaunch: typeof prepareWindowsRestoredWorkspaceLaunch;
  readWindowsRestoreHandoff: typeof readWindowsRestoreHandoff;
} {
  if (process.platform === "win32") fail("platform", "TEST_DEPS_FORBIDDEN");
  if (typeof deps !== "object" || deps === null || Array.isArray(deps))
    fail("platform", "TEST_DEPS_FORBIDDEN");
  for (const name of [
    "runtime",
    "privateFilesystem",
    "authorityLeases",
    "probeEvidence",
    "nonce",
  ] as const)
    syncFunction(deps[name], "platform");
  const wrappedAcquire: HandoffDeps["authorityLeases"] = (options) => {
    const acquire = deps.authorityLeases(options);
    syncFunction(acquire, "platform");
    return (path) => {
      const lease = acquire(path);
      if (
        lease === null ||
        typeof lease !== "object" ||
        lease.trust !== "untrusted-test"
      )
        fail("lease", "WINDOWS_RESTORE_TEST_TRUST");
      return lease;
    };
  };
  const isolated: Reservations = {
    tickets: new Map(),
    producerOwners: new Set(),
    consumerOwners: new Set(),
  };
  const impl = implementation(
    Object.freeze({
      label: "untrusted-test",
      runtime: deps.runtime,
      privateFilesystem: deps.privateFilesystem,
      authorityLeases: wrappedAcquire,
      probeEvidence: deps.probeEvidence,
      nonce: deps.nonce,
    }),
    isolated,
  );
  return {prepareWindowsRestoredWorkspaceLaunch: impl.prepare, readWindowsRestoreHandoff: impl.read};
}
