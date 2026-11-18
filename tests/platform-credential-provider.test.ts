import { describe, expect, it } from "vitest";
import {
  CredentialError,
  CredentialProvider,
  type AsyncSafeStoragePort,
  type CredentialScope,
  type LegacySafeStoragePort,
} from "../src/platform/credential-provider";

type AsyncOptions = {
  available?: boolean;
  backend?: string;
  withBackend?: boolean;
  failEncrypt?: boolean;
  failDecrypt?: boolean;
  mutateInput?: boolean;
};

type TestAsyncPort = AsyncSafeStoragePort & {
  readonly encrypts: number;
  readonly decrypts: number;
};

function asyncPort(options: AsyncOptions = {}): TestAsyncPort {
  let encrypts = 0;
  let decrypts = 0;
  const port: TestAsyncPort = {
    get encrypts() {
      return encrypts;
    },
    get decrypts() {
      return decrypts;
    },
    async isAsyncEncryptionAvailable() {
      return options.available !== false;
    },
    async encryptStringAsync(text: string) {
      encrypts += 1;
      if (options.failEncrypt) throw new Error("synthetic encrypt failure");
      return new Uint8Array(
        Buffer.from(`A${Buffer.from(text, "utf8").toString("base64")}`, "utf8"),
      );
    },
    async decryptStringAsync(bytes: Uint8Array) {
      decrypts += 1;
      if (options.failDecrypt) throw new Error("synthetic decrypt failure");
      const wrapped = Buffer.from(bytes).toString("utf8");
      if (!wrapped.startsWith("A")) throw new Error("synthetic bad ciphertext");
      const plaintext = Buffer.from(wrapped.slice(1), "base64").toString(
        "utf8",
      );
      if (options.mutateInput) bytes.fill(0);
      return plaintext;
    },
  };
  if (options.withBackend)
    port.getSelectedStorageBackend = () => options.backend;
  return port;
}

type LegacyOptions = {
  available?: boolean;
  backend?: string;
  withBackend?: boolean;
  failEncrypt?: boolean;
  failDecrypt?: boolean;
};

type TestLegacyPort = LegacySafeStoragePort & {
  readonly encrypts: number;
  readonly decrypts: number;
};

function legacyPort(options: LegacyOptions = {}): TestLegacyPort {
  let encrypts = 0;
  let decrypts = 0;
  const port: TestLegacyPort = {
    get encrypts() {
      return encrypts;
    },
    get decrypts() {
      return decrypts;
    },
    isEncryptionAvailable() {
      return options.available !== false;
    },
    encryptString(text: string) {
      encrypts += 1;
      if (options.failEncrypt)
        throw new Error("synthetic legacy encrypt failure");
      return Buffer.from(
        `L${Buffer.from(text, "utf8").toString("base64")}`,
        "utf8",
      );
    },
    decryptString(bytes: Buffer) {
      decrypts += 1;
      if (options.failDecrypt)
        throw new Error("synthetic legacy decrypt failure");
      const wrapped = Buffer.from(bytes).toString("utf8");
      if (!wrapped.startsWith("L")) throw new Error("synthetic bad ciphertext");
      return Buffer.from(wrapped.slice(1), "base64").toString("utf8");
    },
  };
  if (options.withBackend)
    port.getSelectedStorageBackend = () => options.backend;
  return port;
}

const scopeA: CredentialScope = Object.freeze({
  serverId: "server-1",
  orgId: "org-1",
  deviceId: "device-1",
});

const scopeB: CredentialScope = Object.freeze({
  serverId: "server-1",
  orgId: "org-1",
  deviceId: "device-2",
});

async function legacyRecord(
  secret: string,
  scope: CredentialScope,
  platform: "darwin" | "win32" | "linux" = "darwin",
): Promise<{ legacy: TestLegacyPort; ciphertext: Buffer }> {
  const asyncBackend =
    platform === "darwin"
      ? "keychain"
      : platform === "win32"
        ? "dpapi"
        : "gnome_libsecret";
  const asyncStorage = asyncPort({
    withBackend: true,
    backend: asyncBackend,
  });
  const provider = new CredentialProvider(asyncStorage, platform);
  const sealed = await provider.seal(scope, secret);
  const plaintext = await asyncStorage.decryptStringAsync(sealed);
  const legacy = legacyPort({ withBackend: true, backend: asyncBackend });
  return { legacy, ciphertext: legacy.encryptString(plaintext) };
}

async function reencrypt(
  port: TestAsyncPort,
  ciphertext: Uint8Array,
  change: (envelope: Record<string, unknown>) => void,
): Promise<Uint8Array> {
  const plaintext = await port.decryptStringAsync(ciphertext);
  const envelope = JSON.parse(plaintext) as Record<string, unknown>;
  change(envelope);
  return port.encryptStringAsync(JSON.stringify(envelope));
}

describe("CredentialProvider description", () => {
  it("reports fixed platform protection and never claims verification", () => {
    expect(new CredentialProvider(asyncPort(), "darwin").describe()).toEqual({
      platform: "darwin",
      protection: "macos-keychain-app-identity",
      verified: false,
    });
    expect(new CredentialProvider(asyncPort(), "win32").describe()).toEqual({
      platform: "win32",
      protection: "windows-dpapi-os-user",
      verified: false,
    });
    expect(new CredentialProvider(asyncPort(), "linux").describe()).toEqual({
      platform: "linux",
      protection: "linux-secret-service",
      verified: false,
    });
  });

  it("rejects unknown platforms", async () => {
    const provider = new CredentialProvider(asyncPort(), "aix");
    await expect(provider.seal(scopeA, "secret")).rejects.toMatchObject({
      code: "credential-platform-unsupported",
    });
    await expect(
      provider.open(scopeA, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "credential-platform-unsupported" });
    expect(() => provider.describe()).toThrow(CredentialError);
  });
});

describe("async seal and open", () => {
  it("round-trips a scoped secret and returns fresh ciphertext bytes", async () => {
    const port = asyncPort({ withBackend: true, backend: "keychain" });
    const provider = new CredentialProvider(port, "darwin");
    const sealed = await provider.seal(scopeA, "top-secret-value");
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(sealed.byteLength).toBeGreaterThan(0);
    expect(await provider.open(scopeA, sealed)).toBe("top-secret-value");
    expect(port.encrypts).toBe(1);
    expect(port.decrypts).toBe(2);
  });

  it("connects the envelope to the exact scope", async () => {
    const port = asyncPort({ withBackend: true, backend: "keychain" });
    const provider = new CredentialProvider(port, "darwin");
    const sealed = await provider.seal(scopeA, "scoped-secret");
    const snapshot = new Uint8Array(sealed);
    await expect(provider.open(scopeB, sealed)).rejects.toMatchObject({
      code: "credential-scope-mismatch",
    });
    expect(sealed).toEqual(snapshot);
  });

  it("prefers async APIs when a hybrid port exposes both generations", async () => {
    const asyncStorage = asyncPort({ withBackend: true, backend: "keychain" });
    const legacyStorage = legacyPort({
      withBackend: true,
      backend: "keychain",
    });
    const provider = new CredentialProvider(
      { ...asyncStorage, ...legacyStorage },
      "darwin",
    );
    const sealed = await provider.seal(scopeA, "hybrid-secret");
    expect(await provider.open(scopeA, sealed)).toBe("hybrid-secret");
    expect(asyncStorage.encrypts).toBe(1);
    expect(asyncStorage.decrypts).toBe(2);
    expect(legacyStorage.encrypts).toBe(0);
    expect(legacyStorage.decrypts).toBe(0);
  });

  it("rejects a non-canonical or malformed envelope", async () => {
    const port = asyncPort({ withBackend: true, backend: "keychain" });
    const provider = new CredentialProvider(port, "darwin");
    const sealed = await provider.seal(scopeA, "canonical-secret");
    const pretty = await reencrypt(port, sealed, () => undefined);
    const plaintext = await port.decryptStringAsync(pretty);
    const spaced = await port.encryptStringAsync(` ${plaintext}`);
    await expect(provider.open(scopeA, spaced)).rejects.toMatchObject({
      code: "credential-corrupt-record",
    });
  });

  it("rejects unsupported envelope versions", async () => {
    const port = asyncPort({ withBackend: true, backend: "keychain" });
    const provider = new CredentialProvider(port, "darwin");
    const sealed = await provider.seal(scopeA, "versioned-secret");
    const future = await reencrypt(port, sealed, (envelope) => {
      envelope.format = "folio-credential-envelope/v2";
    });
    await expect(provider.open(scopeA, future)).rejects.toMatchObject({
      code: "credential-version-unsupported",
    });
  });
});

describe("scope, secret, ciphertext and availability failures", () => {
  it("rejects invalid scopes without mutating the caller input", async () => {
    const provider = new CredentialProvider(asyncPort(), "darwin");
    const extra = { ...scopeA, extra: "field" } as unknown as CredentialScope;
    const long = { ...scopeA, deviceId: "d".repeat(129) };
    const surrogate = { ...scopeA, serverId: "\ud800" };
    const empty = { ...scopeA, orgId: "" };
    for (const scope of [extra, long, surrogate, empty]) {
      const snapshot = { ...scope };
      await expect(provider.seal(scope, "secret")).rejects.toMatchObject({
        code: "credential-invalid-scope",
      });
      expect(scope).toEqual(snapshot);
    }
  });

  it("rejects invalid secrets before touching the storage port", async () => {
    const port = asyncPort();
    const provider = new CredentialProvider(port, "darwin");
    const invalid = ["", "\udc00", "s".repeat(16 * 1024 + 1)];
    for (const secret of invalid) {
      await expect(provider.seal(scopeA, secret)).rejects.toMatchObject({
        code: "credential-invalid-secret",
      });
    }
    await expect(
      provider.seal(scopeA, 7 as unknown as string),
    ).rejects.toMatchObject({ code: "credential-invalid-secret" });
    expect(port.encrypts).toBe(0);
  });

  it("rejects malformed ciphertext without changing it", async () => {
    const provider = new CredentialProvider(asyncPort(), "darwin");
    await expect(provider.open(scopeA, new Uint8Array())).rejects.toMatchObject(
      { code: "credential-corrupt-record" },
    );
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const snapshot = new Uint8Array(bytes);
    await expect(provider.open(scopeA, bytes)).rejects.toMatchObject({
      code: "credential-decrypt-failed",
    });
    expect(bytes).toEqual(snapshot);
  });

  it("distinguishes explicit unavailability from decryption failure", async () => {
    const unavailableAsync = asyncPort({ available: false });
    const asyncProvider = new CredentialProvider(unavailableAsync, "darwin");
    await expect(asyncProvider.seal(scopeA, "secret")).rejects.toMatchObject({
      code: "credential-unavailable",
    });
    await expect(
      asyncProvider.open(scopeA, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "credential-unavailable" });
    expect(unavailableAsync.encrypts).toBe(0);

    const unavailableLegacy = legacyPort({ available: false });
    const legacyProvider = new CredentialProvider(unavailableLegacy, "darwin");
    await expect(
      legacyProvider.open(scopeA, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "credential-unavailable" });
  });

  it("rejects Linux basic_text and unknown backends", async () => {
    const basicAsync = asyncPort({
      withBackend: true,
      backend: "basic_text",
    });
    await expect(
      new CredentialProvider(basicAsync, "linux").seal(scopeA, "secret"),
    ).rejects.toMatchObject({ code: "credential-insecure-backend" });

    const basicLegacy = legacyPort({
      withBackend: true,
      backend: "basic_text",
    });
    await expect(
      new CredentialProvider(basicLegacy, "linux").open(
        scopeA,
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ code: "credential-insecure-backend" });

    const unknownBackend = legacyPort({
      withBackend: true,
      backend: "mystery",
    });
    await expect(
      new CredentialProvider(unknownBackend, "win32").open(
        scopeA,
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ code: "credential-insecure-backend" });
  });
});

describe("legacy migration reads", () => {
  it("opens legacy ciphertext when async encryption is unavailable", async () => {
    const { legacy, ciphertext } = await legacyRecord(
      "legacy-secret",
      scopeA,
      "darwin",
    );
    const provider = new CredentialProvider(legacy, "darwin");
    const snapshot = new Uint8Array(ciphertext);
    expect(await provider.open(scopeA, ciphertext)).toBe("legacy-secret");
    expect(legacy.encrypts).toBe(1);
    expect(legacy.decrypts).toBe(1);
    expect(new Uint8Array(ciphertext)).toEqual(snapshot);
  });

  it("falls back to a legacy read when async decryption fails", async () => {
    const { legacy, ciphertext } = await legacyRecord(
      "fallback-secret",
      scopeA,
      "darwin",
    );
    const hybrid = {
      ...asyncPort({
        withBackend: true,
        backend: "keychain",
        failDecrypt: true,
      }),
      ...legacy,
    };
    const provider = new CredentialProvider(hybrid, "darwin");
    const snapshot = new Uint8Array(ciphertext);
    expect(await provider.open(scopeA, ciphertext)).toBe("fallback-secret");
    expect(new Uint8Array(ciphertext)).toEqual(snapshot);
  });

  it("preserves legacy ciphertext when migration reading fails", async () => {
    const { ciphertext } = await legacyRecord(
      "legacy-failure-secret",
      scopeA,
      "darwin",
    );
    const failing = legacyPort({
      withBackend: true,
      backend: "keychain",
      failDecrypt: true,
    });
    const provider = new CredentialProvider(failing, "darwin");
    const snapshot = new Uint8Array(ciphertext);
    await expect(provider.open(scopeA, ciphertext)).rejects.toMatchObject({
      code: "credential-decrypt-failed",
    });
    expect(new Uint8Array(ciphertext)).toEqual(snapshot);
  });

  it("reads secure Linux legacy records but refuses basic_text", async () => {
    const { legacy, ciphertext } = await legacyRecord(
      "linux-secret",
      scopeA,
      "linux",
    );
    expect(
      await new CredentialProvider(legacy, "linux").open(scopeA, ciphertext),
    ).toBe("linux-secret");

    const insecure = legacyPort({
      withBackend: true,
      backend: "basic_text",
    });
    await expect(
      new CredentialProvider(insecure, "linux").open(
        scopeA,
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ code: "credential-insecure-backend" });
  });
});

describe("failed rotation and input immutability", () => {
  it("keeps the previous record when encryption fails", async () => {
    const good = asyncPort({ withBackend: true, backend: "keychain" });
    const goodProvider = new CredentialProvider(good, "darwin");
    const oldCiphertext = await goodProvider.seal(scopeA, "old-secret");
    const snapshot = new Uint8Array(oldCiphertext);

    const failing = asyncPort({
      withBackend: true,
      backend: "keychain",
      failEncrypt: true,
    });
    await expect(
      new CredentialProvider(failing, "darwin").seal(scopeA, "new-secret"),
    ).rejects.toMatchObject({ code: "credential-encrypt-failed" });

    expect(oldCiphertext).toEqual(snapshot);
    expect(await goodProvider.open(scopeA, oldCiphertext)).toBe("old-secret");
  });

  it("keeps the previous record when the encryption round-trip fails", async () => {
    const good = asyncPort({ withBackend: true, backend: "keychain" });
    const goodProvider = new CredentialProvider(good, "darwin");
    const oldCiphertext = await goodProvider.seal(scopeA, "old-secret");
    const snapshot = new Uint8Array(oldCiphertext);

    const failing = asyncPort({
      withBackend: true,
      backend: "keychain",
      failDecrypt: true,
    });
    await expect(
      new CredentialProvider(failing, "darwin").seal(scopeA, "rotated-secret"),
    ).rejects.toMatchObject({ code: "credential-encrypt-failed" });

    expect(oldCiphertext).toEqual(snapshot);
    expect(await goodProvider.open(scopeA, oldCiphertext)).toBe("old-secret");
  });

  it("does not expose caller bytes to a mutating storage port", async () => {
    const port = asyncPort({
      withBackend: true,
      backend: "keychain",
      mutateInput: true,
    });
    const provider = new CredentialProvider(port, "darwin");
    const sealed = await provider.seal(scopeA, "immutable-secret");
    const snapshot = new Uint8Array(sealed);
    expect(await provider.open(scopeA, sealed)).toBe("immutable-secret");
    expect(sealed).toEqual(snapshot);
  });

  it("does not put the secret in thrown errors", async () => {
    const provider = new CredentialProvider(
      asyncPort({ withBackend: true, backend: "keychain" }),
      "darwin",
    );
    const sealed = await provider.seal(scopeA, "visible-secret");
    const snapshot = new Uint8Array(sealed);
    sealed[0] = (sealed[0] + 1) % 256;
    try {
      await provider.open(scopeA, sealed);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect(String((error as Error).message)).not.toContain("visible-secret");
      expect((error as CredentialError).code).toBe("credential-decrypt-failed");
    }
    sealed.set(snapshot);
  });
});
