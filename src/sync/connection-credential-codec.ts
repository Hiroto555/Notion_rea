import { SyncError } from "./protocol";
import {
  assertSecureStorageBackend,
  parseSyncDeviceToken,
  type SafeStoragePort,
} from "./secret-store";

const FORMAT = "folio-connection-secret/v1";
const MAX_CIPHERTEXT_BYTES = 16 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_KEYS = [
  "format",
  "profileKey",
  "nonce",
  "targetHash",
  "token",
] as const;

export type CredentialEnvelopeContext = {
  profileKey: string;
  nonce: string;
  targetHash: string;
};

function invalid(): never {
  throw new SyncError("connection-secret-invalid");
}

function encryptFailed(): never {
  throw new SyncError("connection-secret-encrypt-failed");
}

function decryptFailed(): never {
  throw new SyncError("connection-secret-decrypt-failed");
}

function readContext(value: unknown): CredentialEnvelopeContext {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      invalid();
    const input = value as Record<string, unknown>;
    const { profileKey, nonce, targetHash } = input;
    if (
      typeof profileKey !== "string" ||
      !HASH.test(profileKey) ||
      typeof nonce !== "string" ||
      !UUID.test(nonce) ||
      typeof targetHash !== "string" ||
      !HASH.test(targetHash)
    )
      invalid();
    return Object.freeze({ profileKey, nonce, targetHash });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    invalid();
  }
}

function readToken(value: unknown): string {
  try {
    return parseSyncDeviceToken(value);
  } catch {
    invalid();
  }
}

function decodeCiphertext(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) invalid();
  let buffer: Buffer;
  try {
    buffer = Buffer.from(value, "base64");
  } catch {
    invalid();
  }
  if (
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_CIPHERTEXT_BYTES ||
    buffer.toString("base64") !== value
  )
    invalid();
  return buffer;
}

function readEnvelope(
  value: unknown,
  context: CredentialEnvelopeContext,
): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > 16 * 1024) return null;
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(value);
  } catch {
    return null;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== ENVELOPE_KEYS.length ||
    !ENVELOPE_KEYS.every((key) => keys.includes(key))
  )
    return null;
  for (const key of ENVELOPE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return null;
  }
  if (
    input.format !== FORMAT ||
    input.profileKey !== context.profileKey ||
    input.nonce !== context.nonce ||
    input.targetHash !== context.targetHash
  )
    return null;
  try {
    return parseSyncDeviceToken(input.token);
  } catch {
    return null;
  }
}

export function sealConnectionToken(
  port: SafeStoragePort,
  platform: NodeJS.Platform,
  context: CredentialEnvelopeContext,
  token: string,
): string {
  const scope = readContext(context);
  const secret = readToken(token);
  assertSecureStorageBackend(port, platform);
  const envelope = JSON.stringify({
    format: FORMAT,
    profileKey: scope.profileKey,
    nonce: scope.nonce,
    targetHash: scope.targetHash,
    token: secret,
  });
  let encrypted: unknown;
  try {
    encrypted = port.encryptString(envelope);
  } catch {
    encryptFailed();
  }
  if (
    !(encrypted instanceof Uint8Array) ||
    encrypted.byteLength === 0 ||
    encrypted.byteLength > MAX_CIPHERTEXT_BYTES
  )
    encryptFailed();
  const ciphertext = Buffer.from(encrypted);
  let roundTrip: unknown;
  try {
    roundTrip = port.decryptString(Buffer.from(ciphertext));
  } catch {
    encryptFailed();
  }
  if (readEnvelope(roundTrip, scope) !== secret) encryptFailed();
  return ciphertext.toString("base64");
}

export function openConnectionToken(
  port: SafeStoragePort,
  platform: NodeJS.Platform,
  context: CredentialEnvelopeContext,
  ciphertext: string,
): string {
  const scope = readContext(context);
  const encrypted = decodeCiphertext(ciphertext);
  assertSecureStorageBackend(port, platform);
  let plaintext: unknown;
  try {
    plaintext = port.decryptString(encrypted);
  } catch {
    decryptFailed();
  }
  const token = readEnvelope(plaintext, scope);
  if (token === null) invalid();
  return token;
}
