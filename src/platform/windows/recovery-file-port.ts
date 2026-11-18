import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import { CollaborationError } from "../../collaboration/runtime/contract";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";
import type {
  WindowsRuntimeDirectoryIdentity,
  WindowsRuntimeFileIdentity,
} from "./runtime-platform";
import { recoveryHeadPublication, type RecoveryHeadRead, type WindowsRecoveryArchive } from "./recovery-archive";
import {
  WINDOWS_RECOVERY_MAX_BYTES,
  observeWindowsRecoveryPublishNew,
  type WindowsRecoveryIo,
  type WindowsRecoveryIoFailure,
  type WindowsRecoveryPublishDispatch,
} from "./private-recovery-io";
import { PrivateFilePublicationUnknownError } from "../private-file-port";
import {
  consumePrivateMutationChannel,
  createPrivateMutationChannel,
  enterPrivateMutationChannel,
  getCheckpointCapacityRefusal,
  getCheckpointGenerationConflict,
  getRecoveryIoFailureCause,
  propagateRecoveryIoFailure,
  recordCheckpointPortPreconditionConflict,
  recordCheckpointPostPublicationUnknown,
  recordCheckpointPriorPending,
  sealPrivateMutationChannel,
  type CheckpointCapacityRefusal,
  type CheckpointGenerationConflict,
  type PrivateMutationChannel,
  type PrivateMutationEntry,
} from "../private-mutation-diagnostic";

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_RECOVERY_PORT_${code}`);
}

function guardPortConflict(
  expectedGeneration: number,
  observedGeneration: number,
  mismatch: "GENERATION" | "HEAD_TOKEN_OR_BYTES",
  entryState?: RecoveryPortObservationEntryState,
): never {
  const error = new CollaborationError("WINDOWS_RECOVERY_PORT_CONFLICT");
  recordCheckpointPortPreconditionConflict(error, expectedGeneration, observedGeneration, mismatch);
  if (entryState !== undefined) {
    entryState.generationConflict = getCheckpointGenerationConflict(error);
  }
  throw error;
}

export type CrashRecoveryNativeRead = Readonly<{
  generation: number;
  token: string;
  bytes: Uint8Array;
}>;

export interface CrashRecoveryNativePort {
  readonly contractVersion: 3;
  readonly platform: "win32";
  read(path: string, workspaceId: string): CrashRecoveryNativeRead | undefined;
  compareAndSwap(request: {
    path: string;
    workspaceId: string;
    expected: CrashRecoveryNativeRead | undefined;
    generation: number;
    bytes: Uint8Array;
  }): CrashRecoveryNativeRead;
}

export type WindowsRecoveryFilePortOptions = Readonly<{
  archive: WindowsRecoveryArchive;
  io: WindowsRecoveryIo;
  /** Synchronous revalidation of the current authority/binding/session,
   * invoked before every archive read, immediately before native dispatch
   * AND inside the SQLite pointer CAS transaction. A defined return value
   * (or thenable) is invalid. */
  assertCurrent(): void;
  /** Pinned parent-directory identity for a physical parent path. Must be
   * synchronous and return the CURRENT native identity — never a stale pin. */
  parentIdentityFor(parentPath: string): WindowsRuntimeDirectoryIdentity;
  /** Synchronous native proof that no file exists at the logical path itself
   * (the pre-CAS legacy location). Caller-provided native evidence only —
   * never an fs.existsSync substitute. Called before the first-generation
   * dispatch and inside the CAS transaction when expected is empty. */
  assertLegacyAbsent(logicalPath: string, workspaceId: string): void;
}>;

declare const recoveryPortObservationHandleBrand: unique symbol;

export type RecoveryPortObservationHandle = Readonly<{
  readonly [recoveryPortObservationHandleBrand]: never;
}>;

export type RecoveryPortPublication = Readonly<{
  attemptId: string;
  stage: "HEAD_CAS" | "READBACK";
  sourceOutcome: Readonly<{
    source: "RECOVERY_IO";
    contractVersion: 3;
    state: "PUBLISHED";
    reason: null;
  }>;
}>;

export type RecoveryPortNonPublishedSourceOutcome = Readonly<{
  source: "RECOVERY_IO";
  contractVersion: 3;
  state: "REJECTED" | "EXISTS" | "UNKNOWN";
  reason: string;
}>;

export type RecoveryPortRecoveryIoFailure = Readonly<{
  attemptId: string;
  dispatch?: WindowsRecoveryPublishDispatch;
  sourceOutcome?: RecoveryPortNonPublishedSourceOutcome;
  capacityRefusal?: CheckpointCapacityRefusal;
}>;

type RecoveryPortObservationEntryState = {
  entry?: PrivateMutationEntry;
  publication?: RecoveryPortPublication;
  generationConflict?: CheckpointGenerationConflict;
  recoveryIoFailure?: RecoveryPortRecoveryIoFailure;
};

type RecoveryPortObservationRecord = {
  entered: boolean;
  invalid: boolean;
};

type RecoveryPortObservationFrame = Readonly<{
  port: object;
  request: object;
  channel: PrivateMutationChannel;
  record: RecoveryPortObservationRecord;
  entryState: RecoveryPortObservationEntryState;
}>;

type RecoveryPortObservationRequestSlot = Readonly<{
  record: RecoveryPortObservationRecord;
  frame?: RecoveryPortObservationFrame;
}>;

export type RecoveryPortObservationResult =
  | Readonly<{ matched: false }>
  | Readonly<{
      matched: true;
      terminal: "THREW" | "RETURNED";
      publication?: RecoveryPortPublication;
      generationConflict?: CheckpointGenerationConflict;
      recoveryIoFailure?: RecoveryPortRecoveryIoFailure;
    }>;

const privateRecoveryObservationUnmatched: RecoveryPortObservationResult = Object.freeze({
  matched: false as const,
});

const privateRecoveryPublishedSourceOutcome: RecoveryPortPublication["sourceOutcome"] = Object.freeze({
  source: "RECOVERY_IO",
  contractVersion: 3,
  state: "PUBLISHED",
  reason: null,
});

const privateRecoveryFactoryPorts = new WeakSet<object>();
const privateRecoveryObservationFrames = new WeakMap<object, RecoveryPortObservationFrame | true>();
const privateRecoveryObservationRequestSlots = new WeakMap<object, RecoveryPortObservationRequestSlot>();

function isRecoveryPortObservationWeakKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function isRegisteredRecoveryFilePort(port: unknown): port is CrashRecoveryNativePort {
  return isRecoveryPortObservationWeakKey(port) && privateRecoveryFactoryPorts.has(port);
}

export function armRecoveryPortObservation(
  port: unknown,
  request: unknown,
): RecoveryPortObservationHandle | undefined {
  if (!isRecoveryPortObservationWeakKey(port) || !isRecoveryPortObservationWeakKey(request)) {
    return undefined;
  }
  if (!privateRecoveryFactoryPorts.has(port)) return undefined;

  const previous = privateRecoveryObservationRequestSlots.get(request);
  if (previous !== undefined) {
    previous.record.invalid = true;
    return undefined;
  }

  const record: RecoveryPortObservationRecord = { entered: false, invalid: false };
  const channel = createPrivateMutationChannel();
  const frame: RecoveryPortObservationFrame = Object.freeze({
    port,
    request,
    channel,
    record,
    entryState: {},
  });
  const handle = Object.freeze({}) as RecoveryPortObservationHandle;
  privateRecoveryObservationFrames.set(handle, frame);
  privateRecoveryObservationRequestSlots.set(request, { record, frame });
  return handle;
}

export function consumeRecoveryPortObservation(
  handle: unknown,
  tag: unknown,
  value: unknown,
): RecoveryPortObservationResult {
  if (!isRecoveryPortObservationWeakKey(handle)) {
    return privateRecoveryObservationUnmatched;
  }
  const current = privateRecoveryObservationFrames.get(handle);
  if (current === undefined || current === true) {
    return privateRecoveryObservationUnmatched;
  }

  privateRecoveryObservationFrames.set(handle, true);

  const frame = current;
  const record = frame.record;
  const entryState = frame.entryState;
  const expectedEntry = entryState.entry;

  if (!record.invalid && record.entered && expectedEntry !== undefined) {
    const matchedEntry = consumePrivateMutationChannel(frame.channel, tag, value);
    const publication = entryState.publication;
    const generationConflict = entryState.generationConflict;
    const recoveryIoFailure = entryState.recoveryIoFailure;
    entryState.entry = undefined;
    entryState.publication = undefined;
    entryState.generationConflict = undefined;
    entryState.recoveryIoFailure = undefined;
    if (
      matchedEntry !== undefined &&
      matchedEntry === expectedEntry &&
      (tag === "THREW" || tag === "RETURNED")
    ) {
      const slot = privateRecoveryObservationRequestSlots.get(frame.request);
      if (slot !== undefined && slot.record === record && slot.frame === frame) {
        privateRecoveryObservationRequestSlots.set(frame.request, { record });
      }
      const result: RecoveryPortObservationResult = {
        matched: true,
        terminal: tag,
        ...(publication !== undefined ? { publication } : {}),
        ...(generationConflict !== undefined ? { generationConflict } : {}),
        ...(recoveryIoFailure !== undefined ? { recoveryIoFailure } : {}),
      };
      return Object.freeze(result);
    }
  } else {
    // Internal metadata cleanup only: this proves no source, dispatch, or authority.
    consumePrivateMutationChannel(frame.channel, undefined, undefined);
    entryState.entry = undefined;
    entryState.publication = undefined;
    entryState.generationConflict = undefined;
    entryState.recoveryIoFailure = undefined;
  }

  record.invalid = true;
  const slot = privateRecoveryObservationRequestSlots.get(frame.request);
  if (slot !== undefined && slot.record === record && slot.frame === frame) {
    privateRecoveryObservationRequestSlots.set(frame.request, { record });
  }
  return privateRecoveryObservationUnmatched;
}

function observeRecoveryPortInvocation(
  port: object,
  request: unknown,
  body: (entryState?: RecoveryPortObservationEntryState) => CrashRecoveryNativeRead,
): CrashRecoveryNativeRead {
  if (!isRecoveryPortObservationWeakKey(request)) {
    return body();
  }

  const slot = privateRecoveryObservationRequestSlots.get(request);
  if (slot === undefined) {
    const record: RecoveryPortObservationRecord = { entered: true, invalid: true };
    privateRecoveryObservationRequestSlots.set(request, { record });
    return body();
  }

  const record = slot.record;
  const frame = slot.frame;
  if (frame === undefined) {
    record.invalid = true;
    return body();
  }

  const eligible =
    !record.entered &&
    !record.invalid &&
    frame.port === port &&
    privateRecoveryFactoryPorts.has(port);
  record.entered = true;

  let entry: PrivateMutationEntry | undefined;
  if (eligible) {
    entry = enterPrivateMutationChannel(frame.channel);
    if (entry === undefined) {
      record.invalid = true;
    } else {
      frame.entryState.entry = entry;
    }
  } else {
    record.invalid = true;
    consumePrivateMutationChannel(frame.channel, undefined, undefined);
  }

  try {
    const result = body(entry === undefined ? undefined : frame.entryState);
    if (entry !== undefined) {
      if (record.invalid) {
        consumePrivateMutationChannel(frame.channel, undefined, undefined);
      } else {
        sealPrivateMutationChannel(frame.channel, entry, "RETURNED", result);
      }
    }
    return result;
  } catch (error) {
    if (entry !== undefined) {
      if (record.invalid) {
        consumePrivateMutationChannel(frame.channel, undefined, undefined);
      } else {
        sealPrivateMutationChannel(frame.channel, entry, "THREW", error);
      }
    }
    throw error;
  } finally {
    const current = privateRecoveryObservationRequestSlots.get(request);
    if (current !== undefined && current.record === record && current.frame === frame) {
      privateRecoveryObservationRequestSlots.set(request, { record });
    }
  }
}

const ATTEMPT = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;

const attemptId = (): string => randomBytes(16).toString("hex");

function isAsyncLike(value: unknown): boolean {
  return typeof value !== "function" || utilTypes.isAsyncFunction(value) || utilTypes.isGeneratorFunction(value);
}

function canonicalPath(value: unknown, code = "PATH"): string {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Z]:\\[\x20-\x7e]*$/.test(value)) fail(code);
  try {
    if (validateWindowsPath(value, `${value[0]}:\\`).canonical !== value) fail(code);
  } catch { fail(code); }
  return value;
}

function parentOf(path: string): string {
  const end = path.lastIndexOf("\\");
  return end === 2 ? path.slice(0, 3) : path.slice(0, end);
}
function childOf(parent: string, name: string): string {
  return `${parent}${parent.endsWith("\\") ? "" : "\\"}${name}`;
}
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("\\") + 1);
}

function checkSync(call: () => unknown): void {
  const outcome: unknown = call();
  if (utilTypes.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
  if (outcome !== undefined) fail("REVALIDATE");
}

function recoveryIoSourceOutcome(
  outcome: WindowsRecoveryIoFailure,
): RecoveryPortNonPublishedSourceOutcome | undefined {
  if (outcome.contractVersion !== 3 ||
      (outcome.state !== "REJECTED" && outcome.state !== "EXISTS" && outcome.state !== "UNKNOWN") ||
      typeof outcome.reason !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(outcome.reason))
    return undefined;
  return Object.freeze({
    source: "RECOVERY_IO",
    contractVersion: 3,
    state: outcome.state,
    reason: outcome.reason,
  });
}

type TerminalEvidence = Readonly<{
  attemptId: string; outcome: string; path: string; sha256: string;
  identity: Readonly<{ canonicalPath: string; fileId: string; volumeId: string }>;
}>;

function terminalEvidence(receipt: string): TerminalEvidence {
  let parsed: unknown;
  try { parsed = JSON.parse(receipt); } catch { fail("RECEIPT"); }
  if (typeof parsed !== "object" || parsed === null) fail("RECEIPT");
  const r = parsed as Record<string, unknown>;
  const evidence = r.evidence;
  if (typeof evidence !== "object" || evidence === null) fail("RECEIPT");
  const e = evidence as Record<string, unknown>;
  const identity = e.identity;
  if (typeof identity !== "object" || identity === null) fail("RECEIPT");
  const id = identity as Record<string, unknown>;
  if (typeof r.attemptId !== "string" || !ATTEMPT.test(r.attemptId) ||
      typeof r.outcome !== "string" ||
      typeof e.path !== "string" || typeof e.sha256 !== "string" || !HASH.test(e.sha256) ||
      typeof id.canonicalPath !== "string" ||
      typeof id.fileId !== "string" || !FILE_ID.test(id.fileId) ||
      typeof id.volumeId !== "string" || !VOLUME_ID.test(id.volumeId))
    fail("RECEIPT");
  return {
    attemptId: r.attemptId, outcome: r.outcome, path: e.path as string, sha256: e.sha256 as string,
    identity: Object.freeze({
      canonicalPath: id.canonicalPath as string,
      fileId: id.fileId as string,
      volumeId: id.volumeId as string,
    }),
  };
}

/**
 * Product typed logical seam: owns the durable archive and the v3 binary IO.
 * A logical crash-recovery path maps to immutable generation files
 * `.<basename>.generation-<random32>.json` in the same private parent; the CAS
 * pointer in the archive names the current one. Nothing is ever overwritten,
 * resent or deleted, including clear-snapshot writes. An unresolved attempt
 * durably blocks new writes for its logical path, including after restart;
 * native PUBLISHED alone never releases that claim.
 */
export function createWindowsRecoveryFilePort(
  options: WindowsRecoveryFilePortOptions,
): CrashRecoveryNativePort {
  if (options === null || typeof options !== "object" || isAsyncLike(options.assertCurrent) ||
      isAsyncLike(options.parentIdentityFor) || isAsyncLike(options.assertLegacyAbsent))
    fail("OPTIONS");
  const archive = options.archive;
  const io = options.io;
  if (archive === null || typeof archive !== "object" || io === null || typeof io !== "object" ||
      io.contractVersion !== 3 || io.platform !== "win32" ||
      isAsyncLike(io.publishNew) || isAsyncLike(io.readPrivate))
    fail("OPTIONS");
  const { assertCurrent, parentIdentityFor, assertLegacyAbsent } = options;

  const revalidate = (): void => checkSync(assertCurrent);
  const legacyAbsent = (logicalPath: string, workspaceId: string): void =>
    checkSync(() => assertLegacyAbsent(logicalPath, workspaceId));

  // Caller returns the CURRENT native IDs for the already-canonical parent
  // path we pass in; we pin that exact path onto the identity.
  const parentIdentity = (parent: string): { canonicalPath: string; fileId: string; volumeId: string } => {
    const raw = parentIdentityFor(parent);
    if (utilTypes.isPromise(raw) || raw === null || typeof raw !== "object") fail("IDENTITY");
    const r = raw as WindowsRuntimeDirectoryIdentity;
    if (typeof r.fileId !== "string" || !FILE_ID.test(r.fileId) ||
        typeof r.volumeId !== "string" || !VOLUME_ID.test(r.volumeId)) fail("IDENTITY");
    return Object.freeze({ canonicalPath: parent, fileId: r.fileId, volumeId: r.volumeId });
  };

  // Native readback of the proven prior generation pinned by the receipt's
  // exact identity and hash; NEVER calls the archive (safe inside the CAS
  // transaction as a proof closure).
  const assertPriorNative = (
    receipt: TerminalEvidence,
    original: Uint8Array,
    directory: { canonicalPath: string; fileId: string; volumeId: string },
  ): void => {
    const outcome = io.readPrivate({
      path: receipt.path,
      expectedDirectory: { fileId: directory.fileId, volumeId: directory.volumeId },
      expectedFile: Object.freeze({
        canonicalPath: receipt.path,
        fileId: receipt.identity.fileId,
        volumeId: receipt.identity.volumeId,
      }),
      expectedSha256: receipt.sha256,
      maxBytes: WINDOWS_RECOVERY_MAX_BYTES,
    });
    if (outcome.state !== "READ" || outcome.contractVersion !== 3 ||
        outcome.identity.fileId !== receipt.identity.fileId ||
        asciiCaseFold(outcome.identity.volumeId) !== asciiCaseFold(receipt.identity.volumeId) ||
        outcome.sha256 !== receipt.sha256 ||
        outcome.byteLength !== original.byteLength ||
        !Buffer.from(outcome.bytes).equals(original))
      fail("PRIOR");
  };

  const readVerified = (
    logicalPath: string,
    workspaceId: string,
  ): { read: CrashRecoveryNativeRead; head: RecoveryHeadRead; receipt: TerminalEvidence } | undefined => {
    // assertCurrent ALWAYS before the archive read, including the absent case.
    revalidate();
    const head = archive.readHead(logicalPath, workspaceId);
    if (head === undefined) {
      // readHead already refused an absent head that still has an unresolved
      // intent; the physical legacy location must be natively absent too.
      legacyAbsent(logicalPath, workspaceId);
      return undefined;
    }
    const pointer = head.pointer;
    const receipt = recoveryHeadPublication(head);
    if (receipt.attemptId !== pointer.attemptId || !["PUBLISHED", "APPLIED_OBSERVED"].includes(receipt.outcome) ||
        receipt.sha256 !== pointer.sha256 ||
        asciiCaseFold(receipt.identity.canonicalPath) !== asciiCaseFold(receipt.path) ||
        asciiCaseFold(receipt.path) === asciiCaseFold(logicalPath))
      fail("RECEIPT");
    const directory = parentIdentity(parentOf(canonicalPath(receipt.path, "RECEIPT")));
    assertPriorNative(receipt, head.original, directory);
    revalidate();
    return {
      read: Object.freeze({
        generation: pointer.generation,
        token: pointer.attemptId,
        bytes: Uint8Array.from(head.original),
      }),
      head,
      receipt,
    };
  };

  const frozenPort = Object.freeze({
    contractVersion: 3 as const,
    platform: "win32" as const,
    read(path: string, workspaceId: string): CrashRecoveryNativeRead | undefined {
      return readVerified(canonicalPath(path), workspaceId)?.read;
    },
    compareAndSwap(request: Parameters<CrashRecoveryNativePort["compareAndSwap"]>[0]): CrashRecoveryNativeRead {
      return observeRecoveryPortInvocation(frozenPort, request, (entryState?: RecoveryPortObservationEntryState) => {
      const logicalPath = canonicalPath(request.path);
      // Clone bytes/expected BEFORE ANY callback — later caller mutation can
      // never alter the dispatched payload or the pinned expectation.
      if (!(request.bytes instanceof Uint8Array) ||
          request.bytes.byteLength > WINDOWS_RECOVERY_MAX_BYTES)
        fail("REQUEST");
      const bytes = Uint8Array.from(request.bytes);
      const workspaceId = request.workspaceId;
      if (typeof workspaceId !== "string" ||
          !Number.isSafeInteger(request.generation) || request.generation <= 0)
        fail("REQUEST");
      const expected = request.expected === undefined ? undefined : Object.freeze({
        generation: request.expected.generation,
        token: request.expected.token,
        bytes: request.expected.bytes instanceof Uint8Array
          ? Uint8Array.from(request.expected.bytes) : request.expected.bytes,
      });
      if (expected !== undefined &&
          (!Number.isSafeInteger(expected.generation) || expected.generation <= 0 ||
           typeof expected.token !== "string" || !ATTEMPT.test(expected.token) ||
           !(expected.bytes instanceof Uint8Array)))
        fail("REQUEST");

      const verified = readVerified(logicalPath, workspaceId);
      const current = verified?.read;
      if (expected === undefined) {
        if (current !== undefined)
          guardPortConflict(0, current.generation, "GENERATION", entryState);
      } else if (current === undefined || current.generation !== expected.generation) {
        guardPortConflict(expected?.generation ?? 0, current?.generation ?? 0, "GENERATION", entryState);
      } else if (current.token !== expected.token ||
                 !Buffer.from(current.bytes).equals(expected.bytes)) {
        guardPortConflict(expected?.generation ?? 0, current?.generation ?? 0, "HEAD_TOKEN_OR_BYTES", entryState);
      }
      if (request.generation !== (expected?.generation ?? 0) + 1) fail("CONFLICT");
      // A pending (reserved, unapplied) intent for this logical path —
      // including an UNKNOWN from before restart — blocks the new write.
      const pendingAttempts = archive.pendingAttempts(logicalPath, workspaceId);
      if (pendingAttempts.length !== 0) {
        const failure = new CollaborationError("WINDOWS_RECOVERY_PORT_PENDING");
        recordCheckpointPriorPending(failure, pendingAttempts);
        throw failure;
      }

      const id = attemptId();
      const parent = parentOf(logicalPath);
      const directory = parentIdentity(parent);
      // Same parent, never the logical name: immutable generation file.
      const destination = childOf(parent, `.${basenameOf(logicalPath)}.generation-${randomBytes(16).toString("hex")}.json`);
      const staging = childOf(parent, `.folio-recovery-${id}.tmp`);
      canonicalPath(destination); canonicalPath(staging);
      const expectedHead = verified === undefined ? null : {
        generation: verified.head.pointer.generation,
        attemptId: verified.head.pointer.attemptId,
        sha256: verified.head.pointer.sha256,
      };

      const observed = observeWindowsRecoveryPublishNew(io, {
        path: destination, stagingPath: staging, attemptId: id, bytes,
        logicalPath, workspaceId,
        generation: request.generation,
        expectedHead,
        expectedDirectory: directory,
        beforePublish(readback) {
          // Exact staged readback already proven by the IO layer; this hook
          // revalidates the caller binding one final time before the
          // irreversible no-replace commit is dispatched.
          checkSync(assertCurrent);
          if (!(readback instanceof Uint8Array)) fail("CALLBACK");
        },
      });
      const currentDispatch = observed.trusted &&
          observed.dispatch !== undefined && observed.dispatch.attemptId === id
        ? observed.dispatch
        : undefined;
      if (observed.terminal === "THREW") {
        if (entryState !== undefined && observed.trusted && currentDispatch !== undefined) {
          entryState.recoveryIoFailure = Object.freeze({
            attemptId: id,
            dispatch: currentDispatch,
          });
        }
        throw observed.value;
      }
      const outcome = observed.value;
      const receipt = outcome;
      if (outcome.state !== "PUBLISHED") {
        if (entryState !== undefined && observed.trusted) {
          const sourceOutcome = recoveryIoSourceOutcome(outcome);
          const refusal = observed.dispatch === undefined
            ? getCheckpointCapacityRefusal(outcome)
            : undefined;
          const capacityRefusal = refusal !== undefined && refusal.attemptId === id
            ? refusal
            : undefined;
          if (sourceOutcome !== undefined || currentDispatch !== undefined || capacityRefusal !== undefined) {
            entryState.recoveryIoFailure = Object.freeze({
              attemptId: id,
              ...(currentDispatch !== undefined ? { dispatch: currentDispatch } : {}),
              ...(sourceOutcome !== undefined ? { sourceOutcome } : {}),
              ...(capacityRefusal !== undefined ? { capacityRefusal } : {}),
            });
          }
        }
        // UNKNOWN/EXISTS/REJECTED already terminally recorded by the IO
        // layer; artifacts are retained and this attempt blocks the path.
        const error = new PrivateFilePublicationUnknownError(
          `Recovery publication unresolved: ${outcome.state}`, logicalPath, staging, outcome,
          getRecoveryIoFailureCause(outcome));
        propagateRecoveryIoFailure(error, outcome);
        throw error;
      }
      if (entryState !== undefined) {
        entryState.publication = Object.freeze({
          attemptId: id,
          stage: "HEAD_CAS",
          sourceOutcome: privateRecoveryPublishedSourceOutcome,
        });
      }
      // Proof closures for the CAS transaction: native IO + caller fence
      // only, never reentering the archive. assertPrior re-reads the EXACT
      // prior native file by pinned ID/hash and compares its bytes; for the
      // first generation the legacy logical location must be absent.
      const proofs = Object.freeze({
        assertCurrent(): void { checkSync(assertCurrent); },
        assertPrior(): void {
          if (verified === undefined) legacyAbsent(logicalPath, workspaceId);
          else assertPriorNative(verified.receipt, verified.head.original, directory);
        },
      });
      try {
        archive.compareAndSwapHead(
          logicalPath, workspaceId, expectedHead, id, proofs,
        );
      } catch (cause) {
        const error = new PrivateFilePublicationUnknownError(
          "Recovery pointer advance unresolved", logicalPath, staging, receipt, cause);
        recordCheckpointPostPublicationUnknown(error, id, "HEAD_CAS");
        throw error;
      }
      if (entryState !== undefined) {
        entryState.publication = Object.freeze({
          attemptId: id,
          stage: "READBACK",
          sourceOutcome: privateRecoveryPublishedSourceOutcome,
        });
      }
      const proven = readVerified(logicalPath, workspaceId)?.read;
      if (proven === undefined || proven.generation !== request.generation ||
          proven.token !== id || !Buffer.from(proven.bytes).equals(bytes)) {
        const error = new PrivateFilePublicationUnknownError(
          "Recovery published readback unresolved", logicalPath, staging, receipt);
        recordCheckpointPostPublicationUnknown(error, id, "READBACK");
        throw error;
      }
      return proven;
      });
    },
  });
  privateRecoveryFactoryPorts.add(frozenPort);
  return frozenPort;
}
