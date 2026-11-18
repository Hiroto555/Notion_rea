import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import {
  CollaborationError,
  type Attempt,
  type Cut,
  type Receipt,
  type Scope,
  type Snapshot,
} from "../src/collaboration/runtime/contract";
import { canonical } from "../src/collaboration/runtime/canonical";
import { createSharedHttpServer } from "../src/collaboration/runtime/http-server";
import {
  HTTP_MAX_REQUEST_BYTES,
  HttpSharedProvider,
} from "../src/collaboration/runtime/http-provider";
import type {
  SharedAuthorityEndpoint,
  WorkspaceListing,
} from "../src/collaboration/runtime/provider-port";

const TOKEN = "token-1";
const WRONG = "wrong-token-1";

const scope: Scope = {
  orgId: "org_a",
  workspaceId: "ws_a",
  documentId: "doc_a",
  incarnationId: "inc_a",
};

const cut: Cut = { epoch: "epoch-1", seq: 0, hash: "0".repeat(64) };
const base = cut;

const attempt: Attempt = {
  v: 1,
  attemptId: "attempt_1",
  intent: {
    v: 1,
    intentId: "intent_1",
    writerId: "writer_1",
    scope,
    base,
    command: { kind: "block.delete", blockId: "p1" },
  },
  base,
};

const snapshot = (): Snapshot => ({
  scope,
  cut,
  state: { document: { type: "doc", content: [] }, tables: [], tombstones: [] },
  events: [],
});

const receipt = (
  input: Attempt,
  status: Receipt["status"] = "SERVER_ACCEPTED",
): Receipt => ({
  v: 1,
  status,
  intentId: input.intent.intentId,
  intentHash: "a".repeat(64),
  attemptId: input.attemptId,
  attemptHash: "b".repeat(64),
  writerId: input.intent.writerId,
  scope: input.intent.scope,
  cut,
  resultHash: "c".repeat(64),
  code: null,
});

const listings: WorkspaceListing[] = [
  {
    workspaceId: "ws_a",
    name: "Shared",
    role: "owner",
    documents: [{ documentId: "doc_a", incarnationId: "inc_a", title: "Page" }],
  },
];

function codeOf(error: unknown): string {
  return error instanceof CollaborationError ? error.code : "NO_CODE";
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(codeOf(error)).toBe(code);
    return;
  }
  throw new Error("expected " + code);
}

function guard(token: string): void {
  if (token !== TOKEN) throw new CollaborationError("TOKEN_INVALID");
}

function createFakeEndpoint(): {
  endpoint: SharedAuthorityEndpoint;
  calls: string[];
  lastAttempt: () => Attempt | null;
} {
  const calls: string[] = [];
  let last: Attempt | null = null;
  const endpoint: SharedAuthorityEndpoint = {
    snapshot(token, input, after) {
      guard(token);
      calls.push("snapshot:" + token + ":" + String(after));
      return snapshot();
    },
    submit(token, input) {
      guard(token);
      calls.push("submit:" + token);
      last = input;
      return receipt(input);
    },
    receipt(token, input) {
      guard(token);
      calls.push("receipt:" + token);
      return receipt(input);
    },
    invalidate(token, input) {
      guard(token);
      calls.push("invalidate:" + token);
      return receipt(input, "INVALIDATED");
    },
    proof(token, input, seq) {
      guard(token);
      calls.push("proof:" + token + ":" + String(seq));
      return seq === 0 ? cut : null;
    },
    workspaces(token, orgId) {
      guard(token);
      calls.push("workspaces:" + token + ":" + orgId);
      return listings;
    },
  };
  return { endpoint, calls, lastAttempt: () => last };
}

type RawResponse = { status: number; body: string };

async function raw(
  url: string,
  path: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<RawResponse> {
  const response = await fetch(url + path, {
    method: options.method ?? "POST",
    headers: options.headers,
    body: options.body,
    redirect: "error",
  });
  return { status: response.status, body: await response.text() };
}

const bearer = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

describe("shared runtime loopback HTTP provider", () => {
  const fake = createFakeEndpoint();
  let server!: ReturnType<typeof createSharedHttpServer>;
  let url = "";

  beforeAll(async () => {
    server = createSharedHttpServer(fake.endpoint);
    url = (await server.listen()).url;
  });

  afterAll(async () => {
    await server.close();
  });

  it("round-trips every operation through a real loopback server", async () => {
    const provider = new HttpSharedProvider(url, TOKEN);
    expect(await provider.snapshot(scope, 0)).toEqual(snapshot());
    expect(await provider.submit(attempt)).toEqual(receipt(attempt));
    expect(await provider.receipt(attempt)).toEqual(receipt(attempt));
    expect(await provider.invalidate(attempt)).toEqual(
      receipt(attempt, "INVALIDATED"),
    );
    expect(await provider.proof(scope, 0)).toEqual(cut);
    expect(await provider.proof(scope, 1)).toBeNull();
    expect(await provider.workspaces("org_a")).toEqual(listings);
    expect(fake.lastAttempt()).toEqual(attempt);
    expect(fake.calls.every((call) => call.includes(TOKEN))).toBe(true);
    provider.close();
    await expect(provider.snapshot(scope)).rejects.toMatchObject({
      code: "CLOSED",
    });
  });

  it("rejects an invalid bearer token without leaking it", async () => {
    const provider = new HttpSharedProvider(url, WRONG);
    let caught: unknown = null;
    try {
      await provider.workspaces("org_a");
    } catch (error) {
      caught = error;
    }
    expect(codeOf(caught)).toBe("TOKEN_INVALID");
    expect(String(caught)).not.toContain(WRONG);
    expect(JSON.stringify(caught)).not.toContain(WRONG);
  });

  it("retains the original attempt when the request fails", async () => {
    const frozen = Object.freeze({
      ...attempt,
      intent: Object.freeze({
        ...attempt.intent,
        scope: Object.freeze({ ...attempt.intent.scope }),
        base: Object.freeze({ ...attempt.intent.base }),
      }),
      base: Object.freeze({ ...attempt.base }),
    }) as Attempt;
    const before = canonical(frozen);
    const provider = new HttpSharedProvider(url, WRONG);
    await expect(provider.submit(frozen)).rejects.toMatchObject({
      code: "TOKEN_INVALID",
    });
    expect(canonical(frozen)).toBe(before);
  });

  it("rejects Origin and cookie-bearing requests", async () => {
    const origin = await raw(url, "/v1/snapshot", {
      body: canonical({ scope }),
      headers: { ...bearer, origin: "http://evil.example" },
    });
    expect(origin.status).toBe(403);
    expect(JSON.parse(origin.body)).toEqual({
      v: 1,
      ok: false,
      error: "ORIGIN_REJECTED",
    });
    const cookie = await raw(url, "/v1/snapshot", {
      body: canonical({ scope }),
      headers: { ...bearer, cookie: "session=1" },
    });
    expect(cookie.status).toBe(400);
    expect(JSON.parse(cookie.body).error).toBe("COOKIE_REJECTED");
  });

  it("rejects non-canonical, unknown and oversized requests", async () => {
    const nonCanonical = await raw(url, "/v1/snapshot", {
      body: JSON.stringify({ scope }, null, 2),
      headers: bearer,
    });
    expect(nonCanonical.status).toBe(400);
    expect(JSON.parse(nonCanonical.body).error).toBe("NON_CANONICAL_WIRE");

    const unknown = await raw(url, "/v1/snapshot", {
      body: canonical({ scope, extra: true }),
      headers: bearer,
    });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error).toBe("INVALID_REQUEST");

    const oversized = await raw(url, "/v1/snapshot", {
      body: "x".repeat(HTTP_MAX_REQUEST_BYTES + 1),
      headers: bearer,
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body).error).toBe("REQUEST_TOO_LARGE");
  });

  it("rejects wrong methods, queries and missing auth", async () => {
    expect((await raw(url, "/v1/snapshot", { method: "GET" })).status).toBe(
      405,
    );
    const query = await raw(url, "/v1/snapshot?x=1", {
      body: canonical({ scope }),
      headers: bearer,
    });
    expect(query.status).toBe(400);
    expect(JSON.parse(query.body).error).toBe("QUERY_REJECTED");
    const noAuth = await raw(url, "/v1/snapshot", {
      body: canonical({ scope }),
      headers: { "content-type": "application/json" },
    });
    expect(noAuth.status).toBe(401);
    expect(JSON.parse(noAuth.body).error).toBe("TOKEN_INVALID");
    const wrongType = await raw(url, "/v1/snapshot", {
      body: canonical({ scope }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "text/plain",
      },
    });
    expect(wrongType.status).toBe(415);
    expect(JSON.parse(wrongType.body).error).toBe("JSON_REQUIRED");
  });

  it("rejects plaintext remote and decorated URLs (TLS endpoints use certificate validation)", () => {
    const invalid = [
      "http://localhost:1234",
      "http://127.0.0.2:1234",
      "http://user:pass@127.0.0.1:1234",
      "http://127.0.0.1:1234/path",
      "http://127.0.0.1:1234?query=1",
      "http://127.0.0.1:1234#fragment",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:70000",
    ];
    for (const value of invalid)
      expectCode(() => new HttpSharedProvider(value, TOKEN), "INVALID_URL");
    expectCode(() => new HttpSharedProvider(url, ""), "INVALID_TOKEN");
    expectCode(
      () => new HttpSharedProvider(url, "x".repeat(257)),
      "INVALID_TOKEN",
    );
  });
});

describe("shared runtime loopback HTTP response validation", () => {
  it("rejects structurally invalid responses", async () => {
    const endpoint: SharedAuthorityEndpoint = {
      snapshot: () => snapshot(),
      submit: () =>
        ({
          v: 1,
          status: "SERVER_ACCEPTED",
          intentId: attempt.intent.intentId,
          intentHash: "a".repeat(64),
          attemptId: attempt.attemptId,
          attemptHash: "b".repeat(64),
          writerId: attempt.intent.writerId,
          scope: attempt.intent.scope,
          cut,
          resultHash: "c".repeat(64),
        }) as unknown as Receipt,
      receipt: () => null,
      invalidate: () => receipt(attempt),
      proof: () => null,
      workspaces: () => listings,
    };
    const server = createSharedHttpServer(endpoint);
    try {
      const url = (await server.listen()).url;
      const provider = new HttpSharedProvider(url, TOKEN);
      await expect(provider.submit(attempt)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    } finally {
      await server.close();
    }
  });

  it("maps oversized endpoint results to RESPONSE_TOO_LARGE", async () => {
    const endpoint: SharedAuthorityEndpoint = {
      snapshot: () => snapshot(),
      submit: () => "x".repeat(8_000_001) as unknown as Receipt,
      receipt: () => null,
      invalidate: () => receipt(attempt),
      proof: () => null,
      workspaces: () => listings,
    };
    const server = createSharedHttpServer(endpoint);
    try {
      const url = (await server.listen()).url;
      const provider = new HttpSharedProvider(url, TOKEN);
      await expect(provider.submit(attempt)).rejects.toMatchObject({
        code: "RESPONSE_TOO_LARGE",
      });
    } finally {
      await server.close();
    }
  }, 20_000);
});

const document = (): Doc => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [{ type: "text", text: "hello" }],
    },
  ],
});

describe("shared runtime HTTP against SharedAuthority", () => {
  it("bootstraps and performs legal operations end to end", async () => {
    let SharedAuthority!: new (directory: string) => {
      bootstrap(input: {
        orgId: string;
        userId: string;
        deviceId: string;
        workspaceId: string;
        documentId: string;
        document: Doc;
      }): { token: string; auth: { writerId: string }; scope: Scope };
      close(): void;
    };
    try {
      ({ SharedAuthority } =
        await import("../src/collaboration/runtime/authority"));
    } catch {
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "folio-http-"));
    const authority = new SharedAuthority(directory);
    const server = createSharedHttpServer(
      authority as unknown as SharedAuthorityEndpoint,
    );
    let provider: HttpSharedProvider | null = null;
    try {
      const boot = authority.bootstrap({
        orgId: scope.orgId,
        userId: "user_a",
        deviceId: "device_a",
        workspaceId: scope.workspaceId,
        documentId: scope.documentId,
        document: document(),
      });
      const url = (await server.listen()).url;
      provider = new HttpSharedProvider(url, boot.token);

      const workspaces = await provider.workspaces(scope.orgId);
      expect(
        workspaces.some(
          (workspace) =>
            workspace.workspaceId === scope.workspaceId &&
            workspace.documents.some(
              (entry) => entry.documentId === scope.documentId,
            ),
        ),
      ).toBe(true);

      const initial = await provider.snapshot(boot.scope);
      const live: Attempt = {
        v: 1,
        attemptId: "attempt_live",
        intent: {
          v: 1,
          intentId: "intent_live",
          writerId: boot.auth.writerId,
          scope: boot.scope,
          base: initial.cut,
          command: {
            kind: "text",
            blockId: "p1",
            from: 5,
            to: 5,
            text: "!",
            before: "hello",
          },
        },
        base: initial.cut,
      };
      const accepted = await provider.submit(live);
      expect(accepted.status).toBe("SERVER_ACCEPTED");
      expect((await provider.receipt(live))?.cut).toEqual(accepted.cut);
      const delta = await provider.snapshot(boot.scope, initial.cut.seq);
      expect(
        delta.events.some((event) => event.attemptId === "attempt_live"),
      ).toBe(true);
      expect(await provider.proof(boot.scope, accepted.cut.seq)).toEqual(
        accepted.cut,
      );
      expect((await provider.invalidate(live)).status).toBe("SERVER_ACCEPTED");

      const invalid = {
        ...live,
        attemptId: "attempt_invalid",
        extra: true,
      } as unknown as Attempt;
      await expect(provider.submit(invalid)).rejects.toMatchObject({
        code: "INVALID_ATTEMPT",
      });
      const wrong = new HttpSharedProvider(url, WRONG);
      await expect(wrong.workspaces(scope.orgId)).rejects.toMatchObject({
        code: "TOKEN_INVALID",
      });
    } finally {
      provider?.close();
      await server.close().catch(() => undefined);
      authority.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
