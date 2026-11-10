import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import {
  ASSET_MAX_BYTES,
  handleSharedAssetRequest,
  type AssetEndpoint,
} from "../src/collaboration/runtime/asset-http";
import { SharedAssetProvider } from "../src/collaboration/runtime/asset-provider";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  CollaborationError,
  type Scope,
} from "../src/collaboration/runtime/contract";

const DOCUMENT = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "paragraph-one" },
      content: [{ type: "text", text: "asset transport test" }],
    },
  ],
};

type Fixture = {
  directory: string;
  authority: SharedAuthority;
  token: string;
  scope: Scope;
  auth: ReturnType<SharedAuthority["bootstrap"]>["auth"];
  url: string;
  server: Server;
  matches: boolean[];
  close(): Promise<void>;
};

function assetListener(endpoint: AssetEndpoint, matches: boolean[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const state: { token: string | null } = { token: null };
    void handleSharedAssetRequest(endpoint, request, response, state)
      .then((matched) => {
        matches.push(matched);
        if (matched) return;
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"NOT_FOUND"}');
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("INVALID_ADDRESS");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "folio-asset-http-"));
  const authority = new SharedAuthority(directory);
  const boot = authority.bootstrap({
    orgId: "org-assets",
    userId: "owner-user",
    deviceId: "owner-device",
    workspaceId: "workspace-assets",
    documentId: "document-assets",
    document: DOCUMENT,
  });
  const matches: boolean[] = [];
  const server = createServer(assetListener(authority, matches));
  const url = await listen(server);
  return {
    directory,
    authority,
    token: boot.token,
    scope: boot.scope,
    auth: boot.auth,
    url,
    server,
    matches,
    async close() {
      await closeServer(server);
      authority.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function encodedScope(scope: Scope): string {
  return Buffer.from(canonical(scope), "utf8").toString("base64url");
}

function stage(
  url: string,
  token: string,
  scope: Scope,
  uploadId: string,
  bytes: Uint8Array,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/v1/assetstage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-folio-scope": encodedScope(scope),
      "x-folio-upload": uploadId,
      ...extra,
    },
    body: Uint8Array.from(bytes).buffer,
    redirect: "error",
  });
}

async function rawRequest(
  target: string,
  method: string,
  headers: Record<string, string>,
  body: Uint8Array,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function rawStream(
  target: string,
  method: string,
  headers: Record<string, string>,
  chunks: Uint8Array[],
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { method, headers }, (response) => {
      const body: Buffer[] = [];
      response.on("data", (chunk: Buffer) => body.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(body),
        }),
      );
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function read(
  url: string,
  token: string,
  scope: Scope,
  hash: string,
): Promise<Response> {
  return fetch(`${url}/v1/assetread`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: canonical({ scope, hash }),
    redirect: "error",
  });
}

function publish(fixtureValue: Fixture, uploadId: string, hash: string) {
  const base = fixtureValue.authority.head();
  return fixtureValue.authority.submit(fixtureValue.token, {
    v: 1,
    attemptId: randomUUID(),
    base,
    intent: {
      v: 1,
      intentId: randomUUID(),
      writerId: fixtureValue.auth.writerId,
      scope: fixtureValue.scope,
      base,
      command: {
        kind: "resource" as const,
        action: "asset.publish",
        payload: { uploadId, hash },
      },
    },
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

const temporary: Fixture[] = [];
const extraServers: Server[] = [];

afterEach(async () => {
  while (temporary.length) {
    const value = temporary.pop()!;
    await value.close();
  }
  while (extraServers.length) {
    await closeServer(extraServers.pop()!);
  }
});

describe("shared asset HTTP transport", () => {
  it("returns false for unrelated paths and enforces strict asset requests", async () => {
    const f = await fixture();
    temporary.push(f);

    const unrelated = await fetch(`${f.url}/v1/snapshot`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(unrelated.status).toBe(404);
    expect(f.matches.at(-1)).toBe(false);

    const wrongMethod = await fetch(`${f.url}/v1/assetstage`, {
      method: "GET",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(wrongMethod.status).toBe(405);
    expect(f.matches.at(-1)).toBe(true);

    const origin = await rawRequest(
      `${f.url}/v1/assetstage`,
      "POST",
      {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/octet-stream",
        "x-folio-scope": encodedScope(f.scope),
        "x-folio-upload": "upload-origin",
        origin: "https://example.test",
      },
      Buffer.from("x"),
    );
    expect(origin.status).toBe(403);

    const cookie = await rawRequest(
      `${f.url}/v1/assetstage`,
      "POST",
      {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/octet-stream",
        "x-folio-scope": encodedScope(f.scope),
        "x-folio-upload": "upload-cookie",
        cookie: "session=1",
      },
      Buffer.from("x"),
    );
    expect(cookie.status).toBe(400);

    const query = await fetch(`${f.url}/v1/assetstage?x=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/octet-stream",
        "x-folio-scope": encodedScope(f.scope),
        "x-folio-upload": "upload-query",
      },
      body: Buffer.from("x"),
    });
    expect(query.status).toBe(400);

    const noToken = await fetch(`${f.url}/v1/assetstage`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-folio-scope": encodedScope(f.scope),
        "x-folio-upload": "upload-no-token",
      },
      body: Buffer.from("x"),
    });
    expect(noToken.status).toBe(401);

    const queryToken = await fetch(`${f.url}/v1/assetstage?token=${f.token}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/octet-stream",
        "x-folio-scope": encodedScope(f.scope),
        "x-folio-upload": "upload-query-token",
      },
      body: Buffer.from("x"),
    });
    expect(queryToken.status).toBe(400);
  });

  it("stages, publishes and reads exact bytes through the authority", async () => {
    const f = await fixture();
    temporary.push(f);
    const bytes = Buffer.from("authenticated asset payload", "utf8");
    const uploadId = "upload-success";

    const staged = await stage(f.url, f.token, f.scope, uploadId, bytes);
    expect(staged.status).toBe(200);
    const stagedBody = await json(staged);
    expect(stagedBody.v).toBe(1);
    expect(stagedBody.ok).toBe(true);
    const result = stagedBody.result as { hash: string; bytes: number };
    expect(result.hash).toBe(sha256(bytes));
    expect(result.bytes).toBe(bytes.byteLength);

    const receipt = publish(f, uploadId, result.hash);
    expect(receipt.status).toBe("SERVER_ACCEPTED");

    const response = await read(f.url, f.token, f.scope, result.hash);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-folio-sha256")).toBe(result.hash);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    const provider = new SharedAssetProvider(f.url, f.token);
    const providerBytes = Buffer.from("provider transport payload", "utf8");
    const providerResult = await provider.stage(
      f.scope,
      "provider-upload",
      providerBytes,
    );
    expect(providerResult).toEqual({
      hash: sha256(providerBytes),
      bytes: providerBytes.byteLength,
    });
    expect(publish(f, "provider-upload", providerResult.hash).status).toBe(
      "SERVER_ACCEPTED",
    );
    expect(
      Buffer.from(await provider.read(f.scope, providerResult.hash)),
    ).toEqual(providerBytes);
    provider.close();
    await expect(
      provider.read(f.scope, providerResult.hash),
    ).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("refuses a real payload larger than 20 MiB", async () => {
    const f = await fixture();
    temporary.push(f);
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const chunks = Array.from({ length: 20 }, () => chunk).concat([
      Buffer.alloc(1, 7),
    ]);
    const response = await rawStream(
      `${f.url}/v1/assetstage`,
      "POST",
      {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/octet-stream",
        "x-folio-scope": encodedScope(f.scope),
        "x-folio-upload": "upload-oversized",
      },
      chunks,
    );
    expect(response.status).toBe(413);
    const body = JSON.parse(response.body.toString("utf8")) as {
      ok: boolean;
      error: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("REQUEST_TOO_LARGE");

    const provider = new SharedAssetProvider(f.url, f.token);
    await expect(
      provider.stage(
        f.scope,
        "upload-oversized-provider",
        new Uint8Array(ASSET_MAX_BYTES + 1),
      ),
    ).rejects.toMatchObject({ code: "ASSET_TOO_LARGE" });
    provider.close();
  }, 30_000);

  it("rejects wrong hashes, bad headers and malformed read bodies", async () => {
    const f = await fixture();
    temporary.push(f);
    const bytes = Buffer.from("hash integrity", "utf8");
    const uploaded = await stage(f.url, f.token, f.scope, "upload-hash", bytes);
    const result = (await json(uploaded)).result as {
      hash: string;
      bytes: number;
    };
    expect(publish(f, "upload-hash", result.hash).status).toBe(
      "SERVER_ACCEPTED",
    );

    const wrongHash = await read(
      f.url,
      f.token,
      f.scope,
      sha256(Buffer.from("different", "utf8")),
    );
    expect(wrongHash.status).toBe(404);

    const missingScope = await fetch(`${f.url}/v1/assetstage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/octet-stream",
        "x-folio-upload": "upload-missing-scope",
      },
      body: Uint8Array.from(bytes).buffer,
    });
    expect(missingScope.status).toBe(400);

    const badScope = await stage(
      f.url,
      f.token,
      f.scope,
      "upload-bad-scope",
      bytes,
      { "x-folio-scope": "not*base64url" },
    );
    expect(badScope.status).toBe(400);

    const wrongType = await fetch(`${f.url}/v1/assetstage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
        "x-folio-scope": encodedScope(f.scope),
        "x-folio-upload": "upload-wrong-type",
      },
      body: JSON.stringify({}),
    });
    expect(wrongType.status).toBe(415);

    const malformedRead = await fetch(`${f.url}/v1/assetread`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      body: '{"hash":"' + result.hash + '","scope":{}}',
    });
    expect(malformedRead.status).toBe(400);

    const nonCanonicalRead = await fetch(`${f.url}/v1/assetread`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
      },
      body: `{ "scope": ${JSON.stringify(f.scope)}, "hash": "${result.hash}" }`,
    });
    expect(nonCanonicalRead.status).toBe(400);
  });

  it("always reauthenticates per request and fails after device revocation", async () => {
    const f = await fixture();
    temporary.push(f);
    const invite = f.authority.invite(
      f.token,
      "org-assets",
      "member-user",
      3_600_000,
    );
    const accepted = f.authority.acceptInvite(invite, "member-device");
    f.authority.grant(f.token, f.scope, "member-user", "editor");
    const memberToken = accepted.token;
    const bytes = Buffer.from("member asset", "utf8");

    const before = await stage(
      f.url,
      memberToken,
      f.scope,
      "member-upload",
      bytes,
    );
    expect(before.status).toBe(200);

    f.authority.revokeDevice(f.token, "org-assets", "member-device");

    const after = await stage(
      f.url,
      memberToken,
      f.scope,
      "member-upload-2",
      bytes,
    );
    expect(after.status).toBe(401);
    const body = await json(after);
    expect(body.error).toBe("TOKEN_INVALID");
  });

  it("handles concurrent duplicate uploads and reads with conflict safety", async () => {
    const f = await fixture();
    temporary.push(f);
    const bytes = Buffer.from("concurrent duplicate asset", "utf8");

    const [first, second] = await Promise.all([
      stage(f.url, f.token, f.scope, "duplicate-upload", bytes),
      stage(f.url, f.token, f.scope, "duplicate-upload", bytes),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstResult = (await json(first)).result as {
      hash: string;
      bytes: number;
    };
    const secondResult = (await json(second)).result as {
      hash: string;
      bytes: number;
    };
    expect(firstResult).toEqual(secondResult);
    expect(publish(f, "duplicate-upload", firstResult.hash).status).toBe(
      "SERVER_ACCEPTED",
    );

    const reads = await Promise.all(
      Array.from({ length: 6 }, () =>
        read(f.url, f.token, f.scope, firstResult.hash),
      ),
    );
    for (const response of reads) {
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }

    const repeated = await stage(
      f.url,
      f.token,
      f.scope,
      "duplicate-upload",
      bytes,
    );
    const repeatedBody = await json(repeated);
    expect(repeatedBody.result).toEqual(firstResult);

    const conflict = await stage(
      f.url,
      f.token,
      f.scope,
      "duplicate-upload",
      Buffer.from("different concurrent bytes", "utf8"),
    );
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error).toBe("UPLOAD_CONFLICT");
  });

  it("redacts a token echoed by a failing endpoint", async () => {
    const token = "secret-token-value-for-redaction";
    const endpoint: AssetEndpoint = {
      stageAsset() {
        throw new CollaborationError(token);
      },
    };
    const server = createServer(assetListener(endpoint, []));
    extraServers.push(server);
    const url = await listen(server);
    const scope: Scope = {
      orgId: "org",
      workspaceId: "workspace",
      documentId: "document",
      incarnationId: "incarnation",
    };
    const response = await stage(
      url,
      token,
      scope,
      "redaction-upload",
      Buffer.from("x"),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual({
      v: 1,
      ok: false,
      error: "INTERNAL_ERROR",
    });
  });

  it("provider verifies response hashes and rejects tampered bodies", async () => {
    const scope: Scope = {
      orgId: "org",
      workspaceId: "workspace",
      documentId: "document",
      incarnationId: "incarnation",
    };
    const requested = "a".repeat(64);
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.url === "/v1/assetread") {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "x-folio-sha256": requested,
          });
          response.end(Buffer.from("tampered", "utf8"));
          return;
        }
        const body = canonical({
          v: 1,
          ok: true,
          result: { hash: "b".repeat(64), bytes: 3 },
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      });
    });
    extraServers.push(server);
    const url = await listen(server);
    const provider = new SharedAssetProvider(url, "provider-token");

    await expect(provider.read(scope, requested)).rejects.toMatchObject({
      code: "HASH_MISMATCH",
    });
    await expect(
      provider.stage(scope, "upload-tampered", Buffer.from("abc")),
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    provider.close();
  });
});
