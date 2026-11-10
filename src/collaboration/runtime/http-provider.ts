import { normalizeSharedEndpoint } from "./endpoint-policy";
import {
  CollaborationError,
  identifier,
  safeCounter,
  wellFormed,
  type AuthContext,
  type Attempt,
  type Cut,
  type Receipt,
  type RuntimeEvent,
  type Scope,
  type Snapshot,
} from "./contract";
import { canonical } from "./canonical";
import { digest } from "./digest";
import { parseCanonicalWire } from "./wire";
import type { SharedProvider, WorkspaceListing } from "./provider-port";

export const HTTP_MAX_REQUEST_BYTES = 1_000_000;
export const HTTP_MAX_RESPONSE_BYTES = 8_000_000;
export const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKEN_LENGTH = 256;
const HASH = /^[a-f0-9]{64}$/;
const STATUS = /^[A-Za-z0-9_.:-]{1,128}$/;
const RECEIPT_STATUS = new Set(["SERVER_ACCEPTED", "REJECTED", "INVALIDATED"]);
const ROLES = new Set(["owner", "editor", "viewer"]);

type RecordValue = Record<string, unknown>;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function record(value: unknown, code = "INVALID_RESPONSE"): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code);
  return value as RecordValue;
}

function exact(
  value: unknown,
  keys: readonly string[],
  code = "INVALID_RESPONSE",
): RecordValue {
  const raw = record(value, code);
  const actual = Object.keys(raw);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(raw, key))
  )
    fail(code);
  return raw;
}

function checkScope(value: unknown): Scope {
  const raw = exact(value, [
    "orgId",
    "workspaceId",
    "documentId",
    "incarnationId",
  ]);
  return {
    orgId: identifier(raw.orgId),
    workspaceId: identifier(raw.workspaceId),
    documentId: identifier(raw.documentId),
    incarnationId: identifier(raw.incarnationId),
  };
}

function checkHash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) fail("INVALID_RESPONSE");
  return value;
}

function checkCut(value: unknown): Cut {
  const raw = exact(value, ["epoch", "seq", "hash"]);
  return {
    epoch: identifier(raw.epoch),
    seq: safeCounter(raw.seq),
    hash: checkHash(raw.hash),
  };
}

function checkState(value: unknown): void {
  const raw = exact(value, ["document", "tables", "tombstones"]);
  const document = record(raw.document);
  if (typeof document.type !== "string") fail("INVALID_RESPONSE");
  if (!Array.isArray(raw.tables)) fail("INVALID_RESPONSE");
  for (const table of raw.tables) {
    const entry = exact(table, ["tableId", "rowIds", "columnIds"]);
    identifier(entry.tableId);
    for (const key of ["rowIds", "columnIds"] as const) {
      if (!Array.isArray(entry[key])) fail("INVALID_RESPONSE");
      for (const id of entry[key]) identifier(id);
    }
  }
  if (!Array.isArray(raw.tombstones)) fail("INVALID_RESPONSE");
  for (const id of raw.tombstones) identifier(id);
}

function checkReceipt(value: unknown): Receipt {
  const raw = exact(value, [
    "v",
    "status",
    "intentId",
    "intentHash",
    "attemptId",
    "attemptHash",
    "writerId",
    "scope",
    "cut",
    "resultHash",
    "code",
  ]);
  if (raw.v !== 1) fail("INVALID_RESPONSE");
  if (typeof raw.status !== "string" || !RECEIPT_STATUS.has(raw.status))
    fail("INVALID_RESPONSE");
  identifier(raw.intentId);
  checkHash(raw.intentHash);
  identifier(raw.attemptId);
  checkHash(raw.attemptHash);
  identifier(raw.writerId);
  checkScope(raw.scope);
  checkCut(raw.cut);
  checkHash(raw.resultHash);
  if (
    raw.code !== null &&
    (typeof raw.code !== "string" ||
      raw.code.length > 128 ||
      !wellFormed(raw.code))
  )
    fail("INVALID_RESPONSE");
  return raw as unknown as Receipt;
}

function checkEvent(value: unknown): void {
  const raw = record(value);
  const keys = Object.keys(raw);
  const required = [
    "seq",
    "epoch",
    "previousHash",
    "hash",
    "scope",
    "intentId",
    "attemptId",
    "writerId",
    "command",
    "appliedText",
    "state",
    "receipt",
  ];
  const hasStateHash = Object.hasOwn(raw, "authorityStateHash");
  const hasAppliedBefore = Object.hasOwn(raw, "appliedBefore");
  const allowed = new Set([...required, "authorityStateHash", "appliedBefore"]);
  if (
    keys.length !== required.length + Number(hasStateHash) + Number(hasAppliedBefore) ||
    keys.some((key) => !allowed.has(key))
  )
    fail("INVALID_RESPONSE");
  safeCounter(raw.seq);
  identifier(raw.epoch);
  checkHash(raw.previousHash);
  checkHash(raw.hash);
  checkScope(raw.scope);
  identifier(raw.intentId);
  identifier(raw.attemptId);
  identifier(raw.writerId);
  const command = record(raw.command);
  if (typeof command.kind !== "string") fail("INVALID_RESPONSE");
  if (raw.appliedText !== null) {
    const applied = record(raw.appliedText);
    if (applied.kind !== "text") fail("INVALID_RESPONSE");
  }
  if (raw.state !== null) checkState(raw.state);
  if (hasAppliedBefore) checkState(raw.appliedBefore);
  const receipt = checkReceipt(raw.receipt);
  if (receipt.cut.epoch !== raw.epoch || receipt.cut.seq !== raw.seq || receipt.cut.hash !== raw.hash ||
      receipt.intentId !== raw.intentId || receipt.attemptId !== raw.attemptId || receipt.writerId !== raw.writerId ||
      canonical(receipt.scope) !== canonical(raw.scope)) fail("INVALID_RESPONSE");
  if (hasStateHash) checkHash(raw.authorityStateHash);
  const body: Record<string, unknown> = {
    seq: raw.seq,
    epoch: raw.epoch,
    previousHash: raw.previousHash,
    scope: raw.scope,
    intentId: raw.intentId,
    attemptId: raw.attemptId,
    writerId: raw.writerId,
    command: raw.command,
    appliedText: raw.appliedText,
    state: raw.state,
    status: receipt.status,
    code: receipt.code,
    resultHash: receipt.resultHash,
    intentHash: receipt.intentHash,
    attemptHash: receipt.attemptHash,
  };
  if (hasStateHash) body.authorityStateHash = raw.authorityStateHash;
  if (hasAppliedBefore) body.appliedBefore = raw.appliedBefore;
  if (digest(body) !== raw.hash) fail("INVALID_RESPONSE");
}

function checkSnapshot(value: unknown): Snapshot {
  const raw = exact(value, ["scope", "cut", "state", "events"]);
  checkScope(raw.scope);
  checkCut(raw.cut);
  checkState(raw.state);
  if (!Array.isArray(raw.events)) fail("INVALID_RESPONSE");
  for (const event of raw.events) checkEvent(event);
  return raw as unknown as Snapshot;
}

function checkWorkspaceListing(value: unknown): WorkspaceListing[] {
  if (!Array.isArray(value)) fail("INVALID_RESPONSE");
  return value.map((entry) => {
    const raw = exact(entry, ["workspaceId", "name", "role", "documents"]);
    identifier(raw.workspaceId);
    if (typeof raw.name !== "string" || !wellFormed(raw.name))
      fail("INVALID_RESPONSE");
    if (
      raw.role !== null &&
      (typeof raw.role !== "string" || !ROLES.has(raw.role))
    )
      fail("INVALID_RESPONSE");
    if (!Array.isArray(raw.documents)) fail("INVALID_RESPONSE");
    const documents = raw.documents.map((document) => {
      const item = exact(document, ["documentId", "incarnationId", "title"]);
      identifier(item.documentId);
      identifier(item.incarnationId);
      if (typeof item.title !== "string" || !wellFormed(item.title))
        fail("INVALID_RESPONSE");
      return {
        documentId: item.documentId as string,
        incarnationId: item.incarnationId as string,
        title: item.title as string,
      };
    });
    return {
      workspaceId: raw.workspaceId as string,
      name: raw.name as string,
      role: raw.role as WorkspaceListing["role"],
      documents,
    };
  });
}

function checkError(value: unknown): string {
  const raw = exact(value, ["v", "ok", "error"]);
  if (raw.v !== 1 || raw.ok !== false) fail("INVALID_RESPONSE");
  if (
    typeof raw.error !== "string" ||
    raw.error.length > 128 ||
    !STATUS.test(raw.error)
  )
    fail("INVALID_RESPONSE");
  return raw.error;
}

function checkSuccess(value: unknown): unknown {
  const raw = exact(value, ["v", "ok", "result"]);
  if (raw.v !== 1 || raw.ok !== true) fail("INVALID_RESPONSE");
  return raw.result;
}

function parseBaseUrl(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048)
    fail("INVALID_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("INVALID_URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === ""
  )
    fail("INVALID_URL");
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    fail("INVALID_URL");
  return `http://127.0.0.1:${url.port}`;
}

export class HttpSharedProvider implements SharedProvider {
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

  private async request(operation: string, payload: unknown): Promise<unknown> {
    if (this.closed) fail("CLOSED");
    const body = canonical(payload, HTTP_MAX_REQUEST_BYTES);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.base}/v1/${operation}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) return fail("REQUEST_TIMEOUT");
      if ((error as Error)?.name === "AbortError")
        return fail("REQUEST_TIMEOUT");
      return fail("NETWORK_ERROR");
    }
    try {
      if (response.redirected) fail("REDIRECT_REJECTED");
      const declared = response.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > HTTP_MAX_RESPONSE_BYTES
        )
          fail("RESPONSE_TOO_LARGE");
      }
      const reader = response.body?.getReader();
      if (!reader) fail("INVALID_RESPONSE");
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > HTTP_MAX_RESPONSE_BYTES) {
          await reader.cancel();
          fail("RESPONSE_TOO_LARGE");
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (bytes.byteLength > HTTP_MAX_RESPONSE_BYTES)
        fail("RESPONSE_TOO_LARGE");
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return fail("INVALID_RESPONSE");
      }
      const parsed = parseCanonicalWire(raw, HTTP_MAX_RESPONSE_BYTES);
      if (!response.ok) fail(checkError(parsed));
      return checkSuccess(parsed);
    } finally {
      clearTimeout(timer);
    }
  }

  async admin(command: unknown): Promise<unknown> {
    return this.request("admin", { command });
  }
  async join(
    orgId: string,
    deviceId: string,
  ): Promise<{ token: string; auth: AuthContext }> {
    const raw = exact(await this.request("join", { orgId, deviceId }), [
      "token",
      "auth",
    ]);
    if (
      typeof raw.token !== "string" ||
      raw.token.length > 256 ||
      raw.token.length < 32
    )
      fail("INVALID_RESPONSE");
    const auth = exact(raw.auth, [
      "userId",
      "deviceId",
      "writerId",
      "sessionId",
    ]);
    return {
      token: raw.token,
      auth: {
        userId: identifier(auth.userId),
        deviceId: identifier(auth.deviceId),
        writerId: identifier(auth.writerId),
        sessionId: identifier(auth.sessionId),
      },
    };
  }
  async session(orgId: string): Promise<AuthContext> {
    const raw = exact(await this.request("session", { orgId }), [
      "userId",
      "deviceId",
      "writerId",
      "sessionId",
    ]);
    return {
      userId: identifier(raw.userId),
      deviceId: identifier(raw.deviceId),
      writerId: identifier(raw.writerId),
      sessionId: identifier(raw.sessionId),
    };
  }
  async protocol(scope: Scope): Promise<1003 | 1004> {
    try {
      const result = await this.admin({action: "protocol", scope}) as {protocol?: unknown};
      if (!result || (result.protocol !== 1003 && result.protocol !== 1004)) fail("INVALID_RESPONSE");
      return result.protocol;
    } catch (error) {
      // A definitive unsupported read endpoint identifies the legacy protocol.
      // Network, authentication and malformed responses never license fallback.
      if (error instanceof CollaborationError && ["ADMIN_UNSUPPORTED", "INVALID_ADMIN_COMMAND"].includes(error.code)) return 1003;
      throw error;
    }
  }
  async state(scope: Scope): Promise<Snapshot> {
    try { return checkSnapshot(await this.request("state", {scope})); }
    catch (error) {
      if (error instanceof CollaborationError && ["STATE_UNSUPPORTED", "NOT_FOUND"].includes(error.code)) return this.snapshot(scope);
      throw error;
    }
  }
  async acceptedEvent(scope: Scope, attemptId: string): Promise<RuntimeEvent> {
    const event = await this.request("event", {scope, attemptId});
    checkEvent(event);
    const result = event as RuntimeEvent;
    if (canonical(result.scope) !== canonical(scope) || result.attemptId !== attemptId || result.receipt.status !== "SERVER_ACCEPTED") fail("INVALID_RESPONSE");
    return result;
  }
  async snapshot(scope: Scope, after?: number): Promise<Snapshot> {
    const payload: Record<string, unknown> = { scope };
    if (after !== undefined) payload.after = after;
    return checkSnapshot(await this.request("snapshot", payload));
  }

  async submit(attempt: Attempt): Promise<Receipt> {
    return checkReceipt(await this.request("submit", { attempt }));
  }

  async receipt(attempt: Attempt): Promise<Receipt | null> {
    const result = await this.request("receipt", { attempt });
    return result === null ? null : checkReceipt(result);
  }

  async invalidate(attempt: Attempt): Promise<Receipt> {
    return checkReceipt(await this.request("invalidate", { attempt }));
  }

  async proof(scope: Scope, seq: number): Promise<Cut | null> {
    const result = await this.request("proof", { scope, seq });
    return result === null ? null : checkCut(result);
  }

  async workspaces(orgId: string): Promise<WorkspaceListing[]> {
    return checkWorkspaceListing(await this.request("workspaces", { orgId }));
  }

  close(): void {
    this.closed = true;
  }
}
