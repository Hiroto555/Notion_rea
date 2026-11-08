import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { syncPath } from "../persistence/durable-file";
import { pinPrivateRoot, assertPrivateRoot } from "./m3-private-root";
import { identifier, SyncError } from "./protocol";

export type ServerOpsConfig = {
  format: "folio-server-config/v1";
  workspaceId: string;
  ownerId: string;
  port: number;
};

export type IssuedSyncCredential = {
  format: "folio-sync-credential/v1";
  baseUrl: string;
  workspaceId: string;
  clientId: string;
  token: string;
};

type ErrorCode = "server-config-invalid" | "server-config-unsafe";
type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const INVALID = "server-config-invalid";
const UNSAFE = "server-config-unsafe";
const ERROR_STATUS = 409;
const CONFIG_FILE = "server-config.json";
const CONFIG_FORMAT = "folio-server-config/v1" as const;
const CREDENTIAL_FORMAT = "folio-sync-credential/v1" as const;
const CONFIG_KEYS = ["format", "workspaceId", "ownerId", "port"] as const;
const CREDENTIAL_KEYS = [
  "format",
  "baseUrl",
  "workspaceId",
  "clientId",
  "token",
] as const;
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const FILE_MODE = 0o600;
const MAX_FILE_BYTES = 4_096;
function assertHandoffAncestors(path: string): void {
  let parent = dirname(resolve(path));
  for (let depth = 0; depth < 128; depth++) {
    for (const name of ["workspace.sqlite", "server.sqlite", "full-manifest.json", "manifest.json", ".folio-sync-transfers"]) {
      try {lstatSync(join(parent, name)); fail(UNSAFE);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
    }
    const next = dirname(parent); if (next === parent) return; parent = next;
  }
  fail(UNSAFE);
}
const O_NOFOLLOW = constants.O_NOFOLLOW || 0;
const O_NONBLOCK = constants.O_NONBLOCK || 0;
const READ_FLAGS =
  constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  O_NOFOLLOW |
  O_NONBLOCK;

function fail(code: ErrorCode): never {
  throw new SyncError(code, ERROR_STATUS);
}

function currentUid(): number {
  if (process.platform === "win32") fail(UNSAFE);
  const getuid = process.getuid;
  if (typeof getuid !== "function") fail(UNSAFE);
  let uid: unknown;
  try {
    uid = getuid.call(process);
  } catch {
    fail(UNSAFE);
  }
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0)
    fail(UNSAFE);
  return uid;
}

function fields(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(INVALID);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(INVALID);
  const input = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expected.length ||
    !expected.every((key) => keys.includes(key))
  )
    fail(INVALID);
  const detached: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail(INVALID);
    detached[key] = descriptor.value;
  }
  return detached;
}

function id(value: unknown): string {
  try {
    return identifier(value);
  } catch {
    fail(INVALID);
  }
}

function loopbackBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail(INVALID);
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    fail(INVALID);
  }
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  )
    fail(INVALID);
  return url.origin;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) fail(INVALID);
  return value;
}

function parseConfig(value: unknown): ServerOpsConfig {
  try {
    const input = fields(value, CONFIG_KEYS);
    if (input.format !== CONFIG_FORMAT) fail(INVALID);
    const port = input.port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    )
      fail(INVALID);
    return Object.freeze({
      format: CONFIG_FORMAT,
      workspaceId: id(input.workspaceId),
      ownerId: id(input.ownerId),
      port,
    });
  } catch (error) {
    if (
      error instanceof SyncError &&
      (error.code === INVALID || error.code === UNSAFE)
    )
      throw error;
    fail(INVALID);
  }
}

function parseCredential(value: unknown): IssuedSyncCredential {
  try {
    const input = fields(value, CREDENTIAL_KEYS);
    if (input.format !== CREDENTIAL_FORMAT) fail(INVALID);
    return Object.freeze({
      format: CREDENTIAL_FORMAT,
      baseUrl: loopbackBaseUrl(input.baseUrl),
      workspaceId: id(input.workspaceId),
      clientId: id(input.clientId),
      token: token(input.token),
    });
  } catch (error) {
    if (
      error instanceof SyncError &&
      (error.code === INVALID || error.code === UNSAFE)
    )
      throw error;
    fail(INVALID);
  }
}

function identity(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertSecureFile(stat: Stats, uid: number): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== FILE_MODE
  )
    fail(UNSAFE);
}

function readSecureFile(filePath: string): string {
  const uid = currentUid();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, READ_FLAGS);
    const first = fstatSync(descriptor);
    assertSecureFile(first, uid);
    if (first.size > MAX_FILE_BYTES) fail(INVALID);
    const before = identity(first);
    const buffer = Buffer.alloc(first.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (read <= 0) fail(UNSAFE);
      offset += read;
    }
    const rechecked = fstatSync(descriptor);
    const pathStat = lstatSync(filePath);
    assertSecureFile(rechecked, uid);
    assertSecureFile(pathStat, uid);
    if (
      !sameIdentity(before, identity(rechecked)) ||
      !sameIdentity(before, identity(pathStat))
    )
      fail(UNSAFE);
    return buffer.toString("utf8");
  } catch (error) {
    if (error instanceof SyncError) throw error;
    return fail(UNSAFE);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The validated bytes are already detached; close failures are not data.
      }
    }
  }
}

function writeSecureExclusive(target: string, text: string): void {
  const uid = currentUid();
  const data = Buffer.from(text, "utf8");
  if (data.length > MAX_FILE_BYTES) fail(INVALID);
  let descriptor: number | undefined;
  let created: Stats | undefined;
  try {
    descriptor = openSync(target, WRITE_FLAGS, FILE_MODE);
    created = fstatSync(descriptor);
    if (!created.isFile() || created.uid !== uid || created.nlink !== 1)
      fail(UNSAFE);
    fchmodSync(descriptor, FILE_MODE);
    const secured = fstatSync(descriptor);
    if ((secured.mode & 0o777) !== FILE_MODE || secured.uid !== uid)
      fail(UNSAFE);
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(
        descriptor,
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (written <= 0) fail(UNSAFE);
      offset += written;
    }
    const final = fstatSync(descriptor);
    if (
      final.size !== data.length ||
      final.nlink !== 1 ||
      (final.mode & 0o777) !== FILE_MODE
    )
      fail(UNSAFE);
    fsyncSync(descriptor);
    const openDescriptor = descriptor;
    descriptor = undefined;
    closeSync(openDescriptor);
    syncPath(dirname(target));
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original fixed-code error.
      }
    }
    // Retain even an incomplete exclusive output for outcome reconciliation.
    if (error instanceof SyncError) throw error;
    fail(UNSAFE);
  }
}

function pin(directory: string, forbiddenRoots: readonly string[] = []) {
  try {
    return pinPrivateRoot(directory, forbiddenRoots);
  } catch {
    fail(UNSAFE);
  }
}

export function readServerOpsConfig(directory: string): ServerOpsConfig {
  const root = pin(directory);
  const text = readSecureFile(join(root.path, CONFIG_FILE));
  assertPrivateRoot(root);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(INVALID);
  }
  return parseConfig(parsed);
}

export function writeServerOpsConfig(
  directory: string,
  config: ServerOpsConfig,
): void {
  const value = parseConfig(config);
  const root = pin(directory);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) fail(INVALID);
  writeSecureExclusive(join(root.path, CONFIG_FILE), text);
  assertPrivateRoot(root);
}

export function readIssuedSyncCredential(
  path: string,
): IssuedSyncCredential {
  assertHandoffAncestors(path);
  const absolute = resolve(path), root = pin(dirname(absolute));
  const text = readSecureFile(join(root.path, basename(absolute)));
  assertPrivateRoot(root);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(INVALID);
  }
  return parseCredential(parsed);
}

export function writeIssuedSyncCredential(
  path: string,
  value: IssuedSyncCredential,
  forbiddenRoots: readonly string[],
): void {
  assertHandoffAncestors(path);
  const credential = parseCredential(value);
  if (!Array.isArray(forbiddenRoots) || forbiddenRoots.length === 0)
    fail(INVALID);
  for (const root of forbiddenRoots) {
    if (typeof root !== "string" || root.length === 0 || root.includes("\0"))
      fail(INVALID);
  }
  const absolute = resolve(path);
  const name = basename(absolute);
  if (name === "" || name === "." || name === "..") fail(INVALID);
  const parent = dirname(absolute);
  if (parent === absolute) fail(UNSAFE);
  const root = pin(parent, forbiddenRoots);
  const target = join(root.path, name);
  const text = JSON.stringify(credential);
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) fail(INVALID);
  writeSecureExclusive(target, text);
  assertPrivateRoot(root);
}
