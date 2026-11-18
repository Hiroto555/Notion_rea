import {
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SyncConnectionVault,
  type SyncConnectionVaultOptions,
} from "../src/main/sync-connection-vault";
import { SyncError } from "../src/sync/protocol";
import type { SafeStoragePort } from "../src/sync/secret-store";
import type { SyncConnectionInput } from "../src/shared/sync-management";

const base = realpathSync(tmpdir());
const roots: string[] = [];

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const FOURTH = "44444444-4444-4444-8444-444444444444";
const FIFTH = "55555555-5555-4555-8555-555555555555";
const WORKSPACE_IDENTITY = "00000000-0000-4000-8000-000000000001";
const OTHER_IDENTITY = "00000000-0000-4000-8000-000000000002";
const TOKEN = "Synthetic_Test_Token_0123456789_abcdefghij";
const TOKEN2 = "Rotated_Synthetic_Token_9876543210_zyxwvut";
const TOKEN3 = "Commit_Fault_Synthetic_Token_24681012_abcdef";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AES_KEY = createHash("sha256").update("folio-test-only-fixed-key").digest();

afterEach(() => {
  vi.restoreAllMocks();
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

function emptyWorkspace(root: string, name = "workspace.sqlite"): string {
  const path = join(root, name);
  writeFileSync(path, "", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  throw new Error("expected an error");
}

type FakeStorage = {
  port: SafeStoragePort;
  state: {
    backend: string | undefined;
    available: boolean;
    encrypts: number;
    decrypts: number;
  };
};

function fakeStorage(initialBackend: string | undefined = "gnome_libsecret"): FakeStorage {
  const state = {
    backend: initialBackend,
    available: true,
    encrypts: 0,
    decrypts: 0,
  };
  const port: SafeStoragePort = {
    isEncryptionAvailable() {
      return state.available;
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
      return state.backend;
    },
  };
  return { port, state };
}

type Harness = {
  root: string;
  vaultDir: string;
  workspace: string;
  storage: FakeStorage;
  gateCalls: string[];
  identityCalls: string[];
  options: SyncConnectionVaultOptions;
  vault: SyncConnectionVault;
};

function harness(options: {
  storage?: FakeStorage;
  platform?: NodeJS.Platform;
  gate?: (path: string) => void;
  identity?: (path: string) => string;
} = {}): Harness {
  const root = privateDir("m3-vault-ws-");
  const vaultDir = privateDir("m3-vault-store-");
  const workspace = emptyWorkspace(root);
  const storage = options.storage ?? fakeStorage();
  const gateCalls: string[] = [];
  const identityCalls: string[] = [];
  const vaultOptions: SyncConnectionVaultOptions = {
    directory: vaultDir,
    forbiddenRoots: [root],
    safeStorage: storage.port,
    platform: options.platform ?? "linux",
    assertWorkspaceAllowed(path) {
      gateCalls.push(path);
      options.gate?.(path);
    },
    workspaceIdentity(path) {
      identityCalls.push(path);
      return options.identity ? options.identity(path) : WORKSPACE_IDENTITY;
    },
  };
  return {
    root,
    vaultDir,
    workspace,
    storage,
    gateCalls,
    identityCalls,
    options: vaultOptions,
    vault: new SyncConnectionVault(vaultOptions),
  };
}

function reopen(source: Harness): SyncConnectionVault {
  return new SyncConnectionVault(source.options);
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

const TARGET = {
  baseUrl: "http://127.0.0.1:8787",
  workspaceId: "ws-alpha",
  clientId: "client-alpha",
  mode: "publish",
};

function allFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...allFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function expectNoPlaintext(directory: string, token: string): void {
  const needle = Buffer.from(token);
  for (const file of allFiles(directory)) {
    expect(readFileSync(file).includes(needle), file).toBe(false);
  }
}

type ExecMode = "before" | "after";

function armExec(mode: ExecMode): void {
  const original = DatabaseSync.prototype.exec;
  let commits = 0;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (!String(sql).includes("COMMIT")) return original.call(this, sql);
    commits++;
    if (commits === 1) return original.call(this, sql);
    if (mode === "before") throw new Error("inject-before-commit");
    original.call(this, sql);
    throw new Error("inject-after-commit");
  });
}

describe("SyncConnectionVault", () => {
  it("saves, loads, reopens and keeps the token out of renderer DTOs and files", () => {
    const h = harness();
    const saved = h.vault.configure(h.workspace, connection());

    expect(saved.outcome).toBe("saved");
    expect(saved.view).toEqual({
      state: "pending-restart",
      revision: FIRST,
      target: TARGET,
      hasCredential: true,
      reason: null,
    });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.stringify(saved.view)).not.toContain("ciphertext");

    const loaded = h.vault.load(h.workspace);
    expect(loaded).toMatchObject({
      revision: FIRST,
      baseUrl: TARGET.baseUrl,
      workspaceId: TARGET.workspaceId,
      clientId: TARGET.clientId,
      token: TOKEN,
      mode: "publish",
    });
    expect(loaded?.bindingId).toMatch(UUID);

    expectNoPlaintext(h.vaultDir, TOKEN);
    expectNoPlaintext(h.root, TOKEN);

    const reopened = reopen(h);
    expect(reopened.load(h.workspace)).toEqual(loaded);
    expect(reopened.view(h.workspace)).toMatchObject({
      state: "pending-restart",
      revision: FIRST,
      target: TARGET,
      hasCredential: true,
    });
  });

  it("rotates credentials, preserves the device binding and disables without a backend", () => {
    const h = harness();
    h.vault.configure(h.workspace, connection());
    const before = h.vault.load(h.workspace);
    expect(before?.bindingId).toMatch(UUID);

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
      target: { ...TARGET, mode: "join" },
      hasCredential: true,
    });
    const after = h.vault.load(h.workspace);
    expect(after).toMatchObject({ revision: SECOND, token: TOKEN2, mode: "join" });
    expect(after?.bindingId).toBe(before?.bindingId);
    expectNoPlaintext(h.vaultDir, TOKEN2);

    const disabled = h.vault.disable(h.workspace, THIRD, SECOND);
    expect(disabled.outcome).toBe("disabled");
    expect(disabled.view).toEqual({
      state: "disabled",
      revision: THIRD,
      target: { ...TARGET, mode: "join" },
      hasCredential: false,
      reason: null,
    });
    expect(h.vault.load(h.workspace)).toBeNull();
    expectNoPlaintext(h.vaultDir, TOKEN2);

    const reopened = reopen(h);
    expect(reopened.view(h.workspace)).toMatchObject({
      state: "disabled",
      revision: THIRD,
      hasCredential: false,
    });
    expect(reopened.load(h.workspace)).toBeNull();
    expect(reopened.resolve(h.workspace, THIRD)).toEqual({
      outcome: "disabled",
      view: {
        state: "disabled",
        revision: THIRD,
        target: { ...TARGET, mode: "join" },
        hasCredential: false,
        reason: null,
      },
    });

    const offline = harness();
    offline.vault.configure(offline.workspace, connection());
    offline.storage.state.available = false;
    const off = offline.vault.disable(offline.workspace, SECOND, FIRST);
    expect(off.outcome).toBe("disabled");
    expect(off.view.state).toBe("disabled");
    expect(offline.vault.load(offline.workspace)).toBeNull();
  });

  it("rejects stale revisions, replays idempotently and refuses conflicting request ids", () => {
    const h = harness();
    expect(h.vault.configure(h.workspace, connection()).outcome).toBe("saved");

    const stale = h.vault.configure(
      h.workspace,
      connection({ requestId: SECOND, expectedRevision: null }),
    );
    expect(stale.outcome).toBe("held");
    expect(stale.view.reason).toBe("conflict");
    expect(h.vault.load(h.workspace)?.token).toBe(TOKEN);

    const replay = h.vault.configure(h.workspace, connection());
    expect(replay.outcome).toBe("saved");
    expect(replay.view.revision).toBe(FIRST);

    const conflict = h.vault.configure(
      h.workspace,
      connection({ token: TOKEN2 }),
    );
    expect(conflict.outcome).toBe("held");
    expect(conflict.view.reason).toBe("conflict");
    expect(h.vault.load(h.workspace)?.token).toBe(TOKEN);

    const crossKind = h.vault.disable(h.workspace, FIRST, null);
    expect(crossKind.outcome).toBe("held");
    expect(crossKind.view.reason).toBe("conflict");

    expect(h.vault.resolve(h.workspace, SECOND)).toBeNull();
    expect(reopen(h).resolve(h.workspace, FIRST)).toEqual({
      outcome: "saved",
      view: {
        state: "pending-restart",
        revision: FIRST,
        target: TARGET,
        hasCredential: true,
        reason: null,
      },
    });
  });

  it("isolates credentials by workspace path, inode and identity", () => {
    let identity = WORKSPACE_IDENTITY;
    const h = harness({ identity: () => identity });
    h.vault.configure(h.workspace, connection());

    identity = OTHER_IDENTITY;
    expect(h.vault.load(h.workspace)).toBeNull();
    expect(h.vault.view(h.workspace).state).toBe("unconfigured");
    identity = WORKSPACE_IDENTITY;
    expect(h.vault.load(h.workspace)?.token).toBe(TOKEN);

    const copy = join(h.root, "copy.sqlite");
    copyFileSync(h.workspace, copy);
    chmodSync(copy, 0o600);
    expect(lstatSync(copy).ino).not.toBe(lstatSync(h.workspace).ino);
    expect(h.vault.load(copy)).toBeNull();
    expect(h.vault.view(copy).state).toBe("unconfigured");

    expect(
      h.vault.configure(copy, connection({ requestId: SECOND, token: TOKEN2 }))
        .outcome,
    ).toBe("saved");
    expect(h.vault.load(copy)?.token).toBe(TOKEN2);
    expect(h.vault.load(h.workspace)?.token).toBe(TOKEN);

    unlinkSync(h.workspace);
    emptyWorkspace(h.root);
    expect(h.vault.load(h.workspace)).toBeNull();
    expect(h.vault.view(h.workspace).state).toBe("unconfigured");
  });

  it("honors a recovered-workspace-held gate before touching vault files or crypto", () => {
    const h = harness({
      gate() {
        throw new SyncError("recovered-workspace-sync-held");
      },
    });
    const cryptoBefore = h.storage.state.encrypts + h.storage.state.decrypts;

    expect(h.vault.view(h.workspace)).toEqual({
      state: "held",
      revision: null,
      target: null,
      hasCredential: false,
      reason: "recovery-copy-held",
    });
    const attempted = h.vault.configure(h.workspace, connection());
    expect(attempted.outcome).toBe("held");
    expect(attempted.view.state).toBe("held");
    expect(attempted.view.reason).toBe("recovery-copy-held");
    expect(codeOf(() => h.vault.load(h.workspace))).toBe(
      "recovered-workspace-sync-held",
    );

    expect(h.gateCalls.length).toBeGreaterThan(0);
    expect(h.gateCalls.every((path) => path === h.workspace)).toBe(true);
    expect(allFiles(h.vaultDir)).toEqual([]);
    expect(h.storage.state.encrypts + h.storage.state.decrypts).toBe(
      cryptoBefore,
    );
  });

  it("fails closed on linux basic_text and missing backends without plaintext fallback", () => {
    const basic = fakeStorage("basic_text");
    const blocked = harness({ storage: basic });
    const action = blocked.vault.configure(blocked.workspace, connection());
    expect(action.outcome).toBe("held");
    expect(action.view).toMatchObject({
      state: "held",
      reason: "secure-store-unavailable",
    });
    expect(blocked.vault.load(blocked.workspace)).toBeNull();
    expect(JSON.stringify(action)).not.toContain(TOKEN);
    expectNoPlaintext(blocked.vaultDir, TOKEN);

    const switched = fakeStorage("gnome_libsecret");
    const saved = harness({ storage: switched });
    saved.vault.configure(saved.workspace, connection());
    switched.state.backend = "basic_text";
    const decrypts = switched.state.decrypts;
    expect(saved.vault.view(saved.workspace)).toMatchObject({
      state: "held",
      reason: "secure-store-unavailable",
    });
    expect(codeOf(() => saved.vault.load(saved.workspace))).toBe(
      "secret-store-insecure-backend",
    );
    expect(switched.state.decrypts).toBe(decrypts);
    expectNoPlaintext(saved.vaultDir, TOKEN);

    const missing = fakeStorage();
    delete missing.port.getSelectedStorageBackend;
    const missingHarness = harness({ storage: missing });
    const missingAction = missingHarness.vault.configure(
      missingHarness.workspace,
      connection(),
    );
    expect(missingAction.outcome).toBe("held");
    expect(missingAction.view.reason).toBe("secure-store-unavailable");
    expect(missingHarness.vault.load(missingHarness.workspace)).toBeNull();
    expectNoPlaintext(missingHarness.vaultDir, TOKEN);

    const existing = fakeStorage("gnome_libsecret");
    const existingHarness = harness({ storage: existing });
    existingHarness.vault.configure(existingHarness.workspace, connection());
    delete existing.port.getSelectedStorageBackend;
    expect(codeOf(() => existingHarness.vault.load(existingHarness.workspace)))
      .toBe("secret-store-unavailable");
    expect(existing.state.decrypts).toBe(1);
  });

  it("refuses symlinked, hardlinked and aliased workspace roots", () => {
    const h = harness();
    h.vault.configure(h.workspace, connection());

    const aliasRoot = join(h.root, "alias-parent");
    symlinkSync(h.root, aliasRoot, "dir");
    const alias = join(aliasRoot, "workspace.sqlite");
    expect(h.vault.view(alias)).toMatchObject({
      state: "held",
      reason: "identity-changed",
    });
    expect(codeOf(() => h.vault.load(alias))).toBe("connection-identity-changed");

    const real = join(h.root, "real.sqlite");
    writeFileSync(real, "", { mode: 0o600 });
    chmodSync(real, 0o600);
    const linked = join(h.root, "symlink.sqlite");
    symlinkSync(real, linked);
    expect(codeOf(() => h.vault.load(linked))).toBe("connection-identity-changed");

    const other = emptyWorkspace(h.root, "other.sqlite");
    const hard = join(h.root, "hard.sqlite");
    linkSync(other, hard);
    expect(lstatSync(hard).nlink).toBe(2);
    expect(codeOf(() => h.vault.load(hard))).toBe("connection-identity-changed");
    expect(h.vault.load(h.workspace)?.token).toBe(TOKEN);
  });

  it("reports COMMIT faults as unknown and settles from a fresh vault", () => {
    const h = harness();
    expect(
      h.vault.configure(h.workspace, connection({ requestId: FIRST })).outcome,
    ).toBe("saved");

    armExec("before");
    const before = h.vault.configure(
      h.workspace,
      connection({
        requestId: SECOND,
        expectedRevision: FIRST,
        token: TOKEN2,
      }),
    );
    vi.restoreAllMocks();
    expect(before.outcome).toBe("outcome-unknown");
    expect(before.view).toMatchObject({
      state: "held",
      reason: "outcome-unknown",
    });

    const beforeState = reopen(h);
    expect(beforeState.resolve(h.workspace, SECOND)).toBeNull();
    expect(beforeState.load(h.workspace)?.token).toBe(TOKEN);
    expect(beforeState.view(h.workspace).revision).toBe(FIRST);

    armExec("after");
    const after = h.vault.configure(
      h.workspace,
      connection({
        requestId: THIRD,
        expectedRevision: FIRST,
        token: TOKEN3,
      }),
    );
    vi.restoreAllMocks();
    expect(after.outcome).toBe("outcome-unknown");
    expect(after.view).toMatchObject({
      state: "held",
      reason: "outcome-unknown",
    });

    const afterState = reopen(h);
    expect(afterState.resolve(h.workspace, THIRD)).toEqual({
      outcome: "saved",
      view: {
        state: "pending-restart",
        revision: THIRD,
        target: TARGET,
        hasCredential: true,
        reason: null,
      },
    });
    expect(afterState.load(h.workspace)?.token).toBe(TOKEN3);
    expect(afterState.view(h.workspace).revision).toBe(THIRD);

    armExec("before");
    const disableBefore = h.vault.disable(h.workspace, FOURTH, THIRD);
    vi.restoreAllMocks();
    expect(disableBefore.outcome).toBe("outcome-unknown");
    const disableBeforeState = reopen(h);
    expect(disableBeforeState.resolve(h.workspace, FOURTH)).toBeNull();
    expect(disableBeforeState.load(h.workspace)?.token).toBe(TOKEN3);

    armExec("after");
    const disableAfter = h.vault.disable(h.workspace, FIFTH, THIRD);
    vi.restoreAllMocks();
    expect(disableAfter.outcome).toBe("outcome-unknown");
    const disableAfterState = reopen(h);
    expect(disableAfterState.resolve(h.workspace, FIFTH)).toEqual({
      outcome: "disabled",
      view: {
        state: "disabled",
        revision: FIFTH,
        target: TARGET,
        hasCredential: false,
        reason: null,
      },
    });
    expect(disableAfterState.load(h.workspace)).toBeNull();
  });
});
