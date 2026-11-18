import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SyncConnectionVault,
  type SyncConnectionVaultOptions,
} from "../src/main/sync-connection-vault";
import { PosixPrivatePlatform } from "../src/sync/private-platform";
import { MAX_SECRET_RECORD_BYTES, syncSecretKey } from "../src/sync/secret-store";
import {
  SecretRecordLedgerPersistence,
  createSecretRecordPersistence,
} from "../src/sync/secret-record-ledger";
import type { SyncConnectionInput } from "../src/shared/sync-management";

const volumes: string[] = [];

function tempPrivateDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(directory, 0o700);
  volumes.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of volumes.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function safeStorage(counter?: { encrypts: number }) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (_value: string) => {
      if (counter) counter.encrypts += 1;
      throw new Error("encrypt-must-not-run");
    },
    decryptString: (_value: Buffer) => {
      throw new Error("decrypt-must-not-run");
    },
  };
}

function scope() {
  return {
    baseUrl: "http://127.0.0.1:8787",
    workspaceId: "workspace1",
    clientId: "client1",
    bindingId: "binding1",
    serverEpoch: "epoch1",
  } as const;
}

function configureInput(): SyncConnectionInput {
  return {
    requestId: randomUUID(),
    expectedRevision: null,
    baseUrl: "http://127.0.0.1:8787",
    workspaceId: "workspace1",
    clientId: "client1",
    mode: "publish",
    token: "A".repeat(32),
  };
}

const WINDOWS_DATABASE = "C:\\Folio\\workspace.sqlite";
const VOLUME_ID = "A".repeat(16);
const FILE_ID = "B".repeat(32);

describe("SyncConnectionVault Windows native binding", () => {
  it("refuses a wrong workspace identity before encryption or ledger open", () => {
    const directory = tempPrivateDirectory("folio-vault-wrong-identity-");
    const counter = { encrypts: 0 };
    let factoryCalls = 0;
    let nativeCalls = 0;
    const options: SyncConnectionVaultOptions = {
      directory,
      forbiddenRoots: [tempPrivateDirectory("folio-vault-forbidden-")],
      safeStorage: safeStorage(counter),
      platform: "win32",
      assertWorkspaceAllowed: () => undefined,
      workspaceIdentity: () => "",
      workspaceNativeIdentity: (path) => {
        nativeCalls += 1;
        return { canonicalPath: path, volumeId: VOLUME_ID, fileId: FILE_ID };
      },
      privatePlatformFactory: () => {
        factoryCalls += 1;
        throw new Error("ledger-must-not-open");
      },
    };
    const vault = new SyncConnectionVault(options);
    const action = vault.configure(WINDOWS_DATABASE, configureInput());
    expect(action.outcome).toBe("held");
    expect(action.view.reason).toBe("identity-changed");
    expect(counter.encrypts).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(nativeCalls).toBe(1);
  });

  it("fails closed when no native identity or ledger port is supplied", () => {
    const directory = tempPrivateDirectory("folio-vault-missing-proof-");
    const vault = new SyncConnectionVault({
      directory,
      forbiddenRoots: [tempPrivateDirectory("folio-vault-forbidden-")],
      safeStorage: safeStorage(),
      platform: "win32",
      assertWorkspaceAllowed: () => undefined,
      workspaceIdentity: () => "identity-1",
    });
    const view = vault.view(WINDOWS_DATABASE);
    expect(view.state).toBe("held");
    expect(view.reason).toBe("identity-changed");
  });

  it("uses the injected Windows native identity and fresh private ledger port", () => {
    const directory = tempPrivateDirectory("folio-vault-native-port-");
    const forbidden = tempPrivateDirectory("folio-vault-forbidden-");
    const calls: { directory: string; name: string }[] = [];
    let nativeCalls = 0;
    const vault = new SyncConnectionVault({
      directory,
      forbiddenRoots: [forbidden],
      safeStorage: safeStorage(),
      platform: "win32",
      assertWorkspaceAllowed: () => undefined,
      workspaceIdentity: () => "identity-1",
      workspaceNativeIdentity: (path) => {
        nativeCalls += 1;
        return { canonicalPath: path, volumeId: VOLUME_ID, fileId: FILE_ID };
      },
      privatePlatformFactory: (factoryDirectory, name) => {
        calls.push({ directory: factoryDirectory, name });
        return new PosixPrivatePlatform([forbidden]);
      },
    });
    const view = vault.view(WINDOWS_DATABASE);
    expect(view).toMatchObject({ state: "unconfigured", reason: null });
    expect(nativeCalls).toBe(1);
    expect(calls).toEqual([{ directory, name: "connections.sqlite" }]);
    expect(existsSync(join(directory, "connections.sqlite"))).toBe(true);
  });

  it("keeps the existing POSIX binding path when no platform is injected", () => {
    const directory = tempPrivateDirectory("folio-vault-posix-");
    const database = join(directory, "workspace.sqlite");
    writeFileSync(database, "");
    chmodSync(database, 0o600);
    const vault = new SyncConnectionVault({
      directory,
      forbiddenRoots: [tempPrivateDirectory("folio-vault-forbidden-")],
      safeStorage: safeStorage(),
      platform: "darwin",
      assertWorkspaceAllowed: () => undefined,
      workspaceIdentity: () => "identity-1",
    });
    const view = vault.view(database);
    expect(view).toMatchObject({ state: "unconfigured", reason: null });
  });
});

describe("SecretRecordLedgerPersistence", () => {
  it("round-trips ciphertext only and never overwrites different bytes", async () => {
    const directory = tempPrivateDirectory("folio-secret-ledger-");
    const persistence = new SecretRecordLedgerPersistence({ directory });
    const key = syncSecretKey(scope());
    const marker = "CIPHERTEXT-MARKER-" + randomUUID();
    const ciphertext = new Uint8Array(Buffer.from(marker, "utf8"));

    await persistence.write(key, ciphertext);
    const read = await persistence.read(key);
    expect(read).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(read!).equals(Buffer.from(ciphertext))).toBe(true);

    const database = readFileSync(join(directory, "secrets.sqlite"));
    expect(database.includes(Buffer.from(marker, "utf8"))).toBe(false);

    await expect(persistence.write(key, ciphertext)).resolves.toBeUndefined();

    const replacement = new Uint8Array(Buffer.from("different-ciphertext"));
    await expect(persistence.write(key, replacement)).rejects.toMatchObject({
      code: "secret-record-ledger-conflict",
    });
    expect(
      Buffer.from((await persistence.read(key))!).equals(Buffer.from(ciphertext)),
    ).toBe(true);

    await expect(persistence.delete(key)).rejects.toMatchObject({
      code: "secret-record-ledger-delete-unsupported",
    });
  });

  it("rejects non-secret-store keys and out-of-range ciphertext", async () => {
    const directory = tempPrivateDirectory("folio-secret-ledger-limits-");
    const persistence = new SecretRecordLedgerPersistence({ directory });
    const key = syncSecretKey(scope());
    await expect(persistence.read("not-a-secret-key")).rejects.toMatchObject({
      code: "secret-record-ledger-invalid-key",
    });
    await expect(
      persistence.write(key, new Uint8Array(0)),
    ).rejects.toMatchObject({ code: "secret-record-ledger-invalid-record" });
    await expect(
      persistence.write(key, new Uint8Array(MAX_SECRET_RECORD_BYTES + 1)),
    ).rejects.toMatchObject({ code: "secret-record-ledger-too-large" });
  });

  it("uses an injected native private port for the secrets ledger", async () => {
    const directory = tempPrivateDirectory("folio-secret-ledger-native-");
    const forbidden = tempPrivateDirectory("folio-secret-ledger-forbidden-");
    const calls: { directory: string; name: string }[] = [];
    const persistence = new SecretRecordLedgerPersistence({
      directory,
      platform: "win32",
      privatePlatformFactory: (factoryDirectory, name) => {
        calls.push({ directory: factoryDirectory, name });
        return new PosixPrivatePlatform([forbidden]);
      },
    });
    const key = syncSecretKey(scope());
    const ciphertext = new Uint8Array(Buffer.from("native-port-ciphertext"));
    await persistence.write(key, ciphertext);
    expect(Buffer.from((await persistence.read(key))!)).toEqual(
      Buffer.from(ciphertext),
    );
    expect(calls).toEqual([{ directory, name: "secrets.sqlite" }, { directory, name: "secrets.sqlite" }]);
  });

  it("selects the file adapter on POSIX and requires explicit Windows config", () => {
    const directory = tempPrivateDirectory("folio-secret-selection-");
    const forbidden = tempPrivateDirectory("folio-secret-selection-forbidden-");
    const posix = createSecretRecordPersistence({
      directory,
      forbiddenRoots: [forbidden],
      platform: "darwin",
    });
    expect(posix.constructor.name).toBe("SecretRecordFilePersistence");
    let failure: unknown;
    try {
      createSecretRecordPersistence({
        directory,
        forbiddenRoots: [forbidden],
        platform: "win32",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "secret-record-ledger-platform-required",
    });
    const windows = createSecretRecordPersistence({
      directory,
      forbiddenRoots: [forbidden],
      platform: "win32",
      privatePlatformFactory: () =>
        new PosixPrivatePlatform([forbidden]),
    });
    expect(windows.constructor.name).toBe("SecretRecordLedgerPersistence");
  });
});
