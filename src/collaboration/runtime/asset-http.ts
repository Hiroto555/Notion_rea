import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CollaborationError,
  demand,
  identifier,
  safeCounter,
  wellFormed,
  type Scope,
} from "./contract";
import { canonical } from "./canonical";
import { parseCanonicalWire, parseScope } from "./wire";

export const ASSET_MAX_BYTES = 20 * 1024 * 1024;
const ASSET_RESULT_MAX_BYTES = 1_000;
const ASSET_REQUEST_MAX_BYTES = 1_000_000;
const ASSET_SCOPE_MAX_BYTES = 4_096;
const MAX_TOKEN_LENGTH = 256;
const HASH = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type AssetStageResult = { hash: string; bytes: number };

export interface AssetEndpoint {
  stageAsset?(
    token: string,
    scope: Scope,
    uploadId: string,
    bytes: Uint8Array,
  ): AssetStageResult;
  readAsset?(token: string, scope: Scope, hash: string): Uint8Array;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, code: string): RecordValue {
  demand(
    typeof value === "object" && value !== null && !Array.isArray(value),
    code,
  );
  return value as RecordValue;
}

function exact(value: unknown, keys: readonly string[]): RecordValue {
  const raw = record(value, "INVALID_RESULT");
  if (
    Object.keys(raw).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(raw, key))
  )
    throw new CollaborationError("INVALID_RESULT");
  return raw;
}

function hashValue(value: unknown): string {
  demand(typeof value === "string" && HASH.test(value), "INVALID_HASH");
  return value;
}

function sizeValue(value: unknown): number {
  return safeCounter(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function singleHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (value === undefined) return null;
  if (typeof value !== "string" || !wellFormed(value))
    throw new HttpFailure(400, "INVALID_HEADER");
  return value;
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = singleHeader(request, name);
  if (value === null) throw new HttpFailure(400, "MISSING_HEADER");
  return value;
}

function decodeScope(header: string): Scope {
  if (header.length > ASSET_SCOPE_MAX_BYTES || !BASE64URL.test(header))
    throw new HttpFailure(400, "INVALID_SCOPE_HEADER");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(header, "base64url"),
    );
  } catch {
    throw new HttpFailure(400, "INVALID_SCOPE_HEADER");
  }
  let parsed: unknown;
  try {
    parsed = parseCanonicalWire(text, ASSET_SCOPE_MAX_BYTES);
  } catch {
    throw new HttpFailure(400, "INVALID_SCOPE_HEADER");
  }
  let scope: Scope;
  try {
    scope = parseScope(parsed);
  } catch {
    throw new HttpFailure(400, "INVALID_SCOPE_HEADER");
  }
  const encoded = Buffer.from(canonical(scope), "utf8").toString("base64url");
  if (encoded !== header) throw new HttpFailure(400, "INVALID_SCOPE_HEADER");
  return scope;
}

function mediaType(request: IncomingMessage): string {
  const value = singleHeader(request, "content-type");
  if (value === null) throw new HttpFailure(415, "CONTENT_TYPE_REQUIRED");
  return value.split(";")[0].trim().toLowerCase();
}

async function readBytes(
  request: IncomingMessage,
  maximum: number,
): Promise<Uint8Array> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (typeof declared !== "string" || !/^(0|[1-9][0-9]*)$/.test(declared))
      throw new HttpFailure(400, "INVALID_CONTENT_LENGTH");
    const length = Number(declared);
    if (!Number.isSafeInteger(length))
      throw new HttpFailure(400, "INVALID_CONTENT_LENGTH");
    if (length > maximum) {
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
    if (total > maximum) tooLarge = true;
    else chunks.push(buffer);
  }
  if (tooLarge) throw new HttpFailure(413, "REQUEST_TOO_LARGE");
  return Buffer.concat(chunks);
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
  if (
    code === "ASSET_NOT_FOUND" ||
    code === "ASSET_MISSING" ||
    code === "UPLOAD_NOT_FOUND" ||
    code === "DOCUMENT_MISSING"
  )
    return 404;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  if (
    code === "UPLOAD_CONFLICT" ||
    code === "UPLOAD_HASH_MISMATCH" ||
    code === "DOCUMENT_DELETED" ||
    code === "SCOPE_NOT_ACTIVE" ||
    code === "STALE_CUT"
  )
    return 409;
  if (code === "ASSET_TOO_LARGE" || code === "REQUEST_TOO_LARGE") return 413;
  if (code === "OCTET_STREAM_REQUIRED" || code === "JSON_REQUIRED") return 415;
  return 400;
}

function safeCode(code: string, secret: string | null): string {
  if (secret !== null && secret.length > 0 && code.includes(secret))
    return "INTERNAL_ERROR";
  return ERROR_CODE.test(code) ? code : "INTERNAL_ERROR";
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  secret: string | null,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  let body: string;
  try {
    body = canonical({ v: 1, ok: false, error: safeCode(code, secret) }, 1024);
  } catch {
    body = '{"error":"INTERNAL_ERROR","ok":false,"v":1}';
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendStageResult(
  response: ServerResponse,
  result: AssetStageResult,
): void {
  let body: string;
  try {
    body = canonical(
      { v: 1, ok: true, result: { hash: result.hash, bytes: result.bytes } },
      ASSET_RESULT_MAX_BYTES,
    );
  } catch {
    sendError(response, 500, "RESPONSE_TOO_LARGE", null);
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function stageResult(
  value: unknown,
  expectedHash: string,
  expectedBytes: number,
): AssetStageResult {
  const raw = exact(value, ["hash", "bytes"]);
  const hash = hashValue(raw.hash);
  const bytes = sizeValue(raw.bytes);
  demand(hash === expectedHash && bytes === expectedBytes, "INVALID_RESULT");
  return { hash, bytes };
}

async function handleStage(
  endpoint: AssetEndpoint,
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
): Promise<void> {
  const stageAsset = endpoint.stageAsset;
  if (typeof stageAsset !== "function")
    throw new CollaborationError("STAGE_UNSUPPORTED");
  if (mediaType(request) !== "application/octet-stream")
    throw new HttpFailure(415, "OCTET_STREAM_REQUIRED");
  const scope = decodeScope(requiredHeader(request, "x-folio-scope"));
  const uploadId = identifier(requiredHeader(request, "x-folio-upload"));
  const bytes = await readBytes(request, ASSET_MAX_BYTES);
  const result = stageAsset.call(endpoint, token, scope, uploadId, bytes);
  const checked = stageResult(result, sha256(bytes), bytes.byteLength);
  sendStageResult(response, checked);
}

async function handleRead(
  endpoint: AssetEndpoint,
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
): Promise<void> {
  const readAsset = endpoint.readAsset;
  if (typeof readAsset !== "function")
    throw new CollaborationError("READ_UNSUPPORTED");
  if (mediaType(request) !== "application/json")
    throw new HttpFailure(415, "JSON_REQUIRED");
  const raw = await readBytes(request, ASSET_REQUEST_MAX_BYTES);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new HttpFailure(400, "INVALID_WIRE");
  }
  let parsed: unknown;
  try {
    parsed = parseCanonicalWire(body, ASSET_REQUEST_MAX_BYTES);
  } catch (error) {
    if (error instanceof CollaborationError)
      throw new HttpFailure(400, error.code);
    if (error instanceof SyntaxError)
      throw new HttpFailure(400, "INVALID_WIRE");
    throw error;
  }
  const root = exact(parsed, ["scope", "hash"]);
  let scope: Scope;
  try {
    scope = parseScope(root.scope);
  } catch {
    throw new HttpFailure(400, "INVALID_SCOPE");
  }
  const hash = hashValue(root.hash);
  const value = readAsset.call(endpoint, token, scope, hash);
  if (!(value instanceof Uint8Array))
    throw new CollaborationError("INVALID_RESULT");
  if (value.byteLength > ASSET_MAX_BYTES)
    throw new CollaborationError("ASSET_TOO_LARGE");
  const copy = Buffer.from(value);
  demand(sha256(copy) === hash, "HASH_MISMATCH");
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(copy.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-folio-sha256": hash,
  });
  response.end(copy);
}

export async function handleSharedAssetRequest(
  endpoint: AssetEndpoint,
  request: IncomingMessage,
  response: ServerResponse,
  state: { token: string | null },
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  const stage = url.pathname === "/v1/assetstage";
  const read = url.pathname === "/v1/assetread";
  if (!stage && !read) return false;
  try {
    if (request.method !== "POST")
      throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
    if (request.headers.origin !== undefined)
      throw new HttpFailure(403, "ORIGIN_REJECTED");
    if (request.headers.cookie !== undefined)
      throw new HttpFailure(400, "COOKIE_REJECTED");
    if (url.search !== "" || url.hash !== "")
      throw new HttpFailure(400, "QUERY_REJECTED");
    const token = bearerToken(request);
    state.token = token;
    if (stage) await handleStage(endpoint, request, response, token);
    else await handleRead(endpoint, request, response, token);
  } catch (error) {
    if (error instanceof HttpFailure)
      sendError(response, error.status, error.code, state.token);
    else if (error instanceof CollaborationError)
      sendError(response, statusFor(error.code), error.code, state.token);
    else sendError(response, 500, "INTERNAL_ERROR", state.token);
  }
  return true;
}
