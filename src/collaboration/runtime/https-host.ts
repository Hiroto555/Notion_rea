import { createServer as createHttpsServer } from "node:https";
import { CollaborationError, wellFormed } from "./contract";
import { createSharedRequestListener } from "./http-server";
import { HTTP_REQUEST_TIMEOUT_MS } from "./http-provider";
import type { SharedAuthorityEndpoint } from "./provider-port";

const KEY_MAX_BYTES = 8 * 1024;
const CERT_MAX_BYTES = 64 * 1024;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;

export type SharedHttpsOptions = {
  key: string;
  cert: string;
  host: string;
  port: number;
};

export type SharedHttpsServer = {
  listen(): Promise<{ url: string }>;
  close(): Promise<void>;
};

function fail(code: string): never {
  throw new CollaborationError(code);
}

function material(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value))
    return fail("INVALID_TLS_OPTIONS");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maxBytes) return fail("INVALID_TLS_OPTIONS");
  return value;
}

function readOptions(value: unknown): SharedHttpsOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail("INVALID_OPTIONS");
  const raw = value as Record<string, unknown>;
  const allowed = ["key", "cert", "host", "port"];
  const keys = Object.keys(raw);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !Object.hasOwn(raw, key))
  )
    return fail("INVALID_OPTIONS");
  const key = material(raw.key, KEY_MAX_BYTES);
  const cert = material(raw.cert, CERT_MAX_BYTES);
  const host = raw.host;
  if (typeof host !== "string" || !IPV4.test(host)) return fail("INVALID_HOST");
  const port = raw.port;
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  )
    return fail("INVALID_PORT");
  return { key, cert, host, port };
}

function checkEndpoint(endpoint: SharedAuthorityEndpoint): void {
  if (
    !endpoint ||
    typeof endpoint.snapshot !== "function" ||
    typeof endpoint.submit !== "function" ||
    typeof endpoint.receipt !== "function" ||
    typeof endpoint.invalidate !== "function" ||
    typeof endpoint.proof !== "function" ||
    typeof endpoint.workspaces !== "function"
  )
    fail("INVALID_ENDPOINT");
}

export function createSharedHttpsServer(
  endpoint: SharedAuthorityEndpoint,
  options: SharedHttpsOptions,
): SharedHttpsServer {
  checkEndpoint(endpoint);
  const config = readOptions(options);

  let server: ReturnType<typeof createHttpsServer>;
  try {
    server = createHttpsServer(
      {
        key: config.key,
        cert: config.cert,
        minVersion: "TLSv1.3",
      },
      createSharedRequestListener(endpoint),
    );
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    return fail("INVALID_TLS_OPTIONS");
  }
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  let bound: { url: string } | null = null;
  let pending: Promise<{ url: string }> | null = null;

  return {
    listen() {
      if (bound !== null) return Promise.resolve(bound);
      if (pending !== null) return pending;
      pending = (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
              server.off("listening", onListening);
              reject(error);
            };
            const onListening = () => {
              server.off("error", onError);
              resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(config.port, config.host);
          });
          const address = server.address();
          if (!address || typeof address === "string") {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            return fail("INVALID_ADDRESS");
          }
          bound = Object.freeze({
            url: `https://${config.host}:${address.port}`,
          });
          return bound;
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
    async close() {
      bound = null;
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
