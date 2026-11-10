import { canonical } from "../src/collaboration/runtime/canonical";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import {
  CollaborationError,
  type Attempt,
  type AuthContext,
  type Intent,
  type Scope,
  type Snapshot,
  type TextCommand,
} from "../src/collaboration/runtime/contract";
import { editorTextIntent } from "../src/collaboration/runtime/editor-intent";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import {
  createSharedHttpServer,
  type SharedHttpServer,
} from "../src/collaboration/runtime/http-server";
import type { SharedProvider } from "../src/collaboration/runtime/provider-port";
import { SharedRuntimeService } from "../src/main/shared-runtime-service";
import { CredentialProvider } from "../src/platform/credential-provider";
import type { Doc } from "../src/shared/types";

function paragraph(id: string, text: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    ...(text.length > 0 ? { content: [{ type: "text", text }] } : {}),
  };
}

function documentWith(id: string, text: string): Doc {
  return { type: "doc", content: [paragraph(id, text)] };
}

function inlineText(doc: Doc, id = "p1"): string {
  const block = doc.content?.find((node) => node.attrs?.id === id);
  return (block?.content ?? []).map((node) => node.text ?? "").join("");
}

function codeOf(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    return error instanceof CollaborationError ? error.code : String(error);
  }
}

class FaultProvider implements SharedProvider {
  submits = 0;
  receipts = 0;
  private mode: "before" | "after-once" | "none";

  constructor(
    private readonly inner: HttpSharedProvider,
    mode: "before" | "after-once",
  ) {
    this.mode = mode;
  }

  async snapshot(scope: Scope, after?: number): Promise<Snapshot> {
    return this.inner.snapshot(scope, after);
  }

  async submit(attempt: Attempt) {
    this.submits++;
    if (this.mode === "before") throw new CollaborationError("LOST_RESPONSE");
    const receipt = await this.inner.submit(attempt);
    if (this.mode === "after-once") {
      this.mode = "none";
      throw new CollaborationError("LOST_RESPONSE");
    }
    return receipt;
  }

  async receipt(attempt: Attempt) {
    this.receipts++;
    return this.inner.receipt(attempt);
  }

  async invalidate(attempt: Attempt) {
    return this.inner.invalidate(attempt);
  }

  async proof(scope: Scope, seq: number) {
    return this.inner.proof(scope, seq);
  }

  async workspaces(orgId: string) {
    return this.inner.workspaces(orgId);
  }

  close(): void {
    this.inner.close();
  }
}

class FakeAsyncSafeStorage {
  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return true;
  }

  async encryptStringAsync(text: string): Promise<Uint8Array> {
    const input = new TextEncoder().encode(text);
    const output = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index++)
      output[index] = input[index] ^ 0x5a;
    return output;
  }

  async decryptStringAsync(bytes: Uint8Array): Promise<string> {
    const output = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index++)
      output[index] = bytes[index] ^ 0x5a;
    return new TextDecoder().decode(output);
  }

  getSelectedStorageBackend(): string {
    return "keychain";
  }
}

type Fixture = {
  tmp: string;
  authority: SharedAuthority;
  server: SharedHttpServer;
  url: string;
  ownerToken: string;
  ownerAuth: AuthContext;
  editorToken: string;
  editorAuth: AuthContext;
  scope: Scope;
  clients: SharedRuntimeClient[];
  services: SharedRuntimeService[];
  cleanup(): Promise<void>;
};

async function setup(): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), "folio-r08-client-"));
  const authority = new SharedAuthority(join(tmp, "authority"));
  const boot = authority.bootstrap({
    orgId: "org1",
    userId: "owner",
    deviceId: "owner-device",
    workspaceId: "ws1",
    documentId: "doc1",
    document: documentWith("p1", "Hello"),
  });
  const invite = authority.invite(boot.token, "org1", "editor", 600_000);
  const accepted = authority.acceptInvite(invite, "editor-device");
  authority.grant(boot.token, boot.scope, "editor", "editor");
  const server = createSharedHttpServer(authority);
  const { url } = await server.listen();
  const clients: SharedRuntimeClient[] = [];
  const services: SharedRuntimeService[] = [];
  return {
    tmp,
    authority,
    server,
    url,
    ownerToken: boot.token,
    ownerAuth: boot.auth,
    editorToken: accepted.token,
    editorAuth: accepted.auth,
    scope: boot.scope,
    clients,
    services,
    async cleanup() {
      for (const client of clients) {
        try {
          client.close();
        } catch {}
      }
      for (const service of services) {
        try {
          service.close();
        } catch {}
      }
      await server.close();
      authority.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("shared runtime client and service integration", () => {
  let activeCleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await activeCleanup?.();
    activeCleanup = null;
  });

  async function fixture(): Promise<Fixture> {
    const value = await setup();
    activeCleanup = value.cleanup;
    return value;
  }

  it("connects, lists, opens, and submits through the explicit service", async () => {
    const f = await fixture();
    const service = new SharedRuntimeService(join(f.tmp, "service-owner"));
    f.services.push(service);

    const connected = (await service.handle({
      type: "connect",
      url: f.url,
      token: f.ownerToken,
      orgId: "org1",
    })) as { generation: number; workspaces: unknown[] };
    expect(connected.generation).toBeGreaterThan(0);

    const listed = (await service.handle({ type: "list" })) as {
      workspaces: {
        workspaceId: string;
        name: string;
        role: string | null;
        documents: {
          documentId: string;
          incarnationId: string;
          title: string;
        }[];
      }[];
    };
    expect(listed.workspaces).toEqual([
      {
        workspaceId: "ws1",
        name: "共有ワークスペース",
        role: "owner",
        documents: [
          {
            documentId: "doc1",
            incarnationId: f.scope.incarnationId,
            title: "共有ページ",
          },
        ],
      },
    ]);

    const opened = (await service.handle({
      type: "open",
      scope: f.scope,
    })) as {
      generation: number;
      scope: Scope;
      snapshot: Snapshot;
    };
    expect(opened.scope).toEqual(f.scope);
    expect(opened.snapshot.cut).toEqual(f.authority.head());
    expect(inlineText(opened.snapshot.state.document)).toBe("Hello");

    const changed = await service.handle({
      type: "document",
      generation: opened.generation,
      base: opened.snapshot.cut,
      document: documentWith("p1", "Hello world"),
    });
    const view = changed as {
      snapshot: Snapshot;
      view: { state: string; pending: number };
    };
    expect(view.view.state).toBe("CLIENT_RECEIPT_DURABLE");
    expect(view.view.pending).toBe(0);
    expect(inlineText(view.snapshot.state.document)).toBe("Hello world");
    expect(
      inlineText(f.authority.snapshot(f.ownerToken, f.scope).state.document),
    ).toBe("Hello world");
  });

  it("keeps a lost-response submit UNKNOWN and reconciles the durable receipt after reopen", async () => {
    const f = await fixture();
    const directory = join(f.tmp, "client-lost-response");
    const firstProvider = new HttpSharedProvider(f.url, f.ownerToken);
    const fault = new FaultProvider(firstProvider, "after-once");
    const first = new SharedRuntimeClient(
      directory,
      fault,
      f.scope,
      f.ownerAuth.writerId,
    );
    f.clients.push(first);
    await first.open();

    const beforeHead = f.authority.head();
    const command: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 5,
      to: 5,
      text: "!",
      before: "Hello",
    };
    await expect(first.submit(command)).rejects.toMatchObject({
      code: "LOST_RESPONSE",
    });

    expect(fault.submits).toBe(1);
    expect(fault.receipts).toBe(0);
    expect(first.entries()).toHaveLength(1);
    expect(first.entries()[0].state).toBe("UNKNOWN");
    const attempt = first.entries()[0].attempts[0].attempt;
    const committedHead = f.authority.head();
    expect(committedHead.seq).toBe(beforeHead.seq + 1);
    expect((await firstProvider.receipt(attempt))?.status).toBe(
      "SERVER_ACCEPTED",
    );

    first.close();
    const secondProvider = new HttpSharedProvider(f.url, f.ownerToken);
    const second = new SharedRuntimeClient(
      directory,
      secondProvider,
      f.scope,
      f.ownerAuth.writerId,
    );
    f.clients.push(second);
    await second.open();
    await second.reconcile();

    const reconciled = second.entries()[0];
    expect(reconciled.state).toBe("CLIENT_RECEIPT_DURABLE");
    expect(reconciled.attempts[0].state).toBe("ACCEPTED");
    expect(reconciled.attempts[0].receipt?.status).toBe("SERVER_ACCEPTED");
    expect(f.authority.head()).toEqual(committedHead);
    expect(
      inlineText((await secondProvider.snapshot(f.scope)).state.document),
    ).toBe("Hello!");
  });

  it("leaves a missing receipt UNKNOWN without resending the attempt", async () => {
    const f = await fixture();
    const provider = new HttpSharedProvider(f.url, f.ownerToken);
    const fault = new FaultProvider(provider, "before");
    const client = new SharedRuntimeClient(
      join(f.tmp, "client-missing-receipt"),
      fault,
      f.scope,
      f.ownerAuth.writerId,
    );
    f.clients.push(client);
    await client.open();

    const beforeHead = f.authority.head();
    const command: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 5,
      to: 5,
      text: "?",
      before: "Hello",
    };
    await expect(client.submit(command)).rejects.toMatchObject({
      code: "LOST_RESPONSE",
    });
    const attempt = client.entries()[0].attempts[0].attempt;

    await client.reconcile();
    await client.reconcile();

    expect(client.entries()[0].state).toBe("UNKNOWN");
    expect(client.entries()[0].attempts[0].state).toBe("UNKNOWN");
    expect(fault.submits).toBe(1);
    expect(fault.receipts).toBeGreaterThanOrEqual(2);
    expect(f.authority.head()).toEqual(beforeHead);
    expect(await provider.receipt(attempt)).toBeNull();
    expect(
      inlineText(f.authority.snapshot(f.ownerToken, f.scope).state.document),
    ).toBe("Hello");
  });

  it("requires durable non-apply proof for archive and fences a late attempt after invalidate", async () => {
    const f = await fixture();
    const provider = new HttpSharedProvider(f.url, f.ownerToken);
    const fault = new FaultProvider(provider, "before");
    const client = new SharedRuntimeClient(
      join(f.tmp, "client-invalidate"),
      fault,
      f.scope,
      f.ownerAuth.writerId,
    );
    f.clients.push(client);
    await client.open();

    const command: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 5,
      to: 5,
      text: "*",
      before: "Hello",
    };
    await expect(client.submit(command)).rejects.toMatchObject({
      code: "LOST_RESPONSE",
    });
    const entry = client.entries()[0];
    const intentId = entry.intent.intentId;
    const attempt = entry.attempts[0].attempt;
    expect(client.entries()[0].state).toBe("UNKNOWN");
    expect(codeOf(() => client.archive(intentId))).toBe("NOT_PROVEN_UNAPPLIED");

    const invalidated = await client.invalidate(intentId);
    expect(invalidated.status).toBe("INVALIDATED");
    expect(client.entries()[0].state).toBe("REJECTED");
    expect(client.entries()[0].attempts[0].state).toBe("INVALIDATED");

    const lateHead = f.authority.head();
    const late = f.authority.submit(f.ownerToken, attempt);
    expect(late.status).toBe("INVALIDATED");
    expect(f.authority.head()).toEqual(lateHead);
    expect(
      inlineText(f.authority.snapshot(f.ownerToken, f.scope).state.document),
    ).toBe("Hello");

    client.archive(intentId);
    expect(client.activeEntries()).toHaveLength(0);
    expect(client.canWrite()).toBe(true);
  });

  it("is idempotent for a duplicate attempt and rejects payload or attempt mismatches", async () => {
    const f = await fixture();
    const base = f.authority.head();
    const intent: Intent = {
      v: 1,
      intentId: "intent-duplicate",
      writerId: f.ownerAuth.writerId,
      scope: f.scope,
      base,
      command: {
        kind: "text",
        blockId: "p1",
        from: 5,
        to: 5,
        text: "?",
        before: "Hello",
      },
    };
    const attempt: Attempt = {
      v: 1,
      attemptId: "attempt-duplicate",
      intent,
      base,
    };

    const first = f.authority.submit(f.ownerToken, attempt);
    expect(first.status).toBe("SERVER_ACCEPTED");
    const acceptedHead = f.authority.head();
    expect(f.authority.submit(f.ownerToken, attempt)).toEqual(first);
    expect(f.authority.head()).toEqual(acceptedHead);

    const changedIntent: Intent = {
      ...intent,
      command: {
        kind: "text",
        blockId: "p1",
        from: 5,
        to: 5,
        text: "!",
        before: "Hello",
      },
    };
    expect(
      codeOf(() =>
        f.authority.submit(f.ownerToken, {
          v: 1,
          attemptId: "attempt-duplicate-2",
          intent: changedIntent,
          base,
        }),
      ),
    ).toBe("ID_REUSE");

    const otherIntent: Intent = {
      ...intent,
      intentId: "intent-other",
      command: {
        kind: "text",
        blockId: "p1",
        from: 6,
        to: 6,
        text: "!",
        before: "Hello?",
      },
    };
    expect(
      codeOf(() =>
        f.authority.submit(f.ownerToken, {
          v: 1,
          attemptId: "attempt-duplicate",
          intent: otherIntent,
          base,
        }),
      ),
    ).toBe("ID_REUSE");
    expect(
      inlineText(f.authority.snapshot(f.ownerToken, f.scope).state.document),
    ).toBe("Hello?");
  });

  it("revokes one device without closing the workspace and keeps writer queues separate", async () => {
    const f = await fixture();
    const editorService = new SharedRuntimeService(
      join(f.tmp, "service-editor"),
    );
    f.services.push(editorService);
    await editorService.handle({
      type: "connect",
      url: f.url,
      token: f.editorToken,
      orgId: "org1",
    });
    const editorList = (await editorService.handle({ type: "list" })) as {
      workspaces: { workspaceId: string; role: string | null }[];
    };
    expect(editorList.workspaces[0].workspaceId).toBe("ws1");
    expect(editorList.workspaces[0].role).toBe("editor");
    const editorOpen = await editorService.handle({
      type: "open",
      scope: f.scope,
    });
    expect((editorOpen as { scope: Scope }).scope).toEqual(f.scope);

    const editorProvider = new HttpSharedProvider(f.url, f.editorToken);
    const editorClient = new SharedRuntimeClient(
      join(f.tmp, "client-editor"),
      editorProvider,
      f.scope,
      f.editorAuth.writerId,
    );
    f.clients.push(editorClient);
    await editorClient.open();
    const editorResult = await editorClient.submit({
      kind: "text",
      blockId: "p1",
      from: 5,
      to: 5,
      text: "B",
      before: "Hello",
    });
    expect(editorResult.receipt.status).toBe("SERVER_ACCEPTED");

    const ownerProvider = new HttpSharedProvider(f.url, f.ownerToken);
    const ownerClient = new SharedRuntimeClient(
      join(f.tmp, "client-owner"),
      ownerProvider,
      f.scope,
      f.ownerAuth.writerId,
    );
    f.clients.push(ownerClient);
    await ownerClient.open();
    const ownerResult = await ownerClient.submit({
      kind: "text",
      blockId: "p1",
      from: 6,
      to: 6,
      text: "O",
      before: "HelloB",
    });
    expect(ownerResult.receipt.status).toBe("SERVER_ACCEPTED");

    expect(f.editorAuth.writerId).not.toBe(f.ownerAuth.writerId);
    expect(editorClient.entries()).toHaveLength(1);
    expect(ownerClient.entries()).toHaveLength(1);
    expect(editorClient.entries()[0].intent.writerId).toBe(
      f.editorAuth.writerId,
    );
    expect(ownerClient.entries()[0].intent.writerId).toBe(f.ownerAuth.writerId);
    expect(
      inlineText(f.authority.snapshot(f.ownerToken, f.scope).state.document),
    ).toBe("HelloBO");

    f.authority.revokeDevice(f.ownerToken, "org1", f.editorAuth.deviceId);
    const revoked = new HttpSharedProvider(f.url, f.editorToken);
    await expect(revoked.snapshot(f.scope)).rejects.toMatchObject({
      code: "TOKEN_INVALID",
    });
    revoked.close();
    await expect(editorService.handle({ type: "list" })).rejects.toMatchObject({
      code: "TOKEN_INVALID",
    });
    expect(codeOf(() => f.authority.snapshot(f.editorToken, f.scope))).toBe(
      "TOKEN_INVALID",
    );
    expect(
      inlineText(f.authority.snapshot(f.ownerToken, f.scope).state.document),
    ).toBe("HelloBO");
  });

  it("fences stale generations, unauthorized senders, and navigation after disconnect", async () => {
    const f = await fixture();
    const service = new SharedRuntimeService(join(f.tmp, "service-fence"));
    f.services.push(service);
    await service.handle({
      type: "connect",
      url: f.url,
      token: f.ownerToken,
      orgId: "org1",
    });
    const first = (await service.handle({
      type: "open",
      scope: f.scope,
    })) as { generation: number; snapshot: Snapshot };
    const stale = first.generation;
    const second = (await service.handle({
      type: "open",
      scope: f.scope,
    })) as { generation: number; snapshot: Snapshot };
    expect(second.generation).toBeGreaterThan(stale);

    await expect(
      service.handle({ type: "refresh", generation: stale }),
    ).rejects.toMatchObject({ code: "STALE_SHARED_SESSION" });
    await expect(
      service.handle({ type: "recover", generation: stale }),
    ).rejects.toMatchObject({ code: "STALE_SHARED_SESSION" });
    await expect(
      service.handle({
        type: "document",
        generation: stale,
        base: first.snapshot.cut,
        document: documentWith("p1", "Hello!"),
      }),
    ).rejects.toMatchObject({ code: "STALE_SHARED_SESSION" });
    await expect(
      service.handle({
        type: "invalidate",
        generation: stale,
        intentId: "missing-intent",
      }),
    ).rejects.toMatchObject({ code: "STALE_SHARED_SESSION" });
    await expect(
      service.handle({
        type: "archive",
        generation: stale,
        intentId: "missing-intent",
      }),
    ).rejects.toMatchObject({ code: "STALE_SHARED_SESSION" });
    await expect(
      service.handle(
        { type: "refresh", generation: second.generation },
        () => false,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_IPC_SENDER" });

    const disconnected = (await service.handle({
      type: "disconnect",
    })) as { generation: number };
    await expect(
      service.handle({
        type: "refresh",
        generation: disconnected.generation,
      }),
    ).rejects.toMatchObject({ code: "SHARED_DOCUMENT_NOT_OPEN" });
  });

  it("converts only narrow plain text edits and keeps the rejected draft recoverable", async () => {
    const base = documentWith("p1", "Hello");
    expect(editorTextIntent(base, base)).toBeNull();
    expect(editorTextIntent(base, documentWith("p1", "Hello world"))).toEqual({
      kind: "text",
      blockId: "p1",
      before: "Hello",
      from: 5,
      to: 5,
      text: " world",
    });
    expect(
      editorTextIntent(documentWith("p1", "🌍"), documentWith("p1", "🌎")),
    ).toEqual({
      kind: "text",
      blockId: "p1",
      before: "🌍",
      from: 0,
      to: 2,
      text: "🌎",
    });

    const marked: Doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [{ type: "text", text: "Hello", marks: [{ type: "bold" }] }],
        },
      ],
    };
    expect(codeOf(() => editorTextIntent(base, marked))).toBe(
      "EDITOR_RICH_NOT_ADOPTED",
    );

    const beforeMultiple: Doc = {
      type: "doc",
      content: [paragraph("p1", "Hello"), paragraph("p2", "World")],
    };
    const afterMultiple: Doc = {
      type: "doc",
      content: [paragraph("p1", "Hello!"), paragraph("p2", "World!")],
    };
    expect(codeOf(() => editorTextIntent(beforeMultiple, afterMultiple))).toBe(
      "EDITOR_MULTI_BLOCK_NOT_ADOPTED",
    );

    const structural: Doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { id: "p1", level: 1 },
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    };
    expect(codeOf(() => editorTextIntent(base, structural))).toBe(
      "EDITOR_STRUCTURE_NOT_ADOPTED",
    );

    const f = await fixture();
    const service = new SharedRuntimeService(join(f.tmp, "service-draft"));
    f.services.push(service);
    await service.handle({
      type: "connect",
      url: f.url,
      token: f.ownerToken,
      orgId: "org1",
    });
    const opened = (await service.handle({
      type: "open",
      scope: f.scope,
    })) as { generation: number; snapshot: Snapshot };

    await expect(
      service.handle({
        type: "document",
        generation: opened.generation,
        base: opened.snapshot.cut,
        document: marked,
      }),
    ).rejects.toMatchObject({ code: "EDITOR_RICH_NOT_ADOPTED" });

    const recover = (await service.handle({
      type: "recover",
      generation: opened.generation,
    })) as string;
    const recovered = JSON.parse(recover) as {
      document: {
        drafts: { key: string; value: { document: Doc; cut: unknown } }[];
      };
    };
    expect(
      recovered.document.drafts.some(
        (draft) => canonical(draft.value.document) === canonical(marked),
      ),
    ).toBe(true);
    expect(
      inlineText(f.authority.snapshot(f.ownerToken, f.scope).state.document),
    ).toBe("Hello");
  });

  it("remembers and resumes a connection through the injected credential adapter", async () => {
    const f = await fixture();
    const credentials = new CredentialProvider(
      new FakeAsyncSafeStorage(),
      "darwin",
    );
    const service = new SharedRuntimeService(
      join(f.tmp, "service-credential"),
      credentials,
    );
    f.services.push(service);

    await service.handle({
      type: "connect",
      url: f.url,
      token: f.ownerToken,
      orgId: "org1",
      remember: true,
    });
    const connections = (await service.handle({
      type: "connections",
    })) as {
      connectionId: string;
      url: string;
      orgId: string;
      deviceId: string;
    }[];
    expect(connections).toHaveLength(1);
    expect(connections[0].url).toBe(f.url);
    expect(connections[0].orgId).toBe("org1");
    expect(connections[0].deviceId).toBe(f.ownerAuth.deviceId);

    await service.handle({ type: "disconnect" });
    await service.handle({
      type: "resume",
      connectionId: connections[0].connectionId,
    });
    const listed = (await service.handle({ type: "list" })) as {
      workspaces: { workspaceId: string }[];
    };
    expect(listed.workspaces[0].workspaceId).toBe("ws1");
    const opened = await service.handle({
      type: "open",
      scope: f.scope,
    });
    expect((opened as { scope: Scope }).scope).toEqual(f.scope);
  });
});
