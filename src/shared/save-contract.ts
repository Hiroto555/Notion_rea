import type { z } from "zod";
import type { Page, RecordProjection, saveOperationSchema } from "./types";

export type SaveOperation = z.infer<typeof saveOperationSchema>;
export type SaveResult = {
  status: "applied" | "rejected" | "unknown";
  operationId: string;
  sessionId: string;
  seq: number;
  pageId: string;
  fingerprint: string;
  page?: Page;
  record?: RecordProjection;
  message?: string;
};

/** Canonicalization is shared by SQLite receipts and the renderer's ACK check. */
export function canonicalOperation(operation: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.keys(value).sort().map((key) =>
        [key, canonical((value as Record<string, unknown>)[key])],
      ));
    return value;
  };
  return JSON.stringify(canonical(operation));
}

export async function operationFingerprint(operation: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalOperation(operation));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function matchesOperation(result: SaveResult, operation: SaveOperation, fingerprint: string): boolean {
  return !!result && result.operationId === operation.operationId &&
    result.sessionId === operation.sessionId && result.seq === operation.seq &&
    result.pageId === operation.pageId && result.fingerprint === fingerprint;
}
