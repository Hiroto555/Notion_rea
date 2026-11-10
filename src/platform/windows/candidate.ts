import {
  CollaborationError,
  wellFormed,
} from "../../collaboration/runtime/contract";
import { RuntimeStore } from "../../collaboration/runtime/store";
import {
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeDirectoryIdentity,
} from "./runtime-platform";

export const WINDOWS_CANDIDATE_READY_CODE = "WINDOWS_CANDIDATE_ROOT_READY";
export const WINDOWS_CANDIDATE_TRUST_BOUNDARY =
  "Injected candidate probes are untrusted contract checks and never become Windows physical PASS.";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_ID_PATTERN = /^[0-9A-Fa-f]{32}$/;
const VOLUME_ID_PATTERN = /^[0-9A-Fa-f]{16}$/;
const ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;

const MANIFEST_KEYS = [
  "candidate",
  "code",
  "created",
  "directories",
  "nonce",
  "ownerSid",
  "ownershipFileId",
  "ownershipPath",
  "physical",
  "root",
  "rootFileId",
  "volumeId",
] as const;
const MANIFEST_KEY_SET: ReadonlySet<string> = new Set(MANIFEST_KEYS);
const DIRECTORY_KEYS = ["name", "path", "fileId", "volumeId"] as const;
const DIRECTORY_KEY_SET: ReadonlySet<string> = new Set(DIRECTORY_KEYS);
const CHILD_NAMES = ["clienta", "clientb", "server"] as const;

export type WindowsCandidateChildName = (typeof CHILD_NAMES)[number];

export type WindowsCandidateExpectedPaths = Readonly<{
  root: string;
  nonce: string;
  clientA: string;
  clientB: string;
  server: string;
  ownershipPath: string;
}>;

export type WindowsCandidateChild = Readonly<{
  name: WindowsCandidateChildName;
  path: string;
  fileId: string;
  volumeId: string;
}>;

export type WindowsCandidateManifest = Readonly<{
  root: string;
  nonce: string;
  ownerSid: string;
  rootFileId: string;
  volumeId: string;
  ownershipPath: string;
  ownershipFileId: string;
  directories: readonly WindowsCandidateChild[];
}>;

export type WindowsCandidateUnsafeProbe = Readonly<{
  probe(path: string, root: string): unknown | Promise<unknown>;
}>;

export type WindowsCandidateStoreOptions = Readonly<{
  systemRoot: string;
  probeExecutable: string;
  expectedHash: string;
  untrustedProbe?: WindowsCandidateUnsafeProbe;
  platform?: NodeJS.Platform;
}>;

export type WindowsCandidateStores = Readonly<{
  manifest: WindowsCandidateManifest;
  authority: RuntimeStore;
  clients: readonly [RuntimeStore, RuntimeStore];
  close(): void;
}>;

export type WindowsCandidateCreation =
  | Readonly<{
      status: "READY";
      physical: "NOT_RUN";
      manifest: WindowsCandidateManifest;
      stores: WindowsCandidateStores;
    }>
  | Readonly<{
      status: "NOT_RUN";
      physical: "NOT_RUN";
      code: string;
      reason: string;
      manifest: WindowsCandidateManifest;
    }>;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function asciiCaseFold(value: string): string {
  let folded = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    folded +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + 0x20)
        : value[index];
  }
  return folded;
}

function samePath(left: string, right: string): boolean {
  return asciiCaseFold(left) === asciiCaseFold(right);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code);
  const result = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(result);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Object.getOwnPropertySymbols(result).length !== 0) fail(code);
  return result;
}

function field(
  value: Record<string, unknown>,
  key: string,
  code: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
    fail(code);
  return descriptor.value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.size) fail(code);
  for (const key of keys) if (!allowed.has(key)) fail(code);
}

function text(value: unknown, code: string, maximum = 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !wellFormed(value)
  )
    fail(code);
  return value as string;
}

function nonce(value: unknown, code: string): string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) fail(code);
  return value;
}

function hex(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value as string;
}

function canonicalAbsolute(value: unknown, code: string): string {
  const input = text(value, code);
  if (!ABSOLUTE_PATTERN.test(input)) fail(code);
  try {
    return validateWindowsPath(input, `${input[0].toUpperCase()}:\\`).canonical;
  } catch (error) {
    if (error instanceof CollaborationError) fail(code);
    throw error;
  }
}

function canonicalUnder(value: unknown, root: string, code: string): string {
  const canonical = canonicalAbsolute(value, code);
  try {
    validateWindowsPath(canonical, root);
  } catch {
    fail(code);
  }
  return canonical;
}

function expectedPaths(
  value: WindowsCandidateExpectedPaths,
): WindowsCandidateExpectedPaths {
  const expected = record(value, "INVALID_WINDOWS_CANDIDATE_EXPECTED");
  requireExactKeys(
    expected,
    new Set(["root", "nonce", "clientA", "clientB", "server", "ownershipPath"]),
    "INVALID_WINDOWS_CANDIDATE_EXPECTED",
  );
  const root = canonicalAbsolute(
    field(expected, "root", "INVALID_WINDOWS_CANDIDATE_EXPECTED"),
    "INVALID_WINDOWS_CANDIDATE_EXPECTED",
  );
  const clientA = canonicalUnder(
    field(expected, "clientA", "INVALID_WINDOWS_CANDIDATE_EXPECTED"),
    root,
    "INVALID_WINDOWS_CANDIDATE_EXPECTED",
  );
  const clientB = canonicalUnder(
    field(expected, "clientB", "INVALID_WINDOWS_CANDIDATE_EXPECTED"),
    root,
    "INVALID_WINDOWS_CANDIDATE_EXPECTED",
  );
  const server = canonicalUnder(
    field(expected, "server", "INVALID_WINDOWS_CANDIDATE_EXPECTED"),
    root,
    "INVALID_WINDOWS_CANDIDATE_EXPECTED",
  );
  const ownershipPath = canonicalUnder(
    field(expected, "ownershipPath", "INVALID_WINDOWS_CANDIDATE_EXPECTED"),
    root,
    "INVALID_WINDOWS_CANDIDATE_EXPECTED",
  );
  const paths = [clientA, clientB, server, ownershipPath];
  const folded = new Set(paths.map(asciiCaseFold));
  if (
    folded.size !== paths.length ||
    paths.some((path) => samePath(path, root))
  )
    fail("INVALID_WINDOWS_CANDIDATE_EXPECTED");
  return Object.freeze({
    root,
    nonce: nonce(
      field(expected, "nonce", "INVALID_WINDOWS_CANDIDATE_EXPECTED"),
      "INVALID_WINDOWS_CANDIDATE_EXPECTED",
    ),
    clientA,
    clientB,
    server,
    ownershipPath,
  });
}

function expectedChildPaths(
  expected: WindowsCandidateExpectedPaths,
): Readonly<Record<WindowsCandidateChildName, string>> {
  return Object.freeze({
    clienta: expected.clientA,
    clientb: expected.clientB,
    server: expected.server,
  });
}

function parseChild(
  value: unknown,
  root: string,
  rootVolumeId: string,
  expectedName: WindowsCandidateExpectedPaths,
): WindowsCandidateChild {
  const child = record(value, "WINDOWS_CANDIDATE_CHILD_INVALID");
  requireExactKeys(child, DIRECTORY_KEY_SET, "WINDOWS_CANDIDATE_CHILD_INVALID");
  const recordName = text(
    field(child, "name", "WINDOWS_CANDIDATE_CHILD_INVALID"),
    "WINDOWS_CANDIDATE_CHILD_INVALID",
    16,
  );
  if (!(CHILD_NAMES as readonly string[]).includes(recordName))
    fail("WINDOWS_CANDIDATE_CHILD_INVALID");
  const name = recordName as WindowsCandidateChildName;
  const path = canonicalUnder(
    field(child, "path", "WINDOWS_CANDIDATE_CHILD_INVALID"),
    root,
    "WINDOWS_CANDIDATE_CHILD_INVALID",
  );
  const expectedPath = expectedChildPaths(expectedName)[name];
  if (!samePath(path, expectedPath)) fail("WINDOWS_CANDIDATE_CHILD_PATH");
  const fileId = hex(
    field(child, "fileId", "WINDOWS_CANDIDATE_CHILD_INVALID"),
    FILE_ID_PATTERN,
    "WINDOWS_CANDIDATE_CHILD_INVALID",
  );
  const volumeId = hex(
    field(child, "volumeId", "WINDOWS_CANDIDATE_CHILD_INVALID"),
    VOLUME_ID_PATTERN,
    "WINDOWS_CANDIDATE_CHILD_INVALID",
  );
  if (!samePath(volumeId, rootVolumeId)) fail("WINDOWS_CANDIDATE_CHILD_VOLUME");
  return Object.freeze({ name, path, fileId, volumeId });
}

/** Strict loader for the actual create-candidate-root.ps1 JSON manifest. */
export function parseWindowsCandidateManifest(
  value: unknown,
  expectedValue: WindowsCandidateExpectedPaths,
): WindowsCandidateManifest {
  const expected = expectedPaths(expectedValue);
  const manifest = record(value, "WINDOWS_CANDIDATE_MANIFEST_INVALID");
  requireExactKeys(
    manifest,
    MANIFEST_KEY_SET,
    "WINDOWS_CANDIDATE_MANIFEST_INVALID",
  );
  if (
    field(manifest, "candidate", "WINDOWS_CANDIDATE_MANIFEST_INVALID") !== true
  )
    fail("WINDOWS_CANDIDATE_NOT_READY");
  if (field(manifest, "created", "WINDOWS_CANDIDATE_MANIFEST_INVALID") !== true)
    fail("WINDOWS_CANDIDATE_NOT_CREATED");
  if (
    field(manifest, "code", "WINDOWS_CANDIDATE_MANIFEST_INVALID") !==
    WINDOWS_CANDIDATE_READY_CODE
  )
    fail("WINDOWS_CANDIDATE_CODE");
  if (
    field(manifest, "physical", "WINDOWS_CANDIDATE_MANIFEST_INVALID") !==
    "NOT_RUN"
  )
    fail("WINDOWS_CANDIDATE_PHYSICAL");
  const root = canonicalAbsolute(
    field(manifest, "root", "WINDOWS_CANDIDATE_MANIFEST_INVALID"),
    "WINDOWS_CANDIDATE_MANIFEST_INVALID",
  );
  if (!samePath(root, expected.root)) fail("WINDOWS_CANDIDATE_ROOT");
  const manifestNonce = nonce(
    field(manifest, "nonce", "WINDOWS_CANDIDATE_MANIFEST_INVALID"),
    "WINDOWS_CANDIDATE_NONCE",
  );
  if (manifestNonce !== expected.nonce) fail("WINDOWS_CANDIDATE_NONCE");
  const ownerSid = text(
    field(manifest, "ownerSid", "WINDOWS_CANDIDATE_MANIFEST_INVALID"),
    "WINDOWS_CANDIDATE_OWNER",
    184,
  );
  const rootFileId = hex(
    field(manifest, "rootFileId", "WINDOWS_CANDIDATE_MANIFEST_INVALID"),
    FILE_ID_PATTERN,
    "WINDOWS_CANDIDATE_ROOT_ID",
  );
  const volumeId = hex(
    field(manifest, "volumeId", "WINDOWS_CANDIDATE_MANIFEST_INVALID"),
    VOLUME_ID_PATTERN,
    "WINDOWS_CANDIDATE_VOLUME_ID",
  );
  const ownershipPath = canonicalUnder(
    field(manifest, "ownershipPath", "WINDOWS_CANDIDATE_MANIFEST_INVALID"),
    root,
    "WINDOWS_CANDIDATE_OWNERSHIP",
  );
  if (!samePath(ownershipPath, expected.ownershipPath))
    fail("WINDOWS_CANDIDATE_OWNERSHIP");
  const ownershipFileId = hex(
    field(manifest, "ownershipFileId", "WINDOWS_CANDIDATE_MANIFEST_INVALID"),
    FILE_ID_PATTERN,
    "WINDOWS_CANDIDATE_OWNERSHIP",
  );

  const rawDirectories = field(
    manifest,
    "directories",
    "WINDOWS_CANDIDATE_MANIFEST_INVALID",
  );
  if (
    !Array.isArray(rawDirectories) ||
    rawDirectories.length !== CHILD_NAMES.length
  )
    fail("WINDOWS_CANDIDATE_CHILDREN");
  const directories = rawDirectories.map((entry) =>
    parseChild(entry, root, volumeId, expected),
  );
  const names = new Set(directories.map((entry) => entry.name));
  if (names.size !== CHILD_NAMES.length) fail("WINDOWS_CANDIDATE_CHILDREN");
  const childPaths = new Set(
    directories.map((entry) => asciiCaseFold(entry.path)),
  );
  if (childPaths.size !== CHILD_NAMES.length)
    fail("WINDOWS_CANDIDATE_CHILD_PATH");
  if (samePath(rootFileId, ownershipFileId))
    fail("WINDOWS_CANDIDATE_CHILD_FILE_ID");
  const fileIds = new Set<string>();
  fileIds.add(asciiCaseFold(rootFileId));
  fileIds.add(asciiCaseFold(ownershipFileId));
  for (const child of directories) {
    const fileId = asciiCaseFold(child.fileId);
    if (fileIds.has(fileId)) fail("WINDOWS_CANDIDATE_CHILD_FILE_ID");
    fileIds.add(fileId);
  }

  return Object.freeze({
    root,
    nonce: manifestNonce,
    ownerSid,
    rootFileId,
    volumeId,
    ownershipPath,
    ownershipFileId,
    directories: Object.freeze(directories),
  });
}

function childByPath(
  manifest: WindowsCandidateManifest,
  path: string,
): WindowsCandidateChild {
  const child = manifest.directories.find((entry) =>
    samePath(entry.path, path),
  );
  if (child === undefined) fail("WINDOWS_CANDIDATE_CHILD_PATH");
  return child;
}

function childByName(
  manifest: WindowsCandidateManifest,
  name: WindowsCandidateChildName,
): WindowsCandidateChild {
  const child = manifest.directories.find((entry) => entry.name === name);
  if (child === undefined) fail("WINDOWS_CANDIDATE_CHILDREN");
  return child;
}

function storeOptions(
  value: WindowsCandidateStoreOptions,
): WindowsCandidateStoreOptions {
  const options = record(value, "INVALID_WINDOWS_CANDIDATE_OPTIONS");
  for (const key of Object.keys(options))
    if (
      key !== "systemRoot" &&
      key !== "probeExecutable" &&
      key !== "expectedHash" &&
      key !== "untrustedProbe" &&
      key !== "platform"
    )
      fail("INVALID_WINDOWS_CANDIDATE_OPTIONS");
  return value;
}

export function assertWindowsCandidateEvidence(
  manifest: WindowsCandidateManifest,
  path: string,
  raw: unknown,
): WindowsProbeEvidence {
  const child = childByPath(manifest, path);
  assertWindowsProbe(raw, {
    canonicalPath: child.path,
    canonicalRoot: manifest.root,
  });
  const evidence = raw as WindowsProbeEvidence;
  if (
    !samePath(evidence.fileId, child.fileId) ||
    !samePath(evidence.volumeId, child.volumeId) ||
    !samePath(evidence.rootFileId, manifest.rootFileId) ||
    !samePath(evidence.rootVolumeId, manifest.volumeId) ||
    !samePath(evidence.volumeId, manifest.volumeId)
  )
    fail("WINDOWS_CANDIDATE_EVIDENCE_ID");
  if (!samePath(evidence.ownerSid, manifest.ownerSid))
    fail("WINDOWS_CANDIDATE_EVIDENCE_OWNER");
  return evidence;
}

function directoryIdentity(
  child: WindowsCandidateChild,
): WindowsRuntimeDirectoryIdentity {
  return Object.freeze({ fileId: child.fileId, volumeId: child.volumeId });
}

export function openWindowsCandidateStores(
  manifest: WindowsCandidateManifest,
  optionsValue: WindowsCandidateStoreOptions,
): WindowsCandidateStores {
  const options = storeOptions(optionsValue);
  const authorityChild = childByName(manifest, "server");
  const clientAChild = childByName(manifest, "clienta");
  const clientBChild = childByName(manifest, "clientb");
  const opened: RuntimeStore[] = [];
  const open = (child: WindowsCandidateChild): RuntimeStore => {
    const platform = new WindowsRuntimePlatform({
      root: manifest.root,
      probeExecutable: options.probeExecutable,
      systemRoot: options.systemRoot,
      expectedHash: options.expectedHash,
      expectedRoot: {
        rootFileId: manifest.rootFileId,
        volumeId: manifest.volumeId,
      },
      expectedDirectory: directoryIdentity(child),
    });
    const store = new RuntimeStore(child.path, { platformAdapter: platform });
    opened.push(store);
    return store;
  };
  try {
    const authority = open(authorityChild);
    const clientA = open(clientAChild);
    const clientB = open(clientBChild);
    let closed = false;
    const stores: WindowsCandidateStores = Object.freeze({
      manifest,
      authority,
      clients: Object.freeze([clientA, clientB]) as readonly [
        RuntimeStore,
        RuntimeStore,
      ],
      close(): void {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        for (const store of [...opened].reverse()) {
          try {
            store.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(failures, "WINDOWS_CANDIDATE_CLOSE_FAILED");
      },
    });
    return stores;
  } catch (error) {
    for (const store of opened.reverse()) {
      try {
        store.close();
      } catch {
        // Preserve the original open failure.
      }
    }
    throw error;
  }
}

export async function createWindowsCandidate(
  value: unknown,
  expectedValue: WindowsCandidateExpectedPaths,
  optionsValue: WindowsCandidateStoreOptions,
): Promise<WindowsCandidateCreation> {
  const options = storeOptions(optionsValue);
  const manifest = parseWindowsCandidateManifest(value, expectedValue);
  if (options.untrustedProbe !== undefined) {
    for (const child of manifest.directories) {
      let raw: unknown = undefined;
      try {
        raw = await options.untrustedProbe.probe(child.path, manifest.root);
      } catch (error) {
        if (error instanceof CollaborationError) throw error;
        fail("WINDOWS_CANDIDATE_EVIDENCE_FAILED");
      }
      assertWindowsCandidateEvidence(manifest, child.path, raw);
    }
    return Object.freeze({
      status: "NOT_RUN",
      physical: "NOT_RUN",
      code: "WINDOWS_CANDIDATE_EVIDENCE_UNTRUSTED",
      reason:
        "injected probe evidence is an untrusted contract check, not Windows physical acceptance",
      manifest,
    });
  }
  if ((options.platform ?? process.platform) !== "win32")
    return Object.freeze({
      status: "NOT_RUN",
      physical: "NOT_RUN",
      code: "NATIVE_PLATFORM_MISMATCH",
      reason: "the Windows candidate requires native win32 execution",
      manifest,
    });
  return Object.freeze({
    status: "READY",
    physical: "NOT_RUN",
    manifest,
    stores: openWindowsCandidateStores(manifest, options),
  });
}
