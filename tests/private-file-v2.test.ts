import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { publishPrivateFileV2, type PrivateFileV2Port, type PrivateFileV2Request } from "../src/platform/private-file-v2";
import { writePendingJournalFileV2 } from "../src/persistence/pending-journal-file-v2";
const path = "C:\\Private\\draft.json", bytes = Buffer.from('{"saved":true}');
function success(request: PrivateFileV2Request) {
  request.beforePublish(Buffer.from(request.bytes));
  return {contractVersion: 2 as const, state: "PUBLISHED" as const, path: request.path, stagingPath: request.stagingPath, attemptId: request.attemptId,
    identity: {canonicalPath: request.path, fileId: "1".repeat(32), volumeId: "2".repeat(16)}, byteLength: request.bytes.length,
    sha256: createHash("sha256").update(request.bytes).digest("hex"), readback: Buffer.from(request.bytes), stagingDisposition: "RENAMED_TO_FINAL" as const,
    contentFlushed: true as const, namespace: "EXCLUSIVE_NO_REPLACE" as const,
    durability: {profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const, scope: "PROCESS_CRASH" as const}};
}
const request = (): PrivateFileV2Request => ({path, bytes, attemptId: "a".repeat(32), stagingPath: "C:\\Private\\stage.tmp", beforePublish() {}});
const port = (publish: PrivateFileV2Port["publish"] = success): PrivateFileV2Port => ({contractVersion: 2, platform: "win32", publish});
it("connects v2 pending saves to the actual staged approval and explicit consumed stage", () => {
  const checks: string[] = [];
  const saved = writePendingJournalFileV2(path, bytes.toString(), {platform: "win32", privateFilePortV2: port(),
    validate(text) {checks.push(text); JSON.parse(text);}, checkDestination(target) {checks.push(target);}});
  expect(checks).toEqual([bytes.toString(), path, bytes.toString(), path]);
  expect(saved).toMatchObject({path, stagingDisposition: "RENAMED_TO_FINAL", durabilityProfile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1"});
});
it.each(["missing callback", "wrong bytes", "repeated callback", "wrong receipt"])("preserves UNKNOWN for %s", kind => {
  const fake = port(r => {
    if (kind === "missing callback") return {...success({...r, beforePublish() {}})};
    if (kind === "wrong bytes") r.beforePublish(Buffer.from("wrong"));
    if (kind === "repeated callback") {r.beforePublish(r.bytes); r.beforePublish(r.bytes);}
    return {...success(r), sha256: "0".repeat(64)};
  });
  expect(() => publishPrivateFileV2(fake, request())).toThrow(/Private v2 publication/);
});
it("refuses known async publisher before it can run and consumes deferred rejection", async () => {
  let called = false;
  const asyncPublish = async () => {called = true; throw new Error("deferred");};
  expect(() => publishPrivateFileV2(port(asyncPublish as unknown as PrivateFileV2Port["publish"]), request())).toThrow(/Synchronous/);
  expect(called).toBe(false);
  const deferred = () => Promise.reject(new Error("deferred"));
  expect(() => publishPrivateFileV2(port(deferred as unknown as PrivateFileV2Port["publish"]), request())).toThrow(/verified/);
  await new Promise(resolve => setImmediate(resolve));
});
it("keeps the POSIX retained stage behavior under the explicit v2 API", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-pending-v2-")));
  try {
    const saved = writePendingJournalFileV2(join(root, "saved.json"), bytes.toString(), {validate: JSON.parse, checkDestination() {}});
    expect(saved.stagingDisposition).toBe("RETAINED");
    expect(readFileSync(saved.path)).toEqual(bytes);
  } finally {rmSync(root, {recursive: true, force: true});}
});
