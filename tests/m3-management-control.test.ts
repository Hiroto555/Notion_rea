import { createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncManagementControl, type SyncManagementOptions } from "../src/main/sync-management-control";
import { SyncConnectionVault } from "../src/main/sync-connection-vault";
import { savedConnectionEnvironment } from "../src/main/sync-connection-startup";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";
import { WorkspaceSyncService, type WorkspaceSyncTransport } from "../src/main/workspace-sync-service";
import { runStartupWorkspaceSyncDetailed } from "../src/main/workspace-sync-startup";
import { Store } from "../src/persistence/store";
import { writeRecoveryOrigin } from "../src/persistence/recovery-origin";
import { readUserVersion } from "../src/persistence/schema-startup";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import type { SafeStoragePort } from "../src/sync/secret-store";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { verifyWorkspaceBinding } from "../src/sync/workspace-binding";
import type { WorkspaceSyncStatus } from "../src/sync/workspace-store";
import type { SyncConnectionInput } from "../src/shared/sync-management";
import type { TransferMaintenanceService } from "../src/main/transfer-maintenance-service";

const KEY = Buffer.alloc(32, 0x2a);
const IV = Buffer.alloc(12, 0x11);
const roots: string[] = [];
const stores: Store[] = [];

class AesStorage implements SafeStoragePort {
  available = true;
  backend: string | undefined = "gnome_libsecret";
  encryptError: Error | undefined;
  decryptError: Error | undefined;
  encryptCalls = 0;
  decryptCalls = 0;
  isEncryptionAvailable() { return this.available; }
  getSelectedStorageBackend() { return this.backend; }
  encryptString(plainText: string) {
    this.encryptCalls++;
    if (this.encryptError) throw this.encryptError;
    const cipher = createCipheriv("aes-256-gcm", KEY, IV);
    const body = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    return Buffer.concat([IV, cipher.getAuthTag(), body]);
  }
  decryptString(encrypted: Buffer) {
    this.decryptCalls++;
    if (this.decryptError) throw this.decryptError;
    if (encrypted.byteLength < 28) throw new Error("bad ciphertext");
    const tag = encrypted.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", KEY, encrypted.subarray(0, 12));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString("utf8");
  }
}

type Fixture = { root: string; directory: string; store: Store; vaultDirectory: string; storage: AesStorage };

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "folio-m3-control-")));
  roots.push(root);
  const directory = join(root, "workspace");
  mkdirSync(directory, { mode: 0o700 });
  const store = new Store(join(directory, "workspace.sqlite"));
  stores.push(store);
  return { root, directory, store, vaultDirectory: join(root, "credentials"), storage: new AesStorage() };
}

function vaultFor(directory: string, allowed: string, storage: SafeStoragePort, identity = "identity-1") {
  return new SyncConnectionVault({
    directory,
    forbiddenRoots: [dirname(allowed)],
    safeStorage: storage,
    platform: "darwin",
    assertWorkspaceAllowed: (path) => { if (path !== allowed) throw new Error("workspace-not-allowed"); },
    workspaceIdentity: () => identity,
  });
}

function maintenanceStub(): TransferMaintenanceService {
  return {
    view: async () => ({ entries: [], nextCursor: null, usedBytes: 0, overLimit: false, held: null }),
    plan: async () => { throw new Error("unused"); },
    release: async () => { throw new Error("unused"); },
    resolve: async () => { throw new Error("unused"); },
  } as unknown as TransferMaintenanceService;
}

function makeControl(f: Fixture, vault: SyncConnectionVault, overrides: Partial<SyncManagementOptions> = {}) {
  return new SyncManagementControl({
    store: f.store,
    readOnly: false,
    vaultDirectory: f.vaultDirectory,
    vault,
    gate: new WorkspaceSyncGate(),
    service: undefined,
    recovery: () => ({ status: "empty", generation: 0 }),
    intentClear: () => true,
    maintenance: maintenanceStub(),
    ...overrides,
  });
}

function connectionInput(overrides: Partial<SyncConnectionInput> = {}): SyncConnectionInput {
  return {
    requestId: randomUUID(),
    expectedRevision: null,
    baseUrl: "http://127.0.0.1:8787",
    workspaceId: "workspace-1",
    clientId: "client-1",
    mode: "publish",
    token: "A".repeat(43),
    ...overrides,
  };
}

function databaseSnapshot(store: Store) {
  return {
    schema: store.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    pages: store.db.prepare("SELECT * FROM pages ORDER BY id").all(),
    settings: store.db.prepare("SELECT * FROM settings ORDER BY key").all(),
    version: store.db.prepare("PRAGMA user_version").get(),
  };
}

const baseEnv: NodeJS.ProcessEnv = {
  FOLIO_SYNC_ENABLED: "1",
  FOLIO_SYNC_URL: "http://127.0.0.1:9999",
  FOLIO_SYNC_TOKEN: "B".repeat(43),
  FOLIO_SYNC_WORKSPACE: "legacy",
  FOLIO_SYNC_CLIENT: "legacy",
  FOLIO_SYNC_BINDING: "legacy",
};

const status = (): WorkspaceSyncStatus => ({ receivedCursor: 0, appliedRevision: 0, generation: 0,
  cleanGeneration: 0, pending: false, conflict: false });

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SyncManagementControl actual vault", () => {
  it("saves a pending configure without touching workspace content, schema, or binding", async () => {
    const f = fixture();
    f.store.create(null, "page", "local");
    const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
    const control = makeControl(f, vault);
    const before = databaseSnapshot(f.store);
    const bindingPath = join(f.directory, ".folio-sync-binding");
    expect(existsSync(f.vaultDirectory)).toBe(false);
    expect(existsSync(bindingPath)).toBe(false);

    const input = connectionInput();
    const action = await control.configure(input);
    expect(action.outcome).toBe("saved");
    expect(action.view).toMatchObject({ state: "pending-restart", revision: input.requestId,
      hasCredential: true, reason: null, target: { baseUrl: "http://127.0.0.1:8787",
        workspaceId: "workspace-1", clientId: "client-1", mode: "publish" } });
    expect(databaseSnapshot(f.store)).toEqual(before);
    expect(existsSync(bindingPath)).toBe(false);
    expect(control.status()).toMatchObject({ state: "pending-restart", revision: input.requestId });

    const loaded = vault.load(f.store.path)!;
    expect(loaded.mode).toBe("publish");
    verifyWorkspaceBinding(f.store.path, loaded, true);
    vault.markActivated(f.store.path, loaded.revision);
    expect(existsSync(bindingPath)).toBe(true);
    expect(control.status()).toMatchObject({ state: "configured", revision: input.requestId });
  });

  it("rejects busy, intent, unsaved input, read-only, and recovery origins before creating the vault", async () => {
    {
      const f = fixture();
      const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
      const control = makeControl(f, vault, { readOnly: true });
      const action = await control.configure(connectionInput());
      expect(action).toMatchObject({ outcome: "held", view: { state: "held", reason: "read-only" } });
      expect(existsSync(f.vaultDirectory)).toBe(false);
    }
    {
      const f = fixture();
      const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
      let stop!: () => void;
      const pending = new Promise<void>((resolve) => { stop = resolve; });
      const transport = { status, sendPending: () => pending, receiveAndStage: async () => {} };
      const service = new WorkspaceSyncService(transport as WorkspaceSyncTransport<WorkspaceSyncStatus>);
      const pass = service.sync();
      await vi.waitFor(() => expect(service.status().running).toBe(true));
      const control = makeControl(f, vault, { service });
      const action = await control.configure(connectionInput());
      expect(action).toMatchObject({ outcome: "held", view: { state: "held", reason: "busy" } });
      expect(existsSync(f.vaultDirectory)).toBe(false);
      stop();
      await pass;
    }
    {
      const f = fixture();
      const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
      const gate = new WorkspaceSyncGate();
      const control = makeControl(f, vault, { gate });
      let stop!: () => void;
      const writing = gate.write(() => new Promise<void>((resolve) => { stop = resolve; }));
      const action = await control.configure(connectionInput());
      expect(action).toMatchObject({ outcome: "held", view: { state: "held", reason: "busy" } });
      expect(existsSync(f.vaultDirectory)).toBe(false);
      stop();
      await writing;
    }
    {
      const f = fixture();
      const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
      const control = makeControl(f, vault, { intentClear: () => false });
      const action = await control.configure(connectionInput());
      expect(action).toMatchObject({ outcome: "held", view: { state: "held", reason: "intent-present" } });
      expect(existsSync(f.vaultDirectory)).toBe(false);
    }
    {
      const f = fixture();
      const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
      const control = makeControl(f, vault, {
        recovery: () => ({ status: "ready", generation: 1, snapshot: { schemaVersion: 1, pages: [], records: [],
          databases: [], creations: [], externalOperations: [], rawDrafts: [
            { scope: "record", pageId: "page-1", key: "draft", value: "unsaved" }] } }),
      });
      const action = await control.configure(connectionInput());
      expect(action).toMatchObject({ outcome: "held", view: { state: "held", reason: "intent-present" } });
      expect(existsSync(f.vaultDirectory)).toBe(false);
    }
    {
      const f = fixture();
      f.store.transaction(() => writeRecoveryOrigin(f.store.db, randomUUID(), "a".repeat(64)));
      const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
      const control = makeControl(f, vault);
      const action = await control.configure(connectionInput());
      expect(action).toMatchObject({ outcome: "held", view: { state: "held", reason: "recovery-copy-held" } });
      expect(existsSync(f.vaultDirectory)).toBe(false);
    }
  });

  it("reads status under read-only and recovery-origin rules without creating the vault", async () => {
    const f = fixture();
    const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
    const control = makeControl(f, vault);
    expect(control.status()).toEqual({ state: "unconfigured", revision: null, target: null,
      hasCredential: false, reason: null });
    expect(existsSync(f.vaultDirectory)).toBe(false);

    const input = connectionInput();
    expect((await control.configure(input)).outcome).toBe("saved");
    expect(control.status()).toMatchObject({ state: "pending-restart", revision: input.requestId });
    expect(makeControl(f, vault, { readOnly: true }).status())
      .toMatchObject({ state: "held", reason: "read-only" });
    expect(() => makeControl(f, vault, { readOnly: true }).resolve(randomUUID())).toThrow("read-only");

    f.store.transaction(() => writeRecoveryOrigin(f.store.db, randomUUID(), "b".repeat(64)));
    expect(control.status()).toMatchObject({ state: "held", reason: "recovery-copy-held" });
    expect(() => control.resolve(randomUUID())).toThrow("recovered-workspace-sync-held");
  });

  it("resolves lost configure and disable replies from a freshly opened vault", async () => {
    const f = fixture();
    const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
    const control = makeControl(f, vault);
    const input = connectionInput();
    const saved = await control.configure(input);
    expect(saved.outcome).toBe("saved");

    const fresh = vaultFor(f.vaultDirectory, f.store.path, f.storage);
    expect(makeControl(f, fresh).resolve(input.requestId)).toMatchObject({ outcome: "saved",
      view: { state: "pending-restart", revision: input.requestId, hasCredential: true } });

    const disableId = randomUUID();
    const disabled = control.disable(disableId, saved.view.revision);
    expect(disabled.outcome).toBe("disabled");
    const fresher = vaultFor(f.vaultDirectory, f.store.path, f.storage);
    expect(makeControl(f, fresher).resolve(disableId)).toMatchObject({ outcome: "disabled",
      view: { state: "disabled", revision: disableId, hasCredential: false } });
    expect(makeControl(f, fresher).resolve(randomUUID())).toBeNull();
  });

  it("suspends an in-flight send immediately on disable and never starts receive, a new pass, or an outbox delete", async () => {
    const f = fixture();
    const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
    const saved = await makeControl(f, vault).configure(connectionInput());
    expect(saved.outcome).toBe("saved");

    let ack!: () => void;
    const sending = new Promise<void>((resolve) => { ack = resolve; });
    const deleteOutbox = vi.fn();
    const transport = Object.assign({
      status: vi.fn(status),
      sendPending: vi.fn(() => sending),
      receiveAndStage: vi.fn(async () => {}),
    }, { deleteOutbox });
    const service = new WorkspaceSyncService(transport as WorkspaceSyncTransport<WorkspaceSyncStatus>);
    const pass = service.sync();
    await vi.waitFor(() => expect(transport.sendPending).toHaveBeenCalledTimes(1));

    f.storage.available = false;
    f.storage.encryptError = new Error("crypto unavailable");
    const control = makeControl(f, vault, { service });
    const action = control.disable(randomUUID(), saved.view.revision);
    expect(action).toMatchObject({ outcome: "disabled",
      view: { state: "disabled", hasCredential: false, reason: null } });
    expect(service.isSuspended()).toBe(true);
    expect(service.status()).toMatchObject({ connection: "disconnected", running: true,
      lastError: "sync-disabled" });
    expect(transport.receiveAndStage).not.toHaveBeenCalled();
    expect(deleteOutbox).not.toHaveBeenCalled();

    ack();
    expect(await pass).toMatchObject({ connection: "disconnected", running: false,
      lastError: "sync-disabled" });
    expect(transport.receiveAndStage).not.toHaveBeenCalled();
    expect(deleteOutbox).not.toHaveBeenCalled();

    const sends = vi.mocked(transport.sendPending).mock.calls.length;
    expect((await service.sync()).lastError).toBe("sync-disabled");
    expect(transport.sendPending).toHaveBeenCalledTimes(sends);
    expect(transport.receiveAndStage).not.toHaveBeenCalled();
    expect(control.status()).toMatchObject({ state: "disabled" });
  });

  it("lets a saved disable override legacy env and never falls back when the store is unavailable", async () => {
    const f = fixture();
    const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
    const control = makeControl(f, vault);
    const input = connectionInput();
    const saved = await control.configure(input);
    expect(saved.outcome).toBe("saved");

    const pending = savedConnectionEnvironment(vault, f.vaultDirectory, f.store.path, baseEnv);
    expect(pending.saved).toMatchObject({ revision: input.requestId, workspaceId: "workspace-1",
      clientId: "client-1", token: input.token, mode: "publish" });
    expect(pending.env.FOLIO_SYNC_ENABLED).toBe("1");

    const disabled = control.disable(randomUUID(), saved.view.revision);
    expect(disabled.outcome).toBe("disabled");
    const disabledEnv = savedConnectionEnvironment(vault, f.vaultDirectory, f.store.path, baseEnv);
    expect(disabledEnv.saved).toBeUndefined();
    expect(disabledEnv.held).toBeUndefined();
    expect(disabledEnv.env.FOLIO_SYNC_ENABLED).toBe("0");

    const reconfigured = await control.configure(connectionInput({ expectedRevision: disabled.view.revision }));
    expect(reconfigured.outcome).toBe("saved");
    f.storage.available = false;
    const unavailable = savedConnectionEnvironment(vault, f.vaultDirectory, f.store.path, baseEnv);
    expect(unavailable.saved).toBeUndefined();
    expect(unavailable.held).toBe(true);
    expect(unavailable.env.FOLIO_SYNC_ENABLED).toBe("0");

    f.storage.available = true;
    f.storage.decryptError = new Error("no key");
    const undecryptable = savedConnectionEnvironment(vault, f.vaultDirectory, f.store.path, baseEnv);
    expect(undecryptable.saved).toBeUndefined();
    expect(undecryptable.held).toBe(true);
    expect(undecryptable.env.FOLIO_SYNC_ENABLED).toBe("0");
  });

  it("never loads a saved credential through a copied workspace database", async () => {
    const f = fixture();
    const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage);
    expect((await makeControl(f, vault).configure(connectionInput())).outcome).toBe("saved");

    const copyDirectory = join(f.root, "copy");
    mkdirSync(copyDirectory, { mode: 0o700 });
    const copyPath = join(copyDirectory, "workspace.sqlite");
    copyFileSync(f.store.path, copyPath);
    const copyVault = vaultFor(f.vaultDirectory, copyPath, f.storage);
    expect(copyVault.load(copyPath)).toBeNull();
    expect(copyVault.view(copyPath)).toMatchObject({ state: "unconfigured", revision: null,
      hasCredential: false });
    const environment = savedConnectionEnvironment(copyVault, f.vaultDirectory, copyPath, baseEnv);
    expect(environment.saved).toBeUndefined();
    expect(environment.held).toBeUndefined();
    expect(environment.env).toEqual(baseEnv);
  });

  it("activates a saved publish config through windowless startup and does not rebind later", async () => {
    const f = fixture();
    mkdirSync(join(f.directory, "assets"), { recursive: true });
    const identity = "identity-lifecycle";
    const vault = vaultFor(f.vaultDirectory, f.store.path, f.storage, identity);
    const workspaceId = randomUUID(), ownerId = randomUUID(), clientId = randomUUID(), token = "C".repeat(43);
    const server = await startCheckpointServer({ databasePath: join(f.root, "server.sqlite"), capabilities: [],
      workspaces: [{ workspaceId, ownerId }], validateCheckpoint: validateWorkspaceCheckpoint });
    try {
      server.registerDevice({ workspaceId, ownerId, clientId, token });
      const input = connectionInput({ baseUrl: server.url, workspaceId, clientId, token });
      const saved = await makeControl(f, vault).configure(input);
      expect(saved).toMatchObject({ outcome: "saved", view: { state: "pending-restart" } });

      const pending = savedConnectionEnvironment(vault, f.vaultDirectory, f.store.path, {});
      expect(pending.saved).toMatchObject({ revision: input.requestId, workspaceId, clientId, token,
        mode: "publish" });
      expect(pending.env.FOLIO_SYNC_ENABLED).toBe("1");

      let firstOpened = 0;
      const first = await runStartupWorkspaceSyncDetailed(f.store, () => ({ status: "empty", generation: 0 }),
        pending.env, undefined, () => { firstOpened++; vault.markActivated(f.store.path, pending.saved!.revision); });
      expect(firstOpened).toBe(1);
      expect(first.message).toContain("起動時同期");
      expect(readUserVersion(f.store.db)).toBe(5);
      expect(vault.view(f.store.path).state).toBe("configured");

      const bindingPath = join(f.directory, ".folio-sync-binding");
      const bindingBefore = readFileSync(bindingPath, "utf8");
      const activated = savedConnectionEnvironment(vault, f.vaultDirectory, f.store.path, {});
      expect(activated.held).toBeUndefined();
      expect(activated.saved).toMatchObject({ revision: input.requestId, workspaceId, clientId, token });
      expect(activated.saved!.mode).toBeUndefined();
      expect(activated.env.FOLIO_SYNC_MODE).toBeUndefined();

      let secondOpened = 0;
      const second = await runStartupWorkspaceSyncDetailed(f.store, () => ({ status: "empty", generation: 0 }),
        activated.env, undefined, () => { secondOpened++; vault.markActivated(f.store.path, activated.saved!.revision); });
      expect(secondOpened).toBe(1);
      expect(second.message).toContain("起動時同期");
      expect(readFileSync(bindingPath, "utf8")).toBe(bindingBefore);
      expect(vault.load(f.store.path)).toMatchObject({ workspaceId, clientId, token, revision: input.requestId });
      expect(readUserVersion(f.store.db)).toBe(5);
    } finally {
      await server.close();
    }
  });
});
