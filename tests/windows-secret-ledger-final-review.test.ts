import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SecretRecordLedgerPersistence,
  createSecretRecordPersistence,
} from "../src/sync/secret-record-ledger";
import { PosixPrivatePlatform } from "../src/sync/private-platform";
import { SyncError } from "../src/sync/protocol";
import { syncSecretKey } from "../src/sync/secret-store";
import { CollaborationError } from "../src/collaboration/runtime/contract";

const roots: string[] = [];
function directory() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-secret-review-")),
  );
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const key = syncSecretKey({
  baseUrl: "http://127.0.0.1:8787",
  workspaceId: "workspace",
  clientId: "client",
  bindingId: "binding",
  serverEpoch: "epoch",
});
const ciphertext = new Uint8Array(
  Buffer.from("opaque ciphertext unit fixture"),
);
describe("Windows secret ledger final review regressions (injected contracts, no OS acceptance)", () => {
  it.each([
    ["C:\\Folio\\Workspace\\Secrets", "c:/folio/workspace"],
    ["c:/Folio/Workspace", "C:\\Folio\\Workspace\\child"],
    ["C:\\Folio\\Workspace", "C:\\Folio\\Workspace"],
  ])(
    "enforces forbidden root for %s before native factory",
    async (path, forbidden) => {
      let opens = 0;
      const adapter = createSecretRecordPersistence({
        directory: path,
        forbiddenRoots: [forbidden],
        platform: "win32",
        privatePlatformFactory() {
          opens++;
          throw new Error("must not open");
        },
      });
      await expect(adapter.write(key, ciphertext)).rejects.toMatchObject({
        code: "secret-record-ledger-unsafe-location",
        status: 409,
      });
      expect(opens).toBe(0);
    },
  );
  it("preserves typed native publication UNKNOWN without rewriting ciphertext", async () => {
    const adapter = new SecretRecordLedgerPersistence({
      directory: "C:\\Folio\\Secrets",
      forbiddenRoots: ["C:\\Folio\\Workspace"],
      platform: "win32",
      privatePlatformFactory() {
        throw new CollaborationError("WINDOWS_PRIVATE_CREATE_UNKNOWN");
      },
    });
    await expect(adapter.write(key, ciphertext)).rejects.toMatchObject({
      code: "WINDOWS_PRIVATE_CREATE_UNKNOWN",
    });
  });
  it("preserves postCOMMIT uncertainty and allows the original immutable ciphertext to be read", async () => {
    const root = directory(),
      forbidden = directory();
    let failed = false;
    const normal = () => new PosixPrivatePlatform([forbidden]);
    const adapter = new SecretRecordLedgerPersistence({
      directory: root,
      forbiddenRoots: [forbidden],
      platform: "win32",
      privatePlatformFactory() {
        const platform = normal(),
          assertRoot = platform.assertRoot.bind(platform);
        platform.assertRoot = () => {
          assertRoot();
          if (failed) return;
          let db: DatabaseSync | undefined;
          try {
            db = new DatabaseSync(join(root, "secrets.sqlite"), {
              readOnly: true,
            });
            const count = db
              .prepare("SELECT COUNT(*) AS count FROM m3_private_records")
              .get();
            if (Number(count?.count) === 1) {
              failed = true;
              throw new SyncError("WINDOWS_DATABASE_IDENTITY_CHANGED", 409);
            }
          } catch (error) {
            if (error instanceof SyncError) throw error;
          } finally {
            db?.close();
          }
        };
        return platform;
      },
    });
    await expect(adapter.write(key, ciphertext)).rejects.toMatchObject({
      code: "secret-record-ledger-outcome-unknown",
      status: 503,
    });
    expect(failed).toBe(true);
    const reopened = new SecretRecordLedgerPersistence({
      directory: root,
      forbiddenRoots: [forbidden],
      platform: "win32",
      privatePlatformFactory: normal,
    });
    expect(await reopened.read(key)).toEqual(ciphertext);
    await reopened.write(key, ciphertext);
    await expect(
      reopened.write(key, new Uint8Array(Buffer.from("different ciphertext"))),
    ).rejects.toMatchObject({ code: "secret-record-ledger-conflict" });
  });
});
