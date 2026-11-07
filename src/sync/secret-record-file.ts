import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_SECRET_RECORD_BYTES,
  isSyncSecretKey,
  type SecretRecordPersistence,
} from "./secret-store";

const RECORD_NAME_PREFIX = "folio-secret-record-v1-";
const RECORD_NAME_SUFFIX = ".bin";
const MAX_PATH_LENGTH = 4_096;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const WRITABLE_ANCESTOR_BITS = 0o022;
const STICKY_BIT = 0o1000;
const NOFOLLOW = fsConstants.O_NOFOLLOW;
const DIRECTORY = fsConstants.O_DIRECTORY;
const READ_FLAGS = fsConstants.O_RDONLY | NOFOLLOW | fsConstants.O_NONBLOCK;
const EXISTING_WRITE_FLAGS =
  fsConstants.O_RDWR | NOFOLLOW | fsConstants.O_NONBLOCK;
const CREATE_FLAGS =
  fsConstants.O_WRONLY | NOFOLLOW | fsConstants.O_CREAT | fsConstants.O_EXCL;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | NOFOLLOW | DIRECTORY;

export type SecretRecordFileErrorCode =
  | "secret-record-file-invalid-options"
  | "secret-record-file-unsupported-platform"
  | "secret-record-file-invalid-directory"
  | "secret-record-file-unsafe-directory"
  | "secret-record-file-directory-changed"
  | "secret-record-file-invalid-key"
  | "secret-record-file-invalid-record"
  | "secret-record-file-too-large"
  | "secret-record-file-unsafe-record"
  | "secret-record-file-ambiguous-record"
  | "secret-record-file-conflict"
  | "secret-record-file-read-failed"
  | "secret-record-file-write-failed"
  | "secret-record-file-delete-unsupported";

export class SecretRecordFileError extends Error {
  constructor(readonly code: SecretRecordFileErrorCode) {
    super(code);
    this.name = "SecretRecordFileError";
  }
}

export type SecretRecordFileOptions = Readonly<{
  directory: string;
  forbiddenRoots: readonly string[];
}>;

type NormalizedOptions = Readonly<{
  directory: string;
  device: number;
  inode: number;
  uid: number;
}>;

function fail(code: SecretRecordFileErrorCode): never {
  throw new SecretRecordFileError(code);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function closeQuietly(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {}
}

function isWithin(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const rest = relative(parent, candidate);
  return (
    rest !== "" &&
    rest !== ".." &&
    !rest.startsWith(".." + sep) &&
    !isAbsolute(rest)
  );
}

function currentUid(): number {
  const getuid = process.getuid;
  if (typeof getuid !== "function")
    fail("secret-record-file-unsupported-platform");
  let uid: unknown;
  try {
    uid = getuid.call(process);
  } catch {
    return fail("secret-record-file-unsupported-platform");
  }
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0)
    fail("secret-record-file-unsupported-platform");
  return uid;
}

function canonicalDirectory(
  value: unknown,
  invalidCode: SecretRecordFileErrorCode,
  unsafeCode: SecretRecordFileErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    !isAbsolute(value)
  )
    fail(invalidCode);
  const absolute = resolve(value);
  let stat: Stats;
  try {
    stat = lstatSync(absolute);
  } catch {
    return fail(invalidCode);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(unsafeCode);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    return fail(unsafeCode);
  }
  if (canonical !== absolute) fail(unsafeCode);
  return canonical;
}

function assertPrivateDirectory(stat: Stats, uid: number): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  )
    fail("secret-record-file-unsafe-directory");
}

function assertSafeAncestors(directory: string): void {
  let current = directory;
  for (;;) {
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch {
      return fail("secret-record-file-unsafe-directory");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail("secret-record-file-unsafe-directory");
    if (
      (stat.mode & WRITABLE_ANCESTOR_BITS) !== 0 &&
      (stat.mode & STICKY_BIT) === 0
    )
      fail("secret-record-file-unsafe-directory");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function normalizeOptions(input: unknown): NormalizedOptions {
  try {
    if (process.platform === "win32")
      fail("secret-record-file-unsupported-platform");
    if (typeof NOFOLLOW !== "number" || typeof DIRECTORY !== "number" || NOFOLLOW === 0 || DIRECTORY === 0)
      fail("secret-record-file-unsupported-platform");
    const uid = currentUid();
    if (input === null || typeof input !== "object" || Array.isArray(input))
      fail("secret-record-file-invalid-options");
    const options = input as Record<string, unknown>;
    const rootsValue = options.forbiddenRoots;
    if (!Array.isArray(rootsValue) || rootsValue.length === 0)
      fail("secret-record-file-invalid-options");
    const roots = rootsValue.map((root) =>
      canonicalDirectory(
        root,
        "secret-record-file-invalid-options",
        "secret-record-file-invalid-options",
      ),
    );
    const directory = canonicalDirectory(
      options.directory,
      "secret-record-file-invalid-directory",
      "secret-record-file-unsafe-directory",
    );
    const stat = lstatSync(directory);
    assertPrivateDirectory(stat, uid);
    assertSafeAncestors(directory);
    for (const root of roots) {
      if (isWithin(root, directory) || isWithin(directory, root))
        fail("secret-record-file-unsafe-directory");
    }
    return Object.freeze({
      directory,
      device: stat.dev,
      inode: stat.ino,
      uid,
    });
  } catch (error) {
    if (error instanceof SecretRecordFileError) throw error;
    return fail("secret-record-file-invalid-options");
  }
}

function assertRecordStat(stat: Stats, uid: number): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== PRIVATE_FILE_MODE
  )
    fail("secret-record-file-unsafe-record");
}

function readVerifiedRecord(descriptor: number, uid: number): Buffer {
  const before = fstatSync(descriptor);
  assertRecordStat(before, uid);
  if (before.size <= 0) fail("secret-record-file-invalid-record");
  if (before.size > MAX_SECRET_RECORD_BYTES)
    fail("secret-record-file-too-large");
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (count <= 0) fail("secret-record-file-ambiguous-record");
    offset += count;
  }
  const after = fstatSync(descriptor);
  if (
    !after.isFile() ||
    after.nlink !== 1 ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mode !== before.mode ||
    after.uid !== before.uid
  )
    fail("secret-record-file-ambiguous-record");
  return bytes;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (count <= 0) fail("secret-record-file-write-failed");
    offset += count;
  }
}

function copyCiphertext(value: unknown): Buffer {
  try {
    if (!(value instanceof Uint8Array))
      fail("secret-record-file-invalid-record");
    if (value.byteLength === 0)
      fail("secret-record-file-invalid-record");
    if (value.byteLength > MAX_SECRET_RECORD_BYTES)
      fail("secret-record-file-too-large");
    const copy = Buffer.from(value);
    if (copy.byteLength !== value.byteLength)
      fail("secret-record-file-invalid-record");
    return copy;
  } catch (error) {
    if (error instanceof SecretRecordFileError) throw error;
    fail("secret-record-file-invalid-record");
  }
}

export class SecretRecordFilePersistence implements SecretRecordPersistence {
  readonly directory: string;
  private readonly device: number;
  private readonly inode: number;
  private readonly uid: number;

  constructor(options: SecretRecordFileOptions) {
    const normalized = normalizeOptions(options);
    this.directory = normalized.directory;
    this.device = normalized.device;
    this.inode = normalized.inode;
    this.uid = normalized.uid;
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    const path = this.recordPath(key);
    this.assertDirectory();
    let descriptor: number | undefined;
    try {
      try {
        descriptor = openSync(path, READ_FLAGS);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") {
          this.assertDirectory();
          return undefined;
        }
        if (code === "ELOOP" || code === "ENOTDIR")
          fail("secret-record-file-unsafe-record");
        fail("secret-record-file-read-failed");
      }
      const record = readVerifiedRecord(descriptor, this.uid);
      const opened = fstatSync(descriptor);
      assertRecordStat(opened, this.uid);
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev ||
          current.ino !== opened.ino || current.nlink !== 1)
        fail("secret-record-file-ambiguous-record");
      this.assertDirectory();
      return record;
    } catch (error) {
      if (error instanceof SecretRecordFileError) throw error;
      fail("secret-record-file-read-failed");
    } finally {
      closeQuietly(descriptor);
    }
  }

  async write(key: string, value: Uint8Array): Promise<void> {
    const path = this.recordPath(key);
    const payload = copyCiphertext(value);
    this.assertDirectory();
    let descriptor: number | undefined;
    try {
      try {
        descriptor = openSync(path, CREATE_FLAGS, PRIVATE_FILE_MODE);
      } catch (error) {
        const code = errorCode(error);
        if (code === "EEXIST") {
          this.acceptExisting(path, payload);
          return;
        }
        if (code === "ELOOP" || code === "ENOTDIR")
          fail("secret-record-file-unsafe-record");
        fail("secret-record-file-write-failed");
      }
      const opened = fstatSync(descriptor);
      assertRecordStat(opened, this.uid);
      if (opened.size !== 0)
        fail("secret-record-file-ambiguous-record");
      writeAll(descriptor, payload);
      const after = fstatSync(descriptor);
      if (
        !after.isFile() ||
        after.nlink !== 1 ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== payload.length ||
        after.mode !== opened.mode ||
        after.uid !== opened.uid
      )
        fail("secret-record-file-ambiguous-record");
      fsyncSync(descriptor);
      const current = lstatSync(path);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        current.nlink !== 1
      )
        fail("secret-record-file-ambiguous-record");
      const openDescriptor = descriptor;
      descriptor = undefined;
      closeSync(openDescriptor);
      this.syncDirectory();
    } catch (error) {
      closeQuietly(descriptor);
      descriptor = undefined;
      // Keep even an incomplete record. A path could be replaced between
      // checking its identity and unlinking it. Later attempts must verify
      // the retained bytes or fail closed.
      if (error instanceof SecretRecordFileError) throw error;
      fail("secret-record-file-write-failed");
    } finally {
      closeQuietly(descriptor);
    }
  }

  async delete(key: string): Promise<void> {
    this.recordPath(key);
    fail("secret-record-file-delete-unsupported");
  }

  private recordPath(key: unknown): string {
    if (!isSyncSecretKey(key)) fail("secret-record-file-invalid-key");
    const name =
      RECORD_NAME_PREFIX +
      createHash("sha256").update(key, "utf8").digest("hex") +
      RECORD_NAME_SUFFIX;
    return join(this.directory, name);
  }

  private assertDirectory(): void {
    let stat: Stats;
    try {
      stat = lstatSync(this.directory);
    } catch {
      fail("secret-record-file-directory-changed");
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== this.device ||
      stat.ino !== this.inode
    )
      fail("secret-record-file-directory-changed");
    try {
      assertPrivateDirectory(stat, this.uid);
      assertSafeAncestors(this.directory);
    } catch (error) {
      if (error instanceof SecretRecordFileError) throw error;
      fail("secret-record-file-directory-changed");
    }
    let canonical: string;
    try {
      canonical = realpathSync(this.directory);
    } catch {
      return fail("secret-record-file-directory-changed");
    }
    if (canonical !== this.directory)
      fail("secret-record-file-directory-changed");
  }

  private acceptExisting(path: string, payload: Buffer): void {
    let descriptor: number | undefined;
    try {
      try {
        descriptor = openSync(path, EXISTING_WRITE_FLAGS);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR")
          fail("secret-record-file-unsafe-record");
        fail("secret-record-file-write-failed");
      }
      const existing = readVerifiedRecord(descriptor, this.uid);
      if (!existing.equals(payload))
        fail("secret-record-file-conflict");
      fsyncSync(descriptor);
      const opened = fstatSync(descriptor);
      assertRecordStat(opened, this.uid);
      const current = lstatSync(path);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        current.nlink !== 1
      )
        fail("secret-record-file-ambiguous-record");
      this.syncDirectory();
    } finally {
      closeQuietly(descriptor);
    }
  }

  private syncDirectory(): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.directory, DIRECTORY_FLAGS);
      const opened = fstatSync(descriptor);
      if (
        !opened.isDirectory() ||
        opened.dev !== this.device ||
        opened.ino !== this.inode
      )
        fail("secret-record-file-directory-changed");
      fsyncSync(descriptor);
    } catch (error) {
      if (error instanceof SecretRecordFileError) throw error;
      fail("secret-record-file-write-failed");
    } finally {
      closeQuietly(descriptor);
    }
  }
}
