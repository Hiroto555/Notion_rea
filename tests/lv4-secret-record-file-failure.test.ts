import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {...actual, fsyncSync: () => {throw new Error("injected fsync failure");}};
});

import { SecretRecordFilePersistence } from "../src/sync/secret-record-file";
import { syncSecretKey } from "../src/sync/secret-store";

it("leaves a newly written ciphertext record in place if fsync fails", async () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "folio-secret-failure-")));
  try {
    chmodSync(root, 0o700);
    const secrets = join(root, "secrets"), workspace = join(root, "workspace");
    mkdirSync(secrets, {mode: 0o700}); mkdirSync(workspace, {mode: 0o700});
    const adapter = new SecretRecordFilePersistence({directory: secrets, forbiddenRoots: [workspace]});
    const key = syncSecretKey({baseUrl: "http://127.0.0.1:12345", workspaceId: "workspace", clientId: "client", bindingId: "binding", serverEpoch: "epoch"});
    const bytes = Buffer.from("ciphertext fixture");
    await expect(adapter.write(key, bytes)).rejects.toMatchObject({code: "secret-record-file-write-failed"});
    const names = readdirSync(secrets);
    expect(names).toHaveLength(1);
    expect(readFileSync(join(secrets, names[0]))).toEqual(bytes);
  } finally {rmSync(root, {recursive: true, force: true});}
});
