import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SyncConnectionVault,
  type SyncConnectionVaultOptions,
} from "../src/main/sync-connection-vault";
import type { SafeStoragePort } from "../src/sync/secret-store";
import type { SyncConnectionInput } from "../src/shared/sync-management";
import { verifyWorkspaceBinding } from "../src/sync/workspace-binding";

const base = realpathSync(tmpdir());
const roots: string[] = [];

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const LEGACY_BINDING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "Synthetic_Binding_Token_0123456789_abcdefghij";
const TOKEN2 = "Rotated_Binding_Token_9876543210_zyxwvut";
const TOKEN3 = "Rejected_Binding_Token_24681012_abcdefgh";
const WORKSPACE_IDENTITY = "00000000-0000-4000-8000-000000000001";
const AES_KEY = createHash("sha256")
  .update("folio-test-only-fixed-key")
  .digest();

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateDir(prefix: string): string {
  const root = mkdtempSync(join(base, prefix));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function sqliteWorkspace(root: string, name = "workspace.sqlite"): string {
  const path = join(root, name);
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY)");
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
  return path;
}

function sidecarPath(workspace: string): string {
  return join(dirname(realpathSync(workspace)), ".folio-sync-binding");
}

function createBinding(
  workspace: string,
  device: { workspaceId: string; clientId: string; bindingId: string },
): string {
  verifyWorkspaceBinding(workspace, device, true);
  return sidecarPath(workspace);
}

type FakeStorage = {
  port: SafeStoragePort;
  state: { encrypts: number; decrypts: number };
};

function fakeStorage(): FakeStorage {
  const state = { encrypts: 0, decrypts: 0 };
  const port: SafeStoragePort = {
    isEncryptionAvailable() {
      return true;
    },
    encryptString(plainText: string) {
      state.encrypts++;
      const iv = Buffer.alloc(12, 0x31);
      const cipher = createCipheriv("aes-256-gcm", AES_KEY, iv);
      const body = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(encrypted: Buffer) {
      state.decrypts++;
      const bytes = Buffer.from(encrypted);
      const iv = bytes.subarray(0, 12);
      const tag = bytes.subarray(12, 28);
      const body = bytes.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", AES_KEY, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString(
        "utf8",
      );
    },
    getSelectedStorageBackend() {
      return "gnome_libsecret";
    },
  };
  return { port, state };
}

type Harness = {
  root: string;
  vaultDir: string;
  workspace: string;
  storage: FakeStorage;
  options: SyncConnectionVaultOptions;
  vault: SyncConnectionVault;
};

function harness(): Harness {
  const root = privateDir("lv4-binding-ws-");
  const vaultDir = privateDir("lv4-binding-vault-");
  const workspace = sqliteWorkspace(root);
  const storage = fakeStorage();
  const options: SyncConnectionVaultOptions = {
    directory: vaultDir,
    forbiddenRoots: [root],
    safeStorage: storage.port,
    platform: "linux",
    assertWorkspaceAllowed() {},
    workspaceIdentity() {
      return WORKSPACE_IDENTITY;
    },
  };
  return {
    root,
    vaultDir,
    workspace,
    storage,
    options,
    vault: new SyncConnectionVault(options),
  };
}

function connection(
  overrides: Partial<SyncConnectionInput> = {},
): SyncConnectionInput {
  return {
    requestId: FIRST,
    expectedRevision: null,
    baseUrl: "http://127.0.0.1:8787/",
    workspaceId: "ws-alpha",
    clientId: "client-alpha",
    mode: "publish",
    token: TOKEN,
    ...overrides,
  };
}

function expectHeldBeforeCrypto(h: Harness, input: SyncConnectionInput): void {
  const encrypts = h.storage.state.encrypts;
  const action = h.vault.configure(h.workspace, input);
  expect(action.outcome).toBe("held");
  expect(action.view.state).toBe("held");
  expect(action.view.reason).toBe("identity-changed");
  expect(h.storage.state.encrypts).toBe(encrypts);
}

describe("SyncConnectionVault existing workspace binding preflight", () => {
  it("preserves the old profile if the sidecar changes during encryption", () => {
    const h = harness();
    expect(h.vault.configure(h.workspace, connection()).outcome).toBe("saved");
    const original = h.vault.load(h.workspace)!;
    const sidecar = createBinding(h.workspace, original);
    const before = readFileSync(sidecar);
    const encrypt = h.storage.port.encryptString;
    h.storage.port.encryptString = (plaintext) => {
      const bytes = encrypt(plaintext);
      writeFileSync(sidecar, "{changed-during-encryption");
      return bytes;
    };
    const action = h.vault.configure(
      h.workspace,
      connection({ requestId: SECOND, expectedRevision: FIRST, token: TOKEN2 }),
    );
    expect(action).toMatchObject({
      outcome: "held",
      view: { reason: "identity-changed" },
    });
    expect(h.vault.resolve(h.workspace, SECOND)).toBeNull();
    expect(h.vault.view(h.workspace).revision).toBe(FIRST);
    writeFileSync(sidecar, before);
    expect(h.vault.load(h.workspace)?.token).toBe(TOKEN);
  });

  it("holds a first save against an existing binding before encryption or receipt writes", () => {
    const h = harness();
    const sidecar = createBinding(h.workspace, {
      workspaceId: "ws-alpha",
      clientId: "client-alpha",
      bindingId: LEGACY_BINDING,
    });
    const sidecarBytes = readFileSync(sidecar);

    expectHeldBeforeCrypto(h, connection());

    expect(h.vault.load(h.workspace)).toBeNull();
    expect(h.vault.resolve(h.workspace, FIRST)).toBeNull();
    expect(readFileSync(sidecar).equals(sidecarBytes)).toBe(true);
  });

  it("holds mismatched workspace/client changes and keeps the prior activated profile usable", () => {
    const h = harness();
    expect(h.vault.configure(h.workspace, connection()).outcome).toBe("saved");
    const activated = h.vault.load(h.workspace)!;
    const sidecar = createBinding(h.workspace, activated);
    h.vault.markActivated(h.workspace, activated.revision);
    const sidecarBytes = readFileSync(sidecar);

    for (const change of [
      { requestId: SECOND, workspaceId: "ws-beta", token: TOKEN2 },
      { requestId: THIRD, clientId: "client-beta", token: TOKEN3 },
    ]) {
      expectHeldBeforeCrypto(
        h,
        connection({
          ...change,
          expectedRevision: activated.revision,
        }),
      );
      expect(h.vault.load(h.workspace)).toMatchObject({
        revision: FIRST,
        token: TOKEN,
        bindingId: activated.bindingId,
      });
      expect(h.vault.view(h.workspace).state).toBe("configured");
    }
    expect(readFileSync(sidecar).equals(sidecarBytes)).toBe(true);
  });

  it("accepts a legitimate same-device token update without replacing the binding", () => {
    const h = harness();
    expect(h.vault.configure(h.workspace, connection()).outcome).toBe("saved");
    const activated = h.vault.load(h.workspace)!;
    const sidecar = createBinding(h.workspace, activated);
    h.vault.markActivated(h.workspace, activated.revision);
    const sidecarBytes = readFileSync(sidecar);

    const rotated = h.vault.configure(
      h.workspace,
      connection({
        requestId: SECOND,
        expectedRevision: FIRST,
        token: TOKEN2,
        mode: "join",
      }),
    );
    expect(rotated.outcome).toBe("saved");
    expect(rotated.view).toMatchObject({
      state: "pending-restart",
      revision: SECOND,
      target: {
        workspaceId: "ws-alpha",
        clientId: "client-alpha",
        mode: "join",
      },
    });
    expect(h.vault.load(h.workspace)).toMatchObject({
      revision: SECOND,
      token: TOKEN2,
      bindingId: activated.bindingId,
      mode: "join",
    });
    expect(readFileSync(sidecar).equals(sidecarBytes)).toBe(true);
  });

  it("fails closed for copied, malformed and symlinked sidecars before encryption", () => {
    const source = harness();
    createBinding(source.workspace, {
      workspaceId: "ws-alpha",
      clientId: "client-alpha",
      bindingId: LEGACY_BINDING,
    });

    const copied = harness();
    copyFileSync(
      sidecarPath(source.workspace),
      join(copied.root, ".folio-sync-binding"),
    );
    expectHeldBeforeCrypto(copied, connection());
    expect(copied.vault.load(copied.workspace)).toBeNull();
    expect(copied.vault.resolve(copied.workspace, FIRST)).toBeNull();

    const malformed = harness();
    writeFileSync(join(malformed.root, ".folio-sync-binding"), "not-json", {
      mode: 0o600,
    });
    expectHeldBeforeCrypto(malformed, connection());
    expect(malformed.vault.load(malformed.workspace)).toBeNull();

    const linked = harness();
    const target = join(linked.root, "binding-target");
    writeFileSync(target, "not-a-binding", { mode: 0o600 });
    symlinkSync(target, join(linked.root, ".folio-sync-binding"));
    expectHeldBeforeCrypto(linked, connection());
    expect(linked.vault.load(linked.workspace)).toBeNull();
  });
});
