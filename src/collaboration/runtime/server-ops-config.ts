import { SyncError, identifier } from "../../sync/protocol";
import {
  readServerOpsConfig as posixReadServerOpsConfig,
  writeServerOpsConfig as posixWriteServerOpsConfig,
  readIssuedSyncCredential as posixReadIssuedSyncCredential,
  writeIssuedSyncCredential as posixWriteIssuedSyncCredential,
  type IssuedSyncCredential,
  type ServerOpsConfig,
} from "../../sync/server-ops-config";
import {
  windowsServerNative,
  type WindowsServerNativePort,
} from "../../platform/windows/server-native";

export type { IssuedSyncCredential, ServerOpsConfig };

type ErrorCode = "server-config-invalid" | "server-config-unsafe";
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
const MAX_FILE_BYTES = 4_096;
/** Names that mark a managed root; a credential handoff may never share an
 * ancestor with any of them (mirrors the POSIX ancestor walk). */
const FORBIDDEN_NAMES = [
  "workspace.sqlite",
  "server.sqlite",
  "full-manifest.json",
  "manifest.json",
  ".folio-sync-transfers",
] as const;
const MAX_ANCESTORS = 128;

function fail(code: ErrorCode): never {
  throw new SyncError(code, ERROR_STATUS);
}

/** Map any non-parse native failure to the fixed unsafe code; never leak
 * helper/transport detail across this boundary. */
function normalize(error: unknown): never {
  if (
    error instanceof SyncError &&
    (error.code === INVALID || error.code === UNSAFE)
  )
    throw error;
  fail(UNSAFE);
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

function decodeUtf8(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) fail(INVALID);
  return text;
}

function parseJson<T>(text: string, parse: (value: unknown) => T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(INVALID);
  }
  return parse(parsed);
}

/**
 * Walk ancestors of a handoff target within the configured native root and
 * reject any directory that carries a managed-root marker name. Ancestors
 * above the configured root are outside this adapter's authority (the root
 * itself is provisioned by the parent).
 */
function assertHandoffAncestors(
  native: WindowsServerNativePort,
  path: string,
): void {
  const inside = (p: string): boolean => {
    try {
      native.canonical(p, true);
      return true;
    } catch {
      return false;
    }
  };
  let parent = native.parent(path);
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    // Ancestors above the configured root are outside this adapter's
    // authority (the root itself is provisioned by the parent).
    if (!inside(parent)) return;
    for (const name of FORBIDDEN_NAMES) {
      if (native.kindOf(native.join(parent, name)) !== "absent")
        fail(UNSAFE);
    }
    if (native.samePath(parent, native.root)) return;
    const next = native.parent(parent);
    if (native.samePath(next, parent)) return;
    parent = next;
  }
  fail(UNSAFE);
}

function nativeReadFile(
  native: WindowsServerNativePort,
  path: string,
): string {
  const file = native.inspectFile(path, MAX_FILE_BYTES);
  if (file.bytes > MAX_FILE_BYTES) fail(INVALID);
  const bytes = native.readFile(path, file, MAX_FILE_BYTES);
  if (bytes.byteLength !== file.bytes) fail(UNSAFE);
  return decodeUtf8(bytes);
}

function nativeWriteNew(
  native: WindowsServerNativePort,
  path: string,
  text: string,
): void {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_FILE_BYTES) fail(INVALID);
  if (native.kindOf(path) !== "absent") fail(UNSAFE);
  const created = native.writeNewFile(path, bytes, MAX_FILE_BYTES);
  if (
    created.bytes !== bytes.byteLength ||
    !native.samePath(created.path, path)
  )
    fail(UNSAFE);
  // Readback through the proved identity: the durable bytes must equal the
  // intent exactly; a new exclusive output is never silently corrected.
  const current = native.inspectFile(path, MAX_FILE_BYTES);
  if (!native.sameIdentity(current, created)) fail(UNSAFE);
  const readback = native.readFile(path, current, MAX_FILE_BYTES);
  if (!Buffer.from(readback).equals(bytes)) fail(UNSAFE);
}

export function readServerOpsConfig(directory: string): ServerOpsConfig {
  const native = windowsServerNative();
  if (native === undefined) return posixReadServerOpsConfig(directory);
  try {
    const dir = native.canonical(directory);
    const root = native.inspectDirectory(dir);
    const path = native.join(dir, CONFIG_FILE);
    const text = nativeReadFile(native, path);
    native.assertDirectory(dir, root);
    return parseJson(text, parseConfig);
  } catch (error) {
    return normalize(error);
  }
}

export function writeServerOpsConfig(
  directory: string,
  config: ServerOpsConfig,
): void {
  const native = windowsServerNative();
  if (native === undefined)
    return posixWriteServerOpsConfig(directory, config);
  const value = parseConfig(config);
  try {
    const dir = native.canonical(directory);
    const root = native.inspectDirectory(dir);
    const text = JSON.stringify(value);
    nativeWriteNew(native, native.join(dir, CONFIG_FILE), text);
    native.assertDirectory(dir, root);
    native.assertCurrent();
  } catch (error) {
    return normalize(error);
  }
}

export function readIssuedSyncCredential(path: string): IssuedSyncCredential {
  const native = windowsServerNative();
  if (native === undefined) return posixReadIssuedSyncCredential(path);
  try {
    const absolute = native.canonical(path);
    assertHandoffAncestors(native, absolute);
    const parent = native.parent(absolute);
    const root = native.inspectDirectory(parent);
    const text = nativeReadFile(native, absolute);
    native.assertDirectory(parent, root);
    return parseJson(text, parseCredential);
  } catch (error) {
    return normalize(error);
  }
}

export function writeIssuedSyncCredential(
  path: string,
  value: IssuedSyncCredential,
  forbiddenRoots: readonly string[],
): void {
  const native = windowsServerNative();
  if (native === undefined)
    return posixWriteIssuedSyncCredential(path, value, forbiddenRoots);
  const credential = parseCredential(value);
  try {
    if (!Array.isArray(forbiddenRoots) || forbiddenRoots.length === 0)
      fail(INVALID);
    const absolute = native.canonical(path);
    const name = native.basename(absolute);
    if (name === "" || name === "." || name === "..") fail(INVALID);
    const parent = native.parent(absolute);
    if (native.samePath(parent, absolute)) fail(UNSAFE);
    for (const root of forbiddenRoots) {
      if (typeof root !== "string" || root.length === 0 || root.includes("\0"))
        fail(INVALID);
      const forbidden = native.canonicalAbsolute(root);
      // No overlap in either direction: the credential may not sit inside a
      // managed server/workspace root, nor may a root sit inside the target.
      if (native.overlaps(parent, forbidden) || native.overlaps(absolute, forbidden))
        fail(UNSAFE);
    }
    assertHandoffAncestors(native, absolute);
    const rootPin = native.inspectDirectory(parent);
    const text = JSON.stringify(credential);
    nativeWriteNew(native, absolute, text);
    native.assertDirectory(parent, rootPin);
    native.assertCurrent();
  } catch (error) {
    return normalize(error);
  }
}
