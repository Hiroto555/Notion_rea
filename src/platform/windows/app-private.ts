import { CollaborationError } from "../../collaboration/runtime/contract";
import {
  WindowsPrivatePlatform,
  type PrivatePlatform,
} from "../../sync/private-platform";
import { WindowsRuntimePlatform } from "./runtime-platform";

export type WindowsAppPrivateConfig = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
}>;

export type WindowsNativeWorkspaceIdentity = Readonly<{
  canonicalPath: string;
  volumeId: string;
  fileId: string;
}>;

export type WindowsAppPrivate = Readonly<{
  runtimePlatform(
    directory: string,
    name?: string,
    createDirectory?: boolean,
  ): WindowsRuntimePlatform;
  ledgerPlatform(directory: string, name: string): PrivatePlatform;
  workspaceIdentity(databasePath: string): WindowsNativeWorkspaceIdentity;
  privateFileIdentity(path: string): WindowsNativeWorkspaceIdentity;
  assertPrivateDirectory(path: string): void;
}>;

const DEFAULT_RUNTIME_NAME = "shared-runtime.sqlite";

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "root",
  "probeExecutable",
  "expectedHash",
  "systemRoot",
]);

const LEDGER_BASENAME = /^[a-z][a-z0-9-]{0,60}\.sqlite$/;
const HASH = /^[0-9a-f]{64}$/;
const VOLUME_ID = /^[0-9A-Fa-f]{16}$/;
const FILE_ID = /^[0-9A-Fa-f]{32}$/;
const ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function readConfig(value: unknown): WindowsAppPrivateConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("INVALID_WINDOWS_APP_PRIVATE_CONFIG");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!CONFIG_KEYS.has(key)) fail("INVALID_WINDOWS_APP_PRIVATE_CONFIG");
  const expectedHash = text(input.expectedHash, "INVALID_PROBE_HASH");
  if (!HASH.test(expectedHash)) fail("INVALID_PROBE_HASH");
  return Object.freeze({
    root: text(input.root, "INVALID_WINDOWS_ROOT"),
    probeExecutable: text(
      input.probeExecutable,
      "INVALID_PROBE_EXECUTABLE",
    ),
    expectedHash,
    systemRoot: text(input.systemRoot, "INVALID_SYSTEM_ROOT"),
  });
}

function readLedgerName(value: unknown): string {
  if (typeof value !== "string" || !LEDGER_BASENAME.test(value))
    fail("INVALID_DATABASE_NAME");
  return value;
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

type RuntimeWithValidatedIdentity = Readonly<{
  validatedFileIdentity(path: string): unknown;
}>;

function readValidatedIdentity(
  runtime: WindowsRuntimePlatform,
  path: string,
): WindowsNativeWorkspaceIdentity {
  const method = (runtime as unknown as Partial<RuntimeWithValidatedIdentity>)
    .validatedFileIdentity;
  if (typeof method !== "function")
    fail("WINDOWS_VALIDATED_IDENTITY_UNAVAILABLE");
  let raw: unknown;
  try {
    raw = method.call(runtime, path);
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    fail("WINDOWS_VALIDATED_IDENTITY_FAILED");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  const record = raw as Record<string, unknown>;
  const canonicalPath = record.canonicalPath;
  const volumeId = record.volumeId;
  const fileId = record.fileId;
  if (
    typeof canonicalPath !== "string" ||
    !ABSOLUTE_WINDOWS_PATH.test(canonicalPath)
  )
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  if (typeof volumeId !== "string" || !VOLUME_ID.test(volumeId))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  if (typeof fileId !== "string" || !FILE_ID.test(fileId))
    fail("WINDOWS_VALIDATED_IDENTITY_INVALID");
  return Object.freeze({ canonicalPath, volumeId, fileId });
}

export function createWindowsAppPrivate(
  value: WindowsAppPrivateConfig,
): WindowsAppPrivate {
  const config = readConfig(value);

  function runtimeFor(databaseName: string): WindowsRuntimePlatform {
    return new WindowsRuntimePlatform({
      root: config.root,
      probeExecutable: config.probeExecutable,
      expectedHash: config.expectedHash,
      systemRoot: config.systemRoot,
      databaseName,
    });
  }

  function runtimePlatform(
    directory: string,
    name: string = DEFAULT_RUNTIME_NAME,
    createDirectory: boolean = true,
  ): WindowsRuntimePlatform {
    if (typeof directory !== "string" || directory.length === 0)
      fail("INVALID_WINDOWS_PRIVATE_DIRECTORY");
    if (typeof createDirectory !== "boolean")
      fail("INVALID_WINDOWS_PRIVATE_DIRECTORY");
    const databaseName = readLedgerName(name);
    const runtime = runtimeFor(databaseName);
    if (!createDirectory) return runtime;
    try {
      runtime.prepareDirectory(directory);
    } catch (error) {
      runtime.close();
      throw error;
    }
    return runtime;
  }

  function ledgerPlatform(directory: string, name: string): PrivatePlatform {
    const runtime = runtimePlatform(directory, name, true);
    try {
      return new WindowsPrivatePlatform(runtime);
    } catch (error) {
      runtime.close();
      throw error;
    }
  }

  function workspaceIdentity(
    databasePath: string,
  ): WindowsNativeWorkspaceIdentity {
    const path = text(databasePath, "INVALID_WINDOWS_DATABASE_PATH");
    const databaseName = readLedgerName(windowsBasename(path));
    const directory = windowsDirname(path);
    const runtime = runtimeFor(databaseName);
    try {
      runtime.bind(directory);
      runtime.assertFile(path);
      return readValidatedIdentity(runtime, path);
    } finally {
      runtime.close();
    }
  }

  function privateFileIdentity(path: string): WindowsNativeWorkspaceIdentity {
    const runtime = runtimeFor(DEFAULT_RUNTIME_NAME);
    try { runtime.bind(windowsDirname(path)); return runtime.validatedPrivateFileIdentity(path); }
    finally {runtime.close();}
  }
  function assertPrivateDirectory(path: string): void {
    const runtime = runtimeFor(DEFAULT_RUNTIME_NAME);
    try {runtime.bind(path);runtime.assertRoot();} finally {runtime.close();}
  }
  return Object.freeze({
    runtimePlatform,
    privateFileIdentity,
    assertPrivateDirectory,
    ledgerPlatform,
    workspaceIdentity,
  });
}
