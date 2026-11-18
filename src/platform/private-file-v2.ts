import { createHash } from "node:crypto";
import { types } from "node:util";
import type { WindowsPrivateIoV2Failure, WindowsPrivatePublishV2Receipt } from "./windows/private-publication-v2";
import { PrivateFileNotPublishedError, PrivateFilePortUnsupportedError, PrivateFilePublicationUnknownError } from "./private-file-port";

export type PrivateFileV2Request = Readonly<{
  path: string; stagingPath: string; attemptId: string; bytes: Uint8Array;
  beforePublish(readback: Uint8Array): void;
}>;
export interface PrivateFileV2Port {
  readonly contractVersion: 2;
  readonly platform: "win32";
  publish(request: PrivateFileV2Request): WindowsPrivatePublishV2Receipt | WindowsPrivateIoV2Failure;
}

/** Explicit v2: successful native rename retains the original at the final
 * name. It does not claim the retained-hardlink semantics of the v1 API. */
export function publishPrivateFileV2(port: PrivateFileV2Port, request: PrivateFileV2Request): WindowsPrivatePublishV2Receipt {
  if (!port || port.contractVersion !== 2 || port.platform !== "win32" ||
      typeof port.publish !== "function" || types.isAsyncFunction(port.publish) || types.isGeneratorFunction(port.publish) ||
      typeof request.beforePublish !== "function" || (types.isAsyncFunction(request.beforePublish) || types.isGeneratorFunction(request.beforePublish)))
    throw new PrivateFilePortUnsupportedError("Synchronous private-file-v2 is required");
  const expected = Buffer.from(request.bytes);
  const sha = createHash("sha256").update(expected).digest("hex");
  let active = true, approved = false, calls = 0, callbackFailed = false;
  const unknown = (message: string, result: unknown, cause?: unknown) =>
    new PrivateFilePublicationUnknownError(message, request.path, request.stagingPath, result, cause);
  let result: ReturnType<PrivateFileV2Port["publish"]>;
  try {
    result = port.publish({...request, bytes: expected, beforePublish(readback) {
      calls++;
      try {
        if (!active || calls !== 1 || !(readback instanceof Uint8Array) || !Buffer.from(readback).equals(expected))
          throw new Error("Staged v2 readback mismatch");
        const outcome: unknown = request.beforePublish(Uint8Array.from(readback));
        if (outcome !== undefined) {
          if (types.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
          throw new Error("Publication approval must finish synchronously");
        }
        approved = true;
      } catch (error) { callbackFailed = true; throw error; }
    }});
  } catch (cause) { throw unknown("Private v2 publication threw; preserve both artifact locations", undefined, cause); }
  finally { active = false; }
  try {
    if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
    if (!result || typeof result !== "object" || result.contractVersion !== 2 || callbackFailed || calls > 1)
      throw new Error("Malformed v2 publication receipt");
    if (result.state === "UNKNOWN") throw new Error("Native v2 publication is unresolved");
    if (result.path !== request.path || (result.stagingPath !== undefined && result.stagingPath !== request.stagingPath) ||
        (result.attemptId !== undefined && result.attemptId !== request.attemptId)) throw new Error("Mismatched v2 failure identity");
    if (result.state === "EXISTS" || result.state === "REJECTED")
      throw new PrivateFileNotPublishedError(request.path, request.stagingPath,
        {status: "NOT_PUBLISHED", code: result.state === "EXISTS" ? "EEXIST" : "DENIED", evidence: result});
    if (result.state !== "PUBLISHED" || !approved || calls !== 1 || result.path !== request.path || result.stagingPath !== request.stagingPath ||
        result.attemptId !== request.attemptId || result.stagingDisposition !== "RENAMED_TO_FINAL" ||
        result.durability?.profile !== "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" || result.durability.scope !== "PROCESS_CRASH" ||
        result.contentFlushed !== true || result.namespace !== "EXCLUSIVE_NO_REPLACE" || result.byteLength !== expected.byteLength || result.sha256 !== sha ||
        result.identity?.canonicalPath !== request.path || !/^[0-9a-fA-F]{32}$/.test(result.identity.fileId) || !/^[0-9a-fA-F]{16}$/.test(result.identity.volumeId) ||
        !(result.readback instanceof Uint8Array) || !Buffer.from(result.readback).equals(expected))
      throw new Error("Private v2 publication evidence differs");
    return result;
  } catch (cause) {
    if (cause instanceof PrivateFileNotPublishedError && !callbackFailed) throw cause;
    throw unknown("Private v2 publication could not be verified", result, cause);
  }
}
