import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { sqliteHeader } from "../../persistence/sqlite-header";
import { synchronousPort } from "../../platform/synchronous-port";
import type {
  PublicationAuthorization,
  PublicationResolutionPort,
} from "../../platform/windows/publication-resolution";
import { pinPrivateRoot } from "../../sync/m3-private-root";
import { SharedAuthority } from "./authority";
import { validateRuntimeBackup, type RuntimeBackup } from "./backup";
import { canonical } from "./canonical";
import {
  CollaborationError,
  identifier,
  safeCounter,
  wellFormed,
  type Cut,
  type Scope,
} from "./contract";
import { SharedMaintenance } from "./maintenance";
import {
  createSharedOperatorContext,
  readSharedOperatorFile,
  type SharedOperatorFilePort,
  type SharedOperatorPorts,
} from "./operator-files";
import type { BackupVerification } from "./retention";
import { RetentionHostRegistry } from "./retention-host-environment";
import type { RetentionArtifactStore, RetentionHoldSelection } from "./retention-release";
import {
  RuntimeStore,
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
} from "./store";

const ACTIONS = [
  "preview",
  "dependencies-preview",
  "verify",
  "compact",
  "upgrade",
  "collect-preview",
  "collect",
  "staging-preview",
  "staging-abandon",
  "publication-inspect",
  "publication-resolve",
  "retention-preview",
  "retention-export",
  "retention-release",
] as const;

type Action = (typeof ACTIONS)[number];

const ACTION_VALUES: Readonly<Record<Action, readonly string[]>> = {
  "retention-preview": ["workspace", "document", "incarnation", "expected-cut", "holds"],
  "retention-export": ["workspace", "document", "incarnation", "expected-cut", "holds", "fingerprint", "destination"],
  "retention-release": ["workspace", "document", "incarnation", "expected-cut", "holds", "fingerprint", "artifact", "artifact-hash", "ack-artifact-hash"],
  "staging-preview": ["workspace", "document", "incarnation"],
  "staging-abandon": ["workspace", "document", "incarnation", "writer", "copy-id", "manifest-hash", "expected-cut"],
  "dependencies-preview": ["expected-cut"],
  preview: [],
  verify: ["destination", "epoch"],
  compact: ["destination", "epoch", "backup"],
  upgrade: ["destination", "epoch"],
  "collect-preview": ["workspace", "document", "incarnation"],
  collect: [
    "workspace",
    "document",
    "incarnation",
    "expected-cut",
    "hashes",
  ],
  "publication-inspect": ["attempt", "expected-cut"],
  "publication-resolve": ["attempt", "expected-cut", "fingerprint"],
};
const OPTIONAL_VALUES: Readonly<Record<Action, readonly string[]>> = {
  "retention-preview": [],
  "retention-export": [],
  "retention-release": [],
  "staging-preview": [],
  "staging-abandon": [],
  "dependencies-preview": [],
  preview: [],
  verify: ["backup"],
  compact: [],
  upgrade: [],
  "collect-preview": [],
  collect: [],
  "publication-inspect": [],
  "publication-resolve": [],
};
const BASE_VALUES = ["root", "org", "token-file", "action"] as const;

const MAX_PATH_LENGTH = 4_096;
const MAX_ARGUMENT_LENGTH = 1_000_000;
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 256;
const MAX_HASHES_ARGUMENT = 1_000_000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;
const PUBLICATION_RESOLUTION_CONTRACT = {
  inspect: { result: "object" },
  resolve: { result: "object" },
} as const;

export type MaintenanceOperatorPorts = SharedOperatorPorts &
  Readonly<{
    nativePublication?: PublicationResolutionPort;
    /** Host-owned registry only; no CLI coverage/roster flags are accepted. */
    retentionHost?: RetentionHostRegistry;
    /**
     * Trusted offline host factory, bound to the just-opened authority.
     * Synchronous only; used when no live registry was injected. The
     * returned close() releases any stores/leases the factory opened.
     */
    retentionHostFactory?: (authority: SharedAuthority) => Readonly<{
      host: RetentionHostRegistry;
      close(): void;
    }>;
  }>;

export type MaintenanceOperatorHandle = Readonly<{
  state: "maintained";
  result: unknown;
  close(): Promise<void>;
}>;

type BackupArtifactVerifier = Readonly<{
  verifyBackupArtifact(
    token: string,
    orgId: string,
    backup: RuntimeBackup,
    destination: RuntimeStore,
    newEpoch: string,
  ): BackupVerification;
}>;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function invalidArguments(): never {
  return fail("INVALID_ARGUMENT");
}

function normalize(error: unknown, fallback: string): never {
  if (error instanceof CollaborationError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(message))
    throw new CollaborationError(message);
  if (/m3-private-root-unsafe/i.test(message))
    throw new CollaborationError("UNSAFE_ROOT");
  if (/SQLite header/i.test(message))
    throw new CollaborationError("NOT_SHARED_RUNTIME_FORMAT");
  throw new CollaborationError(fallback);
}

function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

function parseArguments(args: string[]): Map<string, string> {
  if (!Array.isArray(args) || args.length === 0) invalidArguments();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.includes("\0") ||
      !argument.startsWith("--") ||
      argument === "--"
    )
      invalidArguments();
    const name = argument.slice(2);
    if (values.has(name)) invalidArguments();
    const raw = args[++index];
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > MAX_ARGUMENT_LENGTH ||
      raw.includes("\0") ||
      raw.startsWith("--") ||
      !wellFormed(raw)
    )
      invalidArguments();
    values.set(name, raw);
  }
  const action = values.get("action");
  if (action === undefined || !isAction(action)) invalidArguments();
  const allowed = new Set<string>([
    ...BASE_VALUES,
    ...ACTION_VALUES[action],
    ...OPTIONAL_VALUES[action],
  ]);
  for (const name of values.keys())
    if (!allowed.has(name)) invalidArguments();
  for (const name of BASE_VALUES) if (!values.has(name)) invalidArguments();
  for (const name of ACTION_VALUES[action])
    if (!values.has(name)) invalidArguments();
  return values;
}

function value(values: Map<string, string>, name: string): string {
  const found = values.get(name);
  if (found === undefined) invalidArguments();
  return found;
}

function id(raw: string): string {
  try {
    return identifier(raw);
  } catch {
    return invalidArguments();
  }
}

function absolutePath(raw: string): string {
  if (
    raw.length === 0 ||
    raw.length > MAX_PATH_LENGTH ||
    raw.includes("\0") ||
    !isAbsolute(raw)
  )
    invalidArguments();
  return resolve(raw);
}

function currentUid(): number {
  const getuid = process.getuid;
  if (typeof getuid !== "function") fail("UNSAFE_FILE_OWNER");
  let uid: unknown;
  try {
    uid = getuid.call(process);
  } catch {
    return fail("UNSAFE_FILE_OWNER");
  }
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0)
    fail("UNSAFE_FILE_OWNER");
  return uid;
}

function optionalStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function inside(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const rest = relative(parent, candidate);
  return (
    rest !== "" &&
    rest !== ".." &&
    !rest.startsWith(".." + sep) &&
    !isAbsolute(rest)
  );
}

function canonicalCandidate(raw: string): string {
  const absolute = resolve(raw);
  const tail: string[] = [];
  let current = absolute;
  for (let depth = 0; depth < MAX_PATH_LENGTH; depth++) {
    try {
      const found = realpathSync(current);
      return tail.length === 0 ? found : join(found, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return fail("INVALID_PATH");
      const parent = dirname(current);
      if (parent === current) return fail("INVALID_PATH");
      tail.push(basename(current));
      current = parent;
    }
  }
  return fail("INVALID_PATH");
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.nlink === 1 &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

type PinnedFile = Readonly<{ fd: number; path: string; stat: Stats }>;

function openPinnedFile(
  path: string,
  maxBytes: number,
  code: string,
  privateFile: boolean,
): PinnedFile {
  const uid = privateFile ? currentUid() : undefined;
  let listed: Stats;
  try {
    listed = lstatSync(path);
  } catch {
    return fail(code);
  }
  if (
    !listed.isFile() ||
    listed.isSymbolicLink() ||
    listed.nlink !== 1 ||
    listed.size <= 0 ||
    listed.size > maxBytes
  )
    fail(code);
  if (
    privateFile &&
    (listed.uid !== uid || (listed.mode & 0o777) !== PRIVATE_FILE_MODE)
  )
    fail(code);

  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW || 0) |
        (constants.O_NONBLOCK || 0),
    );
  } catch {
    return fail(code);
  }
  try {
    const opened = fstatSync(descriptor);
    if (
      !sameFile(listed, opened) ||
      opened.size !== listed.size ||
      opened.size > maxBytes
    )
      fail(code);
    if (
      privateFile &&
      (opened.uid !== uid || (opened.mode & 0o777) !== PRIVATE_FILE_MODE)
    )
      fail(code);
    return { fd: descriptor, path, stat: opened };
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {}
    throw error;
  }
}

function readPinnedFile(
  path: string,
  maxBytes: number,
  code: string,
  privateFile: boolean,
): Buffer {
  const file = openPinnedFile(path, maxBytes, code, privateFile);
  try {
    const buffer = Buffer.alloc(file.stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(
        file.fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (read <= 0) fail(code);
      offset += read;
    }
    const after = fstatSync(file.fd);
    if (!sameFile(file.stat, after)) fail(code);
    const listed = lstatSync(file.path);
    if (!sameFile(file.stat, listed)) fail(code);
    return buffer;
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    return fail(code);
  } finally {
    try {
      closeSync(file.fd);
    } catch {}
  }
}

function decodeText(bytes: Buffer, code: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(code);
  }
  if (!wellFormed(text)) fail(code);
  return text;
}

function tokenText(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH ||
    !wellFormed(value)
  )
    fail(code);
  return value;
}

function readTokenFile(
  rawPath: string,
  files?: SharedOperatorFilePort,
): string {
  const path = absolutePath(rawPath);
  const bytes = files
    ? readSharedOperatorFile(files, path, MAX_TOKEN_BYTES, "INVALID_TOKEN_FILE")
    : readPinnedFile(path, MAX_TOKEN_BYTES, "INVALID_TOKEN_FILE", true);
  const text = decodeText(bytes, "INVALID_TOKEN_FILE").trim();
  if (!text.startsWith("{")) return tokenText(text, "INVALID_TOKEN_FILE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("INVALID_TOKEN_FILE");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (Object.getPrototypeOf(parsed) !== Object.prototype &&
      Object.getPrototypeOf(parsed) !== null)
  )
    fail("INVALID_TOKEN_FILE");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !keys.includes("token") ||
    !keys.every((key) => key === "token" || key === "recoveryKey")
  )
    fail("INVALID_TOKEN_FILE");
  const token = tokenText(record.token, "INVALID_TOKEN_FILE");
  if (Object.hasOwn(record, "recoveryKey"))
    tokenText(record.recoveryKey, "INVALID_TOKEN_FILE");
  return token;
}

function readBackupFile(
  rawPath: string,
  files?: SharedOperatorFilePort,
): RuntimeBackup {
  const path = absolutePath(rawPath);
  const bytes = files
    ? readSharedOperatorFile(
        files,
        path,
        MAX_BACKUP_BYTES,
        "INVALID_BACKUP_FILE",
      )
    : readPinnedFile(path, MAX_BACKUP_BYTES, "INVALID_BACKUP_FILE", true);
  const text = decodeText(bytes, "INVALID_BACKUP_FILE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("INVALID_BACKUP_FILE");
  }
  const backup = validateRuntimeBackup(parsed);
  let encoded: string;
  try {
    encoded = canonical(parsed, MAX_BACKUP_BYTES);
  } catch {
    return fail("INVALID_BACKUP_FILE");
  }
  if (encoded !== text) fail("INVALID_BACKUP_FILE");
  return backup;
}

function assertSourceRoot(rawRoot: string): string {
  const absolute = absolutePath(rawRoot);
  const listed = optionalStat(absolute);
  if (listed === undefined) fail("ROOT_MISSING");
  if (listed.isSymbolicLink() || !listed.isDirectory()) fail("INVALID_ROOT");
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(absolute);
  } catch {
    return fail("INVALID_ROOT");
  }

  let rootUid: number;
  try {
    rootUid = pinPrivateRoot(canonicalRoot).uid;
  } catch {
    return fail("UNSAFE_ROOT");
  }

  const database = join(canonicalRoot, SHARED_RUNTIME_FILE);
  const databaseStat = optionalStat(database);
  if (databaseStat === undefined) fail("NOT_BOOTSTRAPPED");
  if (
    databaseStat.isSymbolicLink() ||
    !databaseStat.isFile() ||
    databaseStat.nlink !== 1
  )
    fail("INVALID_ROOT");
  if (databaseStat.uid !== rootUid || (databaseStat.mode & 0o077) !== 0)
    fail("UNSAFE_ROOT");

  let header: ReturnType<typeof sqliteHeader> | undefined;
  try {
    header = sqliteHeader(database);
  } catch {
    return fail("NOT_SHARED_RUNTIME_FORMAT");
  }
  if (
    !header ||
    header.version !== SHARED_RUNTIME_VERSION ||
    header.applicationId !== SHARED_RUNTIME_APPLICATION_ID
  )
    fail("NOT_SHARED_RUNTIME_FORMAT");
  return canonicalRoot;
}

function assertDestination(
  rawDestination: string,
  sourceRoot: string,
): string {
  const absolute = absolutePath(rawDestination);
  if (optionalStat(absolute) !== undefined) fail("DESTINATION_EXISTS");
  const name = basename(absolute);
  if (name === "" || name === "." || name === "..") invalidArguments();
  const parent = dirname(absolute);
  if (parent === absolute) invalidArguments();
  const canonicalParent = canonicalCandidate(parent);

  let pinnedParent: ReturnType<typeof pinPrivateRoot>;
  try {
    pinnedParent = pinPrivateRoot(canonicalParent);
  } catch {
    return fail("UNSAFE_DESTINATION_PARENT");
  }
  const target = join(pinnedParent.path, name);
  if (optionalStat(target) !== undefined) fail("DESTINATION_EXISTS");
  if (inside(sourceRoot, target) || inside(target, sourceRoot))
    fail("DESTINATION_INSIDE_ROOT");
  return target;
}

function createDestination(target: string): void {
  try {
    mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return fail("DESTINATION_EXISTS");
    return fail("DESTINATION_CREATE_FAILED");
  }
  try {
    chmodSync(target, PRIVATE_DIRECTORY_MODE);
    const pin = pinPrivateRoot(target);
    if (pin.path !== target) fail("UNSAFE_DESTINATION");
  } catch (error) {
    return normalize(error, "UNSAFE_DESTINATION");
  }
}

function parseExpectedCut(raw: string): Cut {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("INVALID_EXPECTED_CUT");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (Object.getPrototypeOf(parsed) !== Object.prototype &&
      Object.getPrototypeOf(parsed) !== null)
  )
    fail("INVALID_EXPECTED_CUT");
  let encoded: string;
  try {
    encoded = canonical(parsed);
  } catch {
    return fail("INVALID_EXPECTED_CUT");
  }
  if (encoded !== raw) fail("INVALID_EXPECTED_CUT");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "epoch" ||
    keys[1] !== "hash" ||
    keys[2] !== "seq"
  )
    fail("INVALID_EXPECTED_CUT");
  let seq: number;
  try {
    seq = safeCounter(record.seq);
  } catch {
    return fail("INVALID_EXPECTED_CUT");
  }
  if (typeof record.hash !== "string" || !HASH_PATTERN.test(record.hash))
    fail("INVALID_EXPECTED_CUT");
  let epoch: string;
  try {
    epoch = identifier(record.epoch);
  } catch {
    return fail("INVALID_EXPECTED_CUT");
  }
  return { epoch, seq, hash: record.hash };
}

function parseHashes(raw: string): string[] {
  if (raw.length > MAX_HASHES_ARGUMENT) invalidArguments();
  const parts = raw.split(",");
  if (!parts.every((part) => HASH_PATTERN.test(part)))
    fail("INVALID_HASHES");
  const sorted = [...new Set(parts)].sort();
  if (sorted.length !== parts.length) fail("DUPLICATE_REFERENCE");
  return sorted;
}

function parseHolds(raw: string): RetentionHoldSelection[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail("INVALID_RELEASE_HOLDS"); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32 ||
      canonical(parsed) !== raw)
    return fail("INVALID_RELEASE_HOLDS");
  return parsed.map((item) => {
    if (!item || typeof item !== "object" ||
        Object.keys(item).sort().join(",") !== "hash,holdId" ||
        typeof item.hash !== "string" || !HASH_PATTERN.test(item.hash))
      return fail("INVALID_RELEASE_HOLDS");
    return { hash: item.hash, holdId: id(item.holdId) };
  });
}

/** Artifact acknowledgment never opens a foreign DB writable. Incomplete
 * recovery/sidecars are retained for investigation, not rolled back here. */
function openRetentionArtifact(root: string, files?: SharedOperatorFilePort): RetentionArtifactStore {
  const path = join(root, SHARED_RUNTIME_FILE);
  for (const suffix of ["-journal", "-wal", "-shm"])
    if (optionalStat(path + suffix) !== undefined)
      fail("RETENTION_ARTIFACT_RECOVERY_REQUIRED");
  const read = () => files
    ? readSharedOperatorFile(files, path, 16_000_000, "RETENTION_ARTIFACT_INVALID")
    : readPinnedFile(path, 16_000_000, "RETENTION_ARTIFACT_INVALID", true);
  const original = createHash("sha256").update(read()).digest("hex");
  const assertUnchanged = () => {
    if (createHash("sha256").update(read()).digest("hex") !== original)
      fail("RETENTION_ARTIFACT_CHANGED");
  };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000");
    const row = db.prepare("SELECT raw FROM runtime_records WHERE namespace='meta' AND key='role'").get();
    if (!row || row.raw !== canonical("retention-recovery"))
      fail("RETENTION_ARTIFACT_INVALID");
    const totals = db.prepare(`SELECT
      (SELECT count(*) FROM runtime_records) AS records,
      (SELECT count(*) FROM runtime_blobs) AS blobs,
      (SELECT coalesce(sum(length(CAST(raw AS BLOB))),0) FROM runtime_records) +
      (SELECT coalesce(sum(length(bytes)),0) FROM runtime_blobs) AS bytes`).get()!;
    if (Number(totals.records) !== 2 || Number(totals.blobs) > 32 ||
        Number(totals.bytes) > 8_000_000)
      fail("RETENTION_ARTIFACT_LIMIT");
    assertUnchanged();
  } catch (error) {
    try { db.close(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], "UNKNOWN: artifact open cleanup");
    }
    throw error;
  }
  const decode = (raw: unknown): unknown => {
    if (typeof raw !== "string") return fail("RETENTION_ARTIFACT_INVALID");
    const value: unknown = JSON.parse(raw);
    if (canonical(value) !== raw) return fail("RETENTION_ARTIFACT_INVALID");
    return value;
  };
  const readonly = (): never => fail("RETENTION_ARTIFACT_READ_ONLY");
  return {
    path, db,
    transaction<T>(work: () => T): T {
      assertUnchanged();
      if (db.isTransaction) return work();
      db.exec("BEGIN");
      let value: T;
      try { value = work(); assertUnchanged(); }
      catch (error) {
        try { db.exec("ROLLBACK"); } catch (cleanup) {
          throw new AggregateError([error, cleanup], "UNKNOWN: artifact rollback");
        }
        throw error;
      }
      db.exec("COMMIT");
      return value;
    },
    get(namespace, key) {
      const row = db.prepare("SELECT raw FROM runtime_records WHERE namespace=? AND key=?").get(namespace, key);
      return row ? decode(row.raw) : null;
    },
    all(namespace) {
      return db.prepare("SELECT key,raw FROM runtime_records WHERE namespace=? ORDER BY key").all(namespace)
        .map((row) => ({ key: String(row.key), value: decode(row.raw) }));
    },
    blobGet(scope, hash) {
      const row = db.prepare("SELECT bytes FROM runtime_blobs WHERE scope=? AND hash=?").get(scope, hash);
      if (!row) return null;
      if (!(row.bytes instanceof Uint8Array) ||
          createHash("sha256").update(row.bytes).digest("hex") !== hash)
        return fail("RETENTION_ARTIFACT_INVALID");
      return new Uint8Array(row.bytes);
    },
    set: readonly, blobPut: readonly, blobDelete: readonly,
    close() { db.close(); },
  };
}

function sameCut(left: Cut, right: Cut): boolean {
  return (
    left.epoch === right.epoch &&
    left.seq === right.seq &&
    left.hash === right.hash
  );
}

function sameHashes(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((hash, index) => hash === right[index])
  );
}

function unknownOutcome(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof CollaborationError)
    return error.code === "UNKNOWN" || error.code.endsWith("_UNKNOWN");
  return /UNKNOWN/.test(error.message);
}

function verifyArtifact(
  authority: SharedAuthority,
  token: string,
  orgId: string,
  backup: RuntimeBackup,
  destination: RuntimeStore,
  newEpoch: string,
): BackupVerification {
  const verifier = authority as unknown as Partial<BackupArtifactVerifier>;
  const method = verifier.verifyBackupArtifact;
  if (typeof method !== "function")
    fail("BACKUP_ARTIFACT_VERIFICATION_UNAVAILABLE");
  return method.call(authority, token, orgId, backup, destination, newEpoch);
}

function closeOpened(stores: readonly { close(): void }[]): void {
  const failures: unknown[] = [];
  for (const store of [...stores].reverse()) {
    try {
      store.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new Error("UNKNOWN: maintenance resource cleanup", {
      cause: new AggregateError(failures),
    });
}

export async function runMaintenanceOperator(
  args: string[],
  ports: MaintenanceOperatorPorts = {},
): Promise<MaintenanceOperatorHandle> {
  const context = createSharedOperatorContext(
    ports,
    "WINDOWS_MAINTENANCE_OPERATOR_UNSUPPORTED",
  );
  const files = context.privateFiles;

  const values = parseArguments(args);
  const action = value(values, "action") as Action;
  const retentionAction = action === "retention-preview" ||
    action === "retention-export" || action === "retention-release";
  const orgId = id(value(values, "org"));
  const sourceOptions = context.storeOptions(
    absolutePath(value(values, "root")),
    true,
  );
  const sourceRoot = files
    ? files.assertDirectory(absolutePath(value(values, "root")))
    : assertSourceRoot(value(values, "root"));
  const token = readTokenFile(value(values, "token-file"), files);

  const backup =
    action === "compact" || (action === "verify" && values.has("backup"))
      ? readBackupFile(value(values, "backup"), files)
      : undefined;
  const epoch =
    action === "verify" || action === "compact" || action === "upgrade"
      ? id(value(values, "epoch"))
      : undefined;
  const destinationTarget =
    action === "verify" || action === "compact" || action === "upgrade"
      ? files
        ? files.assertNewDirectory(
            absolutePath(value(values, "destination")),
            [sourceRoot],
          )
        : assertDestination(value(values, "destination"), sourceRoot)
      : undefined;

  const scope: Scope | undefined =
    retentionAction || action === "collect-preview" || action === "collect" || action === "staging-preview" || action === "staging-abandon"
      ? {
          orgId,
          workspaceId: id(value(values, "workspace")),
          documentId: id(value(values, "document")),
          incarnationId: id(value(values, "incarnation")),
        }
      : undefined;
  const expectedCut =
    action === "collect" || action === "staging-abandon" || action === "dependencies-preview" ||
    action === "publication-inspect" || action === "publication-resolve" || retentionAction
      ? parseExpectedCut(value(values, "expected-cut"))
      : undefined;
  const hashes =
    action === "collect"
      ? parseHashes(value(values, "hashes"))
      : undefined;
  const attemptId =
    action === "publication-inspect" || action === "publication-resolve"
      ? value(values, "attempt")
      : undefined;
  if (attemptId !== undefined && !ATTEMPT_PATTERN.test(attemptId))
    fail("INVALID_ATTEMPT");
  const fingerprint =
    action === "publication-resolve" || action === "retention-export" || action === "retention-release"
      ? value(values, "fingerprint")
      : undefined;
  if (fingerprint !== undefined && !HASH_PATTERN.test(fingerprint))
    fail("INVALID_FINGERPRINT");

  let authority: SharedAuthority;
  try {
    authority = context.openAuthority(sourceRoot, sourceOptions);
  } catch (error) {
    return normalize(error, "MAINTENANCE_FAILED");
  }

  const opened: { close(): void }[] = [authority];
  let result: unknown;
  try {
    if (retentionAction) {
      if (!scope || !expectedCut) return invalidArguments();
      // Current owner/all-workspace read + exact-cut authorization BEFORE
      // any host evidence is opened, registered, or leased.
      authority.retentionDependencies(token, orgId, expectedCut);
      authority.session(token, orgId);
      let host: RetentionHostRegistry;
      if (ports.retentionHost instanceof RetentionHostRegistry) {
        host = ports.retentionHost.bindAuthority(authority);
      } else if (typeof ports.retentionHostFactory === "function") {
        // Trusted synchronous offline factory only: a known-async function
        // is rejected before invocation and a thenable result fails closed —
        // never a fabricated coverage roster.
        const factory = synchronousPort(
          { build: ports.retentionHostFactory },
          { build: { result: "object" } },
        );
        const built = factory.build(authority) as Readonly<{
          host: RetentionHostRegistry;
          close(): void;
        }> | null;
        if (
          built === null ||
          typeof built !== "object" ||
          !(built.host instanceof RetentionHostRegistry) ||
          typeof built.close !== "function"
        )
          fail("RETENTION_HOST_INVALID");
        const closer = synchronousPort(
          built,
          { close: { result: "void", cleanup: true } },
        );
        opened.push(closer);
        // Queue owned cleanup before source binding can fail.
        host = built.host.bindAuthority(authority);
      } else {
        fail("RETENTION_HOST_REQUIRED");
      }
      const maintenance = new SharedMaintenance(authority, host);
      const request = { scope, expectedCut, holds: parseHolds(value(values, "holds")) };
      result = host.withLease(() => {
        // This is the actual current owner/all-workspace read/cut boundary.
        // Destination creation and artifact disclosure follow authorization.
        authority.retentionDependencies(token, orgId, expectedCut);
        if (action === "retention-preview")
          return maintenance.retentionReleasePreview(token, request);
        if (action === "retention-export") {
          const preview = maintenance.retentionReleasePreview(token, request);
          if (!preview.releasable)
            fail(preview.blocks[0] ?? "RETENTION_RELEASE_BLOCKED");
          if (preview.combinedFingerprint !== fingerprint)
            fail("RETENTION_FINGERPRINT_MISMATCH");
          const target = files
            ? files.assertNewDirectory(absolutePath(value(values, "destination")), [sourceRoot])
            : assertDestination(value(values, "destination"), sourceRoot);
          if (files) {
            files.createDirectory(target);
            if (files.assertDirectory(target) !== target) fail("UNSAFE_DESTINATION");
          } else createDestination(target);
          const artifact = new RuntimeStore(target, context.storeOptions(target));
          opened.push(artifact);
          return maintenance.exportRetentionRelease(token, request, fingerprint!, artifact);
        }
        const artifactHash = value(values, "artifact-hash");
        const ack = value(values, "ack-artifact-hash");
        if (!HASH_PATTERN.test(artifactHash) || !HASH_PATTERN.test(ack))
          fail("INVALID_ARTIFACT_ACK");
        const target = files
          ? files.assertDirectory(absolutePath(value(values, "artifact")))
          : assertSourceRoot(value(values, "artifact"));
        if (inside(sourceRoot, target) || inside(target, sourceRoot))
          fail("RETENTION_DESTINATION_NOT_ISOLATED");
        const artifact = openRetentionArtifact(target, files);
        opened.push(artifact);
        return maintenance.releaseRetentionHolds(
          token, request, fingerprint!, artifactHash, ack, artifact,
        );
      });
    } else if (action === "dependencies-preview") {
      result = authority.retentionDependencies(token, orgId, expectedCut!);
    } else if (action === "staging-preview") {
      if (!scope) return invalidArguments();
      result = authority.stagingPreview(token, scope);
    } else if (action === "staging-abandon") {
      if (!scope || !expectedCut) return invalidArguments();
      const manifestHash = value(values,"manifest-hash");
      if (!HASH_PATTERN.test(manifestHash)) fail("INVALID_MANIFEST_HASH");
      result = authority.stagingAbandon(token,{scope,expectedCut,writerId:id(value(values,"writer")),copyId:id(value(values,"copy-id")),manifestHash});
    } else if (action === "preview") {
      result = new SharedMaintenance(authority).preview(token, orgId);
    } else if (action === "collect-preview") {
      if (!scope) return invalidArguments();
      const preview = new SharedMaintenance(authority).collectPreview(
        token,
        scope,
      );
      result = preview;
    } else if (action === "collect") {
      if (!scope || !expectedCut || !hashes)
        return invalidArguments();
      result = new SharedMaintenance(authority).collect(
        token,
        scope,
        expectedCut,
        hashes,
      );
    } else if (
      action === "publication-inspect" ||
      action === "publication-resolve"
    ) {
      if (!ports.nativePublication)
        fail("PUBLICATION_RESOLUTION_UNAVAILABLE");
      if (!expectedCut || !attemptId) return invalidArguments();
      const nativePublication = synchronousPort(
        ports.nativePublication,
        PUBLICATION_RESOLUTION_CONTRACT,
      );
      // Fresh current authorization each call: the same owner + all-workspace
      // read + exact cut gate as dependencies-preview, then the session and
      // the genesis hash the port binds to the resolution fingerprint. The
      // callback is synchronous JSON only — never the token.
      const currentAuthorization = (): PublicationAuthorization => {
        authority.retentionDependencies(token, orgId, expectedCut);
        const auth = authority.session(token, orgId);
        const genesis = authority.store.get("meta", "genesis");
        if (genesis === null) fail("PUBLICATION_SOURCE_UNAVAILABLE");
        return {
          sourceRoot,
          orgId,
          genesisHash: createHash("sha256")
            .update(canonical(genesis))
            .digest("hex"),
          auth: {
            userId: auth.userId,
            deviceId: auth.deviceId,
            writerId: auth.writerId,
            sessionId: auth.sessionId,
          },
          cut: { ...authority.head() },
        };
      };
      result = authority.store.transaction(() => {
        // Authorize even with an injected port; the synchronous guard rejects
        // any deferred or generator implementation before invocation.
        currentAuthorization();
        return action === "publication-inspect"
          ? nativePublication.inspect(
              { attemptId, expectedCut },
              currentAuthorization,
            )
          : nativePublication.resolve(
              { attemptId, expectedCut, fingerprint: fingerprint! },
              currentAuthorization,
            );
      });
    } else {
      if (!epoch || !destinationTarget) return invalidArguments();
      authority.recoveryStatus(token, orgId);

      const destinationOptions = context.storeOptions(destinationTarget);
      if (files) {
        try {
          files.createDirectory(destinationTarget);
          if (files.assertDirectory(destinationTarget) !== destinationTarget)
            fail("UNSAFE_DESTINATION");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            fail("DESTINATION_EXISTS");
          throw error;
        }
      } else {
        createDestination(destinationTarget);
      }
      const destination = new RuntimeStore(
        destinationTarget,
        destinationOptions,
      );
      opened.push(destination);

      const maintenance = new SharedMaintenance(authority);
      if (action === "verify") {
        result =
          backup === undefined
            ? maintenance.verify(token, orgId, destination, epoch)
            : verifyArtifact(
                authority,
                token,
                orgId,
                backup,
                destination,
                epoch,
              );
      } else if (action === "compact") {
        if (backup === undefined) return invalidArguments();
        const proof = verifyArtifact(
          authority,
          token,
          orgId,
          backup,
          destination,
          epoch,
        );
        result = maintenance.compact(token, orgId, proof);
      } else {
        const proof = maintenance.verify(token, orgId, destination, epoch);
        result = authority.upgradeProtocol(token, orgId, proof.backupHash);
      }
    }
  } catch (error) {
    if (retentionAction) {
      try { closeOpened(opened); }
      catch (cleanup) {
        const failure = new CollaborationError("MAINTENANCE_UNKNOWN");
        Object.assign(failure, { cause: new AggregateError([error, cleanup]) });
        throw failure;
      }
    } else closeOpened(opened);
    if (
      (files !== undefined || !(error instanceof CollaborationError)) &&
      unknownOutcome(error)
    )
      return fail("MAINTENANCE_UNKNOWN");
    return normalize(error, "MAINTENANCE_FAILED");
  }

  let closed = false;
  return {
    state: "maintained",
    result,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (retentionAction) {
        try { closeOpened(opened); }
        catch (cause) {
          const failure = new CollaborationError("MAINTENANCE_UNKNOWN");
          Object.assign(failure, { cause });
          throw failure;
        }
        return;
      }
      let failure: unknown;
      for (const store of [...opened].reverse()) {
        try {
          store.close();
        } catch (error) {
          if (failure === undefined) failure = error;
        }
      }
      if (failure !== undefined) throw failure;
    },
  };
}
