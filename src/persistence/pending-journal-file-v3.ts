import {randomUUID} from "node:crypto";
import {win32} from "node:path";
import {types} from "node:util";
import {selectPrivateFilePlatform} from "../platform/private-file-port";
import {publishPrivateFileV3, WINDOWS_RECOVERY_MAX_BYTES, type PrivateFileV3Port} from "../platform/windows/private-recovery-io";
import {writePendingJournalFileV2, type PendingJournalV2Options} from "./pending-journal-file-v2";

export type PendingJournalV3Options = PendingJournalV2Options & {privateFilePortV3?: PrivateFileV3Port};

/** Raw recovery exports use the separate v3 binary authority. The receipt
 * reports RENAMED_TO_FINAL; no retained hardlink is manufactured. */
export function writePendingJournalFileV3(destination: string, content: string, options: PendingJournalV3Options) {
  if (!options || typeof options !== "object") throw new Error("INVALID_PRIVATE_JOURNAL_V3");
  if (options.privateFilePortV3 === undefined) return writePendingJournalFileV2(destination, content, options);
  if (options.privateFilePortV2 !== undefined || selectPrivateFilePlatform(options.platform) !== "win32" ||
      typeof destination !== "string" || !win32.isAbsolute(destination) || destination.includes("\0") ||
      typeof content !== "string" || options.operations !== undefined || options.temporaryId !== undefined)
    throw new Error("INVALID_PRIVATE_JOURNAL_V3");
  for (const check of [options.validate, options.checkDestination])
    if (typeof check !== "function" || types.isAsyncFunction(check) || types.isGeneratorFunction(check))
      throw new Error("Journal v3 checks must be synchronous");
  if (Buffer.byteLength(content, "utf8") > WINDOWS_RECOVERY_MAX_BYTES) throw new Error("PRIVATE_JOURNAL_V3_CAPACITY");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content) throw new Error("INVALID_PRIVATE_JOURNAL_UTF8");
  const sync = (work: () => unknown) => {
    const result = work();
    if (result !== null && (typeof result === "object" || typeof result === "function") &&
        typeof (result as {then?: unknown}).then === "function") {
      if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
      throw new Error("Journal v3 checks must be synchronous");
    }
  };
  const path = win32.resolve(destination), attemptId = randomUUID().replace(/-/g, "");
  const stagingPath = win32.join(win32.dirname(path), `.folio-raw-${attemptId}.tmp`);
  sync(() => options.validate(content)); sync(() => options.checkDestination(path));
  const receipt = publishPrivateFileV3(options.privateFilePortV3, {path, stagingPath, attemptId, bytes,
    beforePublish(readback) {
      const text = Buffer.from(readback).toString("utf8");
      if (text !== content) throw new Error("Journal v3 readback differs");
      sync(() => options.validate(text)); sync(() => options.checkDestination(path));
    }});
  return {...receipt, durabilityProfile: receipt.durability.profile};
}
