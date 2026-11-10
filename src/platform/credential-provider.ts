import { canonical } from "../collaboration/runtime/canonical";
import { wellFormed } from "../collaboration/runtime/contract";
import type { SafeStoragePort } from "../sync/secret-store";

export type LegacySafeStoragePort = SafeStoragePort;

export interface AsyncSafeStoragePort {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(text: string): Promise<Uint8Array>;
  decryptStringAsync(bytes: Uint8Array): Promise<string>;
  getSelectedStorageBackend?():
    string | undefined | Promise<string | undefined>;
}

export type CredentialStoragePort =
  AsyncSafeStoragePort | LegacySafeStoragePort;

export type CredentialScope = Readonly<{
  serverId: string;
  orgId: string;
  deviceId: string;
}>;

export type CredentialErrorCode =
  | "credential-invalid-scope"
  | "credential-invalid-secret"
  | "credential-unavailable"
  | "credential-insecure-backend"
  | "credential-encrypt-failed"
  | "credential-decrypt-failed"
  | "credential-corrupt-record"
  | "credential-version-unsupported"
  | "credential-scope-mismatch"
  | "credential-platform-unsupported";

export class CredentialError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(code);
    this.name = "CredentialError";
  }
}

type SupportedPlatform = "darwin" | "win32" | "linux";
type CredentialProtection =
  | "macos-keychain-app-identity"
  | "windows-dpapi-os-user"
  | "linux-secret-service";

export type CredentialDescription = Readonly<{
  platform: SupportedPlatform;
  protection: CredentialProtection;
  verified: false;
}>;

const MAX_SCOPE_LENGTH = 128;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_ENVELOPE_BYTES = 32 * 1024;
const MAX_CIPHERTEXT_BYTES = 16 * 1024;
const ENVELOPE_FORMAT = "folio-credential-envelope/v1";
const ENVELOPE_KEYS = ["format", "scopeHash", "secret"] as const;
const SCOPE_KEYS = ["serverId", "orgId", "deviceId"] as const;

const SECURE_LINUX_BACKENDS = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);
const PLATFORM_BACKENDS: Readonly<
  Record<SupportedPlatform, ReadonlySet<string>>
> = {
  darwin: new Set(["keychain", "keychain_access"]),
  win32: new Set(["dpapi"]),
  linux: SECURE_LINUX_BACKENDS,
};
const PROTECTIONS: Readonly<Record<SupportedPlatform, CredentialProtection>> = {
  darwin: "macos-keychain-app-identity",
  win32: "windows-dpapi-os-user",
  linux: "linux-secret-service",
};

function fail(code: CredentialErrorCode): never {
  throw new CredentialError(code);
}

function assertPlatform(platform: string): SupportedPlatform {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux")
    fail("credential-platform-unsupported");
  return platform;
}

function readData(
  value: unknown,
  keys: readonly string[],
  code: CredentialErrorCode,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const input = value as Record<string, unknown>;
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key)))
    fail(code);
  const detached: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail(code);
    detached[key] = descriptor.value;
  }
  return detached;
}

function readScope(value: unknown): CredentialScope {
  const input = readData(value, SCOPE_KEYS, "credential-invalid-scope");
  const scope: Record<string, string> = {};
  for (const key of SCOPE_KEYS) {
    const field = input[key];
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > MAX_SCOPE_LENGTH ||
      !wellFormed(field)
    )
      fail("credential-invalid-scope");
    scope[key] = field;
  }
  return Object.freeze({
    serverId: scope.serverId,
    orgId: scope.orgId,
    deviceId: scope.deviceId,
  });
}

function validSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SECRET_BYTES &&
    wellFormed(value) &&
    new TextEncoder().encode(value).byteLength <= MAX_SECRET_BYTES
  );
}

function readSecret(value: unknown): string {
  if (!validSecret(value)) fail("credential-invalid-secret");
  return value;
}

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

async function scopeHash(scope: CredentialScope): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail("credential-unavailable");
  const input = new TextEncoder().encode(
    canonical({
      serverId: scope.serverId,
      orgId: scope.orgId,
      deviceId: scope.deviceId,
    }),
  );
  try {
    const result = await subtle.digest("SHA-256", input);
    return toHex(new Uint8Array(result));
  } catch {
    fail("credential-unavailable");
  }
}

async function envelopeFor(
  scope: CredentialScope,
  secret: string,
): Promise<string> {
  return canonical(
    {
      format: ENVELOPE_FORMAT,
      scopeHash: await scopeHash(scope),
      secret,
    },
    MAX_ENVELOPE_BYTES,
  );
}

function readEnvelope(plaintext: string, expectedScopeHash: string): string {
  if (
    !wellFormed(plaintext) ||
    new TextEncoder().encode(plaintext).byteLength > MAX_ENVELOPE_BYTES
  )
    fail("credential-corrupt-record");
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    fail("credential-corrupt-record");
  }
  const input = readData(parsed, ENVELOPE_KEYS, "credential-corrupt-record");
  let reencoded: string;
  try {
    reencoded = canonical(parsed, MAX_ENVELOPE_BYTES);
  } catch {
    fail("credential-corrupt-record");
  }
  if (reencoded !== plaintext) fail("credential-corrupt-record");
  if (typeof input.format !== "string") fail("credential-corrupt-record");
  if (input.format !== ENVELOPE_FORMAT) fail("credential-version-unsupported");
  if (typeof input.scopeHash !== "string") fail("credential-corrupt-record");
  if (input.scopeHash !== expectedScopeHash) fail("credential-scope-mismatch");
  if (!validSecret(input.secret)) fail("credential-corrupt-record");
  return input.secret;
}

function copyCiphertext(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_CIPHERTEXT_BYTES
  )
    fail("credential-corrupt-record");
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function copyEncrypted(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_CIPHERTEXT_BYTES
  )
    fail("credential-encrypt-failed");
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function backendProbe(
  port: AsyncSafeStoragePort | LegacySafeStoragePort,
): (() => unknown) | undefined {
  const candidate = (port as { getSelectedStorageBackend?: unknown })
    .getSelectedStorageBackend;
  return typeof candidate === "function"
    ? (candidate as () => unknown)
    : undefined;
}

function checkBackend(
  selected: unknown,
  platform: SupportedPlatform,
  required: boolean,
): void {
  if (selected === undefined) {
    if (required) fail("credential-unavailable");
    return;
  }
  if (
    typeof selected !== "string" ||
    !PLATFORM_BACKENDS[platform].has(selected)
  )
    fail("credential-insecure-backend");
}

async function asyncAvailable(
  port: AsyncSafeStoragePort,
  platform: SupportedPlatform,
): Promise<boolean> {
  let available: unknown;
  try {
    available = await port.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
  if (available !== true) return false;
  const probe = backendProbe(port);
  if (probe) {
    let selected: unknown;
    try {
      selected = await probe.call(port);
    } catch {
      fail("credential-unavailable");
    }
    checkBackend(selected, platform, platform === "linux");
  }
  return true;
}

async function legacyAvailable(
  port: LegacySafeStoragePort,
  platform: SupportedPlatform,
): Promise<boolean> {
  let available: unknown;
  try {
    available = port.isEncryptionAvailable();
  } catch {
    return false;
  }
  if (available !== true) return false;
  const probe = backendProbe(port);
  if (!probe) return platform !== "linux";
  let selected: unknown;
  try {
    selected = await probe.call(port);
  } catch {
    return false;
  }
  checkBackend(selected, platform, platform === "linux");
  return true;
}

function openLegacy(
  port: LegacySafeStoragePort,
  ciphertext: Uint8Array,
  expectedScopeHash: string,
): string {
  let plaintext: unknown;
  try {
    plaintext = port.decryptString(Buffer.from(ciphertext));
  } catch {
    fail("credential-decrypt-failed");
  }
  if (typeof plaintext !== "string") fail("credential-decrypt-failed");
  return readEnvelope(plaintext, expectedScopeHash);
}

function detectAsync(port: CredentialStoragePort): AsyncSafeStoragePort | null {
  const candidate = port as Partial<AsyncSafeStoragePort>;
  return typeof candidate.isAsyncEncryptionAvailable === "function" &&
    typeof candidate.encryptStringAsync === "function" &&
    typeof candidate.decryptStringAsync === "function"
    ? (candidate as AsyncSafeStoragePort)
    : null;
}

function detectLegacy(
  port: CredentialStoragePort,
): LegacySafeStoragePort | null {
  const candidate = port as Partial<LegacySafeStoragePort>;
  return typeof candidate.isEncryptionAvailable === "function" &&
    typeof candidate.encryptString === "function" &&
    typeof candidate.decryptString === "function"
    ? (candidate as LegacySafeStoragePort)
    : null;
}

export class CredentialProvider {
  private readonly asyncPort: AsyncSafeStoragePort | null;
  private readonly legacyPort: LegacySafeStoragePort | null;

  constructor(
    port: CredentialStoragePort,
    private readonly platform: NodeJS.Platform,
  ) {
    this.asyncPort = detectAsync(port);
    this.legacyPort = detectLegacy(port);
  }

  async seal(scope: CredentialScope, secret: string): Promise<Uint8Array> {
    const platform = assertPlatform(this.platform);
    const normalizedScope = readScope(scope);
    const plaintextSecret = readSecret(secret);
    const asyncPort = this.asyncPort;
    if (!asyncPort) fail("credential-unavailable");
    const available = await asyncAvailable(asyncPort, platform);
    if (!available) fail("credential-unavailable");
    const plaintext = await envelopeFor(normalizedScope, plaintextSecret);
    let encrypted: unknown;
    try {
      encrypted = await asyncPort.encryptStringAsync(plaintext);
    } catch {
      fail("credential-encrypt-failed");
    }
    const ciphertext = copyEncrypted(encrypted);
    let roundTrip: unknown;
    try {
      roundTrip = await asyncPort.decryptStringAsync(
        new Uint8Array(ciphertext),
      );
    } catch {
      fail("credential-encrypt-failed");
    }
    if (typeof roundTrip !== "string") fail("credential-encrypt-failed");
    let verified: string;
    try {
      verified = readEnvelope(roundTrip, await scopeHash(normalizedScope));
    } catch {
      fail("credential-encrypt-failed");
    }
    if (verified !== plaintextSecret) fail("credential-encrypt-failed");
    return ciphertext;
  }

  async open(scope: CredentialScope, bytes: Uint8Array): Promise<string> {
    const platform = assertPlatform(this.platform);
    const normalizedScope = readScope(scope);
    const expectedScopeHash = await scopeHash(normalizedScope);
    const ciphertext = copyCiphertext(bytes);
    const asyncPort = this.asyncPort;
    const legacyPort = this.legacyPort;

    if (asyncPort && (await asyncAvailable(asyncPort, platform))) {
      let plaintext: unknown;
      let failed = false;
      try {
        plaintext = await asyncPort.decryptStringAsync(
          new Uint8Array(ciphertext),
        );
      } catch {
        failed = true;
      }
      if (!failed) {
        if (typeof plaintext !== "string") fail("credential-decrypt-failed");
        return readEnvelope(plaintext, expectedScopeHash);
      }
      if (legacyPort && (await legacyAvailable(legacyPort, platform)))
        return openLegacy(legacyPort, ciphertext, expectedScopeHash);
      fail("credential-decrypt-failed");
    }

    if (legacyPort && (await legacyAvailable(legacyPort, platform)))
      return openLegacy(legacyPort, ciphertext, expectedScopeHash);

    fail("credential-unavailable");
  }

  describe(): CredentialDescription {
    const platform = assertPlatform(this.platform);
    return {
      platform,
      protection: PROTECTIONS[platform],
      verified: false,
    };
  }
}
