import { createHash } from "node:crypto";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const KEY_PREFIX = "folio-sync-device-token/v1";
const SECURE_LINUX_BACKENDS = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

export const MAX_SECRET_RECORD_BYTES = 16 * 1024;

export type SecretStoreErrorCode =
  | "secret-store-invalid-connection"
  | "secret-store-invalid-scope"
  | "secret-store-invalid-token"
  | "secret-store-unavailable"
  | "secret-store-insecure-backend"
  | "secret-store-encrypt-failed"
  | "secret-store-decrypt-failed"
  | "secret-store-corrupt-record"
  | "secret-store-persistence-failed";

/** Fixed-code error; it never carries a token, URL, or backend exception text. */
export class SecretStoreError extends Error {
  constructor(readonly code: SecretStoreErrorCode) {
    super(code);
    this.name = "SecretStoreError";
  }
}

declare const syncDeviceTokenBrand: unique symbol;

/** A device token that passed the wire-compatible shape check. */
export type SyncDeviceToken = string & {
  readonly [syncDeviceTokenBrand]: true;
};

export type SyncConnectionTarget = Readonly<{
  baseUrl: string;
  workspaceId: string;
  clientId: string;
  bindingId: string;
}>;

export type SyncSecretScope = SyncConnectionTarget &
  Readonly<{ serverEpoch: string }>;

/**
 * Minimal structural subset of Electron safeStorage. It is injected so this
 * boundary and its Node tests never import or start Electron.
 */
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string | undefined;
}

/**
 * Opaque ciphertext records keyed by a non-secret derived key. Implementations
 * must live outside workspace files and backups. The separate create-once file
 * adapter requires a caller-supplied private directory and explicit forbidden
 * roots; it is not wired to product settings or an OS credential store.
 */
export interface SecretRecordPersistence {
  read(key: string): Promise<Uint8Array | null | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

function fail(code: SecretStoreErrorCode): never {
  throw new SecretStoreError(code);
}

function fields(
  value: unknown,
  expected: readonly string[],
  code: SecretStoreErrorCode,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const input = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expected.length ||
    !expected.every((key) => keys.includes(key))
  )
    fail(code);
  const detached: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail(code);
    detached[key] = descriptor.value;
  }
  return detached;
}

function identifier(value: unknown, code: SecretStoreErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code);
  return value;
}

function loopbackBaseUrl(value: unknown, code: SecretStoreErrorCode): string {
  if (typeof value !== "string") fail(code);
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    fail(code);
  }
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  )
    fail(code);
  return url.origin;
}

function readConnectionTarget(
  input: Record<string, unknown>,
  code: SecretStoreErrorCode,
): SyncConnectionTarget {
  return Object.freeze({
    baseUrl: loopbackBaseUrl(input.baseUrl, code),
    workspaceId: identifier(input.workspaceId, code),
    clientId: identifier(input.clientId, code),
    bindingId: identifier(input.bindingId, code),
  });
}

export function parseSyncConnectionTarget(
  value: unknown,
): SyncConnectionTarget {
  try {
    return readConnectionTarget(
      fields(
        value,
        ["baseUrl", "workspaceId", "clientId", "bindingId"],
        "secret-store-invalid-connection",
      ),
      "secret-store-invalid-connection",
    );
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    fail("secret-store-invalid-connection");
  }
}

export function parseSyncSecretScope(value: unknown): SyncSecretScope {
  try {
    const input = fields(
      value,
      ["baseUrl", "workspaceId", "clientId", "bindingId", "serverEpoch"],
      "secret-store-invalid-scope",
    );
    const target = readConnectionTarget(input, "secret-store-invalid-scope");
    return Object.freeze({
      ...target,
      serverEpoch: identifier(input.serverEpoch, "secret-store-invalid-scope"),
    });
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    fail("secret-store-invalid-scope");
  }
}

export function parseSyncDeviceToken(value: unknown): SyncDeviceToken {
  if (typeof value !== "string" || !DEVICE_TOKEN.test(value))
    fail("secret-store-invalid-token");
  return value as SyncDeviceToken;
}

function readSecretEnvelope(
  value: unknown,
  expectedKey: string,
): SyncDeviceToken | null {
  let input: Record<string, unknown> | undefined;
  try {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SECRET_RECORD_BYTES) return null;
    input = fields(
      JSON.parse(value),
      ["format", "key", "token"],
      "secret-store-corrupt-record",
    );
  } catch {
    return null;
  }
  if (
    !input ||
    input.format !== KEY_PREFIX ||
    input.key !== expectedKey
  )
    return null;
  try {
    return parseSyncDeviceToken(input.token);
  } catch {
    return null;
  }
}

const SECRET_RECORD_KEY = new RegExp(`^${KEY_PREFIX}:[0-9a-f]{64}$`);

/** True only for the exact key shape produced by `syncSecretKey`. */
export function isSyncSecretKey(value: unknown): value is string {
  return typeof value === "string" && SECRET_RECORD_KEY.test(value);
}

/** The key is a domain-separated hash, so it contains no URL, identity, or token. */
export function syncSecretKey(scope: SyncSecretScope): string {
  const normalized = parseSyncSecretScope(scope);
  const material = JSON.stringify([
    KEY_PREFIX,
    normalized.baseUrl,
    normalized.workspaceId,
    normalized.clientId,
    normalized.bindingId,
    normalized.serverEpoch,
  ]);
  return `${KEY_PREFIX}:${createHash("sha256").update(material).digest("hex")}`;
}

/**
 * Fail-closed store for one secret kind: the sync device token. Encryption is
 * mandatory on every read/write, backend failures are replaced with fixed
 * codes, and ciphertext is round-tripped before persistence.
 */
export class SyncSecretStore {
  constructor(
    private readonly safeStorage: SafeStoragePort,
    private readonly persistence: SecretRecordPersistence,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async get(scope: SyncSecretScope): Promise<SyncDeviceToken | undefined> {
    const key = syncSecretKey(scope);
    this.assertEncryption();
    let record: Uint8Array | null | undefined = undefined;
    try {
      record = await this.persistence.read(key);
    } catch {
      fail("secret-store-persistence-failed");
    }
    if (record === undefined || record === null) return undefined;
    if (
      !(record instanceof Uint8Array) ||
      record.byteLength === 0 ||
      record.byteLength > MAX_SECRET_RECORD_BYTES
    )
      fail("secret-store-corrupt-record");
    let plaintext: unknown = undefined;
    try {
      plaintext = this.safeStorage.decryptString(Buffer.from(record));
    } catch {
      fail("secret-store-decrypt-failed");
    }
    const token = readSecretEnvelope(plaintext, key);
    if (token === null) fail("secret-store-corrupt-record");
    return token;
  }

  async set(scope: SyncSecretScope, token: SyncDeviceToken): Promise<void> {
    const key = syncSecretKey(scope);
    const plaintext = parseSyncDeviceToken(token);
    this.assertEncryption();
    const envelope = JSON.stringify({
      format: KEY_PREFIX,
      key,
      token: plaintext,
    });
    let encrypted: unknown = undefined;
    try {
      encrypted = this.safeStorage.encryptString(envelope);
    } catch {
      fail("secret-store-encrypt-failed");
    }
    if (
      !(encrypted instanceof Uint8Array) ||
      encrypted.byteLength === 0 ||
      encrypted.byteLength > MAX_SECRET_RECORD_BYTES
    )
      fail("secret-store-encrypt-failed");
    let roundTrip: unknown = undefined;
    try {
      roundTrip = this.safeStorage.decryptString(Buffer.from(encrypted));
    } catch {
      fail("secret-store-encrypt-failed");
    }
    if (readSecretEnvelope(roundTrip, key) !== plaintext)
      fail("secret-store-encrypt-failed");
    try {
      await this.persistence.write(key, Buffer.from(encrypted));
    } catch {
      fail("secret-store-persistence-failed");
    }
  }

  async delete(scope: SyncSecretScope): Promise<void> {
    const key = syncSecretKey(scope);
    try {
      await this.persistence.delete(key);
    } catch {
      fail("secret-store-persistence-failed");
    }
  }

  private assertEncryption(): void {
    let available: unknown = undefined;
    try {
      available = this.safeStorage.isEncryptionAvailable();
    } catch {
      fail("secret-store-unavailable");
    }
    if (available !== true) fail("secret-store-unavailable");
    let backend: SafeStoragePort["getSelectedStorageBackend"];
    try { backend = this.safeStorage.getSelectedStorageBackend; }
    catch { fail("secret-store-unavailable"); }
    if (typeof backend !== "function") {
      if (this.platform === "linux") fail("secret-store-unavailable");
      return;
    }
    let selected: unknown = undefined;
    try {
      selected = backend.call(this.safeStorage);
    } catch {
      fail("secret-store-unavailable");
    }
    if (selected === undefined && this.platform === "linux") fail("secret-store-unavailable");
    if (
      selected !== undefined &&
      (typeof selected !== "string" ||
        !SECURE_LINUX_BACKENDS.has(selected))
    )
      fail("secret-store-insecure-backend");
  }
}
