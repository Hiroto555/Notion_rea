import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SyncConnectionVault,
  type SyncConnectionVaultOptions,
} from "../src/main/sync-connection-vault";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import { PosixPrivatePlatform } from "../src/sync/private-platform";
import { SyncError } from "../src/sync/protocol";
import type { SyncConnectionInput } from "../src/shared/sync-management";

const roots: string[] = [];
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-vault-review-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const DATABASE = "C:\\Folio\\Workspace\\workspace.sqlite";
function input(): SyncConnectionInput {
  return {
    requestId: randomUUID(),
    expectedRevision: null,
    baseUrl: "http://127.0.0.1:8787",
    workspaceId: "workspace",
    clientId: "client",
    mode: "publish",
    token: "A".repeat(32),
  };
}
function options(
  overrides: Partial<SyncConnectionVaultOptions> = {},
): SyncConnectionVaultOptions {
  return {
    directory: "C:\\Folio\\Credentials",
    forbiddenRoots: ["C:\\Folio\\Workspace"],
    platform: "win32",
    assertWorkspaceAllowed() {},
    workspaceIdentity: () => "identity-1",
    workspaceNativeIdentity: (path) => ({
      canonicalPath: path,
      volumeId: "A".repeat(16),
      fileId: "B".repeat(32),
    }),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from("cipher:" + plain),
      decryptString: (bytes) => bytes.toString().slice("cipher:".length),
    },
    privatePlatformFactory() {
      throw new Error("unexpected ledger open");
    },
    ...overrides,
  };
}

describe("Windows vault independent final review regressions (injected contracts, no OS acceptance)", () => {
  it.each([
    ["C:\\Folio\\Workspace\\Credentials", "C:\\Folio\\Workspace"],
    ["C:\\Folio\\Workspace", "C:\\Folio\\Workspace\\child"],
    ["c:/folio/workspace/credentials", "C:\\Folio\\Workspace"],
    ["C:\\Folio\\Workspace", "c:/folio/workspace/"],
  ])(
    "refuses credential directory %s overlapping forbidden %s before opening or encrypting",
    (dir, forbidden) => {
      let opens = 0,
        encrypts = 0;
      const o = options({
        directory: dir,
        forbiddenRoots: [forbidden],
        privatePlatformFactory() {
          opens++;
          throw new Error("must not open");
        },
      });
      o.safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString() {
          encrypts++;
          throw new Error("must not encrypt");
        },
        decryptString() {
          throw new Error("must not decrypt");
        },
      };
      const result = new SyncConnectionVault(o).configure(DATABASE, input());
      expect(result).toMatchObject({
        outcome: "held",
        view: { reason: "identity-changed" },
      });
      expect(opens).toBe(0);
      expect(encrypts).toBe(0);
    },
  );
  it("allows a nonoverlapping sibling and binds the native ledger only after path preflight", () => {
    let opens = 0;
    const o = options({
      directory: "c:/folio/Workspace-secrets",
      privatePlatformFactory() {
        opens++;
        throw new CollaborationError("WINDOWS_PRIVATE_CREATE_UNKNOWN");
      },
    });
    const result = new SyncConnectionVault(o).configure(DATABASE, input());
    expect(opens).toBe(1);
    expect(result).toMatchObject({
      outcome: "outcome-unknown",
      view: { reason: "outcome-unknown" },
    });
  });
  it.each([
    "WINDOWS_PRIVATE_CREATE_UNKNOWN",
    "WINDOWS_PRIVATE_CREATE_RACE",
    "WINDOWS_PRIVATE_OPEN_UNKNOWN",
    "WINDOWS_PRIVATE_DIRECTORY_UNKNOWN",
  ])("preserves %s as outcome unknown instead of local-error", (code) => {
    const result = new SyncConnectionVault(
      options({
        privatePlatformFactory() {
          throw new CollaborationError(code);
        },
      }),
    ).configure(DATABASE, input());
    expect(result).toMatchObject({
      outcome: "outcome-unknown",
      view: { state: "held", reason: "outcome-unknown" },
    });
  });
  it("maps native SyncError503 as UNKNOWN without claiming an unapplied configuration", () => {
    const result = new SyncConnectionVault(
      options({
        privatePlatformFactory() {
          throw new SyncError("PROBE_TIMEOUT", 503);
        },
      }),
    ).configure(DATABASE, input());
    expect(result.outcome).toBe("outcome-unknown");
  });
  it("returns UNKNOWN on a proof failure after actual SQLiteCOMMIT and resolves the original request receipt", () => {
    const vaultDirectory = directory(),
      forbidden = directory();
    const workspace = join(forbidden, "workspace.sqlite");
    writeFileSync(workspace, "", { mode: 0o600 });
    let failed = false;
    const normal = () => new PosixPrivatePlatform([forbidden]);
    const o = options({
      directory: vaultDirectory,
      forbiddenRoots: [forbidden],
      workspaceNativeIdentity: () => ({
        canonicalPath: DATABASE,
        volumeId: "A".repeat(16),
        fileId: "B".repeat(32),
      }),
      privatePlatformFactory() {
        const platform = normal(),
          assertRoot = platform.assertRoot.bind(platform);
        platform.assertRoot = () => {
          assertRoot();
          if (failed) return;
          let db: DatabaseSync | undefined;
          try {
            db = new DatabaseSync(join(vaultDirectory, "connections.sqlite"), {
              readOnly: true,
            });
            const count = db
              .prepare("SELECT COUNT(*) AS count FROM m3_private_records")
              .get();
            if (Number(count?.count) === 2) {
              failed = true;
              throw new SyncError("WINDOWS_DIRECTORY_IDENTITY_CHANGED", 409);
            }
          } catch (error) {
            if (error instanceof SyncError) throw error;
          } finally {
            db?.close();
          }
        };
        const close = platform.close.bind(platform);
        platform.close = () => {close();if (failed) throw new SyncError("WINDOWS_PLATFORM_CLOSED",409);};
        return platform;
      },
    });
    const request = input(),
      vault = new SyncConnectionVault(o),
      result = vault.configure(workspace, request);
    expect(failed).toBe(true);
    expect(result).toMatchObject({
      outcome: "outcome-unknown",
      view: { reason: "outcome-unknown" },
    });
    const reopened = new SyncConnectionVault({
      ...o,
      privatePlatformFactory: normal,
    });
    const resolved = reopened.resolve(workspace, request.requestId);
    expect(resolved).toMatchObject({
      outcome: "saved",
      view: { revision: request.requestId, hasCredential: true },
    });
  });
});
