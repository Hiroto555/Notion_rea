import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonical } from "../../collaboration/runtime/canonical";
import {
  CollaborationError,
  safeCounter,
  type Cut,
} from "../../collaboration/runtime/contract";
import type { PublicationReservation } from "./publication-contract";
import type {
  WindowsPrivateIoV2Failure,
  WindowsPrivateReadV2Receipt,
} from "./private-publication-v2";
import type {
  WindowsPublicationInspection,
  WindowsPublicationJournal,
} from "./publication-journal";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";

export type PublicationNativeIdentity = Readonly<{
  canonicalPath: string;
  fileId: string;
  volumeId: string;
}>;
export type PublicationSourceIdentity = Readonly<{
  sourceRoot: string;
  orgId: string;
  genesisHash: string;
  root: PublicationNativeIdentity;
  directory: PublicationNativeIdentity;
  database: PublicationNativeIdentity;
}>;
export type PublicationAuthorization = Readonly<{
  sourceRoot: string;
  orgId: string;
  genesisHash: string;
  auth: Readonly<{
    userId: string;
    deviceId: string;
    writerId: string;
    sessionId: string;
  }>;
  cut: Readonly<{ epoch: string; seq: number; hash: string }>;
}>;
export type PublicationResolutionRequest = Readonly<{
  attemptId: string;
  expectedCut: Cut;
}>;
export type PublicationResolveRequest = PublicationResolutionRequest &
  Readonly<{ fingerprint: string }>;
// The callback MUST return a synchronous canonicalizable JSON snapshot of the
// current operator authorization, never a token or deferred value.
export type CurrentPublicationAuthorization = () => PublicationAuthorization;
export type PublicationResolutionObserved = Readonly<{
  root: PublicationNativeIdentity;
  directory: PublicationNativeIdentity;
  sourceDirectory: PublicationNativeIdentity;
  sourceDatabase: PublicationNativeIdentity;
  file: PublicationNativeIdentity;
  byteLength: number;
  sha256: string;
}>;
export type PublicationResolutionObservation = Readonly<{
  version: 1;
  outcome: "PUBLISHED_OBSERVED";
  attemptId: string;
  snapshotFingerprint: string;
  fingerprint: string;
  authorization: PublicationAuthorization;
  observed: PublicationResolutionObserved;
  preserve: true;
}>;
export type PublicationResolutionInspection = Readonly<{
  version: 1;
  attemptId: string;
  state: WindowsPublicationInspection["state"];
  fingerprint: string;
  snapshotFingerprint: string;
  inspection: WindowsPublicationInspection;
  observation: "MATCH" | "UNCONFIRMED";
  resolvable: boolean;
  preserve: true;
  resolution: PublicationResolutionObservation | null;
}>;
export interface PublicationResolutionPort {
  inspect(
    request: PublicationResolutionRequest,
    currentAuthorization: CurrentPublicationAuthorization,
  ): PublicationResolutionInspection;
  resolve(
    request: PublicationResolveRequest,
    currentAuthorization: CurrentPublicationAuthorization,
  ): PublicationResolutionObservation;
}
export type PublicationNativeReadRequest = Readonly<{
  reservation: PublicationReservation;
  preparedFile: PublicationNativeIdentity;
  source: PublicationSourceIdentity;
}>;
export type PublicationNativeObservation = Readonly<{
  root: PublicationNativeIdentity;
  directory: PublicationNativeIdentity;
  sourceDirectory: PublicationNativeIdentity;
  sourceDatabase: PublicationNativeIdentity;
  receipt: WindowsPrivateReadV2Receipt | WindowsPrivateIoV2Failure;
}>;

const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const WINDOWS_PATH_PROFILE = /^[A-Z]:\\[\x20-\x7e]*$/;
const SNAPSHOT_BYTES = 48 * 1024;
const BINDING_BYTES = 96 * 1024;

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_PUBLICATION_RESOLUTION_${code}`);
}

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return false;
  if (utilTypes.isPromise(value)) {
    // Drain a rejected Promise so refusal leaves no unhandled rejection.
    Promise.prototype.then.call(value, undefined, () => undefined);
    return true;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "then");
    return (
      descriptor !== undefined &&
      (!("value" in descriptor) || typeof descriptor.value === "function")
    );
  } catch {
    return true;
  }
}
function isAsyncLike(value: unknown): boolean {
  return (
    typeof value !== "function" ||
    utilTypes.isAsyncFunction(value) ||
    utilTypes.isGeneratorFunction(value)
  );
}

/** Data-only record: plain prototype, enumerable value properties, exact keys.
 * Accessors, symbol keys and exotic objects are refused before any read. */
function dataRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const names = Object.keys(value);
  if (
    Object.getOwnPropertyNames(value).length !== names.length ||
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name))
  )
    fail(code);
  const record = value as Record<string, unknown>;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail(code);
  }
  return record;
}

function requireIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code);
  return value;
}
function requireHex(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
function requireCanonicalPath(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !WINDOWS_PATH_PROFILE.test(value)
  )
    fail(code);
  let canonicalPath: string;
  try {
    canonicalPath = validateWindowsPath(value, `${value[0]}:\\`).canonical;
  } catch {
    fail(code);
  }
  if (canonicalPath !== value) fail(code);
  return value;
}
function requireCut(value: unknown, code: string): Cut {
  const record = dataRecord(value, ["epoch", "hash", "seq"], code);
  const epoch = requireIdentifier(record.epoch, code);
  const hash = requireHex(record.hash, SHA256, code);
  let seq: number;
  try {
    seq = safeCounter(record.seq);
  } catch {
    fail(code);
  }
  return Object.freeze({ epoch, seq, hash });
}
function requireIdentity(
  value: unknown,
  code: string,
): PublicationNativeIdentity {
  const record = dataRecord(
    value,
    ["canonicalPath", "fileId", "volumeId"],
    code,
  );
  return Object.freeze({
    canonicalPath: requireCanonicalPath(record.canonicalPath, code),
    fileId: requireHex(record.fileId, FILE_ID, code),
    volumeId: requireHex(record.volumeId, VOLUME_ID, code),
  });
}
function sameIdentity(
  left: PublicationNativeIdentity,
  right: PublicationNativeIdentity,
): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    asciiCaseFold(left.fileId) === asciiCaseFold(right.fileId) &&
    asciiCaseFold(left.volumeId) === asciiCaseFold(right.volumeId)
  );
}

function canonicalSnapshot(value: unknown, code: string): string {
  if (isThenable(value)) fail(code);
  try {
    return canonical(value, SNAPSHOT_BYTES);
  } catch {
    fail(code);
  }
}

/** Canonical JSON snapshot of the callback output taken BEFORE any native
 * call; later caller mutation cannot alter what was checked or persisted. */
function requireAuthorization(raw: unknown): PublicationAuthorization {
  const body = canonicalSnapshot(raw, "AUTHORIZATION");
  const record = dataRecord(
    JSON.parse(body),
    ["auth", "cut", "genesisHash", "orgId", "sourceRoot"],
    "AUTHORIZATION",
  );
  const sourceRoot = requireCanonicalPath(
    record.sourceRoot,
    "AUTHORIZATION",
  );
  const orgId = requireIdentifier(record.orgId, "AUTHORIZATION");
  const genesisHash = requireHex(record.genesisHash, SHA256, "AUTHORIZATION");
  const auth = dataRecord(
    record.auth,
    ["deviceId", "sessionId", "userId", "writerId"],
    "AUTHORIZATION",
  );
  return Object.freeze({
    sourceRoot,
    orgId,
    genesisHash,
    auth: Object.freeze({
      userId: requireIdentifier(auth.userId, "AUTHORIZATION"),
      deviceId: requireIdentifier(auth.deviceId, "AUTHORIZATION"),
      writerId: requireIdentifier(auth.writerId, "AUTHORIZATION"),
      sessionId: requireIdentifier(auth.sessionId, "AUTHORIZATION"),
    }),
    cut: requireCut(record.cut, "AUTHORIZATION"),
  });
}

/** Also used before a concrete factory opens its independent journal. */
export function readPublicationAuthorization(callback: CurrentPublicationAuthorization): PublicationAuthorization {
  if (isAsyncLike(callback)) fail("AUTHORIZATION");
  return requireAuthorization(callback());
}

function bindFingerprint(
  snapshotFingerprint: string,
  authorization: PublicationAuthorization,
  observed: PublicationResolutionObserved | null,
): string {
  return createHash("sha256")
    .update(
      canonical({ snapshotFingerprint, authorization, observed }, BINDING_BYTES),
    )
    .digest("hex");
}

function frozenIdentity(
  value: PublicationNativeIdentity,
): PublicationNativeIdentity {
  return Object.freeze({
    canonicalPath: value.canonicalPath,
    fileId: value.fileId,
    volumeId: value.volumeId,
  });
}

/**
 * Read-only terminal observation for attempts whose durable records prove a
 * commit was dispatched but whose terminal outcome is UNKNOWN or unrecorded.
 * The port never writes bytes and never cleans, replays or resolves UNKNOWN
 * to a new terminal state; it only records what a current native read proves.
 * Resolution depends on retained journal evidence only — the request carries
 * no receipt or identity evidence, and `readCurrent` is factory wiring, never
 * request data.
 */
export function createPublicationResolutionPort(
  options: Readonly<{
    journal: WindowsPublicationJournal;
    readCurrent(
      request: PublicationNativeReadRequest,
    ): PublicationNativeObservation;
  }>,
): PublicationResolutionPort {
  const record = dataRecord(options, ["journal", "readCurrent"], "OPTIONS");
  const journal = record.journal as WindowsPublicationJournal;
  if (typeof journal !== "object" || journal === null) fail("OPTIONS");
  for (const name of ["investigate", "appendResolution"] as const) {
    if (
      isAsyncLike((journal as unknown as Record<string, unknown>)[name])
    )
      fail("OPTIONS");
  }
  const readCurrent = record.readCurrent;
  if (isAsyncLike(readCurrent)) fail("OPTIONS");
  const read = readCurrent as (
    request: PublicationNativeReadRequest,
  ) => PublicationNativeObservation;

  let active = false;

  const validateRequest = (
    raw: unknown,
    resolve: boolean,
  ): {
    attemptId: string;
    expectedCut: Cut;
    fingerprint: string | undefined;
  } => {
    const body = canonicalSnapshot(raw, "REQUEST");
    const parsed = dataRecord(
      JSON.parse(body),
      resolve
        ? ["attemptId", "expectedCut", "fingerprint"]
        : ["attemptId", "expectedCut"],
      "REQUEST",
    );
    return {
      attemptId: requireHex(parsed.attemptId, ATTEMPT_ID, "REQUEST"),
      expectedCut: requireCut(parsed.expectedCut, "REQUEST"),
      fingerprint: resolve
        ? requireHex(parsed.fingerprint, SHA256, "REQUEST")
        : undefined,
    };
  };

  const requireCallback = (
    callback: unknown,
  ): CurrentPublicationAuthorization => {
    if (isAsyncLike(callback)) fail("AUTHORIZATION");
    return callback as CurrentPublicationAuthorization;
  };

  const sourceMatches = (
    source: PublicationSourceIdentity,
    authorization: PublicationAuthorization,
  ): boolean =>
    source.sourceRoot === authorization.sourceRoot &&
    source.orgId === authorization.orgId &&
    source.genesisHash === authorization.genesisHash;

  /** Compare a current native observation against retained evidence only.
   * Any identity or digest mismatch is UNCONFIRMED evidence, never an
   * error against the store; malformed port output is a contract breach. */
  const matchObservation = (
    raw: unknown,
    reservation: PublicationReservation,
    preparedFile: PublicationNativeIdentity,
    source: PublicationSourceIdentity,
  ): PublicationResolutionObserved | null => {
    if (isThenable(raw)) fail("OBSERVATION");
    const record = dataRecord(
      raw,
      [
        "directory",
        "receipt",
        "root",
        "sourceDatabase",
        "sourceDirectory",
      ],
      "OBSERVATION",
    );
    let root: PublicationNativeIdentity,
      directory: PublicationNativeIdentity,
      sourceDirectory: PublicationNativeIdentity,
      sourceDatabase: PublicationNativeIdentity;
    try {
      root = requireIdentity(record.root, "OBSERVATION");
      directory = requireIdentity(record.directory, "OBSERVATION");
      sourceDirectory = requireIdentity(
        record.sourceDirectory,
        "OBSERVATION",
      );
      sourceDatabase = requireIdentity(
        record.sourceDatabase,
        "OBSERVATION",
      );
    } catch {
      return null;
    }
    if (
      !sameIdentity(root, reservation.root) ||
      !sameIdentity(directory, reservation.directory) ||
      !sameIdentity(sourceDirectory, source.directory) ||
      !sameIdentity(sourceDatabase, source.database)
    )
      return null;
    const receiptValue = record.receipt;
    if (isThenable(receiptValue)) fail("OBSERVATION");
    try {
      const receipt = dataRecord(
        receiptValue,
        [
          "byteLength",
          "bytes",
          "contractVersion",
          "identity",
          "sha256",
          "state",
        ],
        "RECEIPT",
      );
      if (receipt.contractVersion !== 2 || receipt.state !== "READ")
        return null;
      const identity = requireIdentity(receipt.identity, "OBSERVATION");
      if (
        identity.canonicalPath !== reservation.path ||
        !sameIdentity(identity, preparedFile)
      )
        return null;
      if (
        receipt.byteLength !== reservation.byteLength ||
        receipt.sha256 !== reservation.sha256
      )
        return null;
      if (
        !(receipt.bytes instanceof Uint8Array) ||
        receipt.bytes.byteLength !== reservation.byteLength
      )
        return null;
      // The digest is recomputed over a private copy of the bytes; a reader
      // mutating its own buffer afterwards cannot alter what was checked.
      const bytes = Buffer.from(receipt.bytes);
      if (
        bytes.byteLength !== reservation.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== reservation.sha256
      )
        return null;
      return Object.freeze({
        root,
        directory,
        sourceDirectory,
        sourceDatabase,
        file: frozenIdentity(identity),
        byteLength: receipt.byteLength,
        sha256: receipt.sha256,
      });
    } catch {
      // Any malformed or non-READ receipt is UNCONFIRMED evidence.
      return null;
    }
  };

  const eligible = (inspection: WindowsPublicationInspection): boolean =>
    (inspection.state === "UNKNOWN" ||
      inspection.state === "COMMIT_DISPATCHED") &&
    inspection.dispatches.some(
      (dispatch) => dispatch.phase === "commit-prepared",
    );

  const observe = (
    reservation: PublicationReservation,
    preparedFile: PublicationNativeIdentity,
    source: PublicationSourceIdentity,
  ): PublicationResolutionObserved | null => {
    let raw: unknown;
    try {
      raw = read(
        Object.freeze({
          reservation,
          preparedFile: frozenIdentity(preparedFile),
          source,
        }),
      );
    } catch {
      return null; // Factory reader failure is UNCONFIRMED, never not-applied.
    }
    return matchObservation(raw, reservation, preparedFile, source);
  };

  const context = (
    request: unknown,
    resolving: boolean,
    rawCallback: unknown,
  ): {
    attemptId: string;
    expectedCut: Cut;
    fingerprint: string | undefined;
    currentAuthorization: CurrentPublicationAuthorization;
    investigated: NonNullable<
      ReturnType<WindowsPublicationJournal["investigate"]>
    >;
    authorization: PublicationAuthorization;
  } => {
    const parsed = validateRequest(request, resolving);
    const currentAuthorization = requireCallback(rawCallback);
    const investigated = journal.investigate(parsed.attemptId);
    if (investigated === null) fail("ATTEMPT_MISSING");
    const authorization = requireAuthorization(currentAuthorization());
    if (
      canonical(authorization.cut) !== canonical(parsed.expectedCut)
    )
      fail("AUTHORIZATION_CUT");
    if (
      investigated.source !== null &&
      !sourceMatches(investigated.source, authorization)
    )
      fail("AUTHORIZATION_SOURCE");
    return {
      ...parsed,
      currentAuthorization,
      investigated,
      authorization,
    };
  };

  return Object.freeze({
    inspect(
      request: PublicationResolutionRequest,
      currentAuthorization: CurrentPublicationAuthorization,
    ): PublicationResolutionInspection {
      if (active) fail("REENTRANT");
      active = true;
      try {
        const { attemptId, investigated, authorization } = context(
          request,
          false,
          currentAuthorization,
        );
        let observed: PublicationResolutionObserved | null = null;
        if (
          eligible(investigated.inspection) &&
          investigated.source !== null &&
          investigated.preparedFile !== null
        )
          observed = observe(
            investigated.inspection.reservation,
            investigated.preparedFile,
            investigated.source,
          );
        const resolution = investigated.resolution;
        const matches =
          observed !== null &&
          (resolution === null ||
            canonical(observed) === canonical(resolution.observed));
        return Object.freeze({
          version: 1,
          attemptId,
          state: investigated.inspection.state,
          fingerprint: bindFingerprint(
            investigated.snapshotFingerprint,
            authorization,
            matches ? observed : null,
          ),
          snapshotFingerprint: investigated.snapshotFingerprint,
          inspection: investigated.inspection,
          observation: matches ? "MATCH" : "UNCONFIRMED",
          resolvable: resolution === null && matches,
          preserve: true,
          resolution,
        });
      } finally {
        active = false;
      }
    },
    resolve(
      request: PublicationResolveRequest,
      currentAuthorization: CurrentPublicationAuthorization,
    ): PublicationResolutionObservation {
      if (active) fail("REENTRANT");
      active = true;
      try {
        const {
          attemptId,
          fingerprint,
          investigated,
          authorization,
          currentAuthorization: callback,
        } = context(request, true, currentAuthorization);
        if (!eligible(investigated.inspection)) fail("RESOLUTION_STATE");
        if (investigated.source === null) fail("SOURCE_MISSING");
        if (investigated.preparedFile === null) fail("STAGE_PROOF_MISSING");
        const observed = observe(
          investigated.inspection.reservation,
          investigated.preparedFile,
          investigated.source,
        );
        if (observed === null) fail("UNCONFIRMED");
        const bound = bindFingerprint(
          investigated.snapshotFingerprint,
          authorization,
          observed,
        );
        if (bound !== fingerprint) fail("FINGERPRINT");
        const observation: PublicationResolutionObservation = Object.freeze({
          version: 1,
          outcome: "PUBLISHED_OBSERVED",
          attemptId,
          snapshotFingerprint: investigated.snapshotFingerprint,
          fingerprint: bound,
          authorization,
          observed,
          preserve: true,
        });
        return journal.appendResolution(
          attemptId,
          investigated.snapshotFingerprint,
          observation,
          callback,
        );
      } finally {
        active = false;
      }
    },
  });
}
