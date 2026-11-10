import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { asciiCaseFold, validateWindowsPath } from "../platform/windows/path-policy";
import { createHash } from "node:crypto";
import { PrivateLedger } from "./private-ledger";
import type { PrivatePlatform } from "./private-platform";
import { requireCondition, SyncError } from "./protocol";
import {
  MAX_SECRET_RECORD_BYTES,
  isSyncSecretKey,
  type SecretRecordPersistence,
} from "./secret-store";
import { SecretRecordFilePersistence } from "./secret-record-file";

const LEDGER_NAME = "secrets.sqlite";
const LEDGER_ROLE = "secrets";
const VALUE_PREFIX = "folio-secret-record-ledger/v1:";

export type SecretRecordLedgerOptions = Readonly<{
  directory: string;
  forbiddenRoots?: readonly string[];
  platform?: NodeJS.Platform;
  privatePlatformFactory?: (
    directory: string,
    name: string,
  ) => PrivatePlatform;
}>;

function invalid(code: string, status = 409): never {
  throw new SyncError(code, status);
}

function copyCiphertext(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) invalid("secret-record-ledger-invalid-record");
  if (value.byteLength === 0) invalid("secret-record-ledger-invalid-record");
  if (value.byteLength > MAX_SECRET_RECORD_BYTES)
    invalid("secret-record-ledger-too-large", 413);
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function encodeCiphertext(value: unknown): string {
  const copy = copyCiphertext(value);
  return VALUE_PREFIX + Buffer.from(copy).toString("base64");
}

function decodeCiphertext(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.startsWith(VALUE_PREFIX))
    invalid("secret-record-ledger-invalid-record");
  const encoded = value.slice(VALUE_PREFIX.length);
  const bytes = Buffer.from(encoded, "base64");
  requireCondition(
    bytes.byteLength > 0 &&
      bytes.byteLength <= MAX_SECRET_RECORD_BYTES &&
      bytes.toString("base64") === encoded,
    "secret-record-ledger-invalid-record",
    409,
  );
  return new Uint8Array(bytes);
}

function checkKey(value: unknown): string {
  if (!isSyncSecretKey(value)) invalid("secret-record-ledger-invalid-key");
  return value;
}

function ledgerKey(key: string): string {
  return "secret:" + createHash("sha256").update(key, "utf8").digest("hex");
}

export class SecretRecordLedgerPersistence implements SecretRecordPersistence {
  private readonly options: SecretRecordLedgerOptions;

  constructor(options: SecretRecordLedgerOptions) {
    if (typeof options !== "object" || options === null || Array.isArray(options))
      invalid("secret-record-ledger-invalid-options");
    requireCondition(
      typeof options.directory === "string" && options.directory.length > 0,
      "secret-record-ledger-invalid-options",
      409,
    );
    this.options = options;
  }

  private assertLocation(): void {
    if ((this.options.platform ?? process.platform) !== "win32") return;
    const canonical = (path: string): string => {
      if (/^[A-Za-z]:[\\/]/.test(path)) return asciiCaseFold(validateWindowsPath(path, `${path[0].toUpperCase()}:\\`).canonical);
      requireCondition(process.platform !== "win32", "secret-record-ledger-unsafe-location", 409);
      return realpathSync(resolve(path));
    };
    const directory = canonical(this.options.directory);
    for (const raw of this.options.forbiddenRoots ?? []) {
      const root = canonical(raw), separator = /^[a-z]:\\/.test(directory) ? "\\" : "/";
      const contains = (parent: string, child: string) => parent === child || child.startsWith(parent.endsWith(separator) ? parent : parent + separator);
      requireCondition(!contains(directory, root) && !contains(root, directory), "secret-record-ledger-unsafe-location", 409);
    }
  }
  private open(): PrivateLedger {
    this.assertLocation();
    const factory = this.options.privatePlatformFactory;
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32" && typeof factory !== "function")
      invalid("secret-record-ledger-platform-required", 503);
    const privatePlatform = factory?.(this.options.directory, LEDGER_NAME);
    return new PrivateLedger(
      this.options.directory,
      LEDGER_NAME,
      LEDGER_ROLE,
      this.options.forbiddenRoots ?? [],
      privatePlatform,
    );
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    const recordKey = ledgerKey(checkKey(key));
    const db = this.open();
    try {
      const value = db.read(recordKey);
      return value === null ? undefined : decodeCiphertext(value);
    } finally {
      db.close();
    }
  }

  async write(key: string, value: Uint8Array): Promise<void> {
    const recordKey = ledgerKey(checkKey(key));
    const encoded = encodeCiphertext(value);
    const db = this.open();
    let callbackCompleted = false;
    let failure: unknown;
    try {
      db.transaction(() => {
        const existing = db.read(recordKey);
        if (existing !== null)
          requireCondition(
            existing === encoded,
            "secret-record-ledger-conflict",
            409,
          );
        else db.write(recordKey, encoded);
        callbackCompleted = true;
      });
    } catch (error) {
      failure = callbackCompleted ? new SyncError("secret-record-ledger-outcome-unknown",503) : error;
      throw failure;
    } finally {
      try { db.close(); }
      catch (error) {
        if (failure !== undefined) throw failure;
        if (callbackCompleted) invalid("secret-record-ledger-outcome-unknown", 503);
        throw error;
      }
    }
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    invalid("secret-record-ledger-delete-unsupported");
  }
}

export type SecretRecordPersistenceSelection = Readonly<{
  directory: string;
  forbiddenRoots: readonly string[];
  platform?: NodeJS.Platform;
  privatePlatformFactory?: (
    directory: string,
    name: string,
  ) => PrivatePlatform;
}>;

export function createSecretRecordPersistence(
  options: SecretRecordPersistenceSelection,
): SecretRecordPersistence {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    requireCondition(
      typeof options.privatePlatformFactory === "function",
      "secret-record-ledger-platform-required",
      503,
    );
    return new SecretRecordLedgerPersistence({
      directory: options.directory,
      forbiddenRoots: options.forbiddenRoots,
      platform,
      privatePlatformFactory: options.privatePlatformFactory,
    });
  }
  return new SecretRecordFilePersistence({
    directory: options.directory,
    forbiddenRoots: options.forbiddenRoots,
  });
}
