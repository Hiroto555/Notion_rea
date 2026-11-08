/**
 * Workspace-scoped attachment blob transport.
 *
 * This module is intentionally independent of the checkpoint server/client.
 * The server can hand a `/v1/workspaces/:workspaceId/blobs/:sha256` request to
 * `WorkspaceBlobStore.handle` after it has resolved the workspace capability.
 * The store only receives structural values; it never reads a remote path.
 *
 * Server layout: `<root>/<sha256(workspaceId)>/<sha256>` plus
 * `<root>/<sha256(workspaceId)>/.partial-<sha256>` for an upload in progress. A partial
 * is never visible through GET. Complete files are published with a hard link
 * (exclusive, no overwrite) after the exact byte count and SHA-256 are checked.
 *
 * Transfer protocol (documented, not part of the checkpoint wire protocol):
 * - HEAD/GET: `200`, `Content-Length`, `X-Folio-Blob-Sha256`; HEAD ignores
 *   Range and returns the full length. GET accepts one RFC 7233 byte range and
 *   returns `206` with `Content-Range`. No redirects are emitted.
 * - PUT without Content-Range: one complete blob, at most 20,000,000 bytes.
 * - PUT with `Content-Range: bytes start-end/total`: upload one bounded slice.
 *   `Content-Length` must equal `end-start+1`. The server truncates its partial
 *   to `start` (rejecting `start` beyond the current partial), appends the
 *   slice, fsyncs it, and answers `204` with `X-Folio-Blob-Received`. The final
 *   slice is hash/size checked before an exclusive publish and answers `201`.
 *
 * Client resume granularity:
 * - Upload chunks are 1 MiB. A retry starts at the last acknowledged chunk
 *   boundary; a lost acknowledgement therefore re-sends at most one 1 MiB
 *   chunk. `blob-offset-mismatch` (for example the server lost its partial)
 *   restarts the upload from byte 0.
 * - Download chunks are 1 MiB, but a retry uses the actual size of the
 *   temporary file as the Range start. An interrupted response therefore
 *   resumes at exact byte granularity within the current chunk. Complete files
 *   are only visible under their final asset ID after hash/length verification
 *   and fsync + exclusive hard-link publication.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseAssetURL } from "../shared/assets";
import { syncPath } from "../persistence/durable-file";
import {
  canonicalJson,
  requireCondition,
  sha256 as hashText,
  SyncError,
} from "./protocol";
import { BlobTransferJournal } from "./blob-transfer-journal";
import {
  openBlobTransferPartial,
  checkpointBlobTransferPartial,
  reconcilePublishedPartial,
  type BlobTransferPartial,
} from "./blob-transfer-partial";
import {
  inspectBlobUploadPartial,
  withBlobUploadLock,
} from "./blob-upload-resume";
import type { BlobTransferScope } from "./blob-transfer-types";
import { inspectBlobTransferInventory } from "./blob-transfer-inventory";
import { inspectWorkspaceTransferBudget } from "./blob-transfer-budget";

/** Attachment limit already enforced by `attachFile` in the base application. */
export const WORKSPACE_BLOB_MAX_BYTES = 20_000_000;
/** Fixed upper bound for one resumable HTTP slice. */
export const WORKSPACE_BLOB_CHUNK_BYTES = 1024 * 1024;

const HASH = /^[a-f0-9]{64}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTENT_RANGE = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/;
const RESPONSE_RANGE = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/;
const READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const WRITE_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;
const MAX_ATTEMPTS = 4;
const ERROR_BODY_BYTES = 16 * 1024;

export type WorkspaceBlobAsset = {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
};

export type WorkspaceBlobRequestContext = {
  workspaceId: string;
  sha256: string;
  assertAuthorized: () => void;
};

export type WorkspaceBlobClientOptions = {
  baseUrl: string;
  workspaceId: string;
  token: string;
  assetsDirectory: string;
  timeoutMs?: number;
  admitBytes?: (bytes: number) => void;
  /** Private transfer cache, never a workspace content DB or credential file. */
  transfer?: {
    directory: string;
    scope: BlobTransferScope;
    workspaceDirectory?: string;
  };
};

type NormalizedOptions = {
  baseUrl: string;
  workspaceId: string;
  token: string;
  assetsDirectory: string;
  timeoutMs: number;
  admitBytes?: (bytes: number) => void;
  transferJournal?: BlobTransferJournal;
  assertTransferBudget?: (additionalBytes: number) => void;
};

type FileState =
  | { kind: "missing" }
  | { kind: "symlink" }
  | { kind: "not-file" }
  | { kind: "file"; size: number; sha256: string };

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function closeQuietly(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // Keep the original operation error. A close failure cannot retract it.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Cleanup never replaces the original error.
  }
}

function hashDescriptor(descriptor: number, prefixBytes?: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const size =
      prefixBytes === undefined
        ? buffer.length
        : Math.min(buffer.length, prefixBytes - position);
    if (!size) break;
    const read = readSync(descriptor, buffer, 0, size, position);
    if (read === 0) break;
    position += read;
    requireCondition(
      position <= WORKSPACE_BLOB_MAX_BYTES,
      "blob-too-large",
      413,
    );
    hash.update(buffer.subarray(0, read));
  }
  requireCondition(
    prefixBytes === undefined || position === prefixBytes,
    "asset-changed",
    409,
  );
  return hash.digest("hex");
}

function writeAll(descriptor: number, bytes: Buffer, position: number): void {
  let written = 0;
  while (written < bytes.length) {
    let count: number;
    try {
      count = writeSync(
        descriptor,
        bytes,
        written,
        bytes.length - written,
        position + written,
      );
    } catch (error) {
      if (errorCode(error) === "ENOSPC")
        throw new SyncError("insufficient-storage", 507);
      throw new SyncError("blob-write-failed", 500);
    }
    if (count <= 0) throw new SyncError("blob-write-failed", 500);
    written += count;
  }
}

/** Opens without following a symlink, verifies type/size/hash, returns an open descriptor. */
function openVerified(
  path: string,
  sha256: string,
  bytes?: number,
): { descriptor: number; size: number } | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, READ_FLAGS);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      return null;
    }
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      closeQuietly(descriptor);
      return null;
    }
    if (
      stat.size > WORKSPACE_BLOB_MAX_BYTES ||
      (bytes !== undefined && stat.size !== bytes)
    ) {
      closeQuietly(descriptor);
      return null;
    }
    const digest = hashDescriptor(descriptor);
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.size !== stat.size || digest !== sha256) {
      closeQuietly(descriptor);
      return null;
    }
    return { descriptor, size: after.size };
  } catch (error) {
    closeQuietly(descriptor);
    throw error;
  }
}

function localFileState(path: string): FileState {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw new SyncError("asset-unreadable", 422);
  }
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (!stat.isFile()) return { kind: "not-file" };
  let descriptor: number;
  try {
    descriptor = openSync(path, READ_FLAGS);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "symlink" };
    throw new SyncError("asset-unreadable", 422);
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) return { kind: "not-file" };
    return {
      kind: "file",
      size: opened.size,
      sha256:
        opened.size <= WORKSPACE_BLOB_MAX_BYTES
          ? hashDescriptor(descriptor)
          : "",
    };
  } catch {
    throw new SyncError("asset-unreadable", 422);
  } finally {
    closeQuietly(descriptor);
  }
}

function validateWorkspaceId(value: unknown): string {
  requireCondition(
    typeof value === "string" && WORKSPACE_ID.test(value),
    "invalid-workspace",
  );
  return value;
}

function validateSha256(value: unknown): string {
  requireCondition(
    typeof value === "string" && HASH.test(value),
    "invalid-hash",
  );
  return value;
}

function validateAsset(value: unknown): WorkspaceBlobAsset {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid-asset",
  );
  const asset = value as Record<string, unknown>;
  requireCondition(
    typeof asset.id === "string" &&
      parseAssetURL(`folio-asset://${asset.id}`) === asset.id,
    "invalid-asset-id",
  );
  requireCondition(
    typeof asset.sha256 === "string" && HASH.test(asset.sha256),
    "invalid-hash",
  );
  requireCondition(
    Number.isSafeInteger(asset.bytes) &&
      Number(asset.bytes) >= 0 &&
      Number(asset.bytes) <= WORKSPACE_BLOB_MAX_BYTES,
    "invalid-asset-size",
  );
  return {
    id: asset.id,
    sha256: asset.sha256,
    bytes: Number(asset.bytes),
  };
}

/** Validates the complete manifest before anyone writes a local file. */
function normalizeAssets(
  assets: readonly WorkspaceBlobAsset[],
): WorkspaceBlobAsset[] {
  requireCondition(Array.isArray(assets), "invalid-assets");
  const byId = new Map<string, WorkspaceBlobAsset>();
  for (const value of assets) {
    const asset = validateAsset(value);
    const previous = byId.get(asset.id);
    if (previous) {
      requireCondition(
        previous.sha256 === asset.sha256 && previous.bytes === asset.bytes,
        "asset-manifest-conflict",
      );
    }
    byId.set(asset.id, asset);
  }
  return [...byId.values()];
}

function containedPath(directory: string, id: string): string {
  const path = join(directory, id);
  const rest = relative(directory, path);
  requireCondition(
    rest !== "" &&
      !rest.startsWith(".." + sep) &&
      rest !== ".." &&
      !isAbsolute(rest),
    "unsafe-asset-path",
  );
  return path;
}

function ensureDirectory(path: string, create: boolean): string {
  const absolute = resolve(path);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new SyncError("unsafe-directory", 409);
    if (!stat.isDirectory()) throw new SyncError("unsafe-directory", 409);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    const code = errorCode(error);
    if (code !== "ENOENT" || !create) {
      if (code === "ENOENT" || code === "ENOTDIR") return absolute;
      throw new SyncError("unsafe-directory", 409);
    }
    try {
      mkdirSync(absolute, { recursive: true, mode: 0o700 });
    } catch (mkdirError) {
      const mkdirCode = errorCode(mkdirError);
      if (mkdirCode === "ENOSPC")
        throw new SyncError("insufficient-storage", 507);
      throw new SyncError("unsafe-directory", 409);
    }
    const created = lstatSync(absolute);
    if (created.isSymbolicLink() || !created.isDirectory())
      throw new SyncError("unsafe-directory", 409);
  }
  return absolute;
}

function parseByteRangeHeader(
  value: string | string[] | undefined,
  size: number,
): { start: number; end: number } | null {
  if (value === undefined) return null;
  requireCondition(typeof value === "string", "invalid-range", 416);
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(value);
  requireCondition(match, "invalid-range", 416);
  requireCondition(size > 0, "range-not-satisfiable", 416);
  const startText = match[1];
  const endText = match[2];
  requireCondition(startText !== "" || endText !== "", "invalid-range", 416);
  let start: number;
  let end: number;
  if (startText === "") {
    const suffix = Number(endText);
    requireCondition(
      Number.isSafeInteger(suffix) && suffix > 0,
      "invalid-range",
      416,
    );
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    requireCondition(
      Number.isSafeInteger(start) && start >= 0 && start < size,
      "range-not-satisfiable",
      416,
    );
    if (endText === "") {
      end = size - 1;
    } else {
      end = Number(endText);
      requireCondition(
        Number.isSafeInteger(end) && end >= start,
        "invalid-range",
        416,
      );
      end = Math.min(end, size - 1);
    }
  }
  return { start, end };
}

function parseContentRange(
  value: string | string[] | undefined,
): { start: number; end: number; total: number } | null {
  if (value === undefined) return null;
  requireCondition(typeof value === "string", "invalid-content-range");
  const match = CONTENT_RANGE.exec(value);
  requireCondition(match, "invalid-content-range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  requireCondition(
    Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      Number.isSafeInteger(total) &&
      start >= 0 &&
      end >= start &&
      end < total,
    "invalid-content-range",
  );
  requireCondition(total <= WORKSPACE_BLOB_MAX_BYTES, "blob-too-large", 413);
  return { start, end, total };
}

function contentLengthHeader(
  value: string | string[] | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  requireCondition(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    "invalid-content-length",
  );
  const parsed = Number(value);
  requireCondition(Number.isSafeInteger(parsed), "invalid-content-length");
  requireCondition(parsed <= WORKSPACE_BLOB_MAX_BYTES, "blob-too-large", 413);
  return parsed;
}

function requestIsLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

/**
 * The integrating server owns routing. When it uses the documented blob route,
 * reject a context that disagrees with the path. A different route remains
 * valid because the structural contract passes the trusted context explicitly.
 */
function assertRouteConsistency(
  request: IncomingMessage,
  workspaceId: string,
  sha256: string,
): void {
  const text = request.url ?? "";
  requireCondition(text.length <= 8 * 1024, "invalid-request-target", 414);
  const pathname = new URL(text, "http://127.0.0.1").pathname;
  if (!pathname.startsWith("/v1/workspaces/")) return;
  if (!pathname.includes("/blobs/")) return;
  const match = /^\/v1\/workspaces\/([^/]+)\/blobs\/([^/]+)\/?$/.exec(pathname);
  requireCondition(match, "not-found", 404);
  requireCondition(match[1] === workspaceId, "workspace-mismatch", 403);
  requireCondition(match[2] === sha256, "blob-id-mismatch", 400);
}

function send(
  response: ServerResponse,
  status: number,
  headers: Record<string, string | number> = {},
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end();
}

/** Server-side, workspace-scoped blob store. */
export class WorkspaceBlobStore {
  private readonly root: string;
  private readonly activeUploads = new Set<string>();

  constructor(root: string) {
    requireCondition(
      typeof root === "string" && root.length > 0,
      "invalid-root",
    );
    const absolute = ensureDirectory(root, true);
    this.root = realpathSync(absolute);
    const stat = lstatSync(this.root);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new SyncError("invalid-root");
  }

  private workspacePath(workspaceId: string, create: boolean): string {
    // Use a digest so distinct authenticated IDs stay distinct even on a
    // case-insensitive filesystem.
    return ensureDirectory(
      join(this.root, hashText(validateWorkspaceId(workspaceId))),
      create,
    );
  }

  /** True only when the workspace-scoped stored bytes actually match id sha/length. */
  has(workspaceId: string, asset: WorkspaceBlobAsset): boolean {
    const expected = validateAsset(asset);
    const directory = this.workspacePath(workspaceId, false);
    const found = openVerified(
      join(directory, expected.sha256),
      expected.sha256,
      expected.bytes,
    );
    if (!found) return false;
    closeQuietly(found.descriptor);
    return true;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: WorkspaceBlobRequestContext,
  ): Promise<void> {
    requireCondition(requestIsLoopback(request), "loopback-only", 403);
    requireCondition(
      context !== null &&
        typeof context === "object" &&
        typeof context.assertAuthorized === "function",
      "authorization-required",
      401,
    );
    const workspaceId = validateWorkspaceId(context.workspaceId);
    const sha256 = validateSha256(context.sha256);
    assertRouteConsistency(request, workspaceId, sha256);
    context.assertAuthorized();
    if (request.method === "GET") {
      await this.get(request, response, workspaceId, sha256, false);
      return;
    }
    if (request.method === "HEAD") {
      if (request.headers["x-folio-blob-resume"] === "1") {
        const bytes = headerNumber(request.headers["x-folio-blob-bytes"]);
        requireCondition(
          bytes !== undefined && bytes <= WORKSPACE_BLOB_MAX_BYTES,
          "invalid-blob-size",
        );
        const directory = this.workspacePath(workspaceId, true);
        await withBlobUploadLock(directory, async () => {
          const completed = openVerified(
            join(directory, sha256),
            sha256,
            bytes,
          );
          if (completed) {
            closeQuietly(completed.descriptor);
            context.assertAuthorized();
            send(response, 204, {
              "X-Folio-Blob-Resume": "1",
              "X-Folio-Blob-Received": String(bytes),
              "X-Folio-Blob-Prefix-Sha256": sha256,
            });
            return;
          }
          const partial = inspectBlobUploadPartial(directory, sha256, bytes);
          context.assertAuthorized();
          send(response, 204, {
            "X-Folio-Blob-Resume": "1",
            "X-Folio-Blob-Received": String(partial?.received ?? 0),
            "X-Folio-Blob-Prefix-Sha256":
              partial?.prefixHash ?? createHash("sha256").digest("hex"),
          });
        });
        return;
      }
      await this.get(request, response, workspaceId, sha256, true);
      return;
    }
    if (request.method === "PUT") {
      const key = workspaceId + ":" + sha256;
      requireCondition(
        !this.activeUploads.has(key),
        "blob-upload-in-progress",
        409,
      );
      this.activeUploads.add(key);
      try {
        const directory = this.workspacePath(workspaceId, true);
        await withBlobUploadLock(directory, () =>
          this.put(request, response, workspaceId, sha256, context),
        );
      } finally {
        this.activeUploads.delete(key);
      }
      return;
    }
    throw new SyncError("method-not-allowed", 405);
  }

  private async get(
    request: IncomingMessage,
    response: ServerResponse,
    workspaceId: string,
    sha256: string,
    headOnly: boolean,
  ): Promise<void> {
    const directory = this.workspacePath(workspaceId, false);
    const path = join(directory, sha256);
    const found = openVerified(path, sha256);
    if (!found) throw new SyncError("blob-not-found", 404);
    let descriptor: number | undefined = found.descriptor;
    try {
      const range = headOnly
        ? null
        : parseByteRangeHeader(request.headers.range, found.size);
      const status = range ? 206 : 200;
      const headers: Record<string, string | number> = {
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
        "X-Folio-Blob-Sha256": sha256,
      };
      if (range) {
        headers["Content-Range"] =
          `bytes ${range.start}-${range.end}/${found.size}`;
        headers["Content-Length"] = range.end - range.start + 1;
      } else {
        headers["Content-Length"] = found.size;
      }
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, headers);
      if (headOnly || found.size === 0) {
        response.end();
        return;
      }
      const stream = createReadStream("", {
        fd: found.descriptor,
        start: range ? range.start : 0,
        end: range ? range.end : found.size - 1,
        autoClose: true,
      });
      descriptor = undefined;
      try {
        await pipeline(stream, response);
      } catch {
        // A client disconnect is not a storage failure. Once headers are sent
        // there is no honest JSON error to send, so terminate this response.
        if (!response.destroyed) response.destroy();
        return;
      }
    } finally {
      closeQuietly(descriptor);
    }
  }

  private async put(
    request: IncomingMessage,
    response: ServerResponse,
    workspaceId: string,
    sha256: string,
    context: WorkspaceBlobRequestContext,
  ): Promise<void> {
    const directory = this.workspacePath(workspaceId, true);
    syncPath(this.root);
    const finalPath = join(directory, sha256);
    const partialPath = join(directory, `.partial-${sha256}`);
    const range = parseContentRange(request.headers["content-range"]);
    const declared = contentLengthHeader(request.headers["content-length"]);
    let start = 0;
    let expectedChunk: number | undefined;
    if (range) {
      start = range.start;
      expectedChunk = range.end - range.start + 1;
      requireCondition(declared === expectedChunk, "content-length-mismatch");
    } else {
      requireCondition(
        declared === undefined || declared <= WORKSPACE_BLOB_MAX_BYTES,
        "blob-too-large",
        413,
      );
    }

    let descriptor: number | undefined;
    let discardPartial = false;
    try {
      try {
        descriptor = openSync(partialPath, WRITE_FLAGS, 0o600);
      } catch (error) {
        if (errorCode(error) === "ELOOP")
          throw new SyncError("unsafe-blob-path", 409);
        if (errorCode(error) === "ENOSPC")
          throw new SyncError("insufficient-storage", 507);
        throw new SyncError("blob-write-failed", 500);
      }
      const opened = fstatSync(descriptor);
      if (!opened.isFile()) throw new SyncError("unsafe-blob-path", 409);
      if (range) {
        requireCondition(start <= opened.size, "blob-offset-mismatch", 409);
      }
      try {
        ftruncateSync(descriptor, range ? start : 0);
      } catch (error) {
        if (errorCode(error) === "ENOSPC")
          throw new SyncError("insufficient-storage", 507);
        throw new SyncError("blob-write-failed", 500);
      }

      const limit = range
        ? expectedChunk!
        : (declared ?? WORKSPACE_BLOB_MAX_BYTES);
      let received = 0;
      try {
        for await (const chunk of request) {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          const next = received + bytes.length;
          if (next > limit) {
            request.destroy();
            throw new SyncError("blob-too-large", 413);
          }
          try {
            writeAll(descriptor, bytes, start + received);
          } catch (error) {
            if (error instanceof SyncError) throw error;
            if (errorCode(error) === "ENOSPC")
              throw new SyncError("insufficient-storage", 507);
            throw new SyncError("blob-write-failed", 500);
          }
          received = next;
        }
      } catch (error) {
        if (error instanceof SyncError) {
          discardPartial = true;
          throw error;
        }
        // Transport interruption. Keep the partial so a later Content-Range
        // request can resume from it.
        throw new SyncError("request-aborted", 400);
      }
      if (expectedChunk !== undefined) {
        if (received !== expectedChunk) {
          discardPartial = true;
          throw new SyncError("blob-size-mismatch", 422);
        }
      } else if (declared !== undefined && received !== declared) {
        discardPartial = true;
        throw new SyncError("blob-size-mismatch", 422);
      }

      // The body is fully asynchronous. Re-check the capability after it has
      // been consumed and before any durable publication can happen.
      try {
        context.assertAuthorized();
      } catch (error) {
        discardPartial = true;
        throw error;
      }

      try {
        fsyncSync(descriptor);
      } catch (error) {
        discardPartial = true;
        if (errorCode(error) === "ENOSPC")
          throw new SyncError("insufficient-storage", 507);
        throw new SyncError("blob-write-failed", 500);
      }
      closeQuietly(descriptor);
      descriptor = undefined;

      const total = range ? range.total : received;
      if (range && range.end + 1 !== range.total) {
        send(response, 204, { "X-Folio-Blob-Received": String(range.end + 1) });
        return;
      }

      const verified = openVerified(partialPath, sha256, total);
      if (!verified) {
        discardPartial = true;
        throw new SyncError("blob-hash-mismatch", 422);
      }
      closeQuietly(verified.descriptor);

      const created = publishVerified(
        partialPath,
        finalPath,
        directory,
        sha256,
        total,
      );
      send(response, created ? 201 : 200, {
        "Content-Length": "0",
        "X-Folio-Blob-Sha256": sha256,
        "X-Folio-Blob-Complete": "true",
      });
    } catch (error) {
      closeQuietly(descriptor);
      if (discardPartial) unlinkQuietly(partialPath);
      throw error;
    }
  }
}

/** Hard-link publication is exclusive: an existing name is never replaced. */
function publishVerified(
  partialPath: string,
  finalPath: string,
  directory: string,
  sha256: string,
  bytes: number,
): boolean {
  try {
    linkSync(partialPath, finalPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      if (errorCode(error) === "ENOSPC")
        throw new SyncError("insufficient-storage", 507);
      throw new SyncError("blob-publish-failed", 500);
    }
    const existing = openVerified(finalPath, sha256, bytes);
    if (!existing) throw new SyncError("blob-id-hash-conflict", 409);
    closeQuietly(existing.descriptor);
    unlinkQuietly(partialPath);
    return false;
  }
  unlinkQuietly(partialPath);
  try {
    syncPath(directory);
  } catch (error) {
    if (errorCode(error) === "ENOSPC")
      throw new SyncError("insufficient-storage", 507);
    throw new SyncError("blob-publish-failed", 500);
  }
  return true;
}

function normalizeClientOptions(
  options: WorkspaceBlobClientOptions,
): NormalizedOptions {
  requireCondition(
    options !== null && typeof options === "object",
    "invalid-options",
  );
  let url: URL;
  try {
    url = new URL(String(options.baseUrl));
  } catch {
    throw new SyncError("loopback-only");
  }
  requireCondition(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash,
    "loopback-only",
  );
  const workspaceId = validateWorkspaceId(options.workspaceId);
  requireCondition(
    typeof options.token === "string" &&
      /^[A-Za-z0-9_-]{32,512}$/.test(options.token),
    "invalid-capability",
  );
  const timeoutMs = options.timeoutMs ?? 5_000;
  requireCondition(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000,
    "invalid-timeout",
  );
  if (options.admitBytes !== undefined)
    requireCondition(
      typeof options.admitBytes === "function",
      "invalid-admission",
    );
  requireCondition(
    typeof options.assetsDirectory === "string" &&
      options.assetsDirectory.length > 0,
    "invalid-directory",
  );
  const assetsDirectory = ensureDirectory(options.assetsDirectory, true);
  const canonical = realpathSync(assetsDirectory);
  const stat = lstatSync(canonical);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new SyncError("unsafe-directory", 409);
  return {
    baseUrl: url.origin,
    workspaceId,
    token: options.token,
    assetsDirectory: canonical,
    timeoutMs,
    admitBytes: options.admitBytes,
  };
}

function assertAssetsDirectory(path: string): string {
  requireCondition(
    typeof path === "string" && path.length > 0,
    "invalid-directory",
  );
  const directory = ensureDirectory(path, false);
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR")
      throw new SyncError("asset-missing", 404);
    throw new SyncError("unsafe-directory", 409);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new SyncError("unsafe-directory", 409);
  return realpathSync(directory);
}

function targetPath(directory: string, asset: WorkspaceBlobAsset): string {
  return containedPath(directory, asset.id);
}

function assertLocalFile(directory: string, asset: WorkspaceBlobAsset): string {
  const path = targetPath(directory, asset);
  const state = localFileState(path);
  if (state.kind === "missing") throw new SyncError("asset-missing", 404);
  if (state.kind === "symlink") throw new SyncError("asset-symlink", 409);
  if (state.kind === "not-file") throw new SyncError("asset-not-file", 409);
  if (state.size !== asset.bytes)
    throw new SyncError("asset-size-mismatch", 422);
  if (state.sha256 !== asset.sha256)
    throw new SyncError("asset-hash-mismatch", 422);
  return path;
}

function assertStagedTarget(
  directory: string,
  asset: WorkspaceBlobAsset,
): boolean {
  const path = targetPath(directory, asset);
  const state = localFileState(path);
  if (state.kind === "missing") return false;
  if (state.kind === "symlink") throw new SyncError("asset-symlink", 409);
  if (state.kind === "not-file") throw new SyncError("asset-not-file", 409);
  if (state.size === asset.bytes && state.sha256 === asset.sha256) {
    // The caller requires a durable verified target before returning. A target
    // that was already present is re-opened without following symlinks and
    // fsynced too, so a later SQLite apply cannot point at only cached bytes.
    const existing = openVerified(path, asset.sha256, asset.bytes);
    if (!existing) throw new SyncError("asset-id-hash-conflict", 409);
    try {
      fsyncFile(existing.descriptor);
    } finally {
      closeQuietly(existing.descriptor);
    }
    return true;
  }
  // Never replace bytes already associated with this immutable ID.
  throw new SyncError("asset-id-hash-conflict", 409);
}

function readChunk(
  descriptor: number,
  position: number,
  length: number,
): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(
      descriptor,
      buffer,
      read,
      length - read,
      position + read,
    );
    if (count === 0) throw new SyncError("asset-changed", 409);
    read += count;
  }
  return buffer;
}

function requestHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" };
}

function blobUrl(options: NormalizedOptions, sha256: string): string {
  return `${options.baseUrl}/v1/workspaces/${options.workspaceId}/blobs/${sha256}`;
}

function requestBlob(
  options: NormalizedOptions,
  asset: WorkspaceBlobAsset,
  method: "GET" | "HEAD" | "PUT",
  headers: Record<string, string>,
  body?: Buffer,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let request: ReturnType<typeof httpRequest>;
    try {
      request = httpRequest(
        blobUrl(options, asset.sha256),
        {
          method,
          headers: { ...requestHeaders(options.token), ...headers },
          agent: false,
          signal: AbortSignal.timeout(options.timeoutMs),
        },
        (response) => {
          response.on("error", () => {
            // The consumer still observes stream failures via async iteration
            // or the terminal response events. This only prevents an unhandled
            // 'error' event when a presence probe is deliberately destroyed.
          });
          resolve(response);
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    request.on("error", reject);
    request.end(body);
  });
}

async function readErrorBody(
  response: IncomingMessage,
): Promise<string | undefined> {
  let text = "";
  let total = 0;
  try {
    for await (const part of response) {
      total += part.length;
      if (total > ERROR_BODY_BYTES) {
        response.destroy();
        return undefined;
      }
      text += part.toString("utf8");
    }
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as { error?: unknown };
    return typeof value.error === "string" &&
      /^[a-z0-9-]{1,100}$/.test(value.error)
      ? value.error
      : undefined;
  } catch {
    return undefined;
  }
}

async function responseError(
  response: IncomingMessage,
  status: number,
): Promise<SyncError> {
  const code = await readErrorBody(response);
  if (status >= 300 && status < 400) return new SyncError("http-redirect", 502);
  if (code) return new SyncError(code, status);
  if (status === 404) return new SyncError("blob-not-found", 404);
  if (status === 401) return new SyncError("unauthorized", 401);
  if (status === 403) return new SyncError("forbidden", 403);
  if (status === 413) return new SyncError("blob-too-large", 413);
  if (status === 416) return new SyncError("range-not-satisfiable", 416);
  if (status === 409) return new SyncError("blob-conflict", 409);
  if (status >= 500) return new SyncError("blob-server-error", status);
  return new SyncError("http-error", status);
}

function headerNumber(
  value: string | string[] | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new SyncError("invalid-response", 502);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new SyncError("invalid-response", 502);
  return parsed;
}

function responseHashMatches(
  value: string | string[] | undefined,
  asset: WorkspaceBlobAsset,
): boolean {
  return (
    value === undefined || (typeof value === "string" && value === asset.sha256)
  );
}

async function probeStoredBlob(
  options: NormalizedOptions,
  asset: WorkspaceBlobAsset,
): Promise<boolean> {
  if (asset.bytes === 0) {
    const response = await requestBlob(options, asset, "GET", {});
    const status = response.statusCode ?? 0;
    if (status === 404) {
      response.resume();
      return false;
    }
    if (status !== 200) throw await responseError(response, status);
    const length = headerNumber(response.headers["content-length"]);
    const verified = responseHashMatches(
      response.headers["x-folio-blob-sha256"],
      asset,
    );
    response.resume();
    return length === 0 && verified;
  }
  const response = await requestBlob(options, asset, "GET", {
    Range: "bytes=0-0",
  });
  const status = response.statusCode ?? 0;
  if (status === 404) {
    response.resume();
    return false;
  }
  if (status === 206) {
    const range = parseResponseRange(response.headers["content-range"]);
    const verified = responseHashMatches(
      response.headers["x-folio-blob-sha256"],
      asset,
    );
    response.destroy();
    return (
      range !== null &&
      range.start === 0 &&
      range.end === 0 &&
      range.total === asset.bytes &&
      verified
    );
  }
  if (status === 200) {
    const length = headerNumber(response.headers["content-length"]);
    const verified = responseHashMatches(
      response.headers["x-folio-blob-sha256"],
      asset,
    );
    response.destroy();
    return length === asset.bytes && verified;
  }
  throw await responseError(response, status);
}

async function serverHas(
  options: NormalizedOptions,
  asset: WorkspaceBlobAsset,
): Promise<boolean> {
  const response = await requestBlob(options, asset, "HEAD", {});
  const status = response.statusCode ?? 0;
  if (status === 200) {
    let length: number | undefined;
    try {
      length = headerNumber(response.headers["content-length"]);
    } catch {
      length = undefined;
    }
    const verified = responseHashMatches(
      response.headers["x-folio-blob-sha256"],
      asset,
    );
    response.resume();
    if (length === asset.bytes && verified) return true;
    // A conflicting HEAD is resolved by the bounded GET probe, not trusted.
    return probeStoredBlob(options, asset);
  }
  if (status === 404 || status === 405 || status === 501) {
    response.resume();
    // HEAD is optional for an integrating transport. A bounded Range probe is
    // the fallback; the server still verifies its stored hash before replying.
    return probeStoredBlob(options, asset);
  }
  throw await responseError(response, status);
}
function parseResponseRange(
  value: string | string[] | undefined,
): { start: number; end: number; total: number } | null {
  if (value === undefined || typeof value !== "string") return null;
  const match = RESPONSE_RANGE.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    end >= total
  )
    return null;
  return { start, end, total };
}

function isTransient(error: unknown): boolean {
  if (error instanceof SyncError) return false;
  const code = errorCode(error);
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_ABORTED" ||
    code === "ABORT_ERR"
  );
}

async function uploadOne(
  options: NormalizedOptions,
  asset: WorkspaceBlobAsset,
  path: string,
): Promise<void> {
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(path, READ_FLAGS);
    } catch {
      throw new SyncError("asset-changed", 409);
    }
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== asset.bytes)
      throw new SyncError("asset-changed", 409);

    if (asset.bytes === 0) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const response = await requestBlob(
            options,
            asset,
            "PUT",
            {
              "Content-Length": "0",
              "Content-Type": "application/octet-stream",
            },
            Buffer.alloc(0),
          );
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            response.resume();
            if (await serverHas(options, asset)) return;
            throw new SyncError("blob-upload-unconfirmed", 502);
          }
          const error = await responseError(response, status);
          if (status >= 500) continue;
          throw error;
        } catch (error) {
          if (isTransient(error)) continue;
          throw error;
        }
      }
      throw new SyncError("blob-transfer-failed", 502);
    }

    let offset = 0;
    if (options.transferJournal) {
      const response = await requestBlob(options, asset, "HEAD", {
        "X-Folio-Blob-Resume": "1",
        "X-Folio-Blob-Bytes": String(asset.bytes),
      });
      const status = response.statusCode ?? 0;
      if (status === 204 && response.headers["x-folio-blob-resume"] === "1") {
        const received = headerNumber(
          response.headers["x-folio-blob-received"],
        );
        const prefix = response.headers["x-folio-blob-prefix-sha256"];
        response.resume();
        requireCondition(
          received !== undefined &&
            received <= asset.bytes &&
            typeof prefix === "string" &&
            HASH.test(prefix),
          "blob-resume-mismatch",
          409,
        );
        requireCondition(
          hashDescriptor(descriptor, received) === prefix,
          "blob-resume-mismatch",
          409,
        );
        offset = received;
        // A crash may leave a full, verified-prefix partial before publish.
        // Re-send only the final slice so the server performs its normal
        // full-hash verification and exclusive publication.
        if (offset === asset.bytes && !(await serverHas(options, asset)))
          offset =
            Math.floor((asset.bytes - 1) / WORKSPACE_BLOB_CHUNK_BYTES) *
            WORKSPACE_BLOB_CHUNK_BYTES;
      } else if ([200, 404, 405, 501].includes(status)) {
        response.resume(); // Older servers may not implement the resume probe.
      } else throw await responseError(response, status);
    }
    let failures = 0;
    while (offset < asset.bytes) {
      const end = Math.min(offset + WORKSPACE_BLOB_CHUNK_BYTES, asset.bytes);
      const bytes = readChunk(descriptor, offset, end - offset);
      try {
        const response = await requestBlob(
          options,
          asset,
          "PUT",
          {
            "Content-Length": String(bytes.length),
            "Content-Range": `bytes ${offset}-${end - 1}/${asset.bytes}`,
            "Content-Type": "application/octet-stream",
          },
          bytes,
        );
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          const acknowledged = headerNumber(
            response.headers["x-folio-blob-received"],
          );
          response.resume();
          if (acknowledged !== undefined && acknowledged !== end) {
            throw new SyncError("blob-offset-mismatch", 409);
          }
          offset = end;
          failures = 0;
          continue;
        }
        const error = await responseError(response, status);
        if (
          status === 409 &&
          (error.code === "blob-offset-mismatch" ||
            error.code === "blob-conflict")
        ) {
          failures++;
          if (failures > MAX_ATTEMPTS)
            throw new SyncError("blob-transfer-failed", 502);
          offset = 0;
          continue;
        }
        if (status >= 500) {
          failures++;
          if (failures > MAX_ATTEMPTS)
            throw new SyncError("blob-transfer-failed", 502);
          continue;
        }
        throw error;
      } catch (error) {
        if (isTransient(error)) {
          failures++;
          if (failures > MAX_ATTEMPTS)
            throw new SyncError("blob-transfer-failed", 502);
          continue;
        }
        throw error;
      }
    }
    if (!(await serverHas(options, asset)))
      throw new SyncError("blob-upload-unconfirmed", 502);
  } finally {
    closeQuietly(descriptor);
  }
}

function fsyncFile(descriptor: number): void {
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (errorCode(error) === "ENOSPC")
      throw new SyncError("insufficient-storage", 507);
    throw new SyncError("durable-write-failed", 500);
  }
}

function publishStaged(
  temporary: string,
  target: string,
  directory: string,
  asset: WorkspaceBlobAsset,
): void {
  let linked = false;
  try {
    linkSync(temporary, target);
    linked = true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      const existing = openVerified(target, asset.sha256, asset.bytes);
      if (!existing) throw new SyncError("asset-id-hash-conflict", 409);
      try {
        fsyncFile(existing.descriptor);
      } finally {
        closeQuietly(existing.descriptor);
      }
    } else if (errorCode(error) === "ENOSPC") {
      throw new SyncError("insufficient-storage", 507);
    } else {
      throw new SyncError("asset-publish-failed", 500);
    }
  }
  if (linked) {
    try {
      syncPath(directory);
    } catch (error) {
      if (errorCode(error) === "ENOSPC")
        throw new SyncError("insufficient-storage", 507);
      throw new SyncError("durable-write-failed", 500);
    }
  }
  unlinkQuietly(temporary);
  if (!linked) {
    try {
      syncPath(directory);
    } catch (error) {
      if (errorCode(error) === "ENOSPC")
        throw new SyncError("insufficient-storage", 507);
      throw new SyncError("durable-write-failed", 500);
    }
  }
}

async function downloadOne(
  options: NormalizedOptions,
  asset: WorkspaceBlobAsset,
  directory: string,
): Promise<void> {
  const target = targetPath(directory, asset);
  const journal = options.transferJournal;
  let record = journal?.begin({
    direction: "download",
    assetId: asset.id,
    sha256: asset.sha256,
    bytes: asset.bytes,
  });
  if (record)
    requireCondition(
      record.state === "active",
      "blob-transfer-state-conflict",
      409,
    );
  let temporary = join(
    directory,
    `.folio-blob-${randomBytes(16).toString("hex")}.part`,
  );
  let descriptor: number | undefined;
  let partial: BlobTransferPartial | undefined;
  const checkpoint = (offset: number) => {
    if (journal && record && partial && offset > record.offset)
      record = journal.checkpoint(
        record.key,
        offset,
        checkpointBlobTransferPartial(partial, offset),
      );
  };
  try {
    try {
      if (journal && record) {
        partial = openBlobTransferPartial(journal.directory, record);
        temporary = partial.path;
        descriptor = partial.descriptor;
      } else
        descriptor = openSync(
          temporary,
          WRITE_FLAGS | fsConstants.O_EXCL,
          0o600,
        );
    } catch (error) {
      if (error instanceof SyncError) throw error;
      if (errorCode(error) === "ENOSPC")
        throw new SyncError("insufficient-storage", 507);
      throw new SyncError("asset-staging-failed", 500);
    }

    // The pinned owned partial already counts in the workspace budget. Only
    // its remaining bytes are additional; publication uses the same inode.
    options.assertTransferBudget?.(
      asset.bytes - (record?.offset ?? 0) + 8 * 1024 * 1024,
    );

    if (asset.bytes === 0) {
      const response = await requestBlob(options, asset, "GET", {});
      const status = response.statusCode ?? 0;
      if (status !== 200) throw await responseError(response, status);
      const length = headerNumber(response.headers["content-length"]);
      if (length !== undefined && length !== 0) {
        response.destroy();
        throw new SyncError("blob-size-mismatch", 422);
      }
      response.resume();
    } else {
      let offset = partial?.offset ?? 0;
      let failures = 0;
      while (offset < asset.bytes) {
        checkpoint(offset);
        const end = Math.min(offset + WORKSPACE_BLOB_CHUNK_BYTES, asset.bytes);
        let response: IncomingMessage;
        try {
          response = await requestBlob(options, asset, "GET", {
            Range: `bytes=${offset}-${end - 1}`,
          });
        } catch (error) {
          if (isTransient(error)) {
            failures++;
            if (failures > MAX_ATTEMPTS)
              throw new SyncError("blob-transfer-failed", 502);
            continue;
          }
          throw error;
        }
        const status = response.statusCode ?? 0;

        if (status === 200) {
          // The peer ignored Range. Only a full-body response from offset zero
          // is usable; anything else restarts this staged transfer.
          const length = headerNumber(response.headers["content-length"]);
          if (
            offset !== 0 ||
            (length !== undefined && length !== asset.bytes)
          ) {
            response.destroy();
            if (journal) throw new SyncError("blob-range-mismatch", 502);
            ftruncateSync(descriptor, 0);
            offset = 0;
            failures++;
            if (failures > MAX_ATTEMPTS)
              throw new SyncError("blob-range-mismatch", 502);
            continue;
          }
          try {
            let received = 0;
            for await (const part of response) {
              if (received + part.length > asset.bytes) {
                response.destroy();
                throw new SyncError("blob-size-mismatch", 422);
              }
              writeAll(descriptor, part, received);
              received += part.length;
              if (
                record &&
                received - record.offset >= WORKSPACE_BLOB_CHUNK_BYTES
              )
                checkpoint(received);
            }
            if (received !== asset.bytes)
              throw new SyncError("blob-transfer-failed", 502);
            offset = received;
            failures = 0;
          } catch (error) {
            if (error instanceof SyncError) throw error;
            const staged = fstatSync(descriptor).size;
            offset = staged;
            failures++;
            if (failures > MAX_ATTEMPTS)
              throw new SyncError("blob-transfer-failed", 502);
          }
          continue;
        }

        if (status === 206) {
          const range = parseResponseRange(response.headers["content-range"]);
          if (
            range === null ||
            range.start !== offset ||
            range.end !== end - 1 ||
            range.total !== asset.bytes
          ) {
            response.destroy();
            throw new SyncError("blob-range-mismatch", 502);
          }
          const expected = end - offset;
          const length = headerNumber(response.headers["content-length"]);
          if (length !== undefined && length !== expected) {
            response.destroy();
            throw new SyncError("blob-size-mismatch", 422);
          }
          try {
            let received = 0;
            for await (const part of response) {
              if (received + part.length > expected) {
                response.destroy();
                throw new SyncError("blob-size-mismatch", 422);
              }
              writeAll(descriptor, part, offset + received);
              received += part.length;
            }
            if (received !== expected) {
              offset = fstatSync(descriptor).size;
              failures++;
              if (failures > MAX_ATTEMPTS)
                throw new SyncError("blob-transfer-failed", 502);
              continue;
            }
            offset = end;
            failures = 0;
          } catch (error) {
            if (error instanceof SyncError) throw error;
            offset = fstatSync(descriptor).size;
            failures++;
            if (failures > MAX_ATTEMPTS)
              throw new SyncError("blob-transfer-failed", 502);
          }
          continue;
        }

        const error = await responseError(response, status);
        if (status === 416 && fstatSync(descriptor).size === asset.bytes) break;
        if (status >= 500) {
          failures++;
          if (failures > MAX_ATTEMPTS)
            throw new SyncError("blob-transfer-failed", 502);
          continue;
        }
        throw error;
      }
      checkpoint(offset);
    }

    fsyncFile(descriptor);
    closeQuietly(descriptor);
    descriptor = undefined;

    const verified = openVerified(temporary, asset.sha256, asset.bytes);
    if (!verified) throw new SyncError("blob-hash-mismatch", 422);
    closeQuietly(verified.descriptor);
    publishStaged(temporary, target, directory, asset);
    if (journal && record) {
      syncPath(journal.directory);
      journal.complete(record.key);
    }
  } catch (error) {
    closeQuietly(descriptor);
    if (!journal) unlinkQuietly(temporary);
    else if (
      record &&
      error instanceof SyncError &&
      /unsafe|hash-mismatch|prefix-mismatch|partial-missing|state-conflict|changed/.test(
        error.code,
      )
    ) {
      try {
        journal.block(record.key, error.code);
      } catch {
        /* Keep the first failure and durable evidence. */
      }
    }
    throw error;
  }
}

async function withClientTransfer<T>(
  options: WorkspaceBlobClientOptions,
  direction: "download" | "upload",
  work: (normalized: NormalizedOptions) => Promise<T>,
): Promise<T> {
  const normalized = normalizeClientOptions(options);
  if (options.transfer?.workspaceDirectory) {
    const workspaceDirectory = realpathSync(
      assertAssetsDirectory(options.transfer.workspaceDirectory),
    );
    const cacheRoot = ensureDirectory(
      join(workspaceDirectory, ".folio-sync-transfers"),
      true,
    );
    const transfer = options.transfer;
    const scopeName = hashText(canonicalJson(transfer.scope));
    const directory = join(cacheRoot, scopeName);
    requireCondition(
      resolve(transfer.directory) === directory ||
        resolve(transfer.directory) ===
          join(
            resolve(transfer.workspaceDirectory!),
            ".folio-sync-transfers",
            scopeName,
          ),
      "blob-transfer-scope-mismatch",
      409,
    );
    return withBlobUploadLock(cacheRoot, () =>
      withClientTransfer(
        {
          ...options,
          transfer: { directory, scope: transfer.scope },
        },
        direction,
        (n) => {
          n.assertTransferBudget = (additionalBytes) => {
            const budget = inspectWorkspaceTransferBudget(workspaceDirectory);
            requireCondition(
              !budget.overLimit &&
                Number.isSafeInteger(additionalBytes) &&
                additionalBytes >= 0 &&
                budget.bytes + additionalBytes <= 128 * 1024 * 1024,
              "blob-transfer-budget-held",
              409,
            );
          };
          n.assertTransferBudget(0);
          return work(n);
        },
      ),
    );
  }
  let journal: BlobTransferJournal | undefined;
  try {
    if (options.transfer) {
      requireCondition(
        options.transfer.scope.baseUrlHash === hashText(normalized.baseUrl) &&
          options.transfer.scope.workspaceId === normalized.workspaceId,
        "blob-transfer-scope-mismatch",
        409,
      );
      journal = new BlobTransferJournal(
        join(
          options.transfer.directory,
          direction + "-" + hashText(normalized.assetsDirectory),
        ),
        options.transfer.scope,
      );
      normalized.transferJournal = journal;
      // Recover the hard-link publication window before rejecting nlink=2 in
      // the read-only inventory. Only full, verified destination bytes count.
      if (direction === "download") {
        for (const record of journal.inventory()) {
          if (record.state === "blocked") continue;
          const asset = validateAsset({
            id: record.assetId,
            sha256: record.sha256,
            bytes: record.bytes,
          });
          if (
            record.direction === "download" &&
            assertStagedTarget(normalized.assetsDirectory, asset)
          ) {
            reconcilePublishedPartial(
              journal.directory,
              record,
              targetPath(normalized.assetsDirectory, asset),
            );
            journal.complete(record.key);
          }
        }
        journal.compactCompleted();
      }
      const inventory = inspectBlobTransferInventory(
        journal.directory,
        journal.inventory(),
        { maxBytes: 100 * 1024 * 1024 },
      );
      requireCondition(
        !inventory.overLimit &&
          inventory.unsafeCount === 0 &&
          !inventory.items.some((item) => item.kind === "orphan"),
        "blob-transfer-cache-held",
        409,
      );
    }
    return await work(normalized);
  } finally {
    journal?.close();
  }
}

/** Upload every manifest asset that the server does not already hold. */
export async function uploadCheckpointAssets(
  options: WorkspaceBlobClientOptions,
  assets: readonly WorkspaceBlobAsset[],
): Promise<void> {
  return withClientTransfer(options, "upload", async (normalized) => {
    const manifest = normalizeAssets(assets);
    const sources = new Map<string, string>();
    for (const asset of manifest)
      sources.set(asset.id, assertLocalFile(normalized.assetsDirectory, asset));
    const missing: WorkspaceBlobAsset[] = [];
    for (const asset of manifest) {
      if (!(await serverHas(normalized, asset))) missing.push(asset);
    }
    // Admission is a preflight over all writes. A refusal happens before any
    // request body is sent, so retrying after freeing space starts cleanly.
    if (missing.length)
      normalized.admitBytes?.(
        missing.reduce((total, asset) => total + asset.bytes, 0),
      );
    for (const asset of missing)
      await uploadOne(normalized, asset, sources.get(asset.id)!);
  });
}

/**
 * Download missing manifest assets into the workspace asset directory. An
 * existing file with the same ID but different bytes is immutable and causes a
 * refusal. Verified files are fsynced and published without overwriting.
 */
export async function stageCheckpointAssets(
  options: WorkspaceBlobClientOptions,
  assets: readonly WorkspaceBlobAsset[],
): Promise<void> {
  return withClientTransfer(options, "download", async (normalized) => {
    const manifest = normalizeAssets(assets);
    const missing: WorkspaceBlobAsset[] = [];
    for (const asset of manifest) {
      if (!assertStagedTarget(normalized.assetsDirectory, asset))
        missing.push(asset);
    }
    if (missing.length)
      normalized.admitBytes?.(
        missing.reduce((total, asset) => total + asset.bytes, 0),
      );
    for (const asset of missing) {
      await downloadOne(normalized, asset, normalized.assetsDirectory);
      normalized.transferJournal?.compactCompleted();
    }
    normalized.transferJournal?.compactCompleted();
  });
}

/** Revalidate all attachment bytes immediately before the SQLite apply step. */
export function assertWorkspaceAssets(
  assetsDirectory: string,
  assets: readonly WorkspaceBlobAsset[],
): void {
  const manifest = normalizeAssets(assets);
  const directory = assertAssetsDirectory(assetsDirectory);
  for (const asset of manifest) assertLocalFile(directory, asset);
}

/**
 * Publish previously downloaded, verified staging files without network access.
 * The two directories must be distinct. A fresh copy prevents a later change
 * to a staged inode from altering an already published asset. On failure the
 * database has not been changed; previously published files are harmless
 * unreferenced assets and retries validate them before reuse.
 */
export function publishCheckpointAssetsFromStaging(
  stagingDirectory: string,
  assetsDirectory: string,
  assets: readonly WorkspaceBlobAsset[],
  admitBytes?: (bytes: number) => void,
): void {
  const manifest = normalizeAssets(assets);
  const staging = assertAssetsDirectory(stagingDirectory);
  const active = assertAssetsDirectory(assetsDirectory);
  requireCondition(staging !== active, "asset-staging-directory-conflict", 409);
  const missing: WorkspaceBlobAsset[] = [];
  for (const asset of manifest) {
    // Earlier applied revisions may have released this shared staging copy.
    // Reuse only a fully verified active target; conflicting bytes still fail.
    if (assertStagedTarget(active, asset)) continue;
    assertLocalFile(staging, asset);
    missing.push(asset);
  }
  if (missing.length)
    admitBytes?.(missing.reduce((total, asset) => total + asset.bytes, 0));
  for (const asset of missing) {
    const source = openVerified(
      targetPath(staging, asset),
      asset.sha256,
      asset.bytes,
    );
    if (!source) throw new SyncError("asset-changed", 409);
    const temporary = join(
      active,
      `.folio-blob-${randomBytes(16).toString("hex")}.part`,
    );
    let output: number | undefined;
    try {
      output = openSync(temporary, WRITE_FLAGS | fsConstants.O_EXCL, 0o600);
      for (let position = 0; position < asset.bytes;) {
        const size = Math.min(
          WORKSPACE_BLOB_CHUNK_BYTES,
          asset.bytes - position,
        );
        writeAll(
          output,
          readChunk(source.descriptor, position, size),
          position,
        );
        position += size;
      }
      fsyncFile(output);
      closeSync(output);
      output = undefined;
      const verified = openVerified(temporary, asset.sha256, asset.bytes);
      if (!verified) throw new SyncError("asset-changed", 409);
      closeQuietly(verified.descriptor);
      publishStaged(temporary, targetPath(active, asset), active, asset);
    } finally {
      closeQuietly(source.descriptor);
      closeQuietly(output);
      unlinkQuietly(temporary);
    }
  }
  assertWorkspaceAssets(active, manifest);
}

/** After a confirmed apply only. Release recorded staging bytes only when an
 * independent verified active copy exists. Unknown files are never swept. */
export function reclaimAppliedStaging(
  stagingDirectory: string,
  assetsDirectory: string,
  assets: readonly WorkspaceBlobAsset[],
): { removed: number; held: number } {
  const result = { removed: 0, held: 0 };
  let staging: string, active: string;
  try {
    staging = assertAssetsDirectory(stagingDirectory);
    active = assertAssetsDirectory(assetsDirectory);
    requireCondition(
      staging !== active,
      "asset-staging-directory-conflict",
      409,
    );
  } catch {
    return { removed: 0, held: assets.length };
  }
  const rootPin = lstatSync(staging);
  for (const asset of normalizeAssets(assets)) {
    let source: ReturnType<typeof openVerified> = null,
      destination: ReturnType<typeof openVerified> = null;
    try {
      const path = targetPath(staging, asset),
        current = localFileState(path);
      if (current.kind === "missing") continue;
      destination = openVerified(
        targetPath(active, asset),
        asset.sha256,
        asset.bytes,
      );
      source = openVerified(path, asset.sha256, asset.bytes);
      requireCondition(source && destination, "asset-changed", 409);
      const sourcePin = fstatSync(source.descriptor),
        destinationPin = fstatSync(destination.descriptor),
        listed = lstatSync(path),
        root = lstatSync(staging);
      requireCondition(
        sourcePin.nlink === 1 &&
          !listed.isSymbolicLink() &&
          listed.isFile() &&
          listed.nlink === 1 &&
          listed.dev === sourcePin.dev &&
          listed.ino === sourcePin.ino &&
          (destinationPin.dev !== sourcePin.dev ||
            destinationPin.ino !== sourcePin.ino) &&
          root.isDirectory() &&
          !root.isSymbolicLink() &&
          root.dev === rootPin.dev &&
          root.ino === rootPin.ino,
        "asset-changed",
        409,
      );
      unlinkSync(path);
      syncPath(staging);
      result.removed++;
    } catch {
      result.held++;
    } finally {
      closeQuietly(source?.descriptor);
      closeQuietly(destination?.descriptor);
    }
  }
  return result;
}
