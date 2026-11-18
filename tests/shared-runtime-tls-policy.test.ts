import { describe, expect, it } from "vitest";
import {
  createSharedHttpsServer,
  type SharedHttpsOptions,
} from "../src/collaboration/runtime/https-host";
import { normalizeSharedEndpoint } from "../src/collaboration/runtime/endpoint-policy";
import type { SharedAuthorityEndpoint } from "../src/collaboration/runtime/provider-port";

const endpoint: SharedAuthorityEndpoint = {
  snapshot() {
    throw new Error("unused");
  },
  submit() {
    throw new Error("unused");
  },
  receipt() {
    throw new Error("unused");
  },
  invalidate() {
    throw new Error("unused");
  },
  proof() {
    throw new Error("unused");
  },
  workspaces() {
    throw new Error("unused");
  },
};

function options(overrides: Record<string, unknown>): SharedHttpsOptions {
  return {
    key: "-----BEGIN PRIVATE KEY-----\n",
    cert: "-----BEGIN CERTIFICATE-----\n",
    host: "127.0.0.1",
    port: 0,
    ...overrides,
  } as unknown as SharedHttpsOptions;
}

function rejectsConfig(overrides: Record<string, unknown>, code: string): void {
  expect(() =>
    createSharedHttpsServer(endpoint, options(overrides)),
  ).toThrowError(code);
}

describe("normalizeSharedEndpoint", () => {
  it("accepts canonical loopback HTTP endpoints", () => {
    expect(normalizeSharedEndpoint("http://127.0.0.1:1")).toBe(
      "http://127.0.0.1:1",
    );
    expect(normalizeSharedEndpoint("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(normalizeSharedEndpoint("http://127.0.0.1:65535/")).toBe(
      "http://127.0.0.1:65535",
    );
  });

  it("accepts canonical HTTPS DNS and IP endpoints", () => {
    expect(normalizeSharedEndpoint("https://example.com:8443")).toBe(
      "https://example.com:8443",
    );
    expect(normalizeSharedEndpoint("https://sync.example.com:4443/")).toBe(
      "https://sync.example.com:4443",
    );
    expect(normalizeSharedEndpoint("https://127.0.0.1:8443")).toBe(
      "https://127.0.0.1:8443",
    );
    expect(normalizeSharedEndpoint("https://192.168.1.20:9443")).toBe(
      "https://192.168.1.20:9443",
    );
    expect(normalizeSharedEndpoint("https://localhost:8443")).toBe(
      "https://localhost:8443",
    );
    expect(normalizeSharedEndpoint("https://[::1]:8443")).toBe(
      "https://[::1]:8443",
    );
  });

  it("rejects credentials, query, fragment and paths", () => {
    for (const url of [
      "http://user@127.0.0.1:3000",
      "http://user:pass@127.0.0.1:3000",
      "https://user:pass@example.com:8443",
      "http://127.0.0.1:3000?x=1",
      "https://example.com:8443?x=1",
      "http://127.0.0.1:3000#fragment",
      "https://example.com:8443#fragment",
      "http://127.0.0.1:3000/v1",
      "https://example.com:8443/v1/session",
      "https://example.com:8443//",
    ])
      expect(() => normalizeSharedEndpoint(url)).toThrowError("INVALID_URL");
  });

  it("rejects ambiguous or non-canonical normalization", () => {
    for (const url of [
      "HTTP://127.0.0.1:3000",
      "Http://127.0.0.1:3000",
      "http://127.0.0.1:03000",
      "http://127.000.000.001:3000",
      "https://Example.com:8443",
      "https://EXAMPLE.COM:8443",
      "https://example.com.:8443",
      "https://example.com:08443",
      "https://[0:0:0:0:0:0:0:1]:8443",
      "http://127.0.0.1:80",
      "https://example.com:443",
      "https://example.com:443/",
      " http://127.0.0.1:3000",
      "http://127.0.0.1:3000 ",
    ])
      expect(() => normalizeSharedEndpoint(url)).toThrowError("INVALID_URL");
  });

  it("rejects missing, default or out-of-range ports", () => {
    for (const url of [
      "https://example.com",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "https://example.com:0",
      "https://example.com:65536",
      "https://example.com:3000.5",
      "https://example.com:https",
    ])
      expect(() => normalizeSharedEndpoint(url)).toThrowError("INVALID_URL");
  });

  it("rejects localhost HTTP, wildcard targets and insecure remote HTTP", () => {
    for (const url of [
      "http://localhost:3000",
      "http://0.0.0.0:3000",
      "http://192.168.1.20:3000",
      "http://example.com:3000",
      "https://0.0.0.0:8443",
      "https://[::]:8443",
      "ftp://example.com:21",
      "file://127.0.0.1:3000",
    ])
      expect(() => normalizeSharedEndpoint(url)).toThrowError("INVALID_URL");
  });

  it("rejects malformed and non-string input", () => {
    for (const value of [
      "",
      "not a url",
      "http://",
      "https://",
      "http://127.0.0.1:3000\n",
      "http://127.0.0.1:3000\\",
      "https://exa_mple.com:8443",
      `https://example.com:8443/${"a".repeat(4096)}`,
      null,
      undefined,
      123,
    ])
      expect(() =>
        normalizeSharedEndpoint(value as unknown as string),
      ).toThrowError("INVALID_URL");
  });
});

describe("createSharedHttpsServer invalid configuration", () => {
  it("rejects malformed option containers", () => {
    expect(() =>
      createSharedHttpsServer(endpoint, null as unknown as SharedHttpsOptions),
    ).toThrowError("INVALID_OPTIONS");
    expect(() =>
      createSharedHttpsServer(endpoint, [] as unknown as SharedHttpsOptions),
    ).toThrowError("INVALID_OPTIONS");
    expect(() =>
      createSharedHttpsServer(endpoint, options({ extra: true })),
    ).toThrowError("INVALID_OPTIONS");
  });

  it("rejects missing, empty, ill-formed or oversized key and cert material", () => {
    rejectsConfig({ key: "" }, "INVALID_TLS_OPTIONS");
    rejectsConfig({ cert: "" }, "INVALID_TLS_OPTIONS");
    rejectsConfig({ key: 42 }, "INVALID_TLS_OPTIONS");
    rejectsConfig({ cert: null }, "INVALID_TLS_OPTIONS");
    rejectsConfig({ key: `\ud800${"a".repeat(10)}` }, "INVALID_TLS_OPTIONS");
    rejectsConfig({ cert: `\udc00${"a".repeat(10)}` }, "INVALID_TLS_OPTIONS");
    rejectsConfig({ key: "a".repeat(8 * 1024 + 1) }, "INVALID_TLS_OPTIONS");
    rejectsConfig({ cert: "a".repeat(64 * 1024 + 1) }, "INVALID_TLS_OPTIONS");
  });

  it("rejects non-IPv4 hosts, wildcard shorthand and omitted hosts", () => {
    for (const host of [
      "",
      "localhost",
      "example.com",
      "::1",
      "[::1]",
      "0.0.0.0 ",
      "127.0.0.01",
      "256.0.0.1",
      "127.0.0",
      null,
      0,
    ])
      rejectsConfig({ host }, "INVALID_HOST");
  });

  it("rejects out-of-range or non-integer ports", () => {
    for (const port of [-1, 65536, 1.5, Number.NaN, "3000", null])
      rejectsConfig({ port }, "INVALID_PORT");
  });
});
