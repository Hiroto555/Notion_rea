import type { IncomingMessage, ServerResponse } from "node:http";
import { CollaborationError, demand, identifier, wellFormed } from "./contract";
import { canonical } from "./canonical";
import { parseCanonicalWire } from "./wire";
import { validateRuntimeBackup, type RuntimeBackup } from "./backup";

export const BACKUP_WIRE_MAX_BYTES = 256 * 1024 * 1024;
export const BACKUP_REQUEST_MAX_BYTES = 1_000;
export const BACKUP_HASH_HEADER = "x-folio-backup-hash";
export const BACKUP_HEAD_HEADER = "x-folio-backup-head";

const MAX_TOKEN_LENGTH = 256;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;
const BACKUP_PATH = "/v1/backup";

export interface BackupEndpoint {
  backup?(token: string, orgId: string): RuntimeBackup;
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

function record(value: unknown): RecordValue {
  demand(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_REQUEST",
  );
  return value as RecordValue;
}

function requestOrgId(value: unknown): string {
  const raw = record(value);
  const keys = Object.keys(raw);
  demand(
    keys.length === 1 && keys[0] === "orgId" && Object.hasOwn(raw, "orgId"),
    "INVALID_REQUEST",
  );
  return identifier(raw.orgId);
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

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (typeof declared !== "string" || !/^(0|[1-9][0-9]*)$/.test(declared))
      throw new HttpFailure(400, "INVALID_CONTENT_LENGTH");
    const length = Number(declared);
    if (!Number.isSafeInteger(length))
      throw new HttpFailure(400, "INVALID_CONTENT_LENGTH");
    if (length > BACKUP_REQUEST_MAX_BYTES) {
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
    if (total > BACKUP_REQUEST_MAX_BYTES) tooLarge = true;
    else chunks.push(buffer);
  }
  if (tooLarge) throw new HttpFailure(413, "REQUEST_TOO_LARGE");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new HttpFailure(400, "INVALID_WIRE");
  }
}

function statusFor(code: string): number {
  if (code === "TOKEN_INVALID") return 401;
  if (
    code === "FORBIDDEN" ||
    code === "AUTH_SCOPE_MISMATCH" ||
    code === "WRITER_MISMATCH" ||
    code === "NOT_OWNER" ||
    code === "NOT_ORG_OWNER" ||
    code === "NOT_ORG_MEMBER"
  )
    return 403;
  if (code === "METHOD_NOT_ALLOWED") return 405;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (code === "JSON_REQUIRED") return 415;
  if (code === "BACKUP_UNSUPPORTED") return 501;
  return 400;
}

function safeCode(code: string): string {
  return ERROR_CODE.test(code) ? code : "INTERNAL_ERROR";
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  let body: string;
  try {
    body = canonical({ v: 1, ok: false, error: safeCode(code) }, 1024);
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

function sendBackup(response: ServerResponse, backup: RuntimeBackup): void {
  let body: string;
  try {
    body = canonical(backup, BACKUP_WIRE_MAX_BYTES);
  } catch (error) {
    if (error instanceof CollaborationError)
      sendError(response, statusFor(error.code), error.code);
    else sendError(response, 500, "INTERNAL_ERROR");
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    [BACKUP_HASH_HEADER]: backup.hash,
    [BACKUP_HEAD_HEADER]: canonical(backup.head),
  });
  response.end(body);
}

async function handle(
  endpoint: BackupEndpoint,
  request: IncomingMessage,
  response: ServerResponse,
  state: { token: string | null },
  url: URL,
): Promise<void> {
  if (request.method !== "POST")
    throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
  if (request.headers.origin !== undefined)
    throw new HttpFailure(403, "ORIGIN_REJECTED");
  if (request.headers.cookie !== undefined)
    throw new HttpFailure(400, "COOKIE_REJECTED");
  if (url.search !== "" || url.hash !== "")
    throw new HttpFailure(400, "QUERY_REJECTED");
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw new HttpFailure(415, "JSON_REQUIRED");

  const token = bearerToken(request);
  state.token = token;
  const backup = endpoint.backup;
  if (typeof backup !== "function")
    throw new HttpFailure(501, "BACKUP_UNSUPPORTED");

  let parsed: unknown;
  const raw = await readBody(request);
  try {
    parsed = parseCanonicalWire(raw, BACKUP_REQUEST_MAX_BYTES);
  } catch (error) {
    if (error instanceof CollaborationError)
      throw new HttpFailure(400, error.code);
    if (error instanceof SyntaxError)
      throw new HttpFailure(400, "INVALID_WIRE");
    throw error;
  }
  const orgId = requestOrgId(parsed);
  const result = backup.call(endpoint, token, orgId);
  sendBackup(response, validateRuntimeBackup(result));
}

export async function handleSharedBackupRequest(
  endpoint: BackupEndpoint,
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
  if (url.pathname !== BACKUP_PATH) return false;
  try {
    await handle(endpoint, request, response, state, url);
  } catch (error) {
    if (error instanceof HttpFailure)
      sendError(response, error.status, error.code);
    else if (error instanceof CollaborationError)
      sendError(response, statusFor(error.code), error.code);
    else sendError(response, 500, "INTERNAL_ERROR");
  }
  return true;
}
