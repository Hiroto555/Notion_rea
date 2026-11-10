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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeNewFileDurably } from "../../persistence/durable-file";
import { sqliteHeader } from "../../persistence/sqlite-header";
import { pinPrivateRoot } from "../../sync/m3-private-root";
import { SharedAuthority } from "./authority";
import { validateRuntimeBackup, type RuntimeBackup } from "./backup";
import { canonical } from "./canonical";
import { CollaborationError, identifier, wellFormed } from "./contract";
import { IdentityAuthority } from "./identity";
import { createRuntimeGenesis } from "./state-root";
import {
  RuntimeStore,
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
  type RuntimeStoreOptions,
} from "./store";

const VALUE_NAMES = [
  "root",
  "org",
  "token-file",
  "backup",
  "destination",
  "epoch",
  "device",
  "credentials-output",
] as const;

const MAX_PATH_LENGTH = 4_096;
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 256;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

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
    if (!(VALUE_NAMES as readonly string[]).includes(name)) invalidArguments();
    if (values.has(name)) invalidArguments();
    const value = args[++index];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      value.startsWith("--") ||
      value.includes("://")
    )
      invalidArguments();
    values.set(name, value);
  }
  for (const name of VALUE_NAMES) if (!values.has(name)) invalidArguments();
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

function readTokenFile(rawPath: string): string {
  const path = absolutePath(rawPath);
  const bytes = readPinnedFile(
    path,
    MAX_TOKEN_BYTES,
    "INVALID_TOKEN_FILE",
    true,
  );
  const text = decodeText(bytes, "INVALID_TOKEN_FILE");
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

function readBackupFile(rawPath: string): RuntimeBackup {
  const path = absolutePath(rawPath);
  const bytes = readPinnedFile(
    path,
    MAX_BACKUP_BYTES,
    "INVALID_BACKUP_FILE",
    false,
  );
  const text = decodeText(bytes, "INVALID_BACKUP_FILE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("INVALID_BACKUP_FILE");
  }
  const backup = validateRuntimeBackup(parsed);
  const encoded = canonical(parsed, MAX_BACKUP_BYTES);
  if (encoded !== text) fail("INVALID_BACKUP_FILE");
  return backup;
}

function assertSourceRoot(rawRoot: string): string {
  const absolute = absolutePath(rawRoot);
  const listed = optionalStat(absolute);
  if (listed === undefined) fail("ROOT_MISSING");
  if (listed.isSymbolicLink() || !listed.isDirectory()) fail("INVALID_ROOT");
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    return fail("INVALID_ROOT");
  }
  let rootUid: number;
  try {
    rootUid = pinPrivateRoot(canonical).uid;
  } catch {
    return fail("UNSAFE_ROOT");
  }
  const database = join(canonical, SHARED_RUNTIME_FILE);
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

  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(database, { readOnly: true });
    probe.exec(
      "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000",
    );
    const row = probe
      .prepare("SELECT raw FROM runtime_records WHERE namespace=? AND key=?")
      .get("meta", "role") as Record<string, unknown> | undefined;
    if (row === undefined) fail("WRONG_STORE_ROLE");
    const rawRole = row.raw;
    if (typeof rawRole !== "string") fail("WRONG_STORE_ROLE");
    let role: unknown;
    try {
      role = JSON.parse(rawRole);
    } catch {
      return fail("WRONG_STORE_ROLE");
    }
    if (role !== "authority") fail("WRONG_STORE_ROLE");
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    return fail("NOT_SHARED_RUNTIME_FORMAT");
  } finally {
    if (probe !== undefined) {
      try {
        probe.close();
      } catch {}
    }
  }
  return canonical;
}

function assertDestination(rawDestination: string, sourceRoot: string): string {
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

function assertCredentialsTarget(
  rawOutput: string,
  sourceRoot: string,
  destination: string,
): string {
  const absolute = absolutePath(rawOutput);
  if (optionalStat(absolute) !== undefined) fail("CREDENTIALS_EXIST");
  const output = canonicalCandidate(absolute);
  if (optionalStat(output) !== undefined) fail("CREDENTIALS_EXIST");
  if (inside(sourceRoot, output) || inside(output, sourceRoot))
    fail("CREDENTIALS_INSIDE_ROOT");
  if (inside(destination, output) || inside(output, destination))
    fail("CREDENTIALS_INSIDE_DESTINATION");

  const name = basename(output);
  if (name === "" || name === "." || name === "..") invalidArguments();
  const parent = dirname(output);
  if (parent === output) invalidArguments();
  let pinnedParent: ReturnType<typeof pinPrivateRoot>;
  try {
    pinnedParent = pinPrivateRoot(parent);
  } catch {
    return fail("UNSAFE_CREDENTIALS_PATH");
  }
  const target = join(pinnedParent.path, name);
  if (optionalStat(target) !== undefined) fail("CREDENTIALS_EXIST");
  if (inside(sourceRoot, target) || inside(target, sourceRoot))
    fail("CREDENTIALS_INSIDE_ROOT");
  if (inside(destination, target) || inside(target, destination))
    fail("CREDENTIALS_INSIDE_DESTINATION");
  return target;
}

function readCredentialsBack(path: string, expected: string): void {
  const bytes = readPinnedFile(
    path,
    MAX_TOKEN_BYTES,
    "CREDENTIALS_WRITE_FAILED",
    true,
  );
  const text = decodeText(bytes, "CREDENTIALS_WRITE_FAILED");
  if (text !== expected) fail("CREDENTIALS_WRITE_FAILED");
}

export type RestoreOperatorHandle = Readonly<{
  state: "restored";
  close(): Promise<void>;
}>;

export async function runRestoreOperator(
  args: string[],
  options: RuntimeStoreOptions = {},
): Promise<RestoreOperatorHandle> {
  if (process.platform === "win32")
    fail("WINDOWS_RESTORE_OPERATOR_UNSUPPORTED");

  const values = parseArguments(args);
  const orgId = id(value(values, "org"));
  const epoch = id(value(values, "epoch"));
  const deviceId = id(value(values, "device"));
  const sourceRoot = assertSourceRoot(value(values, "root"));
  const token = readTokenFile(value(values, "token-file"));
  const backup = readBackupFile(value(values, "backup"));
  if (epoch === backup.head.epoch) fail("EPOCH_NOT_FRESH");
  const destinationTarget = assertDestination(
    value(values, "destination"),
    sourceRoot,
  );
  const credentialsTarget = assertCredentialsTarget(
    value(values, "credentials-output"),
    sourceRoot,
    destinationTarget,
  );

  let authority: SharedAuthority;
  try {
    authority = new SharedAuthority(sourceRoot, options);
  } catch (error) {
    return normalize(error, "RESTORE_FAILED");
  }

  try {
    authority.recoveryStatus(token, orgId);
  } catch (error) {
    try {
      authority.close();
    } catch {}
    return normalize(error, "RESTORE_FAILED");
  }

  try {
    mkdirSync(destinationTarget, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    try {
      authority.close();
    } catch {}
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return fail("DESTINATION_EXISTS");
    return fail("DESTINATION_CREATE_FAILED");
  }
  try {
    chmodSync(destinationTarget, PRIVATE_DIRECTORY_MODE);
    const pin = pinPrivateRoot(destinationTarget);
    if (pin.path !== destinationTarget) fail("UNSAFE_DESTINATION");
  } catch (error) {
    try {
      authority.close();
    } catch {}
    // Preserve the newly created diagnostic destination; never recursively delete it.
    return normalize(error, "UNSAFE_DESTINATION");
  }

  let destination: RuntimeStore;
  try {
    destination = new RuntimeStore(destinationTarget, options);
  } catch (error) {
    try {
      authority.close();
    } catch {}
    // Preserve the newly created diagnostic destination; never recursively delete it.
    return normalize(error, "RESTORE_FAILED");
  }

  let credentialsCreated = false;
  try {
    destination.transaction(() => {
      const restored = authority.restoreInto(
        token,
        orgId,
        backup,
        destination,
        epoch,
      );
      const recovered = new IdentityAuthority(destination).recover(
        orgId,
        restored.recoveryKey,
        deviceId,
      );
      destination.set("meta", "restore-authorization", {
        reset: true,
        epoch,
        sourceHash: backup.hash,
        completedRecovery: true,
        operatorUserId: recovered.auth.userId,
        deviceId,
      });
      createRuntimeGenesis(destination, epoch, backup.hash);
      const content = canonical({
        token: recovered.token,
        recoveryKey: recovered.recoveryKey,
      });
      try {
        writeNewFileDurably(credentialsTarget, content, {
          mode: PRIVATE_FILE_MODE,
          syncParentDirectory: true,
        });
        credentialsCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          fail("CREDENTIALS_EXIST");
        return fail("CREDENTIALS_WRITE_FAILED");
      }
      readCredentialsBack(credentialsTarget, content);
    });
  } catch (error) {
    try {
      destination.close();
    } catch {}
    try {
      authority.close();
    } catch {}
    if (
      credentialsCreated ||
      (error instanceof Error && /UNKNOWN/.test(error.message))
    )
      return fail("RESTORE_UNKNOWN");
    return normalize(error, "RESTORE_FAILED");
  }

  let closed = false;
  return {
    state: "restored",
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try {
        destination.close();
      } catch (error) {
        failure = error;
      }
      try {
        authority.close();
      } catch (error) {
        if (failure === undefined) failure = error;
      }
      if (failure !== undefined) throw failure;
    },
  };
}
