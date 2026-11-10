import { CollaborationError } from "../../collaboration/runtime/contract";
import {
  createWindowsAppPrivate,
  type WindowsAppPrivateConfig,
} from "./app-private";
import { WindowsRuntimePlatform } from "./runtime-platform";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";
import type {
  SharedRecoveryFileIdentity,
  SharedRecoveryFilesystemProof,
} from "../../main/shared-recovery-index";

/**
 * Windows native proof adapter for SharedRecoveryIndex.
 *
 * Every assertion and index creation goes through WindowsRuntimePlatform, which
 * in turn uses the pinned, hashed compiled native probe. There is deliberately
 * no uid/mode/chmod surrogate and no boolean escape hatch: if the native helper
 * cannot prove the path, the operation fails.
 *
 * Root/directory creation must use the native helper. The parent-owned
 * app-private `runtimePlatform(directory, name, createDirectory)` factory is
 * used when available; without it this adapter can only assert existing roots.
 * Identity additionally requires the native `validatedFileIdentity` method.
 */

const INDEX_NAME = "shared-recovery-index.sqlite";
const FILE_ID_PATTERN = /^[0-9A-Fa-f]{32}$/;
const VOLUME_ID_PATTERN = /^[0-9A-Fa-f]{16}$/;

type RuntimeWithIdentity = WindowsRuntimePlatform & {
  validatedFileIdentity?(path: string): unknown;
};

type NativeRuntimeFactory = Readonly<{
  runtimePlatform(
    directory: string,
    name: string,
    createDirectory: boolean,
  ): RuntimeWithIdentity;
}>;

type CachedRuntime = {
  readonly runtime: RuntimeWithIdentity;
  readonly directory: string;
  bound: boolean;
};

function fail(code: string): never {
  throw new CollaborationError(code);
}

function windowsBasename(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index >= 0 ? path.slice(index + 1) : path;
}

function windowsDirname(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (index < 0) fail("INVALID_WINDOWS_DATABASE_PATH");
  if (index === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3);
  if (index === 0) return path.slice(0, 1);
  return path.slice(0, index);
}

function canonical(path: string, root: string): string {
  return validateWindowsPath(path, root).canonical;
}

function readIdentity(
  runtime: RuntimeWithIdentity,
  path: string,
): SharedRecoveryFileIdentity {
  const method = runtime.validatedFileIdentity;
  if (typeof method !== "function")
    fail("WINDOWS_VALIDATED_IDENTITY_UNAVAILABLE");
  let raw: unknown;
  try {
    raw = method.call(runtime, path);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string") fail(code);
    }
    fail("WINDOWS_VALIDATED_IDENTITY_FAILED");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  const record = raw as Record<string, unknown>;
  const fileId = record.fileId;
  const volumeId = record.volumeId;
  if (typeof fileId !== "string" || !FILE_ID_PATTERN.test(fileId))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  if (typeof volumeId !== "string" || !VOLUME_ID_PATTERN.test(volumeId))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  return Object.freeze({ fileId, volumeId });
}

export function createWindowsRecoveryProof(
  config: WindowsAppPrivateConfig,
): SharedRecoveryFilesystemProof {
  const appPrivate = createWindowsAppPrivate(config);
  const factory = (
    appPrivate as unknown as Partial<NativeRuntimeFactory>
  ).runtimePlatform;
  const cache = new Map<string, CachedRuntime>();

  function cacheKey(
    directory: string,
    name: string,
    createDirectory: boolean,
  ): string {
    return `${asciiCaseFold(directory)}|${asciiCaseFold(name)}|${
      createDirectory ? "create" : "read"
    }`;
  }

  function makeRuntime(
    directory: string,
    name: string,
    createDirectory: boolean,
  ): RuntimeWithIdentity {
    if (typeof factory === "function")
      return factory.call(appPrivate, directory, name, createDirectory);
    if (createDirectory) fail("WINDOWS_RUNTIME_PLATFORM_UNAVAILABLE");
    return new WindowsRuntimePlatform({
      root: config.root,
      probeExecutable: config.probeExecutable,
      expectedHash: config.expectedHash,
      systemRoot: config.systemRoot,
      databaseName: name,
    }) as RuntimeWithIdentity;
  }

  function drop(key: string, entry: CachedRuntime): void {
    cache.delete(key);
    if (entry.bound && typeof entry.runtime.close === "function") {
      try {
        entry.runtime.close();
      } catch {
        // Best effort: the original failure is what callers must see.
      }
    }
  }

  function runtimeFor(
    directory: string,
    name: string,
    createDirectory: boolean,
  ): CachedRuntime {
    const key = cacheKey(directory, name, createDirectory);
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const runtime = makeRuntime(directory, name, createDirectory);
    const entry: CachedRuntime = { runtime, directory, bound: false };
    cache.set(key, entry);
    return entry;
  }

  function bound(
    directory: string,
    name: string,
    createDirectory: boolean,
  ): RuntimeWithIdentity {
    const key = cacheKey(directory, name, createDirectory);
    const entry = runtimeFor(directory, name, createDirectory);
    if (entry.bound) return entry.runtime;
    try {
      entry.runtime.bind(directory);
      entry.bound = true;
      return entry.runtime;
    } catch (error) {
      drop(key, entry);
      throw error;
    }
  }

  function ensureRoot(root: string): void {
    const canonicalRoot = canonical(root, root);
    bound(canonicalRoot, INDEX_NAME, true).assertRoot();
  }

  function assertRoot(root: string): void {
    const canonicalRoot = canonical(root, root);
    bound(canonicalRoot, INDEX_NAME, false).assertRoot();
  }

  function assertDirectory(directory: string, root: string): void {
    const canonicalRoot = canonical(root, root);
    const target = canonical(directory, canonicalRoot);
    bound(target, INDEX_NAME, false).assertRoot();
  }

  function assertFile(path: string, root: string): void {
    const canonicalRoot = canonical(root, root);
    const target = canonical(path, canonicalRoot);
    bound(windowsDirname(target), windowsBasename(target), false).assertFile(
      target,
    );
  }

  function createIndex(path: string, root: string): void {
    const canonicalRoot = canonical(root, root);
    const target = canonical(path, canonicalRoot);
    if (windowsBasename(target) !== INDEX_NAME)
      fail("INVALID_RECOVERY_INDEX_PATH");
    const runtime = bound(windowsDirname(target), INDEX_NAME, true);
    runtime.assertRoot();
    runtime.createExclusiveDurably(target);
    runtime.syncCreatedDatabase(target);
  }

  function identity(path: string, root: string): SharedRecoveryFileIdentity {
    const canonicalRoot = canonical(root, root);
    const target = canonical(path, canonicalRoot);
    const runtime = bound(
      windowsDirname(target),
      windowsBasename(target),
      false,
    );
    runtime.assertFile(target);
    return readIdentity(runtime, target);
  }

  return Object.freeze({
    ensureRoot,
    assertRoot,
    assertDirectory,
    assertFile,
    createIndex,
    identity,
  });
}
