import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import { createSharedHttpServer } from "../src/collaboration/runtime/http-server";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import { SharedRuntimeService } from "../src/main/shared-runtime-service";
import {
  CollaborationError,
  type Attempt,
  type Command,
  type Cut,
  type Receipt,
  type Scope,
  type Snapshot,
} from "../src/collaboration/runtime/contract";
import type {
  SharedProvider,
  WorkspaceListing,
} from "../src/collaboration/runtime/provider-port";
import { canonical } from "../src/collaboration/runtime/canonical";
import { editorTextIntent } from "../src/collaboration/runtime/editor-intent";
import type { SharedRuntimeSession } from "../src/shared/shared-runtime-ipc";
import type { Doc } from "../src/shared/types";

const cleanups: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

function onCleanup(work: () => void | Promise<void>): void {
  cleanups.push(work);
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  roots.push(root);
  return root;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function paragraphText(document: Doc): string {
  return document.content?.[0]?.content?.[0]?.text ?? "";
}

const INITIAL_DOCUMENT: Doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [{ type: "text", text: "hello" }],
    },
  ],
};

async function setupAuthority() {
  const directory = tempRoot("folio-r12-authority-");
  const authority = new SharedAuthority(directory);
  onCleanup(() => authority.close());
  const boot = authority.bootstrap({
    orgId: "org1",
    userId: "user1",
    deviceId: "device1",
    workspaceId: "ws1",
    documentId: "doc1",
    document: INITIAL_DOCUMENT,
  });
  const server = createSharedHttpServer(authority);
  onCleanup(() => server.close());
  const { url } = await server.listen();
  return {
    authority,
    directory,
    scope: boot.scope,
    token: boot.token,
    auth: boot.auth,
    url,
  };
}

async function setupService(url: string, token: string) {
  const root = tempRoot("folio-r12-service-");
  const service = new SharedRuntimeService(root);
  onCleanup(() => service.close());
  const connected = await service.handle(
    { type: "connect", url, token, orgId: "org1" },
    () => true,
  );
  return { service, connected };
}

class LostAckProvider implements SharedProvider {
  constructor(private readonly inner: HttpSharedProvider) {}
  snapshot(scope: Scope, after?: number): Promise<Snapshot> {
    return this.inner.snapshot(scope, after);
  }
  async submit(attempt: Attempt): Promise<Receipt> {
    await this.inner.submit(attempt);
    throw new CollaborationError("ACK_LOST");
  }
  receipt(attempt: Attempt): Promise<Receipt | null> {
    return this.inner.receipt(attempt);
  }
  invalidate(attempt: Attempt): Promise<Receipt> {
    return this.inner.invalidate(attempt);
  }
  proof(scope: Scope, seq: number): Promise<Cut | null> {
    return this.inner.proof(scope, seq);
  }
  workspaces(orgId: string): Promise<WorkspaceListing[]> {
    return this.inner.workspaces(orgId);
  }
  close(): void {
    this.inner.close();
  }
}

afterEach(async () => {
  for (const work of cleanups.splice(0).reverse()) {
    try {
      await work();
    } catch {
      // Cleanup is best-effort; the assertion that failed is more useful.
    }
  }
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Keep the original test failure.
    }
  }
});

describe("shared main fence", () => {
  it("re-checks the IPC sender after an awaited operation and rejects stale generations", async () => {
    const { url, token, scope } = await setupAuthority();
    const { service, connected } = await setupService(url, token);
    expect(JSON.stringify(connected)).not.toContain(token);
    const opened = (await service.handle(
      { type: "open", scope },
      () => true,
    )) as SharedRuntimeSession;
    expect(opened.scope).toEqual(scope);
    const generation = opened.generation;

    await expect(
      service.handle({ type: "refresh", generation }, () => false),
    ).rejects.toThrow("UNAUTHORIZED_IPC_SENDER");

    let checks = 0;
    await expect(
      service.handle({ type: "refresh", generation }, () => ++checks === 1),
    ).rejects.toThrow("UNAUTHORIZED_IPC_SENDER");
    expect(checks).toBe(2);

    await expect(
      service.handle(
        { type: "refresh", generation: generation - 1 },
        () => true,
      ),
    ).rejects.toThrow("STALE_SHARED_SESSION");
  });

  it("keeps a refused raw draft and accepts a later legal plaintext edit", async () => {
    const { url, token, scope } = await setupAuthority();
    const { service } = await setupService(url, token);
    const opened = (await service.handle(
      { type: "open", scope },
      () => true,
    )) as SharedRuntimeSession;
    expect(opened.snapshot).not.toBeNull();
    const snapshot = opened.snapshot!;
    const next = clone(snapshot.state.document);
    next.content![0]!.content![0]!.text = "hello!";
    const raw = JSON.stringify(next);

    await expect(
      service.handle(
        {
          type: "document",
          generation: opened.generation - 1,
          base: snapshot.cut,
          document: next,
        },
        () => true,
      ),
    ).rejects.toThrow("STALE_SHARED_SESSION");

    await expect(
      service.handle(
        {
          type: "document",
          generation: opened.generation,
          base: { ...snapshot.cut, hash: "0".repeat(64) },
          document: next,
        },
        () => true,
      ),
    ).rejects.toThrow("STALE_EDITOR_BASE");

    const recovered = JSON.parse(
      (await service.handle(
        { type: "recover", generation: opened.generation },
        () => true,
      )) as string,
    ) as {
      document: {
        editing: { value: { raw: string; cut: Cut } }[];
        drafts: { value: { document: Doc; cut: Cut } }[];
      };
    };
    expect(
      recovered.document.editing.some((row) => row.value.raw === raw),
    ).toBe(true);
    expect(
      recovered.document.drafts.some(
        (row) => JSON.stringify(row.value.document) === canonical(next),
      ),
    ).toBe(true);

    const accepted = (await service.handle(
      {
        type: "document",
        generation: opened.generation,
        base: snapshot.cut,
        document: next,
      },
      () => true,
    )) as SharedRuntimeSession;
    expect(accepted.snapshot).not.toBeNull();
    expect(paragraphText(accepted.snapshot!.state.document)).toBe("hello!");
    expect(accepted.snapshot!.cut.seq).toBe(snapshot.cut.seq + 1);

    const after = JSON.parse(
      (await service.handle(
        { type: "recover", generation: opened.generation },
        () => true,
      )) as string,
    ) as { document: { editing: { value: { raw: string } }[] } };
    expect(after.document.editing.some((row) => row.value.raw === raw)).toBe(
      false,
    );
  });

  it("keeps authority and client roles separated for identical scope ids", async () => {
    const { directory, url, token, scope, auth } = await setupAuthority();
    const authorityProvider = new HttpSharedProvider(url, token);
    onCleanup(() => authorityProvider.close());
    expect(
      () =>
        new SharedRuntimeClient(
          directory,
          authorityProvider,
          scope,
          auth.writerId,
        ),
    ).toThrow("WRONG_STORE_ROLE");

    const clientDirectory = tempRoot("folio-r12-client-");
    const clientProvider = new HttpSharedProvider(url, token);
    onCleanup(() => clientProvider.close());
    const client = new SharedRuntimeClient(
      clientDirectory,
      clientProvider,
      scope,
      auth.writerId,
    );
    onCleanup(() => client.close());
    const snapshot = await client.open();
    expect(snapshot.scope).toEqual(scope);
    client.close();
    expect(() => new SharedAuthority(clientDirectory)).toThrow(
      "WRONG_STORE_ROLE",
    );
  });

  it("records a lost acknowledgement as UNKNOWN and reconciles it without retry", async () => {
    const { url, token, scope, auth } = await setupAuthority();
    const clientDirectory = tempRoot("folio-r12-late-");
    const inner = new HttpSharedProvider(url, token);
    onCleanup(() => inner.close());
    const client = new SharedRuntimeClient(
      clientDirectory,
      new LostAckProvider(inner),
      scope,
      auth.writerId,
    );
    onCleanup(() => client.close());
    await client.open();

    const command: Command = {
      kind: "text",
      blockId: "p1",
      from: 5,
      to: 5,
      text: "!",
      before: "hello",
    };
    await expect(client.submit(command)).rejects.toThrow("ACK_LOST");

    let entries = client.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe("UNKNOWN");
    expect(entries[0]!.attempts).toHaveLength(1);
    expect(entries[0]!.attempts[0]!.state).toBe("UNKNOWN");

    await client.reconcile();
    entries = client.entries();
    expect(entries[0]!.state).toBe("CLIENT_RECEIPT_DURABLE");
    expect(entries[0]!.attempts).toHaveLength(1);
    expect(entries[0]!.attempts[0]!.state).toBe("ACCEPTED");
    expect(entries[0]!.attempts[0]!.receipt?.status).toBe("SERVER_ACCEPTED");
    expect(paragraphText(client.snapshot().state.document)).toBe("hello!");
  });

  it("refuses structural editor adoption outside the plaintext scope", () => {
    const before = clone(INITIAL_DOCUMENT);
    const afterText = clone(INITIAL_DOCUMENT);
    afterText.content![0]!.content![0]!.text = "hello!";
    expect(editorTextIntent(before, afterText)).toEqual({
      kind: "text",
      blockId: "p1",
      before: "hello",
      from: 5,
      to: 5,
      text: "!",
    });
    expect(editorTextIntent(before, clone(INITIAL_DOCUMENT))).toBeNull();

    const heading = clone(INITIAL_DOCUMENT);
    heading.content![0]!.type = "heading";
    heading.content![0]!.attrs = { id: "p1", level: 1 };
    expect(() => editorTextIntent(before, heading)).toThrow(
      "EDITOR_STRUCTURE_NOT_ADOPTED",
    );

    const twoBlocks: Doc = {
      type: "doc",
      content: [
        clone(INITIAL_DOCUMENT.content![0]!),
        {
          type: "paragraph",
          attrs: { id: "p2" },
          content: [{ type: "text", text: "second" }],
        },
      ],
    };
    const twoChanged = clone(twoBlocks);
    twoChanged.content![0]!.content![0]!.text = "first changed";
    twoChanged.content![1]!.content![0]!.text = "second changed";
    expect(() => editorTextIntent(twoBlocks, twoChanged)).toThrow(
      "EDITOR_MULTI_BLOCK_NOT_ADOPTED",
    );
  });

  it("rejects origin, cookie, query, non-POST and unauthenticated HTTP requests", async () => {
    const { url, token, scope } = await setupAuthority();
    const body = canonical({ scope });
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const origin = await fetch(`${url}/v1/snapshot`, {
      method: "POST",
      headers: { ...headers, origin: "https://example.invalid" },
      body,
    });
    expect(origin.status).toBe(403);

    const cookie = await fetch(`${url}/v1/snapshot`, {
      method: "POST",
      headers: { ...headers, cookie: "session=1" },
      body,
    });
    expect(cookie.status).toBe(400);

    const get = await fetch(`${url}/v1/snapshot`, { method: "GET", headers });
    expect(get.status).toBe(405);

    const query = await fetch(`${url}/v1/snapshot?after=0`, {
      method: "POST",
      headers,
      body,
    });
    expect(query.status).toBe(400);

    const unauthenticated = await fetch(`${url}/v1/snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unauthenticated.status).toBe(401);

    const valid = await fetch(`${url}/v1/snapshot`, {
      method: "POST",
      headers,
      body,
    });
    expect(valid.status).toBe(200);
    const payload = (await valid.json()) as { ok: boolean; result: Snapshot };
    expect(payload.ok).toBe(true);
    expect(payload.result.scope).toEqual(scope);
  });
});
