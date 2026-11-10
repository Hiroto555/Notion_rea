import { createHash } from "node:crypto";
import { normalizeSharedEndpoint } from "./endpoint-policy";
import {
  CollaborationError,
  identifier,
  wellFormed,
  type Scope,
} from "./contract";
import { canonical } from "./canonical";
import { parseCanonicalWire, parseScope } from "./wire";

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_STAGE_RESPONSE_BYTES = 1_000;
const MAX_ERROR_BYTES = 1_024;
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_TOKEN_LENGTH = 256;
const REQUEST_TIMEOUT_MS = 15_000;
const HASH = /^[a-f0-9]{64}$/;
const STATUS = /^[A-Za-z0-9_.:-]{1,128}$/;

export type SharedAssetStageResult = { hash: string; bytes: number };

type RecordValue = Record<string, unknown>;
type RawResponse = {
  status: number;
  contentType: string | null;
  headers: Headers;
  body: Uint8Array;
};

function fail(code: string): never {
  throw new CollaborationError(code);
}

function record(value: unknown, code: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code);
  return value as RecordValue;
}

function exact(value: unknown, keys: readonly string[]): RecordValue {
  const raw = record(value, "INVALID_RESPONSE");
  if (
    Object.keys(raw).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(raw, key))
  )
    fail("INVALID_RESPONSE");
  return raw;
}

function checkScope(value: unknown): Scope {
  try {
    return parseScope(value);
  } catch {
    return fail("INVALID_SCOPE");
  }
}

function checkHash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) fail("INVALID_RESPONSE");
  return value;
}

function checkSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_ASSET_BYTES
  )
    fail("INVALID_RESPONSE");
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentIs(value: string | null, expected: string): boolean {
  return (
    value !== null && value.split(";")[0].trim().toLowerCase() === expected
  );
}

function parseError(body: Uint8Array): never {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    fail("INVALID_RESPONSE");
  }
  let parsed: unknown;
  try {
    parsed = parseCanonicalWire(text, MAX_ERROR_BYTES);
  } catch {
    fail("INVALID_RESPONSE");
  }
  const raw = exact(parsed, ["v", "ok", "error"]);
  if (raw.v !== 1 || raw.ok !== false) fail("INVALID_RESPONSE");
  if (
    typeof raw.error !== "string" ||
    raw.error.length > 128 ||
    !STATUS.test(raw.error)
  )
    fail("INVALID_RESPONSE");
  fail(raw.error);
}

function successResult(value: unknown): unknown {
  const raw = exact(value, ["v", "ok", "result"]);
  if (raw.v !== 1 || raw.ok !== true) fail("INVALID_RESPONSE");
  return raw.result;
}

export class SharedAssetProvider {
  private readonly base: string;
  private readonly token: string;
  private closed = false;

  constructor(url: string, token: string) {
    this.base = normalizeSharedEndpoint(url);
    if (
      typeof token !== "string" ||
      token.length < 1 ||
      token.length > MAX_TOKEN_LENGTH ||
      !wellFormed(token)
    )
      fail("INVALID_TOKEN");
    this.token = token;
  }

  private async request(
    path: string,
    headers: Record<string, string>,
    body: Uint8Array,
    maximum: number,
  ): Promise<RawResponse> {
    if (this.closed) fail("CLOSED");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(`${this.base}${path}`, {
          method: "POST",
          headers,
          body: Uint8Array.from(body).buffer,
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) fail("REQUEST_TIMEOUT");
        if ((error as Error)?.name === "AbortError") fail("REQUEST_TIMEOUT");
        return fail("NETWORK_ERROR");
      }
      if (response.redirected) fail("REDIRECT_REJECTED");
      const declared = response.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
          if (response.body)
            await response.body.cancel().catch(() => undefined);
          fail("RESPONSE_TOO_LARGE");
        }
      }
      const reader = response.body?.getReader();
      if (!reader) fail("INVALID_RESPONSE");
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maximum) {
          await reader.cancel().catch(() => undefined);
          fail("RESPONSE_TOO_LARGE");
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        headers: response.headers,
        body: bytes,
      };
    } catch (error) {
      if (error instanceof CollaborationError) throw error;
      if (controller.signal.aborted) fail("REQUEST_TIMEOUT");
      if ((error as Error)?.name === "AbortError") fail("REQUEST_TIMEOUT");
      return fail("NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
  }

  async stage(
    scope: Scope,
    uploadId: string,
    bytes: Uint8Array,
  ): Promise<SharedAssetStageResult> {
    const checkedScope = checkScope(scope);
    const upload = identifier(uploadId);
    if (!(bytes instanceof Uint8Array)) fail("INVALID_BYTES");
    if (bytes.byteLength > MAX_ASSET_BYTES) fail("ASSET_TOO_LARGE");
    const copy = bytes.slice();
    const expectedHash = sha256(copy);
    const encoded = Buffer.from(canonical(checkedScope), "utf8").toString(
      "base64url",
    );
    const response = await this.request(
      "/v1/assetstage",
      {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/octet-stream",
        "x-folio-scope": encoded,
        "x-folio-upload": upload,
        accept: "application/json",
      },
      copy,
      MAX_STAGE_RESPONSE_BYTES,
    );
    if (response.status < 200 || response.status >= 300)
      parseError(response.body);
    if (!contentIs(response.contentType, "application/json"))
      fail("INVALID_RESPONSE");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    } catch {
      fail("INVALID_RESPONSE");
    }
    let parsed: unknown;
    try {
      parsed = parseCanonicalWire(text, MAX_STAGE_RESPONSE_BYTES);
    } catch {
      fail("INVALID_RESPONSE");
    }
    const result = exact(successResult(parsed), ["hash", "bytes"]);
    const hash = checkHash(result.hash);
    const size = checkSize(result.bytes);
    if (hash !== expectedHash || size !== copy.byteLength)
      fail("HASH_MISMATCH");
    return { hash, bytes: size };
  }

  async read(scope: Scope, hash: string): Promise<Uint8Array> {
    const checkedScope = checkScope(scope);
    if (typeof hash !== "string" || !HASH.test(hash)) fail("INVALID_HASH");
    const body = canonical({ scope: checkedScope, hash }, MAX_REQUEST_BYTES);
    const response = await this.request(
      "/v1/assetread",
      {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/octet-stream",
      },
      Buffer.from(body, "utf8"),
      MAX_ASSET_BYTES,
    );
    if (response.status < 200 || response.status >= 300)
      parseError(response.body);
    if (!contentIs(response.contentType, "application/octet-stream"))
      fail("INVALID_RESPONSE");
    const declaredHash = response.headers.get("x-folio-sha256");
    if (declaredHash !== hash) fail("HASH_MISMATCH");
    if (response.body.byteLength > MAX_ASSET_BYTES) fail("ASSET_TOO_LARGE");
    if (sha256(response.body) !== hash) fail("HASH_MISMATCH");
    return response.body;
  }

  close(): void {
    this.closed = true;
  }
}
