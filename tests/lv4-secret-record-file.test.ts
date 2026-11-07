import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SECRET_RECORD_BYTES,
  SecretStoreError,
  SyncSecretStore,
  parseSyncDeviceToken,
  syncSecretKey,
  type SafeStoragePort,
  type SyncSecretScope,
} from "../src/sync/secret-store";
import {
  SecretRecordFileError,
  SecretRecordFilePersistence,
  type SecretRecordFileOptions,
} from "../src/sync/secret-record-file";

const SCOPE: SyncSecretScope = {
  baseUrl: "http://127.0.0.1:43210",
  workspaceId: "workspace-a",
  clientId: "client-a",
  bindingId: "binding-a",
  serverEpoch: "epoch-a",
};
const KEY = syncSecretKey(SCOPE);
const OTHER_KEY = syncSecretKey({ ...SCOPE, serverEpoch: "epoch-b" });
const CIPHERTEXT = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x7f, 0x80,
]);
const DIFFERENT = Buffer.from(CIPHERTEXT);
DIFFERENT[0] ^= 0xff;
const TOKEN = "A".repeat(43);
const OTHER_TOKEN = "B".repeat(43);

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

type Fixture = {
  root: string;
  workspace: string;
  backups: string;
  secrets: string;
  options: SecretRecordFileOptions;
};

function makeFixture(prefix = "folio-secret-record-file-"): Fixture {
  const root = makeRoot(prefix);
  const workspace = join(root, "workspace");
  const backups = join(root, "backups");
  const secrets = join(root, "secrets");
  for (const directory of [workspace, backups, secrets]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  return {
    root,
    workspace,
    backups,
    secrets,
    options: { directory: secrets, forbiddenRoots: [workspace, backups] },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

async function rejection(
  promise: Promise<unknown>,
): Promise<SecretRecordFileError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretRecordFileError);
    const recordError = error as SecretRecordFileError;
    expect(recordError.message).toBe(recordError.code);
    return recordError;
  }
  throw new Error("expected SecretRecordFileError");
}

function syncRejection(work: () => unknown): SecretRecordFileError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretRecordFileError);
    const recordError = error as SecretRecordFileError;
    expect(recordError.message).toBe(recordError.code);
    return recordError;
  }
  throw new Error("expected SecretRecordFileError");
}

async function secretStoreRejection(
  promise: Promise<unknown>,
): Promise<SecretStoreError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretStoreError);
    const secretError = error as SecretStoreError;
    expect(secretError.message).toBe(secretError.code);
    return secretError;
  }
  throw new Error("expected SecretStoreError");
}

function recordPath(fixture: Fixture): string {
  const names = readdirSync(fixture.secrets);
  expect(names).toHaveLength(1);
  return join(fixture.secrets, names[0]);
}

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
  backend: string | undefined =
    process.platform === "linux" ? "gnome_libsecret" : undefined;

  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(plainText: string): Buffer {
    return scramble(plainText);
  }

  decryptString(encrypted: Buffer): string {
    return unscramble(encrypted);
  }

  getSelectedStorageBackend(): string | undefined {
    return this.backend;
  }
}

describe("SecretRecordFilePersistence", () => {
  it("round-trips exact ciphertext from a preexisting private directory", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);

    await adapter.write(KEY, CIPHERTEXT);

    const record = await adapter.read(KEY);
    expect(record).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(record!)).toEqual(CIPHERTEXT);
    const path = recordPath(fixture);
    const stat = lstatSync(path);
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(path)).toEqual(CIPHERTEXT);
    const reopened = new SecretRecordFilePersistence(fixture.options);
    expect(Buffer.from((await reopened.read(KEY))!)).toEqual(CIPHERTEXT);
    expect(await adapter.read(OTHER_KEY)).toBeUndefined();
  });

  it("validates ciphertext type and length before creating a record", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    const maximum = Buffer.alloc(MAX_SECRET_RECORD_BYTES, 0x5a);

    await adapter.write(KEY, maximum);
    expect(Buffer.from((await adapter.read(KEY))!)).toEqual(maximum);

    expect((await rejection(adapter.write(OTHER_KEY, Buffer.alloc(0)))).code)
      .toBe("secret-record-file-invalid-record");
    expect(
      (
        await rejection(
          adapter.write(OTHER_KEY, Buffer.alloc(MAX_SECRET_RECORD_BYTES + 1)),
        )
      ).code,
    ).toBe("secret-record-file-too-large");
    for (const value of ["text", new Uint16Array(2), null, undefined]) {
      expect(
        (
          await rejection(
            adapter.write(OTHER_KEY, value as unknown as Uint8Array),
          )
        ).code,
      ).toBe("secret-record-file-invalid-record");
    }
    expect(readdirSync(fixture.secrets)).toHaveLength(1);
  });

  it("requires an existing canonical private directory outside forbidden roots", () => {
    const fixture = makeFixture();
    const construct = (
      directory: string,
      forbiddenRoots: readonly string[] = fixture.options.forbiddenRoots,
    ) => new SecretRecordFilePersistence({ directory, forbiddenRoots });

    const missing = join(fixture.root, "missing");
    expect(syncRejection(() => construct(missing)).code).toBe(
      "secret-record-file-invalid-directory",
    );
    expect(existsSync(missing)).toBe(false);

    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.secrets, alias);
    expect(syncRejection(() => construct(alias)).code).toBe(
      "secret-record-file-unsafe-directory",
    );
    const parentAlias = join(fixture.root, "parent-alias");
    symlinkSync(fixture.root, parentAlias);
    expect(syncRejection(() => construct(join(parentAlias, "secrets"))).code).toBe(
      "secret-record-file-unsafe-directory",
    );

    chmodSync(fixture.secrets, 0o755);
    try {
      expect(syncRejection(() => construct(fixture.secrets)).code).toBe(
        "secret-record-file-unsafe-directory",
      );
    } finally {
      chmodSync(fixture.secrets, 0o700);
    }

    const insideWorkspace = join(fixture.workspace, "secrets");
    mkdirSync(insideWorkspace, { mode: 0o700 });
    chmodSync(insideWorkspace, 0o700);
    expect(syncRejection(() => construct(insideWorkspace)).code).toBe(
      "secret-record-file-unsafe-directory",
    );

    expect(syncRejection(() => construct(fixture.root)).code).toBe(
      "secret-record-file-unsafe-directory",
    );
    expect(syncRejection(() => construct(fixture.secrets, [])).code).toBe(
      "secret-record-file-invalid-options",
    );
  });

  it("rejects non-canonical keys without touching the directory", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    const invalidKeys = [
      "",
      "short",
      "folio-sync-device-token/v1:",
      "folio-sync-device-token/v1:" + "a".repeat(63),
      "folio-sync-device-token/v1:" + "a".repeat(65),
      "folio-sync-device-token/v1:" + "A".repeat(64),
      "folio-sync-device-token/v2:" + "a".repeat(64),
      "folio-sync-device-token/v1:" + "a".repeat(64) + "/../x",
    ];

    for (const key of invalidKeys) {
      expect((await rejection(adapter.write(key, CIPHERTEXT))).code).toBe(
        "secret-record-file-invalid-key",
      );
      expect((await rejection(adapter.read(key))).code).toBe(
        "secret-record-file-invalid-key",
      );
      expect((await rejection(adapter.delete(key))).code).toBe(
        "secret-record-file-invalid-key",
      );
    }
    expect(
      (
        await rejection(
          adapter.read(123 as unknown as string),
        )
      ).code,
    ).toBe("secret-record-file-invalid-key");
    expect(readdirSync(fixture.secrets)).toEqual([]);
  });

  it("is create-once and preserves the original on a different write", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    await adapter.write(KEY, CIPHERTEXT);
    const path = recordPath(fixture);
    const before = lstatSync(path);

    await adapter.write(KEY, CIPHERTEXT);
    const after = lstatSync(path);
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(1);

    const error = await rejection(adapter.write(KEY, DIFFERENT));
    expect(error.code).toBe("secret-record-file-conflict");
    expect(readFileSync(path)).toEqual(CIPHERTEXT);
    expect(Buffer.from((await adapter.read(KEY))!)).toEqual(CIPHERTEXT);
  });

  it("rejects hardlinked records and preserves their bytes", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    await adapter.write(KEY, CIPHERTEXT);
    const path = recordPath(fixture);
    const alias = join(fixture.root, "alias");
    linkSync(path, alias);

    expect((await rejection(adapter.read(KEY))).code).toBe(
      "secret-record-file-unsafe-record",
    );
    expect((await rejection(adapter.write(KEY, CIPHERTEXT))).code).toBe(
      "secret-record-file-unsafe-record",
    );
    expect((await rejection(adapter.write(KEY, DIFFERENT))).code).toBe(
      "secret-record-file-unsafe-record",
    );
    expect(readFileSync(path)).toEqual(CIPHERTEXT);

    unlinkSync(alias);
    expect(Buffer.from((await adapter.read(KEY))!)).toEqual(CIPHERTEXT);
  });

  it("rejects symlinked record paths without changing their target", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    await adapter.write(KEY, CIPHERTEXT);
    const path = recordPath(fixture);
    unlinkSync(path);
    const target = join(fixture.root, "target");
    writeFileSync(target, "keep", { mode: 0o600 });
    chmodSync(target, 0o600);
    symlinkSync(target, path);

    expect((await rejection(adapter.read(KEY))).code).toBe(
      "secret-record-file-unsafe-record",
    );
    expect((await rejection(adapter.write(KEY, CIPHERTEXT))).code).toBe(
      "secret-record-file-unsafe-record",
    );
    expect(readFileSync(target, "utf8")).toBe("keep");
    unlinkSync(path);
  });

  it("rejects a directory at a record path for reads and writes", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    await adapter.write(KEY, CIPHERTEXT);
    const path = recordPath(fixture);
    unlinkSync(path);
    mkdirSync(path, {mode: 0o700});
    expect((await rejection(adapter.read(KEY))).code).toBe("secret-record-file-unsafe-record");
    expect((await rejection(adapter.write(KEY, CIPHERTEXT))).code).toBe("secret-record-file-unsafe-record");
  });

  it("rejects unsafe, empty, and oversized existing records", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    await adapter.write(KEY, CIPHERTEXT);
    const path = recordPath(fixture);

    chmodSync(path, 0o644);
    expect((await rejection(adapter.read(KEY))).code).toBe(
      "secret-record-file-unsafe-record",
    );
    chmodSync(path, 0o600);

    truncateSync(path, 0);
    expect((await rejection(adapter.read(KEY))).code).toBe(
      "secret-record-file-invalid-record",
    );

    unlinkSync(path);
    await adapter.write(KEY, CIPHERTEXT);
    truncateSync(path, MAX_SECRET_RECORD_BYTES + 1);
    expect((await rejection(adapter.read(KEY))).code).toBe(
      "secret-record-file-too-large",
    );
  });

  it("leaves deletion unimplemented and keeps the record", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    await adapter.write(KEY, CIPHERTEXT);
    const path = recordPath(fixture);

    const error = await rejection(adapter.delete(KEY));
    expect(error.code).toBe("secret-record-file-delete-unsupported");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(CIPHERTEXT);
  });

  it("fails closed when the checked directory is replaced", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    await adapter.write(KEY, CIPHERTEXT);
    const name = readdirSync(fixture.secrets)[0];
    const moved = join(fixture.root, "moved");
    renameSync(fixture.secrets, moved);
    mkdirSync(fixture.secrets, { mode: 0o700 });
    chmodSync(fixture.secrets, 0o700);

    expect((await rejection(adapter.read(KEY))).code).toBe(
      "secret-record-file-directory-changed",
    );
    expect((await rejection(adapter.write(OTHER_KEY, CIPHERTEXT))).code).toBe(
      "secret-record-file-directory-changed",
    );
    expect(readdirSync(fixture.secrets)).toEqual([]);
    expect(readFileSync(join(moved, name))).toEqual(CIPHERTEXT);

    rmSync(fixture.secrets, { recursive: true, force: true });
    symlinkSync(moved, fixture.secrets);
    expect((await rejection(adapter.read(KEY))).code).toBe(
      "secret-record-file-directory-changed",
    );
  });

  it("never logs keys, ciphertext, or failures", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method));
    try {
      const fixture = makeFixture();
      const adapter = new SecretRecordFilePersistence(fixture.options);
      await adapter.write(KEY, CIPHERTEXT);
      await adapter.read(KEY);
      await rejection(adapter.write(KEY, DIFFERENT));
      await rejection(adapter.delete(KEY));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("works through SyncSecretStore and preserves the old token on updates", async () => {
    const fixture = makeFixture();
    const adapter = new SecretRecordFilePersistence(fixture.options);
    const store = new SyncSecretStore(new FakeSafeStorage(), adapter);

    await store.set(SCOPE, parseSyncDeviceToken(TOKEN));
    expect(await store.get(SCOPE)).toBe(TOKEN);

    const path = recordPath(fixture);
    const bytes = readFileSync(path);
    expect(bytes.includes(Buffer.from(TOKEN))).toBe(false);
    expect(bytes.toString("utf8")).not.toContain(TOKEN);
    expect(bytes.toString("utf8")).not.toContain("folio-sync-device-token");

    await store.set(SCOPE, parseSyncDeviceToken(TOKEN));
    expect(await store.get(SCOPE)).toBe(TOKEN);

    const updateError = await secretStoreRejection(
      store.set(SCOPE, parseSyncDeviceToken(OTHER_TOKEN)),
    );
    expect(updateError.code).toBe("secret-store-persistence-failed");
    expect(await store.get(SCOPE)).toBe(TOKEN);
    expect(readFileSync(path)).toEqual(bytes);

    const deleteError = await secretStoreRejection(store.delete(SCOPE));
    expect(deleteError.code).toBe("secret-store-persistence-failed");
    expect(await store.get(SCOPE)).toBe(TOKEN);
  });

  it("does not import Electron or log, rename, or recursively delete", () => {
    const source = readFileSync(
      new URL("../src/sync/secret-record-file.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:from\s+["']electron["']|require\s*\(\s*["']electron["']\s*\))/,
    );
    expect(source).not.toMatch(/\bconsole\./);
    expect(source).not.toMatch(/\brenameSync\b/);
    expect(source).not.toMatch(/\brmSync\b/);
  });
});
