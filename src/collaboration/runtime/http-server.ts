import { handleSharedBackupRequest } from "./backup-http";
import { handleSharedAssetRequest, type AssetEndpoint } from "./asset-http";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  CollaborationError,
  demand,
  identifier,
  safeCounter,
  wellFormed,
  type Attempt,
  type Scope,
} from "./contract";
import { canonical } from "./canonical";
import { parseAttempt, parseCanonicalWire } from "./wire";
import type { SharedAuthorityEndpoint } from "./provider-port";
import {
  HTTP_MAX_REQUEST_BYTES,
  HTTP_MAX_RESPONSE_BYTES,
  HTTP_REQUEST_TIMEOUT_MS,
} from "./http-provider";

const MAX_TOKEN_LENGTH = 256;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;
const OPERATIONS = new Set([
  "admin",
  "join",
  "session",
  "snapshot",
  "state",
  "event",
  "submit",
  "receipt",
  "invalidate",
  "proof",
  "workspaces",
]);

type RecordValue = Record<string, unknown>;

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function record(value: unknown): RecordValue {
  demand(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_REQUEST",
  );
  return value as RecordValue;
}

function onlyKeys(
  value: RecordValue,
  allowed: readonly string[],
  required: readonly string[],
): void {
  for (const key of Object.keys(value))
    demand(allowed.includes(key), "INVALID_REQUEST");
  for (const key of required)
    demand(Object.hasOwn(value, key), "INVALID_REQUEST");
}

function requestScope(value: unknown): Scope {
  const raw = record(value);
  onlyKeys(
    raw,
    ["orgId", "workspaceId", "documentId", "incarnationId"],
    ["orgId", "workspaceId", "documentId", "incarnationId"],
  );
  return {
    orgId: identifier(raw.orgId),
    workspaceId: identifier(raw.workspaceId),
    documentId: identifier(raw.documentId),
    incarnationId: identifier(raw.incarnationId),
  };
}

function requestAttempt(value: unknown): Attempt {
  return parseAttempt(value);
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header !== "string") throw new HttpFailure(401, "TOKEN_INVALID");
  if (header.length > MAX_TOKEN_LENGTH + 7)
    throw new HttpFailure(401, "TOKEN_INVALID");
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) throw new HttpFailure(401, "TOKEN_INVALID");
  const token = match[1];
  if (token.length < 1 || token.length > MAX_TOKEN_LENGTH || !wellFormed(token))
    throw new HttpFailure(401, "TOKEN_INVALID");
  return token;
}

function parseRequest(raw: string): RecordValue {
  let parsed: unknown;
  try {
    parsed = parseCanonicalWire(raw, HTTP_MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof CollaborationError)
      throw new HttpFailure(400, error.code);
    if (error instanceof SyntaxError)
      throw new HttpFailure(400, "INVALID_WIRE");
    throw error;
  }
  return record(parsed);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (typeof declared !== "string" || !/^(0|[1-9][0-9]*)$/.test(declared))
      throw new HttpFailure(400, "INVALID_CONTENT_LENGTH");
    const length = Number(declared);
    if (!Number.isSafeInteger(length))
      throw new HttpFailure(400, "INVALID_CONTENT_LENGTH");
    if (length > HTTP_MAX_REQUEST_BYTES) {
      request.resume();
      throw new HttpFailure(413, "REQUEST_TOO_LARGE");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > HTTP_MAX_REQUEST_BYTES) tooLarge = true;
    else chunks.push(buffer);
  }
  if (tooLarge) throw new HttpFailure(413, "REQUEST_TOO_LARGE");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new HttpFailure(400, "INVALID_WIRE");
  }
  return text;
}

function statusFor(code: string): number {
  if (code === "TOKEN_INVALID") return 401;
  if (
    code === "FORBIDDEN" ||
    code === "AUTH_SCOPE_MISMATCH" ||
    code === "WRITER_MISMATCH" ||
    code === "NOT_OWNER"
  )
    return 403;
  if (code === "DOCUMENT_MISSING") return 404;
  return 400;
}

function safeCode(code: string, secret?: string | null): string {
  if (secret && secret.length > 0 && code.includes(secret))
    return "INTERNAL_ERROR";
  return ERROR_CODE.test(code) ? code : "INTERNAL_ERROR";
}

function headers(length: number): Record<string, string> {
  return {
    "content-type": "application/json",
    "content-length": String(length),
    "cache-control": "no-store",
  };
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  secret?: string | null,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = canonical(
    { v: 1, ok: false, error: safeCode(code, secret) },
    1024,
  );
  response.writeHead(status, headers(Buffer.byteLength(body)));
  response.end(body);
}

function sendSuccess(response: ServerResponse, result: unknown): void {
  let body: string;
  try {
    body = canonical({ v: 1, ok: true, result }, HTTP_MAX_RESPONSE_BYTES);
  } catch {
    sendError(response, 500, "RESPONSE_TOO_LARGE");
    return;
  }
  response.writeHead(200, headers(Buffer.byteLength(body)));
  response.end(body);
}

async function handle(
  endpoint: SharedAuthorityEndpoint,
  request: IncomingMessage,
  response: ServerResponse,
  state: { token: string | null },
): Promise<void> {
  if (request.method !== "POST")
    throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
  if (request.headers.origin !== undefined)
    throw new HttpFailure(403, "ORIGIN_REJECTED");
  if (request.headers.cookie !== undefined)
    throw new HttpFailure(400, "COOKIE_REJECTED");
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw new HttpFailure(415, "JSON_REQUIRED");

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.search !== "" || url.hash !== "")
    throw new HttpFailure(400, "QUERY_REJECTED");
  const match = /^\/v1\/([a-z]+)$/.exec(url.pathname);
  if (!match || !OPERATIONS.has(match[1]))
    throw new HttpFailure(404, "NOT_FOUND");
  const operation = match[1];

  const token = bearerToken(request);
  state.token = token;
  const root = parseRequest(await readBody(request));

  let result: unknown;
  switch (operation) {
    case "admin": {
      onlyKeys(root, ["command"], ["command"]);
      demand(endpoint.admin, "ADMIN_UNSUPPORTED");
      result = endpoint.admin(token, root.command);
      break;
    }
    case "join": {
      onlyKeys(root, ["orgId", "deviceId"], ["orgId", "deviceId"]);
      demand(endpoint.join, "JOIN_UNSUPPORTED");
      result = endpoint.join(
        token,
        identifier(root.orgId),
        identifier(root.deviceId),
      );
      break;
    }
    case "session": {
      onlyKeys(root, ["orgId"], ["orgId"]);
      demand(endpoint.session, "SESSION_UNSUPPORTED");
      result = endpoint.session(token, identifier(root.orgId));
      break;
    }
    case "state": {
      onlyKeys(root, ["scope"], ["scope"]);
      demand(endpoint.state, "STATE_UNSUPPORTED");
      result = endpoint.state(token, requestScope(root.scope));
      break;
    }
    case "event": {
      onlyKeys(root, ["scope", "attemptId"], ["scope", "attemptId"]);
      demand(endpoint.acceptedEvent, "EVENT_UNSUPPORTED");
      result = endpoint.acceptedEvent(token, requestScope(root.scope), identifier(root.attemptId));
      break;
    }
    case "snapshot": {
      onlyKeys(root, ["scope", "after"], ["scope"]);
      const scope = requestScope(root.scope);
      const after = Object.hasOwn(root, "after")
        ? safeCounter(root.after)
        : undefined;
      result = endpoint.snapshot(token, scope, after);
      break;
    }
    case "submit": {
      onlyKeys(root, ["attempt"], ["attempt"]);
      result = endpoint.submit(token, requestAttempt(root.attempt));
      break;
    }
    case "receipt": {
      onlyKeys(root, ["attempt"], ["attempt"]);
      result = endpoint.receipt(token, requestAttempt(root.attempt));
      break;
    }
    case "invalidate": {
      onlyKeys(root, ["attempt"], ["attempt"]);
      result = endpoint.invalidate(token, requestAttempt(root.attempt));
      break;
    }
    case "proof": {
      onlyKeys(root, ["scope", "seq"], ["scope", "seq"]);
      result = endpoint.proof(
        token,
        requestScope(root.scope),
        safeCounter(root.seq),
      );
      break;
    }
    case "workspaces": {
      onlyKeys(root, ["orgId"], ["orgId"]);
      result = endpoint.workspaces(token, identifier(root.orgId));
      break;
    }
    default:
      throw new HttpFailure(404, "NOT_FOUND");
  }
  sendSuccess(response, result);
}

export type SharedHttpServer = {
  listen(): Promise<{ url: string }>;
  close(): Promise<void>;
};

export function createSharedHttpServer(
  endpoint: SharedAuthorityEndpoint,
): SharedHttpServer {
  if (
    !endpoint ||
    typeof endpoint.snapshot !== "function" ||
    typeof endpoint.submit !== "function" ||
    typeof endpoint.receipt !== "function" ||
    typeof endpoint.invalidate !== "function" ||
    typeof endpoint.proof !== "function" ||
    typeof endpoint.workspaces !== "function"
  )
    throw new CollaborationError("INVALID_ENDPOINT");

  const server = createServer(createSharedRequestListener(endpoint));
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  let boundUrl: string | null = null;
  return {
    async listen() {
      if (boundUrl !== null) return { url: boundUrl };
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
        server.listen(0, "127.0.0.1");
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new CollaborationError("INVALID_ADDRESS");
      }
      boundUrl = `http://127.0.0.1:${address.port}`;
      return { url: boundUrl };
    },
    async close() {
      boundUrl = null;
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

export function createSharedRequestListener(
  endpoint: SharedAuthorityEndpoint,
): import("node:http").RequestListener {
  return (request, response) => {
    const state: { token: string | null } = { token: null };
    void (async () => {
      if (await handleSharedBackupRequest(endpoint, request, response, state))
        return;
      if (
        await handleSharedAssetRequest(
          endpoint as SharedAuthorityEndpoint & AssetEndpoint,
          request,
          response,
          state,
        )
      )
        return;
      await handle(endpoint, request, response, state);
    })().catch((error: unknown) => {
      if (error instanceof HttpFailure)
        sendError(response, error.status, error.code, state.token);
      else if (error instanceof CollaborationError)
        sendError(response, statusFor(error.code), error.code, state.token);
      else sendError(response, 500, "INTERNAL_ERROR", state.token);
    });
  };
}
