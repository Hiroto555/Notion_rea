import { randomUUID, createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import type { Doc } from "../src/shared/types";
import type {
  Attempt,
  AuthContext,
  Command,
  Scope,
} from "../src/collaboration/runtime/contract";
import { canonical } from "../src/collaboration/runtime/canonical";
import { parseCanonicalWire } from "../src/collaboration/runtime/wire";
import {
  validateRuntimeBackup,
  type RuntimeBackup,
} from "../src/collaboration/runtime/backup";
import {
  BACKUP_HASH_HEADER,
  BACKUP_WIRE_MAX_BYTES,
  handleSharedBackupRequest,
} from "../src/collaboration/runtime/backup-http";
import { SharedBackupProvider } from "../src/collaboration/runtime/backup-provider";

type Fixture = {
  directory: string;
  authority: SharedAuthority;
  token: string;
  orgId: string;
  auth: AuthContext;
  scope: Scope;
};

const fixtures: Fixture[] = [];
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.authority.close();
    } catch {
      /* already closed by a failed test */
    }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

const testDocument: Doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "blockD41" },
      content: [{ type: "text", text: "shared backup fixture" }],
    },
  ],
};

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "folio-backup-http-"));
  const authority = new SharedAuthority(directory);
  const boot = authority.bootstrap({
    orgId: "orgD41",
    userId: "userD41",
    deviceId: "deviceD41",
    workspaceId: "workspaceD41",
    documentId: "documentD41",
    document: testDocument,
  });
  const created = {
    directory,
    authority,
    token: boot.token,
    orgId: "orgD41",
    auth: boot.auth,
    scope: boot.scope,
  };
  fixtures.push(created);
  return created;
}

function attempt(
  authority: SharedAuthority,
  auth: AuthContext,
  scope: Scope,
  command: Command,
): Attempt {
  const base = authority.head();
  return {
    v: 1,
    attemptId: randomUUID(),
    base,
    intent: {
      v: 1,
      intentId: randomUUID(),
      writerId: auth.writerId,
      scope,
      base,
      command,
    },
  };
}

function startBackupServer(endpoint: {
  backup?: (token: string, orgId: string) => RuntimeBackup;
}) {
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const state: { token: string | null } = { token: null };
      void handleSharedBackupRequest(endpoint, request, response, state)
        .then((matched) => {
          if (matched || response.headersSent) return;
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not found");
        })
        .catch(() => {
          if (response.headersSent) response.destroy();
          else {
            response.writeHead(500, { "content-type": "text/plain" });
            response.end("internal");
          }
        });
    },
  );
  return listen(server);
}

async function listen(server: ReturnType<typeof createServer>) {
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
  if (!address || typeof address === "string") throw new Error("NO_ADDRESS");
  const url = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  };
  closers.push(close);
  return { url, close };
}

function startFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  return listen(createServer(handler));
}

async function backupRequest(
  url: string,
  token: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/v1/backup`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

async function errorBody(response: Response): Promise<string> {
  const raw = await response.text();
  const parsed = parseCanonicalWire(raw, 1024) as {
    v: number;
    ok: boolean;
    error: string;
  };
  expect(parsed.v).toBe(1);
  expect(parsed.ok).toBe(false);
  expect(raw).toBe(canonical(parsed, 1024));
  return parsed.error;
}

function largeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const pattern = "folio-shared-backup-large-fixture\n";
  for (let index = 0; index < bytes.byteLength; index++)
    bytes[index] = pattern.charCodeAt(index % pattern.length);
  return bytes;
}

describe("shared runtime backup HTTP", () => {
  it("exports a canonical RuntimeBackup with exact content and required headers", async () => {
    const { authority, token, orgId } = fixture();
    const expected = authority.backup(token, orgId);
    const server = await startBackupServer(authority);

    const response = await backupRequest(
      server.url,
      token,
      canonical({ orgId }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get(BACKUP_HASH_HEADER)).toBe(expected.hash);

    const raw = await response.text();
    expect(raw).toBe(canonical(expected, 256_000_000));
    const parsed = validateRuntimeBackup(
      parseCanonicalWire(raw, BACKUP_WIRE_MAX_BYTES),
    );
    expect(parsed.head).toEqual(expected.head);
    expect(parsed.hash).toBe(expected.hash);
    expect(parsed.records.length).toBe(expected.records.length);
  });

  it("downloads the raw canonical body unchanged and rejects use after close", async () => {
    const { authority, token, orgId } = fixture();
    const expected = authority.backup(token, orgId);
    const server = await startBackupServer(authority);

    const provider = new SharedBackupProvider(server.url, token);
    const download = await provider.download(orgId);
    expect(download.raw).toBe(canonical(expected, 256_000_000));
    expect(download.hash).toBe(expected.hash);
    expect(download.head).toEqual(expected.head);
    expect(validateRuntimeBackup(JSON.parse(download.raw)).hash).toBe(
      expected.hash,
    );

    provider.close();
    await expect(provider.download(orgId)).rejects.toMatchObject({
      code: "CLOSED",
    });
  });

  it("rejects malformed, cross-origin, cookie, query and oversized requests", async () => {
    const { authority, token, orgId } = fixture();
    const server = await startBackupServer(authority);
    const body = canonical({ orgId });

    const get = await fetch(`${server.url}/v1/backup`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.status).toBe(405);
    expect(await errorBody(get)).toBe("METHOD_NOT_ALLOWED");

    const origin = await backupRequest(server.url, token, body, {
      origin: "http://example.com",
    });
    expect(origin.status).toBe(403);
    expect(await errorBody(origin)).toBe("ORIGIN_REJECTED");

    const cookie = await backupRequest(server.url, token, body, {
      cookie: "session=1",
    });
    expect(cookie.status).toBe(400);
    expect(await errorBody(cookie)).toBe("COOKIE_REJECTED");

    const query = await fetch(`${server.url}/v1/backup?x=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
    });
    expect(query.status).toBe(400);
    expect(await errorBody(query)).toBe("QUERY_REJECTED");

    const nonCanonical = await backupRequest(
      server.url,
      token,
      `{"orgId":"${orgId}"} `,
    );
    expect(nonCanonical.status).toBe(400);
    expect(await errorBody(nonCanonical)).toBe("NON_CANONICAL_WIRE");

    const extraKey = await backupRequest(
      server.url,
      token,
      canonical({ orgId, extra: true }),
    );
    expect(extraKey.status).toBe(400);
    expect(await errorBody(extraKey)).toBe("INVALID_REQUEST");

    const oversized = await backupRequest(server.url, token, "x".repeat(1001));
    expect(oversized.status).toBe(413);
    expect(await errorBody(oversized)).toBe("REQUEST_TOO_LARGE");

    const missingToken = await fetch(`${server.url}/v1/backup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(missingToken.status).toBe(401);
    expect(await errorBody(missingToken)).toBe("TOKEN_INVALID");

    const otherPath = await fetch(`${server.url}/v1/assetread`, {
      method: "POST",
    });
    expect(otherPath.status).toBe(404);
  });

  it("rejects a revoked session token", async () => {
    const { authority, token, orgId, auth } = fixture();
    const invite = authority.invite(token, orgId, auth.userId);
    const replacement = authority.join(invite, orgId, "replacementDevice");
    authority.revokeDevice(replacement.token, orgId, auth.deviceId);
    const server = await startBackupServer(authority);

    const response = await backupRequest(
      server.url,
      token,
      canonical({ orgId }),
    );
    expect(response.status).toBe(401);
    expect(await errorBody(response)).toBe("TOKEN_INVALID");
  });

  it("forbids an organization owner with no explicit workspace read role", async () => {
    const { authority, token, orgId } = fixture();
    const inviteToken = authority.invite(token, orgId, "userD41b");
    const joined = authority.acceptInvite(inviteToken, "deviceD41b");
    authority.handoff(token, orgId, "userD41b", []);

    expect(() => authority.backup(joined.token, orgId)).toThrow("FORBIDDEN");

    const server = await startBackupServer(authority);
    const response = await backupRequest(
      server.url,
      joined.token,
      canonical({ orgId }),
    );
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toBe("FORBIDDEN");
  });

  it("round-trips a backup larger than 8 MiB through the stream", async () => {
    const { authority, token, orgId, auth, scope } = fixture();
    const bytes = largeBytes(7 * 1024 * 1024);
    const staged = authority.stageAsset(token, scope, "uploadD41", bytes);
    const publish = attempt(authority, auth, scope, {
      kind: "resource",
      action: "asset.publish",
      payload: { uploadId: "uploadD41", hash: staged.hash },
    });
    expect(authority.submit(token, publish).status).toBe("SERVER_ACCEPTED");
    expect(staged.hash).toBe(createHash("sha256").update(bytes).digest("hex"));

    const expected = authority.backup(token, orgId);
    expect(Buffer.byteLength(canonical(expected, 256_000_000))).toBeGreaterThan(
      8 * 1024 * 1024,
    );

    const server = await startBackupServer(authority);
    const provider = new SharedBackupProvider(server.url, token);
    const download = await provider.download(orgId);
    expect(download.raw).toBe(canonical(expected, 256_000_000));
    expect(download.hash).toBe(expected.hash);
    const parsed = validateRuntimeBackup(
      parseCanonicalWire(download.raw, BACKUP_WIRE_MAX_BYTES),
    );
    expect(parsed.blobs).toHaveLength(expected.blobs.length);
    expect(parsed.blobs.some((blob) => blob.hash === staged.hash)).toBe(true);
  });

  it("rejects invalid endpoints before opening a connection", () => {
    expect(
      () => new SharedBackupProvider("http://example.com:80", "t".repeat(32)),
    ).toThrow("INVALID_URL");
    expect(
      () => new SharedBackupProvider("http://127.0.0.1:1/path", "t".repeat(32)),
    ).toThrow("INVALID_URL");
  });

  it("rejects a mismatched hash header from a fake read-only response", async () => {
    const { authority, token, orgId } = fixture();
    const raw = canonical(authority.backup(token, orgId));
    const server = await startFakeServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(raw)),
        [BACKUP_HASH_HEADER]: "0".repeat(64),
      });
      response.end(raw);
    });
    const provider = new SharedBackupProvider(server.url, token);
    await expect(provider.download(orgId)).rejects.toMatchObject({
      code: "BACKUP_HASH_MISMATCH",
    });
  });

  it("rejects truncated streams and oversized declared responses", async () => {
    const { token, orgId } = fixture();
    const truncated = await startFakeServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "1000",
      });
      response.flushHeaders();
      response.write('{"format":"folio-shared-runtime-backup/1"');
      setTimeout(() => response.destroy(), 25);
    });
    const first = new SharedBackupProvider(truncated.url, token);
    await expect(first.download(orgId)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    const oversized = await startFakeServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(BACKUP_WIRE_MAX_BYTES + 1),
      });
      response.end();
    });
    const second = new SharedBackupProvider(oversized.url, token);
    await expect(second.download(orgId)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("rejects redirects from a fake read-only response", async () => {
    const { token, orgId } = fixture();
    const server = await startFakeServer((request, response) => {
      request.resume();
      response.writeHead(302, { location: "http://127.0.0.1:1/v1/backup" });
      response.end();
    });
    const provider = new SharedBackupProvider(server.url, token);
    await expect(provider.download(orgId)).rejects.toMatchObject({
      code: "REDIRECT_REJECTED",
    });
  });
});
