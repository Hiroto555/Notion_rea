import { normalizeSharedEndpoint } from "./endpoint-policy";
import { CollaborationError, identifier, wellFormed } from "./contract";
import { canonical } from "./canonical";
import { parseCanonicalWire } from "./wire";
import { validateRuntimeBackup, type RuntimeBackup } from "./backup";
import type { BackupDownload } from "./backup-port";
import {
  BACKUP_HASH_HEADER,
  BACKUP_HEAD_HEADER,
  BACKUP_REQUEST_MAX_BYTES,
  BACKUP_WIRE_MAX_BYTES,
} from "./backup-http";

export const BACKUP_REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOKEN_LENGTH = 256;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function checkError(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("INVALID_RESPONSE");
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (
    keys.length !== 3 ||
    !keys.includes("v") ||
    !keys.includes("ok") ||
    !keys.includes("error") ||
    raw.v !== 1 ||
    raw.ok !== false ||
    typeof raw.error !== "string" ||
    raw.error.length < 1 ||
    raw.error.length > 128 ||
    !/^[A-Za-z0-9_.:-]+$/.test(raw.error)
  )
    fail("INVALID_RESPONSE");
  return raw.error;
}

export class SharedBackupProvider {
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

  async download(orgId: string): Promise<BackupDownload> {
    if (this.closed) fail("CLOSED");
    const org = identifier(orgId);
    const body = canonical({ orgId: org }, BACKUP_REQUEST_MAX_BYTES);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      BACKUP_REQUEST_TIMEOUT_MS,
    );
    try {
      let response: Response;
      try {
        response = await fetch(`${this.base}/v1/backup`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) fail("REQUEST_TIMEOUT");
        return fail("NETWORK_ERROR");
      }

      if (response.status >= 300 && response.status < 400)
        fail("REDIRECT_REJECTED");
      if (response.redirected) fail("REDIRECT_REJECTED");

      const declared = response.headers.get("content-length");
      if (declared !== null) {
        if (!/^(0|[1-9][0-9]*)$/.test(declared)) fail("INVALID_RESPONSE");
        const length = Number(declared);
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > BACKUP_WIRE_MAX_BYTES
        )
          fail("RESPONSE_TOO_LARGE");
      }

      const reader = response.body?.getReader();
      if (!reader) fail("INVALID_RESPONSE");
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          part = await reader.read();
        } catch {
          if (controller.signal.aborted) fail("REQUEST_TIMEOUT");
          return fail("INVALID_RESPONSE");
        }
        if (part.done) break;
        length += part.value.byteLength;
        if (length > BACKUP_WIRE_MAX_BYTES) {
          try {
            await reader.cancel();
          } catch {
            /* bounded response failure is reported below */
          }
          fail("RESPONSE_TOO_LARGE");
        }
        chunks.push(part.value);
      }
      if (length > BACKUP_WIRE_MAX_BYTES) fail("RESPONSE_TOO_LARGE");

      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return fail("INVALID_RESPONSE");
      }

      let parsed: unknown;
      try {
        parsed = parseCanonicalWire(raw, BACKUP_WIRE_MAX_BYTES);
      } catch (error) {
        if (error instanceof CollaborationError) fail(error.code);
        return fail("INVALID_RESPONSE");
      }
      if (!response.ok) fail(checkError(parsed));

      let backup: RuntimeBackup;
      try {
        backup = validateRuntimeBackup(parsed);
      } catch (error) {
        if (error instanceof CollaborationError) fail(error.code);
        return fail("INVALID_BACKUP");
      }

      const hashHeader = response.headers.get(BACKUP_HASH_HEADER);
      if (hashHeader === null || hashHeader !== backup.hash)
        fail("BACKUP_HASH_MISMATCH");
      const headHeader = response.headers.get(BACKUP_HEAD_HEADER);
      if (headHeader !== null && headHeader !== canonical(backup.head))
        fail("BACKUP_HEAD_MISMATCH");

      return { raw, head: backup.head, hash: backup.hash };
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.closed = true;
  }
}
