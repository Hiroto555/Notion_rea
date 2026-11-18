import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { types } from "node:util";
import { publishPrivateFileV2, type PrivateFileV2Port } from "../platform/private-file-v2";
import { selectPrivateFilePlatform } from "../platform/private-file-port";
import { writePendingJournalFile, type PendingJournalWriteOptions } from "./pending-journal-file";

export type PendingJournalV2Options = Omit<PendingJournalWriteOptions, "privateFilePort"> & {privateFilePortV2?: PrivateFileV2Port};
export function writePendingJournalFileV2(destination: string, content: string, options: PendingJournalV2Options) {
  const platform = selectPrivateFilePlatform(options.platform);
  if (platform !== "win32" && options.privateFilePortV2 === undefined) {
    const saved = writePendingJournalFile(destination, content, options);
    return {...saved, contractVersion: 2 as const, stagingDisposition: "RETAINED" as const,
      durabilityProfile: "POSIX_FILE_AND_DIRECTORY_SYNC_V1" as const};
  }
  if (!options.privateFilePortV2) throw new Error("WINDOWS_PRIVATE_FILE_V2_REQUIRED");
  if (!win32.isAbsolute(destination) || destination.includes("\0") || typeof content !== "string" || options.operations !== undefined)
    throw new Error("INVALID_PRIVATE_JOURNAL_V2");
  if (types.isAsyncFunction(options.validate) || types.isGeneratorFunction(options.validate) || types.isAsyncFunction(options.checkDestination) || types.isGeneratorFunction(options.checkDestination)) throw new Error("Journal v2 checks must be synchronous");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content) throw new Error("INVALID_PRIVATE_JOURNAL_UTF8");
  const sync = (work: () => unknown) => {
    const result = work();
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as {then?: unknown}).then === "function") {
      if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
      throw new Error("Journal v2 checks must be synchronous");
    }
  };
  const path = win32.resolve(destination), attemptId = randomUUID().replace(/-/g, "");
  const stagingPath = win32.join(win32.dirname(path), `.folio-private-${attemptId}.tmp`);
  sync(() => options.validate(content)); sync(() => options.checkDestination(path));
  const receipt = publishPrivateFileV2(options.privateFilePortV2, {path, stagingPath, attemptId, bytes, beforePublish(readback) {
    const text = Buffer.from(readback).toString("utf8");
    if (text !== content) throw new Error("Journal v2 readback differs");
    sync(() => options.validate(text)); sync(() => options.checkDestination(path));
  }});
  return {...receipt, durabilityProfile: receipt.durability.profile};
}
