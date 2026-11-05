import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  canonicalJson,
  fingerprintCommit,
  hashCheckpoint,
  MAX_WIRE_BYTES,
  type Checkpoint,
  type Commit,
  type CommitResult,
  type HeadResponse,
} from "../src/sync/protocol";
import { CheckpointRemote } from "../src/sync/client";

type Captured = {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: string;
};
type Responder = (
  request: IncomingMessage,
  response: ServerResponse,
  captured: Captured,
) => void;

const token = randomBytes(32).toString("hex");
const checkpoint = (text: string): Checkpoint => ({
  format: "folio-checkpoint/v1",
  name: "test-fixture",
  version: 1,
  payload: { text },
  assets: [],
});
const makeCommit = (
  serverEpoch = "epoch",
  baseRevision = 0,
  clientId = "client-a",
  operationId = "op-a",
): Commit => {
  const value = checkpoint("remote");
  return {
    protocol: 1,
    workspaceId: "workspace",
    clientId,
    operationId,
    serverEpoch,
    baseRevision,
    checkpointHash: hashCheckpoint(value),
    checkpoint: value,
  };
};
const headResponse = (overrides: Partial<HeadResponse> = {}): HeadResponse => ({
  protocol: 1,
  workspaceId: "workspace",
  serverEpoch: "epoch",
  head: { revision: 0, checkpointHash: null, checkpoint: null },
  ...overrides,
});
function appliedResult(
  operation: Commit,
  overrides: Record<string, unknown> = {},
): CommitResult {
  return {
    protocol: 1,
    workspaceId: operation.workspaceId,
    clientId: operation.clientId,
    operationId: operation.operationId,
    serverEpoch: operation.serverEpoch,
    fingerprint: fingerprintCommit(operation),
    status: "applied",
    revision: operation.baseRevision + 1,
    checkpointHash: operation.checkpointHash,
    ...overrides,
  } as CommitResult;
}
function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const content = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    ...headers,
  });
  response.end(content);
}
async function withMock<T>(
  responder: Responder,
  work: (url: string, requests: Captured[]) => Promise<T>,
): Promise<T> {
  const requests: Captured[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const captured: Captured = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      responder(request, response, captured);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    return await work(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
function remoteAt(baseUrl: string): CheckpointRemote {
  return new CheckpointRemote({
    baseUrl,
    workspaceId: "workspace",
    token,
    timeoutMs: 1_000,
  });
}


describe("CheckpointRemote endpoint and result validation", () => {
  it("rejects non-loopback endpoints, tokens, workspaces and timeouts", () => {
    for (const baseUrl of [
      "http://example.com",
      "http://localhost:1234",
      "https://127.0.0.1",
      "http://127.0.0.1/path",
      "http://127.0.0.1?x=1",
    ])
      expect(
        () => new CheckpointRemote({ baseUrl, workspaceId: "workspace", token }),
      ).toThrow("loopback-only");
    expect(
      () =>
        new CheckpointRemote({
          baseUrl: "http://127.0.0.1:1234",
          workspaceId: "workspace",
          token: "short",
        }),
    ).toThrow("invalid-capability");
    expect(
      () =>
        new CheckpointRemote({
          baseUrl: "http://127.0.0.1:1234",
          workspaceId: "not a workspace",
          token,
        }),
    ).toThrow("invalid-identifier");
    for (const timeoutMs of [0, -1, 60_001, 1.5])
      expect(
        () =>
          new CheckpointRemote({
            baseUrl: "http://127.0.0.1:1234",
            workspaceId: "workspace",
            token,
            timeoutMs,
          }),
      ).toThrow("invalid-timeout");
  });

  it("sends the expected route and headers and validates success results", async () => {
    const operation = makeCommit();
    await withMock(
      (request, response) => {
        if (request.url === "/v1/workspaces/workspace/head")
          return sendJson(response, 200, headResponse());
        if (request.url === "/v1/workspaces/workspace/commits")
          return sendJson(response, 200, appliedResult(operation));
        if (request.url?.includes("/operations/"))
          return sendJson(response, 404, { error: "operation-not-found" });
        if (request.url === "/v1/workspaces/workspace/changes?after=0")
          return sendJson(response, 200, {
            protocol: 1,
            workspaceId: "workspace",
            serverEpoch: "epoch",
            after: 0,
            headRevision: 0,
            changes: [],
          });
        sendJson(response, 404, { error: "not-found" });
      },
      async (baseUrl, requests) => {
        const remote = remoteAt(baseUrl);
        expect((await remote.head()).head.revision).toBe(0);
        expect(requests[0].headers.authorization).toBe(`Bearer ${token}`);
        expect(requests[0].headers.accept).toBe("application/json");
        expect(requests[0].url).toBe("/v1/workspaces/workspace/head");

        expect(await remote.commit(operation)).toMatchObject({
          status: "applied",
          revision: 1,
        });
        expect(requests[1].method).toBe("POST");
        expect(requests[1].url).toBe("/v1/workspaces/workspace/commits");
        expect(requests[1].headers["content-type"]).toBe("application/json");
        expect(requests[1].body).toBe(canonicalJson(operation));

        expect(await remote.lookup("client-a", "missing")).toBeNull();
        expect(requests[2].url).toBe(
          "/v1/workspaces/workspace/operations/client-a/missing",
        );
        expect((await remote.changes(0)).changes).toEqual([]);
        expect(requests[3].url).toBe(
          "/v1/workspaces/workspace/changes?after=0",
        );
      },
    );
  });

  it("rejects wrong workspace, receipt identities and conflict heads", async () => {
    const operation = makeCommit();
    const conflictAtBase: CommitResult = {
      protocol: 1,
      workspaceId: operation.workspaceId,
      clientId: operation.clientId,
      operationId: operation.operationId,
      serverEpoch: operation.serverEpoch,
      fingerprint: fingerprintCommit(operation),
      status: "conflict",
      head: {
        revision: operation.baseRevision,
        checkpointHash: null,
        checkpoint: null,
      },
    };
    const cases: Array<{
      name: string;
      endpoint: "head" | "commit" | "lookup" | "changes";
      response: unknown;
      code: string;
    }> = [
      {
        name: "head workspace",
        endpoint: "head",
        response: headResponse({ workspaceId: "other" }),
        code: "workspace-mismatch",
      },
      {
        name: "commit workspace",
        endpoint: "commit",
        response: appliedResult(operation, { workspaceId: "other" }),
        code: "workspace-mismatch",
      },
      {
        name: "client",
        endpoint: "commit",
        response: appliedResult(operation, { clientId: "client-b" }),
        code: "result-identity-mismatch",
      },
      {
        name: "operation",
        endpoint: "commit",
        response: appliedResult(operation, { operationId: "op-b" }),
        code: "result-identity-mismatch",
      },
      {
        name: "fingerprint",
        endpoint: "commit",
        response: appliedResult(operation, {
          fingerprint: createHash("sha256").update("wrong").digest("hex"),
        }),
        code: "result-identity-mismatch",
      },
      {
        name: "epoch",
        endpoint: "commit",
        response: appliedResult(operation, { serverEpoch: "other-epoch" }),
        code: "server-epoch-mismatch",
      },
      {
        name: "revision",
        endpoint: "commit",
        response: appliedResult(operation, { revision: 9 }),
        code: "result-identity-mismatch",
      },
      {
        name: "checkpoint hash",
        endpoint: "commit",
        response: appliedResult(operation, {
          checkpointHash: createHash("sha256").update("hash").digest("hex"),
        }),
        code: "result-identity-mismatch",
      },
      {
        name: "conflict base",
        endpoint: "commit",
        response: conflictAtBase,
        code: "result-identity-mismatch",
      },
      {
        name: "lookup client",
        endpoint: "lookup",
        response: appliedResult(operation, { clientId: "client-b" }),
        code: "result-identity-mismatch",
      },
      {
        name: "lookup operation",
        endpoint: "lookup",
        response: appliedResult(operation, { operationId: "op-b" }),
        code: "result-identity-mismatch",
      },
      {
        name: "changes workspace",
        endpoint: "changes",
        response: {
          protocol: 1,
          workspaceId: "other",
          serverEpoch: "epoch",
          after: 0,
          headRevision: 0,
          changes: [],
        },
        code: "workspace-mismatch",
      },
      {
        name: "changes cursor",
        endpoint: "changes",
        response: {
          protocol: 1,
          workspaceId: "workspace",
          serverEpoch: "epoch",
          after: 1,
          headRevision: 1,
          changes: [],
        },
        code: "cursor-mismatch",
      },
    ];
    for (const testCase of cases) {
      await withMock(
        (_request, response) => sendJson(response, 200, testCase.response),
        async (baseUrl) => {
          const remote = remoteAt(baseUrl);
          const action =
            testCase.endpoint === "head"
              ? remote.head()
              : testCase.endpoint === "commit"
                ? remote.commit(operation)
                : testCase.endpoint === "lookup"
                  ? remote.lookup("client-a", operation.operationId)
                  : remote.changes(0);
          await expect(action).rejects.toThrow(testCase.code);
        },
      );
    }
  });

  it("rejects malformed, unbounded and non-JSON responses", async () => {
    await withMock(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(JSON.stringify(headResponse()));
      },
      async (baseUrl) => {
        await expect(remoteAt(baseUrl).head()).rejects.toThrow(
          "invalid-response",
        );
      },
    );
    await withMock(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{");
      },
      async (baseUrl) => {
        await expect(remoteAt(baseUrl).head()).rejects.toThrow(
          "invalid-response",
        );
      },
    );
    await withMock(
      (_request, response) => {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_WIRE_BYTES + 1),
        });
        response.flushHeaders();
      },
      async (baseUrl) => {
        await expect(remoteAt(baseUrl).head()).rejects.toThrow(
          "response-too-large",
        );
      },
    );
    await withMock(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("x".repeat(MAX_WIRE_BYTES + 1));
      },
      async (baseUrl) => {
        await expect(remoteAt(baseUrl).head()).rejects.toThrow(
          "response-too-large",
        );
      },
    );
  });

  it("maps HTTP error codes without hiding their status", async () => {
    await withMock(
      (_request, response) =>
        sendJson(response, 401, { error: "unauthorized" }),
      async (baseUrl) => {
        await expect(remoteAt(baseUrl).head()).rejects.toMatchObject({
          code: "unauthorized",
          status: 401,
        });
      },
    );
    await withMock(
      (_request, response) => sendJson(response, 409, { error: "conflict" }),
      async (baseUrl) => {
        await expect(remoteAt(baseUrl).lookup("client-a", "op-a")).rejects.toMatchObject({
          code: "conflict",
          status: 409,
        });
      },
    );
  });
});
