import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  CollaborationError,
  wellFormed,
  type Json,
} from "../../collaboration/runtime/contract";
import { canonical } from "../../collaboration/runtime/canonical";
import { PrivateLedger } from "../../sync/private-ledger";
import { synchronousPrivatePlatform, type PrivatePlatform } from "../../sync/private-platform";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
} from "./path-policy";
import {
  WINDOWS_PUBLICATION_MAX_BYTES,
  WINDOWS_PUBLICATION_MAX_WIRE_BYTES,
  type DurablePublicationAuthority,
  type PublicationReservation,
} from "./publication-contract";
import type {
  CurrentPublicationAuthorization,
  PublicationNativeIdentity,
  PublicationResolutionObservation,
  PublicationSourceIdentity,
} from "./publication-resolution";

const CHUNK_BYTES = 24 * 1024;
const METADATA_BYTES = 48 * 1024;
const normalWireBound = (n: number) => Math.min(WINDOWS_PUBLICATION_MAX_WIRE_BYTES, 4 * Math.ceil(n / 3) + 8192);
function lifecycleBudget(n: number) {
  const wire = normalWireBound(n), prepared = 4 * Math.ceil(n / 3) + 16384;
  const encoded = (n: number) => 4 * Math.ceil(n / 3);
  // Full normal prepare + prepared evidence + worst bounded stdout AND stderr
  // terminal originals. Raw captures are stored as bytes, without JSON escape
  // amplification. Includes metadata/manifests/commit wire and row overhead.
  return {version: 1, bytes: encoded(wire) + encoded(prepared) + 2 * encoded(WINDOWS_PUBLICATION_MAX_WIRE_BYTES) + 2 * METADATA_BYTES + 32768,
    rows: Math.ceil(wire / CHUNK_BYTES) + Math.ceil(prepared / CHUNK_BYTES) + 2 * Math.ceil(WINDOWS_PUBLICATION_MAX_WIRE_BYTES / CHUNK_BYTES) + 32};
}
const LEDGER_VALUE_BYTES = 64 * 1024;
const JOURNAL_ROLE = "windows-publication-v2";

export const WINDOWS_PUBLICATION_JOURNAL_DATABASE =
  "publication-state.sqlite";

type DispatchPhase = "prepare" | "commit-prepared";
type Outcome = "PUBLISHED" | "UNKNOWN" | "REJECTED";
type LocalStep = "reserved" | "prepare" | "prepared" | "commit-prepared";
type AttemptState =
  | "RESERVED"
  | "PREPARE_DISPATCHED"
  | "PREPARED"
  | "COMMIT_DISPATCHED"
  | Outcome;

export type WindowsPublicationDispatchMetadata = Readonly<{
  phase: DispatchPhase;
  byteLength: number;
  sha256: string;
  chunkCount: number;
}>;
export type WindowsPublicationInspection = Readonly<{
  reservation: PublicationReservation;
  state: AttemptState;
  dispatches: readonly WindowsPublicationDispatchMetadata[];
  prepared: null | Readonly<{ byteLength: number; sha256: string }>;
  terminal: null | Readonly<{
    outcome: Outcome;
    byteLength: number;
    sha256: string;
  }>;
}>;

const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const SID = /^S-1-[0-9]+(?:-[0-9]+)+$/;
const ORG_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHARED_RUNTIME_DATABASE = "shared-runtime.sqlite";
const RESOLUTION_BYTES = 48 * 1024;
const WINDOWS_PATH_PROFILE = /^[A-Z]:\\[\x20-\x7e]*$/;
const JSON_INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const JSON_NUMBER_TOKEN =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const OUTCOMES: ReadonlySet<string> = new Set([
  "PUBLISHED",
  "UNKNOWN",
  "REJECTED",
]);
const IDENTITY_KEYS = ["canonicalPath", "fileId", "volumeId"] as const;
const STAGED_IDENTITY_FIELDS = [
  "fileId",
  "volumeId",
  "stagingFileId",
  "stagingVolumeId",
] as const;

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_PUBLICATION_JOURNAL_${code}`);
}

/** A thenable is never a synchronous callback result. Rejected real Promises
 * are drained so refusal leaves no unhandled rejection, and `.then` getters
 * are never executed on data-only input. */
function isThenableResult(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return false;
  if (utilTypes.isPromise(value)) {
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

const sha = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const attemptKey = (id: string, suffix: string): string =>
  `attempt:${id}:${suffix}`;
const wireKey = (id: string, phase: DispatchPhase, index: number): string =>
  attemptKey(id, `wire:${phase}:${String(index).padStart(4, "0")}`);
const same = (a: string, b: string): boolean =>
  asciiCaseFold(a) === asciiCaseFold(b);

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

function requireCanonicalWindowsPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !WINDOWS_PATH_PROFILE.test(value)
  )
    fail("RESERVATION_PATH");
  let output: string;
  try {
    output = validateWindowsPath(value, `${value[0]}:\\`).canonical;
  } catch {
    fail("RESERVATION_PATH");
  }
  if (output !== value) fail("RESERVATION_PATH");
  return value;
}

function requirePattern(
  value: unknown,
  pattern: RegExp,
  code = "RESERVATION",
): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code);
  const record = value as Record<string, unknown>;
  const names = Object.keys(record);
  if (
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name))
  )
    fail(code);
  return record;
}

/**
 * Lexical separation only — this is a syntax check on absolute paths, never
 * filesystem evidence. Windows drive paths compare ASCII-folded on `\`;
 * POSIX-absolute paths compare case-sensitively on `/`. Mixed styles are
 * deliberately incomparable (a POSIX test fixture cannot alias a Windows
 * synthetic reservation path).
 */
type LexicalPath = Readonly<{ separator: "\\" | "/"; folded: string }>;
function lexicalPath(value: unknown): LexicalPath | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !wellFormed(value)
  )
    return null;
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    let canonicalPath: string;
    try {
      canonicalPath = validateWindowsPath(
        value,
        `${value[0].toUpperCase()}:\\`,
      ).canonical;
    } catch {
      return null;
    }
    return { separator: "\\", folded: asciiCaseFold(canonicalPath) };
  }
  if (value.startsWith("/")) {
    let trimmed = value.replace(/\/+$/, "");
    if (trimmed === "") trimmed = "/";
    if (trimmed === "/") return { separator: "/", folded: "/" };
    const segments = trimmed.split("/");
    for (let index = 1; index < segments.length; index++) {
      const segment = segments[index];
      if (segment === "" || segment === "." || segment === "..") return null;
    }
    return { separator: "/", folded: trimmed };
  }
  return null;
}

function overlapsLexical(a: LexicalPath, b: LexicalPath): boolean {
  if (a.separator !== b.separator) return false;
  const contains = (parent: string, candidate: string): boolean =>
    candidate === parent ||
    (parent.endsWith(a.separator)
      ? candidate.startsWith(parent)
      : candidate.startsWith(parent + a.separator));
  return contains(a.folded, b.folded) || contains(b.folded, a.folded);
}

type ReservationIdentity = Readonly<{
  canonicalPath: string;
  fileId: string;
  volumeId: string;
}>;
type ValidatedReservation = Readonly<{
  attemptId: string;
  path: string;
  stagingPath: string;
  root: ReservationIdentity;
  directory: ReservationIdentity;
  byteLength: number;
  sha256: string;
  /** Immutable canonical JSON body persisted once at reservation time. */
  body: string;
  /** Canonical JSON of the folded identity tuple backing the target index. */
  identity: string;
  targetKey: string;
}>;

function requireIdentity(value: unknown): ReservationIdentity {
  const record = exactKeys(value, IDENTITY_KEYS, "RESERVATION");
  return Object.freeze({
    canonicalPath: requireCanonicalWindowsPath(record.canonicalPath),
    fileId: requirePattern(record.fileId, FILE_ID, "RESERVATION_IDENTITY"),
    volumeId: requirePattern(
      record.volumeId,
      VOLUME_ID,
      "RESERVATION_IDENTITY",
    ),
  });
}

/**
 * Canonicalize the caller input first so getters, exotic objects, unsafe
 * numbers and unpaired surrogates can never reach the ledger; the persisted
 * body is the canonical JSON itself. Path/identity checks below are syntax
 * and envelope consistency checks only — they are not filesystem evidence.
 */
function validateReservation(input: unknown): ValidatedReservation {
  let body: string;
  try {
    body = canonical(input, METADATA_BYTES);
  } catch {
    fail("RESERVATION");
  }
  const record = exactKeys(
    JSON.parse(body) as unknown,
    [
      "attemptId",
      "byteLength",
      "contractVersion",
      "directory",
      "path",
      "root",
      "sha256",
      "stagingPath",
    ],
    "RESERVATION",
  );
  if (record.contractVersion !== 2) fail("RESERVATION");
  const attemptId = requirePattern(record.attemptId, ATTEMPT_ID);
  const sha256 = requirePattern(record.sha256, SHA256);
  const byteLength = record.byteLength;
  if (
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > WINDOWS_PUBLICATION_MAX_BYTES
  )
    fail("RESERVATION");
  const path = requireCanonicalWindowsPath(record.path);
  const stagingPath = requireCanonicalWindowsPath(record.stagingPath);
  const root = requireIdentity(record.root);
  const directory = requireIdentity(record.directory);
  const parent = parentOf(path);
  if (parent !== directory.canonicalPath) fail("RESERVATION_LINK");
  try {
    validateWindowsPath(path, root.canonicalPath);
  } catch {
    fail("RESERVATION_LINK");
  }
  if (same(path, root.canonicalPath)) fail("RESERVATION_LINK");
  try {
    validateWindowsPath(directory.canonicalPath, root.canonicalPath);
  } catch {
    fail("RESERVATION_LINK");
  }
  if (!same(directory.volumeId, root.volumeId)) fail("RESERVATION_IDENTITY");
  if (
    same(directory.canonicalPath, root.canonicalPath) &&
    !same(directory.fileId, root.fileId)
  )
    fail("RESERVATION_IDENTITY");
  if (stagingPath !== childOf(parent, `.folio-private-${attemptId}.tmp`))
    fail("RESERVATION_LINK");
  if (same(stagingPath, path)) fail("RESERVATION_LINK");
  const identity = canonical([
    asciiCaseFold(root.volumeId),
    asciiCaseFold(root.fileId),
    asciiCaseFold(directory.volumeId),
    asciiCaseFold(directory.fileId),
    asciiCaseFold(basenameOf(path)),
  ]);
  return Object.freeze({
    attemptId,
    path,
    stagingPath,
    root,
    directory,
    byteLength,
    sha256,
    body,
    identity,
    targetKey: `target:${sha(identity)}`,
  });
}

/**
 * Strict bounded JSON reader for the native request envelope: object/array
 * support, duplicate keys rejected (including escaped spellings), integer-only
 * numbers (lexical check plus safe-integer, -0 refused), escaped or literal
 * lone surrogates refused, null-prototype result objects, bounded depth and
 * node count, and no trailing input. JSON.parse is only applied to complete
 * string tokens inside a catch so raw input never leaks through an error.
 */
function parseWireJson(source: string): unknown {
  let at = 0;
  let nodes = 0;
  const white = (): void => {
    while (
      at < source.length &&
      (source[at] === " " ||
        source[at] === "\t" ||
        source[at] === "\r" ||
        source[at] === "\n")
    )
      at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '"') {
        let value: unknown;
        try {
          value = JSON.parse(source.slice(start, at));
        } catch {
          fail("WIRE_JSON");
        }
        if (typeof value !== "string" || !wellFormed(value)) fail("WIRE_JSON");
        return value;
      }
      if (c === "\\") at++;
    }
    return fail("WIRE_JSON");
  };
  const number = (): number => {
    const token = JSON_NUMBER_TOKEN.exec(source.slice(at));
    if (token === null || !JSON_INTEGER.test(token[0])) fail("WIRE_NUMBER");
    at += token[0].length;
    const value = Number(token[0]);
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      fail("WIRE_NUMBER");
    return value;
  };
  const value = (depth: number): unknown => {
    if (++nodes > 100_000 || depth > 100) fail("WIRE_JSON");
    white();
    const c = source[at];
    if (c === '"') return string();
    if (c === "{") {
      at++;
      white();
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (source[at] === "}") {
        at++;
        return result;
      }
      for (;;) {
        white();
        if (source[at] !== '"') fail("WIRE_JSON");
        const key = string();
        if (keys.has(key)) fail("WIRE_JSON");
        keys.add(key);
        white();
        if (source[at++] !== ":") fail("WIRE_JSON");
        result[key] = value(depth + 1);
        white();
        const delimiter = source[at++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") fail("WIRE_JSON");
      }
    }
    if (c === "[") {
      at++;
      white();
      const result: unknown[] = [];
      if (source[at] === "]") {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        white();
        const delimiter = source[at++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") fail("WIRE_JSON");
      }
    }
    if (source.startsWith("true", at)) {
      at += 4;
      return true;
    }
    if (source.startsWith("false", at)) {
      at += 5;
      return false;
    }
    if (source.startsWith("null", at)) {
      at += 4;
      return null;
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9"))
      return number();
    return fail("WIRE_JSON");
  };
  const result = value(0);
  white();
  if (at !== source.length) fail("WIRE_JSON");
  return result;
}

type StoredManifest = Readonly<{
  phase: DispatchPhase;
  byteLength: number;
  sha256: string;
  chunkCount: number;
}>;
type DurableAttempt = Readonly<{
  reservation: ValidatedReservation;
  dispatches: readonly StoredManifest[];
  preparedBody: string | null;
  preparedEvidence: unknown;
  terminalBody: string | null;
  terminalOutcome: Outcome | null;
  state: AttemptState;
}>;

function storedCanonical(body: string, code: string): unknown {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    fail(code);
  }
  let reencoded: string;
  try {
    reencoded = canonical(data, LEDGER_VALUE_BYTES);
  } catch {
    fail(code);
  }
  if (reencoded !== body) fail(code);
  return data;
}

/** Wraps the injected platform to prove kind, record bind results and retain
 * close causes that PrivateLedger would otherwise drop after a failed open. */
class JournalPlatformProxy implements PrivatePlatform {
  readonly kind = "windows" as const;
  boundDirectory: string | undefined;
  readonly closeFailures: unknown[] = [];

  constructor(
    private readonly inner: PrivatePlatform,
    private readonly roots: readonly LexicalPath[],
  ) {}

  bind(directory: string): string {
    const bound = this.inner.bind(directory);
    const lex = lexicalPath(bound);
    if (lex === null) fail("PLATFORM");
    for (const root of this.roots)
      if (overlapsLexical(lex, root)) fail("FORBIDDEN_ROOT");
    this.boundDirectory = bound;
    return bound;
  }
  assertRoot(): void {
    this.inner.assertRoot();
  }
  assertFile(path: string): void {
    this.inner.assertFile(path);
  }
  assertSidecars(path: string): void {
    this.inner.assertSidecars(path);
  }
  createExclusive(path: string): void {
    this.inner.createExclusive(path);
  }
  assertEmptyFile(path: string): void {
    this.inner.assertEmptyFile(path);
  }
  close(): void {
    try {
      this.inner.close();
    } catch (error) {
      this.closeFailures.push(error);
      throw error;
    }
  }
}

/**
 * Separate durable SQLite authority for Windows publication v2. One own
 * transaction per step, immutable records, no replay of UNKNOWN, no retry,
 * resume, reconcile, delete or purge. A reopen keeps retained state but
 * receives no dispatch authority; only terminal observation is possible.
 */
export class WindowsPublicationJournal implements DurablePublicationAuthority {
  private readonly ledger!: PrivateLedger;
  private readonly platform: JournalPlatformProxy;
  private readonly boundDirectory: string;
  private readonly sourceIdentity: (() => PublicationSourceIdentity) | undefined;
  private readonly owned = new Map<string, LocalStep>();
  private closed = false;
  private closing = false;
  private unavailable = false;
  private failure: unknown;

  constructor(
    directory: string,
    platform: PrivatePlatform,
    forbiddenRoots: readonly string[] = [],
    sourceIdentity?: () => PublicationSourceIdentity,
  ) {
    if (sourceIdentity !== undefined && (typeof sourceIdentity !== "function" ||
        utilTypes.isAsyncFunction(sourceIdentity) || utilTypes.isGeneratorFunction(sourceIdentity)))
      fail("SOURCE_CALLBACK");
    let kind: unknown;
    try {
      kind =
        typeof platform === "object" && platform !== null
          ? platform.kind
          : undefined;
    } catch {
      fail("PLATFORM");
    }
    if (kind !== "windows") fail("PLATFORM");
    const dirLex = lexicalPath(directory);
    if (dirLex === null) fail("DIRECTORY");
    if (!Array.isArray(forbiddenRoots)) fail("FORBIDDEN_ROOT");
    const roots: LexicalPath[] = [];
    for (const root of forbiddenRoots) {
      const lex = lexicalPath(root);
      if (lex === null) fail("FORBIDDEN_ROOT");
      roots.push(lex);
    }
    for (const root of roots)
      if (overlapsLexical(dirLex, root)) fail("FORBIDDEN_ROOT");
    this.platform = new JournalPlatformProxy(synchronousPrivatePlatform(platform), roots);
    try {
      this.ledger = new PrivateLedger(
        directory,
        WINDOWS_PUBLICATION_JOURNAL_DATABASE,
        JOURNAL_ROLE,
        [],
        this.platform,
      );
    } catch (error) {
      if (this.platform.closeFailures.length > 0)
        throw new AggregateError(
          [error, ...this.platform.closeFailures],
          "windows publication journal initialization failed",
        );
      throw error;
    }
    const bound = this.platform.boundDirectory;
    if (bound === undefined) fail("PLATFORM");
    this.boundDirectory = bound;
    this.sourceIdentity = sourceIdentity;
  }

  private assertUsable(): void {
    if (this.unavailable) throw this.failure;
    if (this.closing || this.closed) fail("CLOSED");
  }

  private transact<T>(work: () => T, verify?: () => void): T {
    this.assertUsable();
    let finished = false;
    try {
      const result = this.ledger.transaction(() => {
        const value = work();
        finished = true;
        return value;
      });
      verify?.();
      return result;
    } catch (error) {
      if (finished) {
        this.unavailable = true;
        this.failure = error;
        this.owned.clear();
      }
      throw error;
    }
  }

  private append(key: string, value: string): void {
    if (this.ledger.read(key) !== null) fail("IMMUTABLE");
    this.ledger.write(key, value);
  }

  private parseWire(exactWire: string): {
    parsed: Record<string, unknown>;
    bytes: Buffer;
  } {
    if (
      typeof exactWire !== "string" ||
      exactWire.length === 0 ||
      exactWire.length > WINDOWS_PUBLICATION_MAX_WIRE_BYTES
    )
      fail("WIRE_BOUNDS");
    if (!wellFormed(exactWire)) fail("WIRE_UNICODE");
    const bytes = Buffer.from(exactWire, "utf8");
    if (bytes.byteLength > WINDOWS_PUBLICATION_MAX_WIRE_BYTES)
      fail("WIRE_BOUNDS");
    if (bytes.toString("utf8") !== exactWire) fail("WIRE_UNICODE");
    const parsed = parseWireJson(exactWire);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      fail("WIRE_ENVELOPE");
    return { parsed: parsed as Record<string, unknown>, bytes };
  }

  /** Envelope fields must match the reservation exactly; unknown fields stay
   * bounded-valid JSON for the native grammar owner to rule on. This layer
   * performs identity-envelope validation, not native receipt proof. */
  private checkWireEnvelope(
    wire: Record<string, unknown>,
    reservation: ValidatedReservation,
    phase: DispatchPhase,
    preparedEvidence: unknown,
  ): void {
    if (wire.contractVersion !== 2) fail("WIRE_ENVELOPE");
    if (wire.operation !== phase) fail("WIRE_ENVELOPE");
    if (wire.attemptId !== reservation.attemptId) fail("WIRE_ENVELOPE");
    if (wire.path !== reservation.path) fail("WIRE_ENVELOPE");
    if (wire.root !== reservation.root.canonicalPath) fail("WIRE_ENVELOPE");
    const idField = (name: string, pattern: RegExp, expected: string): void => {
      const value = wire[name];
      if (
        typeof value !== "string" ||
        !pattern.test(value) ||
        !same(value, expected)
      )
        fail("WIRE_ENVELOPE");
    };
    idField("rootFileId", FILE_ID, reservation.root.fileId);
    idField("rootVolumeId", VOLUME_ID, reservation.root.volumeId);
    idField("directoryFileId", FILE_ID, reservation.directory.fileId);
    idField(
      "directoryVolumeId",
      VOLUME_ID,
      reservation.directory.volumeId,
    );
    if ("stagingPath" in wire && wire.stagingPath !== reservation.stagingPath)
      fail("WIRE_ENVELOPE");
    if ("byteLength" in wire && wire.byteLength !== reservation.byteLength)
      fail("WIRE_ENVELOPE");
    if ("sha256" in wire && wire.sha256 !== reservation.sha256)
      fail("WIRE_ENVELOPE");
    if (
      "expectedSha256" in wire &&
      wire.expectedSha256 !== reservation.sha256
    )
      fail("WIRE_ENVELOPE");
    for (const name of ["fileId", "stagingFileId"] as const)
      if (name in wire) requirePattern(wire[name], FILE_ID, "WIRE_ENVELOPE");
    for (const name of ["volumeId", "stagingVolumeId"] as const)
      if (name in wire) {
        const value = requirePattern(
          wire[name],
          VOLUME_ID,
          "WIRE_ENVELOPE",
        );
        if (!same(value, reservation.root.volumeId)) fail("WIRE_ENVELOPE");
      }
    if (phase === "prepare") {
      const base64 = wire.bytesBase64;
      if (typeof base64 !== "string") fail("WIRE_ENVELOPE");
      const decoded = Buffer.from(base64, "base64");
      if (
        decoded.toString("base64") !== base64 ||
        decoded.byteLength !== reservation.byteLength ||
        decoded.byteLength > WINDOWS_PUBLICATION_MAX_BYTES ||
        sha(decoded) !== reservation.sha256
      )
        fail("WIRE_ENVELOPE");
      return;
    }
    if ("bytesBase64" in wire) fail("WIRE_ENVELOPE");
    if (
      typeof preparedEvidence === "object" &&
      preparedEvidence !== null &&
      !Array.isArray(preparedEvidence)
    ) {
      const evidence = preparedEvidence as Record<string, unknown>;
      for (const name of STAGED_IDENTITY_FIELDS) {
        const recorded = evidence[name];
        if (typeof recorded !== "string") continue;
        const current = wire[name];
        if (typeof current !== "string" || !same(current, recorded))
          fail("WIRE_ENVELOPE");
      }
    }
  }

  /**
   * Evidence is caller-validated storage, not a verified native receipt.
   * Common envelope fields are checked for consistency when present; every
   * other field is stored as bounded canonical JSON without interpretation.
   */
  private checkEvidence(
    evidence: unknown,
    reservation: ValidatedReservation,
    expectedOperation: string,
    expectedState: string,
  ): void {
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      Array.isArray(evidence)
    )
      return;
    const record = evidence as Record<string, unknown>;
    const identityField = (expected: ReservationIdentity): void => {
      const field = expected === reservation.root ? "root" : "directory";
      const value = record[field];
      if (value === undefined) return;
      if (typeof value === "string") {
        if (value !== expected.canonicalPath) fail("EVIDENCE");
        return;
      }
      const triple = exactKeys(value, IDENTITY_KEYS, "EVIDENCE");
      if (triple.canonicalPath !== expected.canonicalPath) fail("EVIDENCE");
      const fileId = requirePattern(triple.fileId, FILE_ID, "EVIDENCE");
      const volumeId = requirePattern(
        triple.volumeId,
        VOLUME_ID,
        "EVIDENCE",
      );
      if (!same(fileId, expected.fileId)) fail("EVIDENCE");
      if (!same(volumeId, expected.volumeId)) fail("EVIDENCE");
    };
    if ("version" in record && record.version !== 2) fail("EVIDENCE");
    if ("attemptId" in record && record.attemptId !== reservation.attemptId)
      fail("EVIDENCE");
    if ("path" in record && record.path !== reservation.path)
      fail("EVIDENCE");
    identityField(reservation.root);
    identityField(reservation.directory);
    const folded = (
      name: string,
      pattern: RegExp,
      expected: string,
    ): void => {
      if (!(name in record)) return;
      const value = record[name];
      if (typeof value !== "string" || !pattern.test(value))
        fail("EVIDENCE");
      if (!same(value, expected)) fail("EVIDENCE");
    };
    folded("rootFileId", FILE_ID, reservation.root.fileId);
    folded("rootVolumeId", VOLUME_ID, reservation.root.volumeId);
    folded("directoryFileId", FILE_ID, reservation.directory.fileId);
    folded(
      "directoryVolumeId",
      VOLUME_ID,
      reservation.directory.volumeId,
    );
    if (
      "stagingPath" in record &&
      record.stagingPath !== reservation.stagingPath
    )
      fail("EVIDENCE");
    if ("byteLength" in record && record.byteLength !== reservation.byteLength)
      fail("EVIDENCE");
    if ("sha256" in record && record.sha256 !== reservation.sha256)
      fail("EVIDENCE");
    if (
      "expectedSha256" in record &&
      record.expectedSha256 !== reservation.sha256
    )
      fail("EVIDENCE");
    if ("operation" in record && record.operation !== expectedOperation)
      fail("EVIDENCE");
    if ("state" in record && record.state !== expectedState) fail("EVIDENCE");
    for (const name of ["fileId", "stagingFileId"] as const)
      if (name in record) requirePattern(record[name], FILE_ID, "EVIDENCE");
    for (const name of ["volumeId", "stagingVolumeId"] as const)
      if (name in record) {
        const value = requirePattern(record[name], VOLUME_ID, "EVIDENCE");
        if (!same(value, reservation.root.volumeId)) fail("EVIDENCE");
      }
  }

  private storedReservation(
    body: string,
    attemptId: string,
  ): ValidatedReservation {
    const data = storedCanonical(body, "STATE");
    const reservation = validateReservation(data);
    if (reservation.attemptId !== attemptId || reservation.body !== body)
      fail("STATE");
    return reservation;
  }

  private storedIndex(
    body: string,
    reservation: ValidatedReservation,
  ): void {
    const data = exactKeys(
      storedCanonical(body, "STATE"),
      ["attemptId", "identity"],
      "STATE",
    );
    if (
      data.attemptId !== reservation.attemptId ||
      data.identity !== reservation.identity
    )
      fail("STATE");
  }

  private storedManifest(
    body: string,
    phase: DispatchPhase,
  ): StoredManifest {
    const data = exactKeys(
      storedCanonical(body, "STATE"),
      ["byteLength", "chunkBytes", "chunkCount", "phase", "sha256", "version"],
      "STATE",
    );
    if (
      data.version !== 1 ||
      data.phase !== phase ||
      data.chunkBytes !== CHUNK_BYTES ||
      typeof data.byteLength !== "number" ||
      !Number.isSafeInteger(data.byteLength) ||
      data.byteLength < 1 ||
      data.byteLength > WINDOWS_PUBLICATION_MAX_WIRE_BYTES ||
      typeof data.chunkCount !== "number" ||
      !Number.isSafeInteger(data.chunkCount) ||
      data.chunkCount !== Math.ceil(data.byteLength / CHUNK_BYTES) ||
      typeof data.sha256 !== "string" ||
      !SHA256.test(data.sha256)
    )
      fail("STATE");
    return Object.freeze({
      phase,
      byteLength: data.byteLength,
      sha256: data.sha256,
      chunkCount: data.chunkCount,
    });
  }

  private wireBytes(attemptId: string, manifest: StoredManifest): Buffer {
    const parts: Buffer[] = [];
    for (let index = 0; index < manifest.chunkCount; index++) {
      const raw = this.ledger.read(wireKey(attemptId, manifest.phase, index));
      if (raw === null) fail("STATE");
      const expected =
        index === manifest.chunkCount - 1
          ? manifest.byteLength - (manifest.chunkCount - 1) * CHUNK_BYTES
          : CHUNK_BYTES;
      const decoded = Buffer.from(raw, "base64");
      if (
        decoded.toString("base64") !== raw ||
        decoded.byteLength !== expected
      )
        fail("STATE");
      parts.push(decoded);
    }
    const wire = Buffer.concat(parts);
    if (wire.byteLength !== manifest.byteLength || sha(wire) !== manifest.sha256)
      fail("STATE");
    const text = wire.toString("utf8");
    if (!wellFormed(text) || !Buffer.from(text, "utf8").equals(wire))
      fail("STATE");
    return wire;
  }

  private storedEvidence(body: string, attemptId: string, phase: "prepared" | "terminal"): Record<string, unknown> {
    const data = storedCanonical(body, "STATE") as Record<string, unknown>;
    if (data.version === 1) return data;
    if (data.version === 3) {
      exactKeys(data, ["version", "evidence", ...(phase === "terminal" ? ["outcome"] : [])], "STATE");
      const envelope = data.evidence as Record<string, unknown>, captured = envelope?.captured as Record<string, unknown>;
      if (!captured || typeof captured !== "object") fail("STATE");
      for (const stream of ["stdout", "stderr"]) {
        const ref = captured[stream] as Record<string, unknown>;
        if (!ref || typeof ref !== "object" || !("storage" in ref)) continue;
        exactKeys(ref, ["storage", "byteLength", "sha256", "chunkCount", "encoding"], "STATE");
        if (ref.storage !== "raw-chunks" || typeof ref.byteLength !== "number" || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > WINDOWS_PUBLICATION_MAX_WIRE_BYTES || ref.chunkCount !== Math.ceil(ref.byteLength / CHUNK_BYTES) || (ref.encoding !== "latin1" && ref.encoding !== "utf8")) fail("STATE");
        const pieces: Buffer[] = [];
        for (let i = 0; i < (ref.chunkCount as number); i++) {
          const text = this.ledger.read(attemptKey(attemptId, `${phase}-capture:${stream}:${i}`));
          if (text === null) fail("STATE");
          const bytes = Buffer.from(text, "base64");
          if (bytes.toString("base64") !== text || bytes.length !== Math.min(CHUNK_BYTES, ref.byteLength - i * CHUNK_BYTES)) fail("STATE");
          pieces.push(bytes);
        }
        const bytes = Buffer.concat(pieces);
        if (sha(bytes) !== ref.sha256) fail("STATE");
        const text = bytes.toString(ref.encoding);
        if (!Buffer.from(text, ref.encoding).equals(bytes)) fail("STATE");
        captured[stream] = text;
      }
      return {...data, version: 1};
    }
    const keys = ["version", "storage", "byteLength", "sha256", "chunkCount", ...(phase === "terminal" ? ["outcome"] : [])];
    exactKeys(data, keys, "STATE");
    if (data.version !== 2 || data.storage !== "chunks" || typeof data.byteLength !== "number" ||
        !Number.isSafeInteger(data.byteLength) || data.byteLength < 1 || data.byteLength > 4_500_000 ||
        data.chunkCount !== Math.ceil(data.byteLength / CHUNK_BYTES) || typeof data.sha256 !== "string" || !SHA256.test(data.sha256)) fail("STATE");
    const parts: Buffer[] = [];
    for (let i = 0; i < (data.chunkCount as number); i++) {
      const text = this.ledger.read(attemptKey(attemptId, `${phase}-evidence:${i}`));
      if (text === null) fail("STATE");
      const bytes = Buffer.from(text, "base64");
      if (bytes.toString("base64") !== text || bytes.length !== Math.min(CHUNK_BYTES, data.byteLength - i * CHUNK_BYTES)) fail("STATE");
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    if (sha(bytes) !== data.sha256) fail("STATE");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail("STATE");
    let evidence: unknown;
    try { evidence = JSON.parse(text); if (canonical(evidence, 4_500_000) !== text) fail("STATE"); } catch { fail("STATE"); }
    return {version: 1, evidence, ...(phase === "terminal" ? {outcome: data.outcome} : {})};
  }
  private storedPrepared(body: string, attemptId: string): unknown {
    const data = exactKeys(this.storedEvidence(body, attemptId, "prepared"), ["evidence", "version"], "STATE");
    if (data.version !== 1) fail("STATE");
    return data.evidence;
  }
  private storedTerminal(body: string, attemptId: string): Outcome {
    const data = exactKeys(this.storedEvidence(body, attemptId, "terminal"), ["evidence", "outcome", "version"], "STATE");
    if (data.version !== 1 || !OUTCOMES.has(data.outcome as string)) fail("STATE");
    return data.outcome as Outcome;
  }

  /**
   * Trusted factory snapshot of the shared-source binding, captured once at
   * reservation time — never CLI input and never backfilled onto attempts
   * that predate binding. The bound source root must equal the directory
   * identity, hold shared-runtime.sqlite, sit inside the reservation root and
   * share its volume; IDs and the org/genesis pair are syntax-checked.
   */
  private validateSource(
    data: unknown,
    reservation: ValidatedReservation,
  ): PublicationSourceIdentity {
    const record = exactKeys(
      data,
      ["database", "directory", "genesisHash", "orgId", "root", "sourceRoot"],
      "SOURCE",
    );
    const sourceRoot = requireCanonicalWindowsPath(record.sourceRoot);
    const orgId = requirePattern(record.orgId, ORG_ID, "SOURCE");
    const genesisHash = requirePattern(record.genesisHash, SHA256, "SOURCE");
    const root = requireIdentity(record.root);
    const directory = requireIdentity(record.directory);
    const database = requireIdentity(record.database);
    if (sourceRoot !== directory.canonicalPath) fail("SOURCE_LINK");
    if (
      database.canonicalPath !==
      childOf(sourceRoot, SHARED_RUNTIME_DATABASE)
    )
      fail("SOURCE_LINK");
    if (
      root.canonicalPath !== reservation.root.canonicalPath ||
      !same(root.fileId, reservation.root.fileId) ||
      !same(root.volumeId, reservation.root.volumeId)
    )
      fail("SOURCE_LINK");
    try {
      validateWindowsPath(sourceRoot, root.canonicalPath);
    } catch {
      fail("SOURCE_LINK");
    }
    try {
      validateWindowsPath(database.canonicalPath, root.canonicalPath);
    } catch {
      fail("SOURCE_LINK");
    }
    if (
      !same(directory.volumeId, root.volumeId) ||
      !same(database.volumeId, root.volumeId)
    )
      fail("SOURCE_IDENTITY");
    if (
      same(directory.canonicalPath, root.canonicalPath) &&
      !same(directory.fileId, root.fileId)
    )
      fail("SOURCE_IDENTITY");
    return Object.freeze({
      sourceRoot,
      orgId,
      genesisHash,
      root,
      directory,
      database,
    });
  }

  /** Snapshot the factory callback inside the reservation transaction; the
   * stored body is the canonical JSON itself, bounded like other metadata. */
  private captureSource(reservation: ValidatedReservation): string {
    let raw: unknown;
    try {
      raw = (this.sourceIdentity as () => unknown)();
    } catch {
      fail("SOURCE");
    }
    if (isThenableResult(raw)) fail("SOURCE");
    let body: string;
    try {
      body = canonical(raw, METADATA_BYTES);
    } catch {
      fail("SOURCE");
    }
    this.validateSource(JSON.parse(body) as unknown, reservation);
    return body;
  }

  private storedSource(
    reservation: ValidatedReservation,
    attemptId: string,
  ): PublicationSourceIdentity | null {
    const body = this.ledger.read(attemptKey(attemptId, "source"));
    if (body === null) return null;
    return this.validateSource(storedCanonical(body, "STATE"), reservation);
  }

  /**
   * Verified stage identity, reconstructed only from the retained raw native
   * stdout captured at prepare time. A stored parsed summary, a missing raw
   * capture, non-ASCII or malformed output, or an unverified probe is NOT
   * proof — the result is null while retained rows stay untouched. The commit
   * wire must exist and bind the stage File ID/volume before this counts.
   */
  private stageProof(
    attemptId: string,
    state: DurableAttempt,
  ): PublicationNativeIdentity | null {
    const reservation = state.reservation;
    try {
      const evidence = state.preparedEvidence;
      const record = exactKeys(
        evidence,
        ["captured", "phase", "reply", "status"],
        "STAGE_PROOF",
      );
      if (record.phase !== "prepare" || record.status !== 0) return null;
      const captured = exactKeys(
        record.captured,
        ["captureEncoding", "status", "signal", "stderr", "stdout"],
        "STAGE_PROOF",
      );
      if (
        captured.status !== 0 ||
        captured.signal !== null ||
        captured.stderr !== "" ||
        captured.captureEncoding !== "latin1" ||
        typeof captured.stdout !== "string"
      )
        return null;
      const stdout = captured.stdout;
      const stdoutBytes = Buffer.from(stdout, "latin1");
      if (
        stdoutBytes.byteLength > WINDOWS_PUBLICATION_MAX_WIRE_BYTES ||
        /[^\x09\x0a\x0d\x20-\x7e]/.test(stdout)
      )
        return null;
      const receipt = exactKeys(
        parseWireJson(stdout),
        [
          "attemptId",
          "byteLength",
          "bytesBase64",
          "contentFlushed",
          "contractVersion",
          "directory",
          "file",
          "filesystem",
          "operation",
          "path",
          "root",
          "sha256",
          "stagingPath",
          "state",
        ],
        "STAGE_PROOF",
      );
      if (
        receipt.contractVersion !== 2 ||
        receipt.operation !== "prepare" ||
        receipt.state !== "PREPARED" ||
        receipt.attemptId !== reservation.attemptId ||
        receipt.path !== reservation.path ||
        receipt.stagingPath !== reservation.stagingPath ||
        receipt.root !== reservation.root.canonicalPath ||
        receipt.byteLength !== reservation.byteLength ||
        receipt.sha256 !== reservation.sha256 ||
        receipt.contentFlushed !== true ||
        receipt.filesystem !== "NTFS"
      )
        return null;
      assertWindowsProbe(receipt.file, {
        canonicalPath: reservation.stagingPath,
        canonicalRoot: reservation.root.canonicalPath,
      });
      assertWindowsProbe(receipt.directory, {
        canonicalPath: reservation.directory.canonicalPath,
        canonicalRoot: reservation.root.canonicalPath,
      });
      const file = receipt.file as Record<string, unknown>;
      const directory = receipt.directory as Record<string, unknown>;
      if (
        typeof file.sid !== "string" ||
        !SID.test(file.sid) ||
        file.sid !== directory.sid ||
        typeof file.rootFileId !== "string" ||
        !same(file.rootFileId, reservation.root.fileId) ||
        typeof file.rootVolumeId !== "string" ||
        !same(file.rootVolumeId, reservation.root.volumeId) ||
        typeof directory.rootFileId !== "string" ||
        !same(directory.rootFileId, reservation.root.fileId) ||
        typeof directory.rootVolumeId !== "string" ||
        !same(directory.rootVolumeId, reservation.root.volumeId) ||
        typeof file.volumeId !== "string" ||
        !same(file.volumeId, reservation.root.volumeId) ||
        typeof directory.volumeId !== "string" ||
        !same(directory.volumeId, reservation.directory.volumeId) ||
        typeof directory.fileId !== "string" ||
        !same(directory.fileId, reservation.directory.fileId)
      )
        return null;
      const encoded = receipt.bytesBase64;
      if (typeof encoded !== "string") return null;
      const decoded = Buffer.from(encoded, "base64");
      if (
        decoded.toString("base64") !== encoded ||
        decoded.byteLength !== reservation.byteLength ||
        sha(decoded) !== reservation.sha256
      )
        return null;
      const prepareManifest = state.dispatches.find(
        (dispatch) => dispatch.phase === "prepare",
      );
      const commitManifest = state.dispatches.find(
        (dispatch) => dispatch.phase === "commit-prepared",
      );
      if (prepareManifest === undefined || commitManifest === undefined)
        return null;
      const prepareWire = this.parseWire(
        this.wireBytes(attemptId, prepareManifest).toString("utf8"),
      ).parsed;
      this.checkWireEnvelope(
        prepareWire,
        reservation,
        "prepare",
        evidence,
      );
      const originalEncoded = prepareWire.bytesBase64;
      if (typeof originalEncoded !== "string") return null;
      if (!Buffer.from(originalEncoded, "base64").equals(decoded))
        return null;
      const commitWire = this.parseWire(
        this.wireBytes(attemptId, commitManifest).toString("utf8"),
      ).parsed;
      this.checkWireEnvelope(
        commitWire,
        reservation,
        "commit-prepared",
        evidence,
      );
      const stagedFileIds = [
        commitWire.fileId,
        commitWire.stagingFileId,
      ].filter((value) => typeof value === "string") as string[];
      const stagedVolumeIds = [
        commitWire.volumeId,
        commitWire.stagingVolumeId,
      ].filter((value) => typeof value === "string") as string[];
      if (
        stagedFileIds.length === 0 ||
        stagedFileIds.some(
          (value) => !same(value, file.fileId as string),
        ) ||
        stagedVolumeIds.length === 0 ||
        stagedVolumeIds.some(
          (value) => !same(value, file.volumeId as string),
        )
      )
        return null;
      return Object.freeze({
        canonicalPath: reservation.path,
        fileId: file.fileId as string,
        volumeId: file.volumeId as string,
      });
    } catch {
      return null;
    }
  }

  /**
   * SHA-256 over the canonical ordered list of every original attempt row —
   * (key, byte length, value digest) — plus the target index row. Only the
   * resolution row is excluded so a fingerprint taken before resolve still
   * describes the same evidence afterwards.
   */
  private attemptSnapshotFingerprint(
    attemptId: string,
    reservation: ValidatedReservation,
  ): string {
    const rows = this.ledger.entries(`attempt:${attemptId}:`, 4096);
    const items: { key: string; length: number; sha256: string }[] = [];
    const resolutionKey = attemptKey(attemptId, "resolution");
    for (const row of rows) {
      if (row.key === resolutionKey) continue;
      items.push({
        key: row.key,
        length: Buffer.byteLength(row.value),
        sha256: sha(row.value),
      });
    }
    const target = this.ledger.read(reservation.targetKey);
    if (target === null) fail("STATE");
    items.push({
      key: reservation.targetKey,
      length: Buffer.byteLength(target),
      sha256: sha(target),
    });
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return sha(canonical(items));
  }

  private requireResolutionIdentity(
    value: unknown,
    expected: PublicationNativeIdentity | ReservationIdentity,
  ): PublicationNativeIdentity {
    const identity = requireIdentity(value);
    if (
      identity.canonicalPath !== expected.canonicalPath ||
      !same(identity.fileId, expected.fileId) ||
      !same(identity.volumeId, expected.volumeId)
    )
      fail("RESOLUTION");
    return identity;
  }

  private storedResolution(
    attemptId: string,
    reservation: ValidatedReservation,
    source: PublicationSourceIdentity | null,
    preparedFile: PublicationNativeIdentity | null,
    snapshotFingerprint: string,
  ): PublicationResolutionObservation | null {
    const body = this.ledger.read(attemptKey(attemptId, "resolution"));
    if (body === null) return null;
    if (source === null) fail("STATE");
    const data = exactKeys(
      storedCanonical(body, "STATE"),
      [
        "attemptId",
        "authorization",
        "fingerprint",
        "observed",
        "outcome",
        "preserve",
        "snapshotFingerprint",
        "version",
      ],
      "STATE",
    );
    return this.validateResolution(
      data,
      attemptId,
      reservation,
      source,
      preparedFile,
      snapshotFingerprint,
    );
  }

  /** Strict internal validation of a resolution record — the caller's object
   * is never trusted; observed identities must equal retained proof and the
   * bound fingerprint is recomputed from the snapshot, authorization and
   * observed metadata rather than accepted from the input. */
  private validateResolution(
    data: Record<string, unknown>,
    attemptId: string,
    reservation: ValidatedReservation,
    source: PublicationSourceIdentity,
    preparedFile: PublicationNativeIdentity | null,
    snapshotFingerprint: string,
  ): PublicationResolutionObservation {
    if (
      data.version !== 1 ||
      data.outcome !== "PUBLISHED_OBSERVED" ||
      data.preserve !== true ||
      data.attemptId !== attemptId ||
      data.snapshotFingerprint !== snapshotFingerprint
    )
      fail("RESOLUTION");
    const fingerprint = requirePattern(
      data.fingerprint,
      SHA256,
      "RESOLUTION",
    );
    const authRecord = exactKeys(
      data.authorization,
      ["auth", "cut", "genesisHash", "orgId", "sourceRoot"],
      "RESOLUTION",
    );
    const sourceRoot = requireCanonicalWindowsPath(authRecord.sourceRoot);
    if (sourceRoot !== source.sourceRoot) fail("RESOLUTION");
    const orgId = requirePattern(authRecord.orgId, ORG_ID, "RESOLUTION");
    if (orgId !== source.orgId) fail("RESOLUTION");
    const genesisHash = requirePattern(
      authRecord.genesisHash,
      SHA256,
      "RESOLUTION",
    );
    if (genesisHash !== source.genesisHash) fail("RESOLUTION");
    const session = exactKeys(
      authRecord.auth,
      ["deviceId", "sessionId", "userId", "writerId"],
      "RESOLUTION",
    );
    const cutRecord = exactKeys(
      authRecord.cut,
      ["epoch", "hash", "seq"],
      "RESOLUTION",
    );
    const seq = cutRecord.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)
      fail("RESOLUTION");
    const authorization = Object.freeze({
      sourceRoot,
      orgId,
      genesisHash,
      auth: Object.freeze({
        userId: requirePattern(session.userId, ORG_ID, "RESOLUTION"),
        deviceId: requirePattern(session.deviceId, ORG_ID, "RESOLUTION"),
        writerId: requirePattern(session.writerId, ORG_ID, "RESOLUTION"),
        sessionId: requirePattern(session.sessionId, ORG_ID, "RESOLUTION"),
      }),
      cut: Object.freeze({
        epoch: requirePattern(cutRecord.epoch, ORG_ID, "RESOLUTION"),
        seq,
        hash: requirePattern(cutRecord.hash, SHA256, "RESOLUTION"),
      }),
    });
    const observedRecord = exactKeys(
      data.observed,
      [
        "byteLength",
        "directory",
        "file",
        "root",
        "sha256",
        "sourceDatabase",
        "sourceDirectory",
      ],
      "RESOLUTION",
    );
    const file = requireIdentity(observedRecord.file);
    if (file.canonicalPath !== reservation.path) fail("RESOLUTION");
    if (
      preparedFile === null ||
      !same(file.fileId, preparedFile.fileId) ||
      !same(file.volumeId, preparedFile.volumeId)
    )
      fail("RESOLUTION");
    if (
      observedRecord.byteLength !== reservation.byteLength ||
      observedRecord.sha256 !== reservation.sha256
    )
      fail("RESOLUTION");
    const observed = Object.freeze({
      root: this.requireResolutionIdentity(
        observedRecord.root,
        reservation.root,
      ),
      directory: this.requireResolutionIdentity(
        observedRecord.directory,
        reservation.directory,
      ),
      sourceDirectory: this.requireResolutionIdentity(
        observedRecord.sourceDirectory,
        source.directory,
      ),
      sourceDatabase: this.requireResolutionIdentity(
        observedRecord.sourceDatabase,
        source.database,
      ),
      file,
      byteLength: reservation.byteLength,
      sha256: reservation.sha256,
    });
    const bound = sha(
      canonical({ snapshotFingerprint, authorization, observed }),
    );
    if (fingerprint !== bound) fail("RESOLUTION");
    return Object.freeze({
      version: 1,
      outcome: "PUBLISHED_OBSERVED",
      attemptId,
      snapshotFingerprint,
      fingerprint,
      authorization,
      observed,
      preserve: true,
    });
  }

  /**
   * Fixed-key durable reader: reservation, its matching target index, both
   * phase manifests with fully verified chunks, and the evidence records.
   * Returns metadata internally; wire bytes and evidence never leave.
   */
  private readState(attemptId: string): DurableAttempt | null {
    const body = this.ledger.read(attemptKey(attemptId, "reservation"));
    if (body === null) return null;
    const reservation = this.storedReservation(body, attemptId);
    const index = this.ledger.read(reservation.targetKey);
    if (index === null) fail("STATE");
    this.storedIndex(index, reservation);
    const dispatches: StoredManifest[] = [];
    for (const phase of ["prepare", "commit-prepared"] as const) {
      const raw = this.ledger.read(
        attemptKey(attemptId, `dispatch:${phase}`),
      );
      if (raw === null) continue;
      const manifest = this.storedManifest(raw, phase);
      this.wireBytes(attemptId, manifest);
      dispatches.push(manifest);
    }
    const preparedBody = this.ledger.read(attemptKey(attemptId, "prepared"));
    const preparedEvidence =
      preparedBody === null ? null : this.storedPrepared(preparedBody, attemptId);
    const terminalBody = this.ledger.read(attemptKey(attemptId, "terminal"));
    const terminalOutcome =
      terminalBody === null ? null : this.storedTerminal(terminalBody, attemptId);
    const hasPrepare = dispatches.some((d) => d.phase === "prepare");
    const hasCommit = dispatches.some((d) => d.phase === "commit-prepared");
    if (preparedBody !== null && !hasPrepare) fail("STATE");
    if (hasCommit && (preparedBody === null || !hasPrepare)) fail("STATE");
    if (terminalOutcome === "PUBLISHED" && !hasCommit) fail("STATE");
    const state: AttemptState =
      terminalOutcome ??
      (hasCommit
        ? "COMMIT_DISPATCHED"
        : preparedBody !== null
          ? "PREPARED"
          : hasPrepare
            ? "PREPARE_DISPATCHED"
            : "RESERVED");
    return Object.freeze({
      reservation,
      dispatches: Object.freeze(dispatches),
      preparedBody,
      preparedEvidence,
      terminalBody,
      terminalOutcome,
      state,
    });
  }

  private verifyLifecycleCapacity(attemptId: string): void {
    const budgetBody = this.ledger.read(attemptKey(attemptId, "budget"));
    if (budgetBody === null) fail("CAPACITY");
    const budget = JSON.parse(budgetBody) as ReturnType<typeof lifecycleBudget>;
    const own = this.ledger.entries(`attempt:${attemptId}:`, 4096);
    if (own.length > budget.rows || own.reduce((n, row) => n + Buffer.byteLength(row.value), 0) > budget.bytes) fail("CAPACITY");
    this.admitLifecycle({version: 1, bytes: 0, rows: 0});
  }
  private admitLifecycle(next: ReturnType<typeof lifecycleBudget>, extraBytes = 0, extraRows = 0): void {
    const stats = this.ledger.capacity(), entries = this.ledger.entries("attempt:", 4096);
    let bytes = stats.bytes, rows = stats.rows;
    for (const row of entries.filter(row => row.key.endsWith(":reservation"))) {
      const prefix = row.key.slice(0, -"reservation".length);
      if (!entries.some(e => e.key === prefix + "terminal") && !entries.some(e => e.key === prefix + "budget")) fail("CAPACITY");
    }
    for (const entry of entries.filter(row => row.key.endsWith(":budget"))) {
      const prefix = entry.key.slice(0, -"budget".length);
      if (entries.some(row => row.key === prefix + "terminal")) continue;
      let budget: ReturnType<typeof lifecycleBudget>;
      try {budget = JSON.parse(entry.value);} catch {fail("CAPACITY");}
      if (budget.version !== 1 || !Number.isSafeInteger(budget.bytes) || !Number.isSafeInteger(budget.rows) || budget.bytes <= 0 || budget.rows <= 0) fail("CAPACITY");
      const spent = entries.filter(row => row.key.startsWith(prefix));
      bytes += Math.max(0, budget.bytes - spent.reduce((n, row) => n + Buffer.byteLength(row.value), 0));
      rows += Math.max(0, budget.rows - spent.length);
    }
    if (bytes + next.bytes + extraBytes > stats.maxBytes || rows + next.rows + extraRows > stats.maxRows) fail("CAPACITY");
  }

  reserve(reservation: PublicationReservation): void {
    this.assertUsable();
    const validated = validateReservation(reservation);
    const bound = lexicalPath(this.boundDirectory);
    if (bound !== null)
      for (const candidate of [
        validated.root.canonicalPath,
        validated.directory.canonicalPath,
      ]) {
        const lex = lexicalPath(candidate);
        if (lex !== null && overlapsLexical(bound, lex))
          fail("RESERVATION_ROOT");
      }
    const reservationKey = attemptKey(validated.attemptId, "reservation");
    const sourceKey = attemptKey(validated.attemptId, "source");
    let sourceBody: string | undefined;
    const indexValue = canonical({
      attemptId: validated.attemptId,
      identity: validated.identity,
    });
    const readback = (): void => {
      if (
        this.ledger.read(reservationKey) !== validated.body ||
        this.ledger.read(validated.targetKey) !== indexValue ||
        (sourceBody !== undefined &&
          this.ledger.read(sourceKey) !== sourceBody)
      )
        fail("READBACK");
    };
    this.transact(() => {
      const existing = this.ledger.read(reservationKey);
      if (existing !== null)
        fail(
          existing === validated.body
            ? "ATTEMPT_CONSUMED"
            : "ATTEMPT_REUSED",
        );
      if (this.ledger.read(validated.targetKey) !== null)
        fail("TARGET_CONSUMED");
      const budget = lifecycleBudget(validated.byteLength);
      this.admitLifecycle(budget, Buffer.byteLength(indexValue), 1);
      this.append(attemptKey(validated.attemptId, "budget"), canonical(budget));
      this.append(reservationKey, validated.body);
      this.append(validated.targetKey, indexValue);
      if (this.sourceIdentity !== undefined) {
        sourceBody = this.captureSource(validated);
        this.append(sourceKey, sourceBody);
      }
      this.verifyLifecycleCapacity(validated.attemptId);
      readback();
    }, readback);
    this.owned.set(validated.attemptId, "reserved");
  }

  recordDispatch(
    attemptId: string,
    phase: "prepare" | "commit-prepared",
    exactWire: string,
  ): void {
    this.assertUsable();
    if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId))
      fail("ATTEMPT");
    if (phase !== "prepare" && phase !== "commit-prepared") fail("PHASE");
    const expectedStep: LocalStep =
      phase === "prepare" ? "reserved" : "prepared";
    if (this.owned.get(attemptId) !== expectedStep)
      fail("DISPATCH_AUTHORITY");
    const { parsed: wire, bytes } = this.parseWire(exactWire);
    const expectedState: AttemptState =
      phase === "prepare" ? "RESERVED" : "PREPARED";
    const manifestBody = canonical({
      version: 1,
      phase,
      byteLength: bytes.byteLength,
      sha256: sha(bytes),
      chunkBytes: CHUNK_BYTES,
      chunkCount: Math.ceil(bytes.byteLength / CHUNK_BYTES),
    });
    const manifestKey = attemptKey(attemptId, `dispatch:${phase}`);
    const chunks: string[] = [];
    for (
      let index = 0;
      index * CHUNK_BYTES < bytes.byteLength;
      index++
    )
      chunks.push(
        bytes
          .subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
          .toString("base64"),
      );
    this.transact(() => {
      const state = this.readState(attemptId);
      if (state === null || state.state !== expectedState)
        fail("DISPATCH_STATE");
      if (bytes.byteLength > (phase === "prepare" ? normalWireBound(state.reservation.byteLength) : 8192)) fail("WIRE_CAPABILITY");
      this.checkWireEnvelope(
        wire,
        state.reservation,
        phase,
        state.preparedEvidence,
      );
      this.append(manifestKey, manifestBody);
      for (let index = 0; index < chunks.length; index++)
        this.append(wireKey(attemptId, phase, index), chunks[index]);
      this.verifyLifecycleCapacity(attemptId);
      if (this.ledger.read(manifestKey) !== manifestBody) fail("READBACK");
      for (let index = 0; index < chunks.length; index++)
        if (
          this.ledger.read(wireKey(attemptId, phase, index)) !==
          chunks[index]
        )
          fail("READBACK");
    }, () => {
      const raw = this.ledger.read(manifestKey);
      if (raw === null) fail("READBACK");
      const stored = this.wireBytes(
        attemptId,
        this.storedManifest(raw, phase),
      );
      if (
        stored.byteLength !== bytes.byteLength ||
        !stored.equals(bytes) ||
        stored.toString("utf8") !== exactWire
      )
        fail("READBACK");
    });
    this.owned.set(attemptId, phase);
  }

  private encodeEvidence(outcome: Outcome | undefined, evidence: Json): {snapshot: unknown; body: string; chunks: string[]; rawChunks?: Record<string, string[]>} {
    // G's bounded parsed summary is separate from the exact captured pipes.
    // Externalize the latter before storing JSON so NUL/high bytes cannot
    // amplify evidence beyond the reserved lifecycle capacity.
    const d = evidence && typeof evidence === "object" ? Object.getOwnPropertyDescriptor(evidence, "captured") : undefined;
    const capture = d && "value" in d ? d.value as unknown : undefined;
    if (capture && typeof capture === "object" && !Array.isArray(capture)) {
      let snapshot: unknown;
      try {snapshot = JSON.parse(canonical(evidence, 20_000_000));} catch {fail("EVIDENCE");}
      const stored = structuredClone(snapshot) as Record<string, unknown>, captured = stored.captured as Record<string, unknown>;
      const rawChunks: Record<string, string[]> = {};
      for (const stream of ["stdout", "stderr"]) {
        const text = captured[stream]; if (typeof text !== "string") continue;
        const encoding = captured.captureEncoding === "latin1" ? "latin1" : "utf8";
        const bytes = Buffer.from(text, encoding);
        if (bytes.toString(encoding) !== text || bytes.length > WINDOWS_PUBLICATION_MAX_WIRE_BYTES) fail("EVIDENCE");
        rawChunks[stream] = [];
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) rawChunks[stream].push(bytes.subarray(offset, offset + CHUNK_BYTES).toString("base64"));
        captured[stream] = {storage: "raw-chunks", byteLength: bytes.length, sha256: sha(bytes), chunkCount: rawChunks[stream].length, encoding};
      }
      let body: string;
      try {body = canonical({version: 3, evidence: stored, ...(outcome === undefined ? {} : {outcome})}, METADATA_BYTES);} catch {fail("EVIDENCE");}
      return {snapshot, body, chunks: [], rawChunks};
    }
    let text: string;
    try {text = canonical(evidence, METADATA_BYTES);} catch {fail("EVIDENCE");}
    const snapshot: unknown = JSON.parse(text);
    return {snapshot, body: canonical({version: 1, evidence: snapshot, ...(outcome === undefined ? {} : {outcome})}), chunks: []};
  }
  private appendEvidence(attemptId: string, phase: "prepared" | "terminal", chunks: string[], rawChunks?: Record<string, string[]>): void {
    for (let i = 0; i < chunks.length; i++) this.append(attemptKey(attemptId, `${phase}-evidence:${i}`), chunks[i]);
    for (const [stream, values] of Object.entries(rawChunks ?? {})) for (let i = 0; i < values.length; i++) this.append(attemptKey(attemptId, `${phase}-capture:${stream}:${i}`), values[i]);
  }

  recordPrepared(attemptId: string, evidence: Json): void {
    this.assertUsable();
    if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId))
      fail("ATTEMPT");
    if (this.owned.get(attemptId) !== "prepare") fail("DISPATCH_AUTHORITY");
    const { snapshot, body, chunks, rawChunks } = this.encodeEvidence(undefined, evidence);
    const key = attemptKey(attemptId, "prepared");
    this.transact(() => {
      const state = this.readState(attemptId);
      if (state === null || state.state !== "PREPARE_DISPATCHED")
        fail("DISPATCH_STATE");
      const envelope = snapshot as Record<string, unknown> | null;
      const captured = envelope && typeof envelope === "object" ? envelope.captured as Record<string, unknown> | undefined : undefined;
      if (captured && typeof captured === "object") {
        const encoding = captured.captureEncoding === "latin1" ? "latin1" : "utf8";
        if (typeof captured.stdout !== "string" || captured.stderr !== "" ||
            Buffer.byteLength(captured.stdout, encoding) > 4 * Math.ceil(state.reservation.byteLength / 3) + 16384) fail("EVIDENCE");
      }
      this.checkEvidence(
        snapshot,
        state.reservation,
        "prepare",
        "PREPARED",
      );
      this.appendEvidence(attemptId, "prepared", chunks, rawChunks);
      this.append(key, body);
      this.verifyLifecycleCapacity(attemptId);
      if (this.ledger.read(key) !== body) fail("READBACK");
    }, () => {
      if (this.ledger.read(key) !== body) fail("READBACK");
      this.readState(attemptId);
    });
    this.owned.set(attemptId, "prepared");
  }

  recordTerminal(
    attemptId: string,
    outcome: "PUBLISHED" | "UNKNOWN" | "REJECTED",
    evidence: Json,
  ): void {
    this.assertUsable();
    if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId))
      fail("ATTEMPT");
    if (!OUTCOMES.has(outcome)) fail("OUTCOME");
    const { snapshot, body, chunks, rawChunks } = this.encodeEvidence(outcome, evidence);
    const key = attemptKey(attemptId, "terminal");
    this.transact(() => {
      const state = this.readState(attemptId);
      if (state === null) fail("TERMINAL_STATE");
      if (state.terminalBody !== null) fail("TERMINAL");
      if (!this.owned.has(attemptId)) fail("TERMINAL_AUTHORITY");
      if (outcome === "PUBLISHED" && state.state !== "COMMIT_DISPATCHED")
        fail("TERMINAL_STATE");
      const lastPhase =
        state.dispatches.length === 0
          ? "prepare"
          : state.dispatches[state.dispatches.length - 1].phase;
      this.checkEvidence(
        snapshot,
        state.reservation,
        lastPhase,
        outcome,
      );
      this.appendEvidence(attemptId, "terminal", chunks, rawChunks);
      this.append(key, body);
      this.verifyLifecycleCapacity(attemptId);
      if (this.ledger.read(key) !== body) fail("READBACK");
    }, () => {
      if (this.ledger.read(key) !== body) fail("READBACK");
      this.readState(attemptId);
    });
    this.owned.delete(attemptId);
  }

  private buildInspection(state: DurableAttempt): WindowsPublicationInspection {
    const reservation = state.reservation;
    return Object.freeze({
      reservation: Object.freeze({
        contractVersion: 2 as const,
        attemptId: reservation.attemptId,
        path: reservation.path,
        stagingPath: reservation.stagingPath,
        root: Object.freeze({
          canonicalPath: reservation.root.canonicalPath,
          fileId: reservation.root.fileId,
          volumeId: reservation.root.volumeId,
        }),
        directory: Object.freeze({
          canonicalPath: reservation.directory.canonicalPath,
          fileId: reservation.directory.fileId,
          volumeId: reservation.directory.volumeId,
        }),
        byteLength: reservation.byteLength,
        sha256: reservation.sha256,
      }),
      state: state.state,
      dispatches: Object.freeze(
        state.dispatches.map((dispatch) =>
          Object.freeze({
            phase: dispatch.phase,
            byteLength: dispatch.byteLength,
            sha256: dispatch.sha256,
            chunkCount: dispatch.chunkCount,
          }),
        ),
      ),
      prepared:
        state.preparedBody === null
          ? null
          : Object.freeze({
              byteLength: Buffer.byteLength(state.preparedBody, "utf8"),
              sha256: sha(state.preparedBody),
            }),
      terminal:
        state.terminalBody === null
          ? null
          : Object.freeze({
              outcome: state.terminalOutcome as Outcome,
              byteLength: Buffer.byteLength(state.terminalBody, "utf8"),
              sha256: sha(state.terminalBody),
            }),
    });
  }

  /** Metadata-only bounded observation: fixed keys, never wire or evidence. */
  inspect(attemptId: string): WindowsPublicationInspection | null {
    this.assertUsable();
    if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId))
      fail("ATTEMPT");
    return this.transact(() => {
      const state = this.readState(attemptId);
      if (state === null) return null;
      return this.buildInspection(state);
    });
  }

  /**
   * Sanitized investigation metadata for the resolution port: the existing
   * metadata-only inspection, a snapshot fingerprint over every original row
   * (including the target index, excluding only the resolution row), the
   * retained source binding, the stage identity proven by retained raw native
   * output, and any recorded resolution. Bytes, raw captures, parsed replies
   * and tokens never leave. Live-owned attempts report no stage proof: an
   * in-flight owner must finish its own lifecycle before anyone observes.
   */
  investigate(attemptId: string): Readonly<{
    inspection: WindowsPublicationInspection;
    snapshotFingerprint: string;
    source: PublicationSourceIdentity | null;
    preparedFile: PublicationNativeIdentity | null;
    resolution: PublicationResolutionObservation | null;
  }> | null {
    this.assertUsable();
    if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId))
      fail("ATTEMPT");
    return this.transact(() => {
      const state = this.readState(attemptId);
      if (state === null) return null;
      const snapshotFingerprint = this.attemptSnapshotFingerprint(
        attemptId,
        state.reservation,
      );
      const source = this.storedSource(state.reservation, attemptId);
      const preparedFile = this.owned.has(attemptId)
        ? null
        : this.stageProof(attemptId, state);
      const resolution = this.storedResolution(
        attemptId,
        state.reservation,
        source,
        preparedFile,
        snapshotFingerprint,
      );
      return Object.freeze({
        inspection: this.buildInspection(state),
        snapshotFingerprint,
        source,
        preparedFile,
        resolution,
      });
    });
  }

  /**
   * Appends the single immutable resolution observation for an eligible
   * attempt (UNKNOWN or COMMIT_DISPATCHED with a verified commit dispatch),
   * called only after the service validated a fresh native read. The journal
   * re-derives everything itself: the snapshot fingerprint, the retained
   * source/stage/commit proof, the observed identities, the bound
   * fingerprint, and a fresh authorization taken synchronously inside this
   * transaction immediately before the append. An existing identical
   * resolution returns read-only; a differing one is refused. Nothing is
   * cleaned, replayed or freed — the lifecycle reservation stays charged.
   */
  appendResolution(
    attemptId: string,
    snapshotFingerprint: string,
    observation: PublicationResolutionObservation,
    currentAuthorization: CurrentPublicationAuthorization,
  ): PublicationResolutionObservation {
    this.assertUsable();
    if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId))
      fail("ATTEMPT");
    if (
      typeof snapshotFingerprint !== "string" ||
      !SHA256.test(snapshotFingerprint)
    )
      fail("SNAPSHOT");
    if (
      typeof currentAuthorization !== "function" ||
      utilTypes.isAsyncFunction(currentAuthorization) ||
      utilTypes.isGeneratorFunction(currentAuthorization)
    )
      fail("AUTHORIZATION");
    let body: string;
    try {
      body = canonical(observation, RESOLUTION_BYTES);
    } catch {
      fail("RESOLUTION");
    }
    const resolutionKey = attemptKey(attemptId, "resolution");
    let expected: string | null = null;
    const result = this.transact(() => {
      const state = this.readState(attemptId);
      if (state === null) fail("ATTEMPT");
      if (this.owned.has(attemptId)) fail("RESOLUTION_AUTHORITY");
      if (
        (state.state !== "UNKNOWN" &&
          state.state !== "COMMIT_DISPATCHED") ||
        !state.dispatches.some(
          (dispatch) => dispatch.phase === "commit-prepared",
        )
      )
        fail("RESOLUTION_STATE");
      if (
        this.attemptSnapshotFingerprint(attemptId, state.reservation) !==
        snapshotFingerprint
      )
        fail("SNAPSHOT");
      const source = this.storedSource(state.reservation, attemptId);
      if (source === null) fail("SOURCE");
      const preparedFile = this.stageProof(attemptId, state);
      if (preparedFile === null) fail("PROOF");
      const parsed = exactKeys(
        storedCanonical(body, "RESOLUTION"),
        [
          "attemptId",
          "authorization",
          "fingerprint",
          "observed",
          "outcome",
          "preserve",
          "snapshotFingerprint",
          "version",
        ],
        "RESOLUTION",
      );
      const validated = this.validateResolution(
        parsed,
        attemptId,
        state.reservation,
        source,
        preparedFile,
        snapshotFingerprint,
      );
      let fresh: unknown;
      try {
        fresh = currentAuthorization();
      } catch {
        fail("AUTHORIZATION");
      }
      if (isThenableResult(fresh)) fail("AUTHORIZATION");
      let freshBody: string;
      try {
        freshBody = canonical(fresh, RESOLUTION_BYTES);
      } catch {
        fail("AUTHORIZATION");
      }
      if (freshBody !== canonical(validated.authorization))
        fail("AUTHORIZATION");
      const existing = this.ledger.read(resolutionKey);
      if (existing !== null) {
        expected = existing;
        const stored = this.storedResolution(
          attemptId,
          state.reservation,
          source,
          preparedFile,
          snapshotFingerprint,
        );
        if (
          stored !== null &&
          canonical({
            attemptId: stored.attemptId,
            observed: stored.observed,
            snapshotFingerprint: stored.snapshotFingerprint,
          }) ===
            canonical({
              attemptId: validated.attemptId,
              observed: validated.observed,
              snapshotFingerprint: validated.snapshotFingerprint,
            })
        )
          return stored;
        fail("RESOLUTION_CONFLICT");
      }
      this.admitLifecycle(
        { version: 1, bytes: 0, rows: 0 },
        Buffer.byteLength(body),
        1,
      );
      this.append(resolutionKey, body);
      this.verifyLifecycleCapacity(attemptId);
      if (this.ledger.read(resolutionKey) !== body) fail("READBACK");
      expected = body;
      return validated;
    }, () => {
      if (
        expected === null ||
        this.ledger.read(resolutionKey) !== expected
      )
        fail("READBACK");
    });
    return result;
  }

  /**
   * Delegates to the ledger's aggregated db+platform close. Once closing is
   * entered, every operation stays blocked until an explicit retry completes;
   * nothing else may act on the process or filesystem from here.
   */
  close(): void {
    if (this.closed) return;
    this.closing = true;
    this.ledger.close();
    this.closed = true;
  }
}
