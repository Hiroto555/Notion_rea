import { posix, win32 } from "node:path";
import { types } from "node:util";

export type PrivateFilePlatform = "posix" | "win32";
export type PrivateFileCapabilities = {
  synchronous: true;
  exclusivePublication: true;
  privateAccess: true;
  fileDurability: true;
  nameDurability: true;
  readback: true;
  retainedStaging: true;
  preservesUnknown: true;
};
export type PrivateFilePublishRequest = {
  path: string;
  stagingPath: string;
  bytes: Uint8Array;
  beforePublish: (readback: Uint8Array) => void;
};
export type PrivateFilePublishResult =
  | { status: "PUBLISHED"; path: string; stagingPath: string; readback: Uint8Array }
  | { status: "NOT_PUBLISHED"; code: "EEXIST" | "UNSUPPORTED" | "DENIED"; evidence?: unknown }
  | { status: "UNKNOWN"; evidence: unknown; artifacts: readonly string[] };

/**
 * Caller-selected trust metadata, not proof of OS acceptance. An adapter must
 * exclusively create and retain a same-directory stage, write/flush it, prove
 * private root/file access using platform-native identities, verify readback,
 * and call beforePublish exactly once synchronously before irreversible
 * exclusive no-replace publication. It may publish only after approval, then
 * must verify exact final bytes and durable file/name state. UNKNOWN preserves
 * every artifact; no retry or cleanup operation is part of this interface.
 */
export interface PrivateFilePort {
  platform: PrivateFilePlatform;
  implementation: "posix" | "audited-native";
  auditReference?: string;
  capabilities: PrivateFileCapabilities;
  publish(request: PrivateFilePublishRequest): PrivateFilePublishResult;
}

export class PrivateFilePortUnsupportedError extends Error {
  readonly code = "PRIVATE_FILE_PORT_UNSUPPORTED";
  constructor(message: string) { super(message); this.name = "PrivateFilePortUnsupportedError"; }
}

export class PrivateFilePublicationUnknownError extends Error {
  readonly code = "PRIVATE_FILE_PUBLICATION_UNKNOWN";
  constructor(
    message: string,
    readonly path: string,
    readonly stagingPath: string,
    readonly result: unknown,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "PrivateFilePublicationUnknownError";
  }
}

export class PrivateFileNotPublishedError extends Error {
  readonly code: "EEXIST" | "UNSUPPORTED" | "DENIED";
  constructor(
    readonly path: string,
    readonly stagingPath: string,
    readonly result: Extract<PrivateFilePublishResult, { status: "NOT_PUBLISHED" }>,
  ) {
    super(`Private file not published: ${result.code}`);
    this.name = "PrivateFileNotPublishedError";
    this.code = result.code;
  }
}

/** Production omits the override. A Windows host can never select POSIX. */
export function selectPrivateFilePlatform(platform: NodeJS.Platform = process.platform): PrivateFilePlatform {
  if (process.platform === "win32" && platform !== "win32")
    throw new PrivateFilePortUnsupportedError("Windows cannot select POSIX publication");
  if (platform === "win32") return "win32";
  if (["aix", "android", "darwin", "freebsd", "linux", "netbsd", "openbsd", "sunos"].includes(platform))
    return "posix";
  throw new PrivateFilePortUnsupportedError(`Unsupported publication platform: ${platform}`);
}

const capabilities: readonly (keyof PrivateFileCapabilities)[] = [
  "synchronous", "exclusivePublication", "privateAccess", "fileDurability",
  "nameDurability", "readback", "retainedStaging", "preservesUnknown",
];

function isThenable(value: unknown): boolean {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

function checkedPublisher(port: unknown, platform: NodeJS.Platform | undefined): PrivateFilePort["publish"] {
  const group = selectPrivateFilePlatform(platform);
  if (!port || typeof port !== "object" || isThenable(port))
    throw new PrivateFilePortUnsupportedError("A synchronous private file port is required");
  const candidate = port as PrivateFilePort;
  if (candidate.platform !== group ||
      !["posix", "audited-native"].includes(candidate.implementation) ||
      (group === "win32" && (candidate.implementation !== "audited-native" ||
        typeof candidate.auditReference !== "string" || !candidate.auditReference.trim())) ||
      !candidate.capabilities || capabilities.some(key => candidate.capabilities[key] !== true))
    throw new PrivateFilePortUnsupportedError("Unsupported private file port declaration");
  const publish = candidate.publish;
  if (typeof publish !== "function" || types.isAsyncFunction(publish) || types.isGeneratorFunction(publish))
    throw new PrivateFilePortUnsupportedError("Private file publisher must be synchronous");
  return publish;
}

export function assertPrivateFilePort(port: unknown, platform?: NodeJS.Platform): asserts port is PrivateFilePort {
  checkedPublisher(port, platform);
}

function sameBytes(actual: unknown, expected: Uint8Array): actual is Uint8Array {
  return actual instanceof Uint8Array && actual.byteLength === expected.byteLength &&
    expected.every((byte, index) => actual[index] === byte);
}

/**
 * One invocation only. Once invocation begins, malformed responses and thrown
 * values are UNKNOWN, never authority to delete artifacts or retry publication.
 */
export function publishPrivateFile(
  port: PrivateFilePort,
  request: PrivateFilePublishRequest,
  platform?: NodeJS.Platform,
): Extract<PrivateFilePublishResult, { status: "PUBLISHED" }> {
  const publish = checkedPublisher(port, platform);
  const paths = selectPrivateFilePlatform(platform) === "win32" ? win32 : posix;
  if (typeof request.path !== "string" || typeof request.stagingPath !== "string" ||
      request.path.includes("\0") || request.stagingPath.includes("\0") ||
      !paths.isAbsolute(request.path) || !paths.isAbsolute(request.stagingPath) ||
      paths.resolve(request.path) !== request.path || paths.resolve(request.stagingPath) !== request.stagingPath ||
      paths.dirname(request.path) !== paths.dirname(request.stagingPath) ||
      request.path === request.stagingPath || !(request.bytes instanceof Uint8Array) ||
      typeof request.beforePublish !== "function" || types.isAsyncFunction(request.beforePublish) ||
      types.isGeneratorFunction(request.beforePublish))
    throw new PrivateFilePortUnsupportedError("Invalid private file publication request");
  const path = request.path, stagingPath = request.stagingPath;
  const expected = Uint8Array.from(request.bytes);
  const approve = request.beforePublish;
  let active = true, calls = 0, approved = false, callbackFailed = false;
  const unknown = (message: string, result: unknown, cause?: unknown) =>
    new PrivateFilePublicationUnknownError(message, path, stagingPath, result, cause);
  const beforePublish = (readback: Uint8Array): void => {
    calls++;
    if (!active || calls !== 1) {
      callbackFailed = true;
      throw unknown("Late or repeated publication approval", undefined);
    }
    try {
      if (!sameBytes(readback, expected)) throw new Error("Private staging readback differs");
      const approval: unknown = approve(Uint8Array.from(readback));
      if (isThenable(approval)) throw new Error("Publication approval must be synchronous");
      approved = true;
    } catch (error) {
      callbackFailed = true;
      throw error;
    }
  };
  let result: unknown;
  let notPublished: PrivateFileNotPublishedError | undefined;
  try {
    result = publish.call(port, { path, stagingPath, bytes: Uint8Array.from(expected), beforePublish });
  } catch (cause) {
    throw unknown("Private file publication threw; retain all artifacts", undefined, cause);
  } finally {
    active = false;
  }
  try {
    if (!result || typeof result !== "object" || isThenable(result))
      throw new Error("Malformed or asynchronous publication response");
    const response = result as PrivateFilePublishResult;
    if (callbackFailed || calls > 1) throw new Error("Publication approval failed");
    if (response.status === "NOT_PUBLISHED") {
      if (!["EEXIST", "UNSUPPORTED", "DENIED"].includes(response.code))
        throw new Error("Malformed no-publication response");
      notPublished = new PrivateFileNotPublishedError(path, stagingPath, response);
      if (callbackFailed || calls > 1) throw new Error("Publication approval failed");
    } else if (response.status === "UNKNOWN") {
      if (!("evidence" in response) || !Array.isArray(response.artifacts) ||
          !response.artifacts.every(artifact => typeof artifact === "string"))
        throw new Error("Malformed unknown response");
      throw new Error("Private file publication outcome is unknown");
    } else {
      if (response.status !== "PUBLISHED" || calls !== 1 || !approved ||
          response.path !== path || response.stagingPath !== stagingPath ||
          !sameBytes(response.readback, expected))
        throw new Error("Private file publication contract mismatch");
      // Response accessors must not hide a late/repeated callback either.
      if (callbackFailed || calls !== 1 || !approved)
        throw new Error("Publication approval failed");
      return response;
    }
  } catch (cause) {
    throw unknown("Private file publication could not be verified", result, cause);
  }
  throw notPublished!;
}
