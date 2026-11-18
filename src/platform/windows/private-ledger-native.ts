import { CollaborationError } from "../../collaboration/runtime/contract";
import {
  WindowsPrivatePlatform,
  isValidPrivateLedgerName,
  WINDOWS_PRIVATE_TRUST_BOUNDARY,
} from "../../sync/private-platform";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimePlatformOptions,
} from "./runtime-platform";

export const WINDOWS_PRIVATE_NATIVE_FACTORY_TRUST_BOUNDARY =
  WINDOWS_PRIVATE_TRUST_BOUNDARY;

export type WindowsPrivatePlatformOptions = Readonly<{
  root: string;
  probeExecutable: string;
  systemRoot: string;
  databaseName?: string;
  expectedHash?: string;
  untrustedTestPort?: WindowsRuntimePlatformOptions["untrustedTestPort"];
}>;

const OPTION_KEYS: ReadonlySet<string> = new Set([
  "root",
  "probeExecutable",
  "systemRoot",
  "databaseName",
  "expectedHash",
  "untrustedTestPort",
]);

function fail(code: string): never {
  throw new CollaborationError(code);
}

function storeOptions(
  value: WindowsPrivatePlatformOptions,
): WindowsPrivatePlatformOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("INVALID_WINDOWS_PRIVATE_PLATFORM_OPTIONS");
  const options = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(options))
    if (!OPTION_KEYS.has(key))
      fail("INVALID_WINDOWS_PRIVATE_PLATFORM_OPTIONS");
  const databaseName = options.databaseName;
  if (databaseName !== undefined) {
    if (!isValidPrivateLedgerName(databaseName))
      fail("INVALID_DATABASE_NAME");
  }
  return value;
}

function buildPlatform(
  options: WindowsPrivatePlatformOptions,
): WindowsPrivatePlatform {
  const runtime = new WindowsRuntimePlatform({
    root: options.root,
    probeExecutable: options.probeExecutable,
    systemRoot: options.systemRoot,
    databaseName: options.databaseName,
    expectedHash: options.expectedHash,
    untrustedTestPort: options.untrustedTestPort,
  });
  return new WindowsPrivatePlatform(runtime);
}

/**
 * Production factory. An executable hash is mandatory and the untrusted test
 * seam is refused, so a production wiring cannot silently skip executable
 * pinning or substitute fake filesystem proof.
 */
export function createWindowsPrivatePlatform(
  value: WindowsPrivatePlatformOptions,
): WindowsPrivatePlatform {
  const options = storeOptions(value);
  if (options.untrustedTestPort !== undefined)
    fail("WINDOWS_PRIVATE_TEST_PORT_FORBIDDEN");
  if (options.expectedHash === undefined)
    fail("WINDOWS_PRIVATE_EXPECTED_HASH_REQUIRED");
  return buildPlatform(options);
}

/**
 * Explicit contract-test factory. It can never run on win32 (actual Windows
 * acceptance must go through the production factory above), and it only
 * permits the already-labelled untrusted runtime seam.
 */
export function createWindowsPrivatePlatformForTesting(
  value: WindowsPrivatePlatformOptions,
): WindowsPrivatePlatform {
  if (process.platform === "win32")
    fail("WINDOWS_PRIVATE_TEST_PORT_FORBIDDEN");
  const options = storeOptions(value);
  if (options.untrustedTestPort === undefined)
    fail("WINDOWS_PRIVATE_TEST_PORT_REQUIRED");
  return buildPlatform(options);
}
