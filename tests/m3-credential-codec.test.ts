import { createCipheriv, createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  openConnectionToken,
  sealConnectionToken,
  type CredentialEnvelopeContext,
} from "../src/sync/connection-credential-codec";
import type { SafeStoragePort } from "../src/sync/secret-store";

const KEY = Buffer.alloc(32, 0x2a);
const IV = Buffer.alloc(12, 0x11);
const TOKEN = "A".repeat(43);
const CONTEXT: CredentialEnvelopeContext = {
  profileKey: "a".repeat(64),
  nonce: "123e4567-e89b-42d3-a456-426614174000",
  targetHash: "b".repeat(64),
};

function aesPort(overrides: Partial<SafeStoragePort> = {}): SafeStoragePort {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plainText) {
      const cipher = createCipheriv("aes-256-gcm", KEY, IV);
      const body = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([IV, cipher.getAuthTag(), body]);
    },
    decryptString(encrypted) {
      if (encrypted.byteLength < 28) throw new Error("bad ciphertext");
      const tag = encrypted.subarray(12, 28);
      const decipher = createDecipheriv("aes-256-gcm", KEY, encrypted.subarray(0, 12));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...overrides,
  };
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  }
  return undefined;
}

function plaintextBase64(port: SafeStoragePort, value: unknown): string {
  return port.encryptString(JSON.stringify(value)).toString("base64");
}

function envelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "folio-connection-secret/v1",
    ...CONTEXT,
    token: TOKEN,
    ...extra,
  };
}

describe("connection credential codec", () => {
  it("round-trips and returns only canonical base64 ciphertext", () => {
    const port = aesPort();
    const sealed = sealConnectionToken(port, "darwin", CONTEXT, TOKEN);
    expect(openConnectionToken(port, "darwin", CONTEXT, sealed)).toBe(TOKEN);
    expect(sealed).toBe(Buffer.from(sealed, "base64").toString("base64"));
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain("folio-connection-secret/v1");
  });

  it("rejects a swapped context scope", () => {
    const port = aesPort();
    const sealed = sealConnectionToken(port, "darwin", CONTEXT, TOKEN);
    for (const changed of [
      { ...CONTEXT, profileKey: "c".repeat(64) },
      { ...CONTEXT, nonce: "123e4567-e89b-42d3-a456-426614174001" },
      { ...CONTEXT, targetHash: "d".repeat(64) },
    ]) {
      expect(errorCode(() => openConnectionToken(port, "darwin", changed, sealed))).toBe(
        "connection-secret-invalid",
      );
    }
  });

  it("rejects tampered ciphertext as a decrypt failure", () => {
    const port = aesPort();
    const sealed = sealConnectionToken(port, "darwin", CONTEXT, TOKEN);
    const tampered = Buffer.from(sealed, "base64");
    tampered[tampered.length - 1] ^= 0xff;
    expect(
      errorCode(() =>
        openConnectionToken(port, "darwin", CONTEXT, tampered.toString("base64")),
      ),
    ).toBe("connection-secret-decrypt-failed");
  });

  it("rejects non-canonical and invalid base64", () => {
    const port = aesPort();
    const sealed = sealConnectionToken(port, "darwin", CONTEXT, TOKEN);
    for (const value of [`${sealed}\n`, "not*base64", "%%%%", ""]) {
      expect(errorCode(() => openConnectionToken(port, "darwin", CONTEXT, value))).toBe(
        "connection-secret-invalid",
      );
    }
  });

  it("rejects oversized ciphertext", () => {
    const port = aesPort();
    const oversized = Buffer.alloc(16 * 1024 + 1).toString("base64");
    expect(errorCode(() => openConnectionToken(port, "darwin", CONTEXT, oversized))).toBe(
      "connection-secret-invalid",
    );
    const sealing = aesPort({ encryptString: () => Buffer.alloc(16 * 1024 + 1) });
    expect(errorCode(() => sealConnectionToken(sealing, "darwin", CONTEXT, TOKEN))).toBe(
      "connection-secret-encrypt-failed",
    );
  });

  it("rejects extra or missing envelope fields and format changes", () => {
    const port = aesPort();
    const cases = [
      plaintextBase64(port, envelope({ extra: true })),
      plaintextBase64(port, { ...envelope(), format: "folio-connection-secret/v2" }),
      plaintextBase64(port, { ...envelope(), token: "short" }),
      plaintextBase64(port, ["not", "an", "object"]),
    ];
    for (const ciphertext of cases) {
      expect(errorCode(() => openConnectionToken(port, "darwin", CONTEXT, ciphertext))).toBe(
        "connection-secret-invalid",
      );
    }
  });

  it("rejects invalid tokens and contexts", () => {
    const port = aesPort();
    expect(errorCode(() => sealConnectionToken(port, "darwin", CONTEXT, "short"))).toBe(
      "connection-secret-invalid",
    );
    const badContexts: unknown[] = [
      { ...CONTEXT, profileKey: "A".repeat(64) },
      { ...CONTEXT, profileKey: "a".repeat(63) },
      { ...CONTEXT, nonce: "not-a-uuid" },
      { ...CONTEXT, targetHash: "g".repeat(64) },
      null,
      [],
    ];
    for (const context of badContexts) {
      expect(
        errorCode(() =>
          sealConnectionToken(port, "darwin", context as CredentialEnvelopeContext, TOKEN),
        ),
      ).toBe("connection-secret-invalid");
    }
  });

  it("rejects plaintext and basic_text Linux backends", () => {
    expect(
      errorCode(() =>
        sealConnectionToken(
          aesPort({ getSelectedStorageBackend: () => "basic_text" }),
          "linux",
          CONTEXT,
          TOKEN,
        ),
      ),
    ).toBe("secret-store-insecure-backend");
    expect(
      errorCode(() =>
        sealConnectionToken(
          aesPort({ getSelectedStorageBackend: undefined }),
          "linux",
          CONTEXT,
          TOKEN,
        ),
      ),
    ).toBe("secret-store-unavailable");
  });

  it("preserves SecretStoreError when the backend throws or is unavailable", () => {
    const throwing = aesPort({
      isEncryptionAvailable: () => {
        throw new Error("backend exploded");
      },
    });
    expect(errorCode(() => sealConnectionToken(throwing, "darwin", CONTEXT, TOKEN))).toBe(
      "secret-store-unavailable",
    );
    const unavailable = aesPort({ isEncryptionAvailable: () => false });
    expect(errorCode(() => sealConnectionToken(unavailable, "darwin", CONTEXT, TOKEN))).toBe(
      "secret-store-unavailable",
    );
    expect(errorCode(() => openConnectionToken(unavailable, "darwin", CONTEXT, "AAAA"))).toBe(
      "secret-store-unavailable",
    );
  });

  it("reports encryption and decryption failures with fixed codes", () => {
    const encryptThrows = aesPort({
      encryptString: () => {
        throw new Error("no entropy");
      },
    });
    expect(errorCode(() => sealConnectionToken(encryptThrows, "darwin", CONTEXT, TOKEN))).toBe(
      "connection-secret-encrypt-failed",
    );

    const roundTripMismatch = aesPort({
      decryptString: () =>
        JSON.stringify({ ...envelope(), token: "B".repeat(43) }),
    });
    expect(
      errorCode(() => sealConnectionToken(roundTripMismatch, "darwin", CONTEXT, TOKEN)),
    ).toBe("connection-secret-encrypt-failed");

    const decryptThrows = aesPort({
      decryptString: () => {
        throw new Error("bad tag");
      },
    });
    const sealed = sealConnectionToken(aesPort(), "darwin", CONTEXT, TOKEN);
    expect(errorCode(() => openConnectionToken(decryptThrows, "darwin", CONTEXT, sealed))).toBe(
      "connection-secret-decrypt-failed",
    );
  });
});
