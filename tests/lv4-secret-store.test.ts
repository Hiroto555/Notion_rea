import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SECRET_RECORD_BYTES,
  SecretStoreError,
  SyncSecretStore,
  parseSyncConnectionTarget,
  parseSyncDeviceToken,
  parseSyncSecretScope,
  syncSecretKey,
  type SafeStoragePort,
  type SecretRecordPersistence,
  type SyncDeviceToken,
  type SyncSecretScope,
} from "../src/sync/secret-store";

const TOKEN = "A".repeat(43);
const OTHER_TOKEN = "B".repeat(43);

const scope: SyncSecretScope = {
  baseUrl: "http://127.0.0.1:43210",
  workspaceId: "workspace-a",
  clientId: "client-a",
  bindingId: "binding-a",
  serverEpoch: "epoch-a",
};

function scramble(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0x5a;
  return bytes;
}

function unscramble(value: Buffer): string {
  const bytes = Buffer.from(value);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0x5a;
  return bytes.toString("utf8");
}

class FakeSafeStorage implements SafeStoragePort {
  available = true;
  backend: string | undefined = process.platform === "linux" ? "gnome_libsecret" : undefined;
  availabilityError: unknown;
  backendError: unknown;
  encryptError: unknown;
  decryptError: unknown;
  encryptCalls = 0;
  decryptCalls = 0;

  isEncryptionAvailable(): boolean {
    if (this.availabilityError) throw this.availabilityError;
    return this.available;
  }

  encryptString(plainText: string): Buffer {
    this.encryptCalls += 1;
    if (this.encryptError) throw this.encryptError;
    return scramble(plainText);
  }

  decryptString(encrypted: Buffer): string {
    this.decryptCalls += 1;
    if (this.decryptError) throw this.decryptError;
    return unscramble(encrypted);
  }

  getSelectedStorageBackend(): string | undefined {
    if (this.backendError) throw this.backendError;
    return this.backend;
  }
}

class MemoryPersistence implements SecretRecordPersistence {
  readonly records = new Map<string, Uint8Array>();
  reads = 0;
  writes = 0;
  deletes = 0;
  readError: unknown;
  writeError: unknown;
  deleteError: unknown;

  async read(key: string): Promise<Uint8Array | undefined> {
    if (this.readError) throw this.readError;
    this.reads += 1;
    return this.records.get(key);
  }

  async write(key: string, value: Uint8Array): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.writes += 1;
    this.records.set(key, Buffer.from(value));
  }

  async delete(key: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deletes += 1;
    this.records.delete(key);
  }
}

async function rejection(promise: Promise<unknown>): Promise<SecretStoreError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretStoreError);
    const secretError = error as SecretStoreError;
    expect(secretError.message).toBe(secretError.code);
    return secretError;
  }
  throw new Error("expected secret-store rejection");
}

function syncRejection(work: () => unknown): SecretStoreError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretStoreError);
    const secretError = error as SecretStoreError;
    expect(secretError.message).toBe(secretError.code);
    return secretError;
  }
  throw new Error("expected secret-store rejection");
}

describe("SyncSecretStore", () => {
  it("round-trips a typed token without persisting plaintext", async () => {
    const safeStorage = new FakeSafeStorage();
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(safeStorage, persistence);

    await store.set(scope, parseSyncDeviceToken(TOKEN));

    expect(persistence.writes).toBe(1);
    expect(persistence.records.size).toBe(1);
    const [key, record] = [...persistence.records.entries()][0];
    expect(key).toBe(syncSecretKey(scope));
    expect(key).not.toContain(TOKEN);
    expect(Buffer.from(record).toString("latin1")).not.toContain(TOKEN);
    expect(Buffer.from(record).includes(Buffer.from(TOKEN))).toBe(false);
    expect(await store.get(scope)).toBe(TOKEN);

    await store.delete(scope);
    expect(persistence.deletes).toBe(1);
    expect(await store.get(scope)).toBeUndefined();
  });

  it("separates records by connection identity and server epoch", async () => {
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(new FakeSafeStorage(), persistence);
    const otherEpoch = { ...scope, serverEpoch: "epoch-b" };
    const otherBinding = { ...scope, bindingId: "binding-b" };

    await store.set(scope, parseSyncDeviceToken(TOKEN));
    await store.set(otherEpoch, parseSyncDeviceToken(OTHER_TOKEN));

    expect(await store.get(scope)).toBe(TOKEN);
    expect(await store.get(otherEpoch)).toBe(OTHER_TOKEN);
    expect(await store.get(otherBinding)).toBeUndefined();
    expect(syncSecretKey(scope)).not.toBe(syncSecretKey(otherEpoch));
    expect(syncSecretKey(scope)).not.toBe(syncSecretKey(otherBinding));
    for (const raw of [
      scope.baseUrl,
      scope.workspaceId,
      scope.clientId,
      scope.bindingId,
      scope.serverEpoch,
    ])
      expect(syncSecretKey(scope)).not.toContain(raw);
  });

  it("rejects a ciphertext moved to a different connection scope", async () => {
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(new FakeSafeStorage(), persistence);
    const otherEpoch = { ...scope, serverEpoch: "epoch-b" };

    await store.set(scope, parseSyncDeviceToken(TOKEN));
    persistence.records.set(
      syncSecretKey(otherEpoch),
      Buffer.from(persistence.records.get(syncSecretKey(scope))!),
    );

    const error = await rejection(store.get(otherEpoch));
    expect(error.code).toBe("secret-store-corrupt-record");
    expect(error.message).not.toContain(TOKEN);
  });

  it("fails closed when encryption is unavailable and never writes", async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.available = false;
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(safeStorage, persistence);

    const setError = await rejection(
      store.set(scope, parseSyncDeviceToken(TOKEN)),
    );
    expect(setError.code).toBe("secret-store-unavailable");
    expect(safeStorage.encryptCalls).toBe(0);
    expect(persistence.writes).toBe(0);
    expect(persistence.records.size).toBe(0);

    const getError = await rejection(store.get(scope));
    expect(getError.code).toBe("secret-store-unavailable");
    expect(persistence.reads).toBe(0);

    await store.delete(scope);
    expect(persistence.deletes).toBe(1);
  });

  it("normalizes availability failures without echoing their text", async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.availabilityError = new Error(`unavailable ${TOKEN}`);
    const store = new SyncSecretStore(safeStorage, new MemoryPersistence());

    const error = await rejection(store.get(scope));
    expect(error.code).toBe("secret-store-unavailable");
    expect(error.message).not.toContain(TOKEN);
  });

  it("rejects malformed tokens before encryption", async () => {
    const safeStorage = new FakeSafeStorage();
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(safeStorage, persistence);
    const invalid = "short-token-value";

    const error = await rejection(
      store.set(scope, invalid as SyncDeviceToken),
    );
    expect(error.code).toBe("secret-store-invalid-token");
    expect(error.message).not.toContain(invalid);
    expect(safeStorage.encryptCalls).toBe(0);
    expect(persistence.writes).toBe(0);
    expect(() => parseSyncDeviceToken(invalid)).toThrow(SecretStoreError);
  });

  it("normalizes encryption failures without writing or leaking", async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.encryptError = new Error(`encrypt failed ${TOKEN}`);
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(safeStorage, persistence);

    const error = await rejection(
      store.set(scope, parseSyncDeviceToken(TOKEN)),
    );
    expect(error.code).toBe("secret-store-encrypt-failed");
    expect(error.message).not.toContain(TOKEN);
    expect(persistence.writes).toBe(0);
  });

  it("normalizes decryption failures without leaking plaintext", async () => {
    const safeStorage = new FakeSafeStorage();
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(safeStorage, persistence);
    await store.set(scope, parseSyncDeviceToken(TOKEN));
    safeStorage.decryptError = new Error(`decrypt failed ${TOKEN}`);

    const error = await rejection(store.get(scope));
    expect(error.code).toBe("secret-store-decrypt-failed");
    expect(error.message).not.toContain(TOKEN);
  });

  it("rejects empty, oversized, and wrongly decrypted records", async () => {
    const safeStorage = new FakeSafeStorage();
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(safeStorage, persistence);
    const key = syncSecretKey(scope);

    persistence.records.set(key, Buffer.alloc(0));
    expect((await rejection(store.get(scope))).code).toBe(
      "secret-store-corrupt-record",
    );

    persistence.records.set(key, Buffer.alloc(MAX_SECRET_RECORD_BYTES + 1));
    expect((await rejection(store.get(scope))).code).toBe(
      "secret-store-corrupt-record",
    );

    persistence.records.set(key, scramble("not-a-valid-token"));
    expect((await rejection(store.get(scope))).code).toBe(
      "secret-store-corrupt-record",
    );
  });

  it("normalizes persistence failures without leaking secrets", async () => {
    const safeStorage = new FakeSafeStorage();
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(safeStorage, persistence);

    persistence.writeError = new Error(`write failed ${TOKEN}`);
    const writeError = await rejection(
      store.set(scope, parseSyncDeviceToken(TOKEN)),
    );
    expect(writeError.code).toBe("secret-store-persistence-failed");
    expect(writeError.message).not.toContain(TOKEN);
    expect(persistence.writes).toBe(0);

    persistence.writeError = undefined;
    await store.set(scope, parseSyncDeviceToken(TOKEN));
    persistence.readError = new Error(`read failed ${TOKEN}`);
    const readError = await rejection(store.get(scope));
    expect(readError.code).toBe("secret-store-persistence-failed");
    expect(readError.message).not.toContain(TOKEN);

    persistence.deleteError = new Error(`delete failed ${TOKEN}`);
    const deleteError = await rejection(store.delete(scope));
    expect(deleteError.code).toBe("secret-store-persistence-failed");
    expect(deleteError.message).not.toContain(TOKEN);
  });

  it("rejects insecure selected backends but accepts known safe ones", async () => {
    const safeStorage = new FakeSafeStorage();
    const persistence = new MemoryPersistence();
    const store = new SyncSecretStore(safeStorage, persistence, "darwin");

    for (const backend of ["basic_text", "unknown"]) {
      safeStorage.backend = backend;
      const error = await rejection(
        store.set(scope, parseSyncDeviceToken(TOKEN)),
      );
      expect(error.code).toBe("secret-store-insecure-backend");
      expect(persistence.writes).toBe(0);
    }

    safeStorage.backend = "gnome_libsecret";
    await store.set(scope, parseSyncDeviceToken(TOKEN));
    expect(await store.get(scope)).toBe(TOKEN);

    safeStorage.backend = undefined;
    await store.set(scope, parseSyncDeviceToken(OTHER_TOKEN));
    expect(await store.get(scope)).toBe(OTHER_TOKEN);
  });

  it("fails closed on Linux when the secure backend cannot be identified", async () => {
    const safeStorage = new FakeSafeStorage();
    const persistence = new MemoryPersistence();
    safeStorage.backend = undefined;
    const linux = new SyncSecretStore(safeStorage, persistence, "linux");
    expect((await rejection(linux.set(scope, parseSyncDeviceToken(TOKEN)))).code)
      .toBe("secret-store-unavailable");
    expect(persistence.writes).toBe(0);
    const noBackend: SafeStoragePort = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => scramble(value),
      decryptString: (value) => unscramble(value),
    };
    expect((await rejection(new SyncSecretStore(noBackend, persistence, "linux").get(scope))).code)
      .toBe("secret-store-unavailable");
    Object.defineProperty(noBackend, "getSelectedStorageBackend", {get() {throw new Error(TOKEN);}});
    const getterError = await rejection(new SyncSecretStore(noBackend, persistence, "linux").get(scope));
    expect(getterError.code).toBe("secret-store-unavailable");
    expect(getterError.message).not.toContain(TOKEN);
  });

  it("accepts only loopback targets without credentials or token-bearing parts", () => {
    expect(
      parseSyncConnectionTarget({
        baseUrl: "http://127.0.0.1:43210/",
        workspaceId: "workspace-a",
        clientId: "client-a",
        bindingId: "binding-a",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:43210",
      workspaceId: "workspace-a",
      clientId: "client-a",
      bindingId: "binding-a",
    });

    for (const baseUrl of [
      "https://127.0.0.1:43210",
      "http://localhost:43210",
      `http://user:${TOKEN}@127.0.0.1:43210`,
      `http://127.0.0.1:43210/?token=${TOKEN}`,
      `http://127.0.0.1:43210/#${TOKEN}`,
      "http://127.0.0.1:43210/secret",
    ]) {
      const error = syncRejection(() =>
        parseSyncConnectionTarget({
          baseUrl,
          workspaceId: "workspace-a",
          clientId: "client-a",
          bindingId: "binding-a",
        }),
      );
      expect(error.code).toBe("secret-store-invalid-connection");
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).not.toContain(baseUrl);
    }
  });

  it("rejects unexpected fields and malformed scope identifiers", () => {
    const unexpected = syncRejection(() =>
      parseSyncSecretScope({ ...scope, token: TOKEN }),
    );
    expect(unexpected.code).toBe("secret-store-invalid-scope");
    expect(unexpected.message).not.toContain(TOKEN);

    const malformed = syncRejection(() =>
      parseSyncSecretScope({ ...scope, workspaceId: `../${TOKEN}` }),
    );
    expect(malformed.code).toBe("secret-store-invalid-scope");
    expect(malformed.message).not.toContain(TOKEN);
  });

  it("rejects accessor-based records without invoking them", () => {
    let touched = false;
    const value: Record<string, unknown> = { ...scope };
    Object.defineProperty(value, "workspaceId", {
      enumerable: true,
      get() {
        touched = true;
        return scope.workspaceId;
      },
    });

    const error = syncRejection(() => parseSyncSecretScope(value));
    expect(error.code).toBe("secret-store-invalid-scope");
    expect(touched).toBe(false);
  });

  it("converts hostile proxy failures to a fixed code", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`hostile ${TOKEN}`);
        },
      },
    );
    const error = syncRejection(() => parseSyncSecretScope(hostile));
    expect(error.code).toBe("secret-store-invalid-scope");
    expect(error.message).not.toContain(TOKEN);
  });

  it("never logs through success or failure paths", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method));
    try {
      const safeStorage = new FakeSafeStorage();
      const persistence = new MemoryPersistence();
      const store = new SyncSecretStore(safeStorage, persistence);
      await store.set(scope, parseSyncDeviceToken(TOKEN));
      expect(await store.get(scope)).toBe(TOKEN);
      safeStorage.available = false;
      await rejection(store.set(scope, parseSyncDeviceToken(OTHER_TOKEN)));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("does not import Electron or filesystem modules", () => {
    const source = readFileSync(
      new URL("../src/sync/secret-store.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:from\s+["']electron["']|require\s*\(\s*["']electron["']\s*\))/,
    );
    expect(source).not.toContain("node:fs");
    expect(source).not.toMatch(/\bconsole\./);
  });
});
