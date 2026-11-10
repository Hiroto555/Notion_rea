import { canonical } from "../src/collaboration/runtime/canonical";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import { createSharedHttpServer } from "../src/collaboration/runtime/http-server";
import { SharedResourceClient } from "../src/collaboration/runtime/resource-client";
import {
  CollaborationError,
  scopeKey,
  type Attempt,
  type Cut,
  type Receipt,
  type ResourceCommand,
  type Scope,
  type Snapshot,
} from "../src/collaboration/runtime/contract";
import type {
  SharedProvider,
  WorkspaceListing,
} from "../src/collaboration/runtime/provider-port";
import { blankDoc } from "../src/shared/types";

type RecordsView = {
  records: {
    id: string;
    revision: number;
    title: string;
    values: Record<string, string | number | boolean>;
    deleted: boolean;
  }[];
};

type Environment = {
  root: string;
  authority: SharedAuthority;
  server: { close(): Promise<void> };
  url: string;
  token: string;
  writerId: string;
  scope: Scope;
};

const environments: Environment[] = [];

async function environment(): Promise<Environment> {
  const root = mkdtempSync(join(tmpdir(), "folio-resource-client-"));
  const authority = new SharedAuthority(join(root, "authority"));
  const server = createSharedHttpServer(authority);
  const { url } = await server.listen();
  const boot = authority.bootstrap({
    orgId: "org1",
    userId: "user1",
    deviceId: "device1",
    workspaceId: "workspace1",
    documentId: "root1",
    document: JSON.parse(
      canonical({
        type: "doc",
        content: [{ type: "paragraph", attrs: { id: "resource_p" } }],
      }),
    ),
  });
  const env: Environment = {
    root,
    authority,
    server,
    url,
    token: boot.token,
    writerId: boot.auth.writerId,
    scope: boot.scope,
  };
  environments.push(env);
  return env;
}

afterEach(async () => {
  while (environments.length > 0) {
    const env = environments.pop()!;
    await env.server.close().catch(() => undefined);
    env.authority.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

class FaultProvider implements SharedProvider {
  private failed = false;
  constructor(
    private readonly inner: HttpSharedProvider,
    private readonly mode: "before-send" | "after-commit",
  ) {}
  snapshot(scope: Scope, after?: number): Promise<Snapshot> {
    return this.inner.snapshot(scope, after);
  }
  async submit(attempt: Attempt): Promise<Receipt> {
    if (
      attempt.intent.command.kind === "resource" &&
      attempt.intent.command.action === "db.create"
    )
      return this.inner.submit(attempt);
    if (this.failed) return this.inner.submit(attempt);
    this.failed = true;
    if (this.mode === "before-send")
      throw new CollaborationError("NETWORK_ERROR");
    await this.inner.submit(attempt);
    throw new CollaborationError("LOST_HTTP_ACK");
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

const createDatabase = (
  databaseId: string,
  options: { done?: boolean } = {},
): ResourceCommand => ({
  kind: "resource",
  action: "db.create",
  payload: {
    databaseId,
    revision: 0,
    properties: [
      { id: "name", name: "Name", type: "text" },
      ...(options.done
        ? [{ id: "done", name: "Done", type: "checkbox" as const }]
        : []),
    ],
  },
});

const schemaChange = (
  databaseId: string,
  revision: number,
): ResourceCommand => ({
  kind: "resource",
  action: "db.schema",
  payload: {
    databaseId,
    revision,
    properties: [
      { id: "name", name: "Name", type: "text" },
      { id: "done", name: "Done", type: "checkbox" },
    ],
  },
});

const recordCreate = (
  databaseId: string,
  title: string,
  values: Record<string, string | number | boolean>,
): ResourceCommand => ({
  kind: "resource",
  action: "record.create",
  payload: {
    databaseId,
    revision: 0,
    title,
    values,
    document: JSON.parse(
      canonical({
        type: "doc",
        content: [{ type: "paragraph", attrs: { id: "resource_p" } }],
      }),
    ),
  },
});

describe("SharedResourceClient", () => {
  it("creates a record at a fresh scope and applies schema CAS plus record.patch", async () => {
    const env = await environment();
    const provider = new HttpSharedProvider(env.url, env.token);
    const client = new SharedResourceClient(
      join(env.root, "writers", "w1"),
      provider,
      env.writerId,
    );
    try {
      const dbReceipt = await client.execute(
        env.scope,
        createDatabase("db1"),
        env.authority.head(),
      );
      expect(dbReceipt.status).toBe("SERVER_ACCEPTED");
      expect(client.hasPending()).toBe(false);

      const recordScope: Scope = {
        orgId: env.scope.orgId,
        workspaceId: env.scope.workspaceId,
        documentId: "record1",
        incarnationId: "incarnation1",
      };
      const createReceipt = await client.execute(
        recordScope,
        recordCreate("db1", "Alpha", { name: "Alpha" }),
        env.authority.head(),
      );
      expect(createReceipt.status).toBe("SERVER_ACCEPTED");
      expect(createReceipt.intentId).toBeTruthy();
      const headAfterCreate = env.authority.head();
      expect(createReceipt.cut.epoch).toBe(headAfterCreate.epoch);
      expect(createReceipt.cut.seq).toBe(headAfterCreate.seq);

      const rootView = env.authority.records(
        env.token,
        env.scope,
      ) as unknown as RecordsView;
      expect(rootView.records).toHaveLength(1);
      expect(rootView.records[0].id).toBe("record1");
      expect(rootView.records[0].values).toEqual({ name: "Alpha" });

      const body = env.authority.snapshot(env.token, recordScope);
      expect(body.state.document.type).toBe("doc");
      expect(body.cut.seq).toBe(headAfterCreate.seq);

      const schemaReceipt = await client.execute(
        env.scope,
        schemaChange("db1", 0),
        env.authority.head(),
      );
      expect(schemaReceipt.status).toBe("SERVER_ACCEPTED");

      const patchReceipt = await client.execute(
        recordScope,
        {
          kind: "resource",
          action: "record.patch",
          payload: {
            databaseId: "db1",
            revision: 0,
            schemaRevision: 1,
            title: "Beta",
            values: { name: "Beta", done: true },
          },
        },
        env.authority.head(),
      );
      expect(patchReceipt.status).toBe("SERVER_ACCEPTED");

      const patched = env.authority.records(
        env.token,
        env.scope,
      ) as unknown as RecordsView;
      expect(patched.records[0].revision).toBe(1);
      expect(patched.records[0].title).toBe("Beta");
      expect(patched.records[0].values).toEqual({
        name: "Beta",
        done: true,
      });

      const stale = await client.execute(
        env.scope,
        schemaChange("db1", 0),
        env.authority.head(),
      );
      expect(stale.status).toBe("REJECTED");
      expect(stale.code).toBe("STALE_DATABASE");
      expect(client.hasPending()).toBe(true);
      expect(() => client.archive(env.scope, stale.intentId)).not.toThrow();
      expect(client.hasPending()).toBe(false);
    } finally {
      client.close();
    }
  });

  it("keeps a lost HTTP acknowledgement UNKNOWN and reconciles without resending", async () => {
    const env = await environment();
    const inner = new HttpSharedProvider(env.url, env.token);
    const fault = new FaultProvider(inner, "after-commit");
    const first = new SharedResourceClient(
      join(env.root, "writers", "lost"),
      fault,
      env.writerId,
    );
    const recordScope: Scope = {
      orgId: env.scope.orgId,
      workspaceId: env.scope.workspaceId,
      documentId: "record-lost",
      incarnationId: "incarnation-lost",
    };
    const dbReceipt = await first.execute(
      env.scope,
      createDatabase("db-lost"),
      env.authority.head(),
    );
    expect(dbReceipt.status).toBe("SERVER_ACCEPTED");
    const baseBefore = env.authority.head();

    await expect(
      first.execute(
        recordScope,
        recordCreate("db-lost", "Lost", { name: "Lost" }),
        baseBefore,
      ),
    ).rejects.toThrow("LOST_HTTP_ACK");
    const entry = first
      .entries()
      .find((item) => item.intent.scope.documentId === "record-lost")!;
    expect(entry.state).toBe("UNKNOWN");
    expect(entry.attempts[0].state).toBe("UNKNOWN");
    expect(entry.attempts[0].receipt).toBeNull();
    expect(first.hasPending()).toBe(true);
    const committedHead = env.authority.head();
    expect(committedHead.seq).toBe(baseBefore.seq + 1);
    await expect(
      first.execute(
        recordScope,
        recordCreate("db-lost", "Blocked", { name: "Blocked" }),
        committedHead,
      ),
    ).rejects.toThrow("PENDING_INTENT_BLOCKS_WRITE");
    const committedView = env.authority.records(
      env.token,
      env.scope,
    ) as unknown as RecordsView;
    expect(committedView.records).toHaveLength(1);
    first.close();

    const provider = new HttpSharedProvider(env.url, env.token);
    const reopened = new SharedResourceClient(
      join(env.root, "writers", "lost"),
      provider,
      env.writerId,
    );
    try {
      expect(reopened.entries()).toHaveLength(2);
      await reopened.reconcile();
      const reconciled = reopened
        .entries()
        .find((item) => item.intent.intentId === entry.intent.intentId)!;
      expect(reconciled.state).toBe("CLIENT_RECEIPT_DURABLE");
      expect(reconciled.attempts).toHaveLength(1);
      expect(reconciled.attempts[0].state).toBe("ACCEPTED");
      expect(reconciled.attempts[0].receipt?.status).toBe("SERVER_ACCEPTED");
      expect(reopened.hasPending()).toBe(false);
      expect(env.authority.head()).toEqual(committedHead);
    } finally {
      reopened.close();
    }
  });

  it("closes a before-send failure explicitly and archives the original raw intent", async () => {
    const env = await environment();
    const inner = new HttpSharedProvider(env.url, env.token);
    const fault = new FaultProvider(inner, "before-send");
    const client = new SharedResourceClient(
      join(env.root, "writers", "fault"),
      fault,
      env.writerId,
    );
    const probe = new HttpSharedProvider(env.url, env.token);
    const recordScope: Scope = {
      orgId: env.scope.orgId,
      workspaceId: env.scope.workspaceId,
      documentId: "record-fault",
      incarnationId: "incarnation-fault",
    };
    try {
      const dbReceipt = await client.execute(
        env.scope,
        createDatabase("db-fault"),
        env.authority.head(),
      );
      expect(dbReceipt.status).toBe("SERVER_ACCEPTED");
      const base = env.authority.head();

      await expect(
        client.execute(
          recordScope,
          recordCreate("db-fault", "Fault", { name: "Fault" }),
          base,
        ),
      ).rejects.toThrow("NETWORK_ERROR");
      const entry = client
        .entries()
        .find((item) => item.intent.scope.documentId === "record-fault")!;
      const originalRaw = entry.raw;
      expect(entry.state).toBe("UNKNOWN");
      expect(await probe.receipt(entry.attempts[0].attempt)).toBeNull();
      expect(env.authority.head()).toEqual(base);
      expect(client.hasPending()).toBe(true);

      await expect(
        client.execute(
          recordScope,
          recordCreate("db-fault", "Blocked", { name: "Blocked" }),
          env.authority.head(),
        ),
      ).rejects.toThrow("PENDING_INTENT_BLOCKS_WRITE");

      const invalidated = await client.invalidate(
        recordScope,
        entry.intent.intentId,
      );
      expect(invalidated.status).toBe("INVALIDATED");
      expect(invalidated.intentId).toBe(entry.intent.intentId);
      expect(client.hasPending()).toBe(true);

      client.archive(recordScope, entry.intent.intentId);
      expect(client.hasPending()).toBe(false);
      const queueRow = client
        .entries()
        .find((item) => item.intent.intentId === entry.intent.intentId)!;
      expect(queueRow.raw).toBe(originalRaw);
      const marker = client.store.get(
        "resource-client.archive",
        `${scopeKey(recordScope)}:${env.writerId}:${entry.intent.intentId}`,
      ) as { raw: string };
      expect(marker.raw).toBe(originalRaw);

      const released = await client.execute(
        recordScope,
        recordCreate("db-fault", "Released", { name: "Released" }),
        env.authority.head(),
      );
      expect(released.status).toBe("SERVER_ACCEPTED");
      const view = env.authority.records(
        env.token,
        env.scope,
      ) as unknown as RecordsView;
      expect(view.records.map((record) => record.id)).toEqual(["record-fault"]);
    } finally {
      probe.close();
      client.close();
    }
  });

  it("rejects a non-resource command and oversized input before queueing", async () => {
    const env = await environment();
    const provider = new HttpSharedProvider(env.url, env.token);
    const client = new SharedResourceClient(
      join(env.root, "writers", "input"),
      provider,
      env.writerId,
    );
    try {
      const notResource = {
        kind: "text",
        blockId: "block1",
        from: 0,
        to: 0,
        text: "",
        before: "",
      } as unknown as ResourceCommand;
      await expect(
        client.execute(env.scope, notResource, env.authority.head()),
      ).rejects.toThrow("INVALID_COMMAND");
      expect(client.entries()).toHaveLength(0);
      expect(client.hasPending()).toBe(false);

      const oversized: ResourceCommand = {
        kind: "resource",
        action: "record.create",
        payload: {
          databaseId: "db1",
          revision: 0,
          title: "Too large",
          values: {},
          document: { type: "doc", blob: "x".repeat(1_100_000) },
        },
      };
      await expect(
        client.execute(env.scope, oversized, env.authority.head()),
      ).rejects.toThrow("JSON_LIMIT");
      expect(client.entries()).toHaveLength(0);
      expect(client.hasPending()).toBe(false);
    } finally {
      client.close();
    }
  });

  it("rejects a directory owned by another role", async () => {
    const env = await environment();
    const provider = new HttpSharedProvider(env.url, env.token);
    env.authority.close();
    try {
      expect(
        () =>
          new SharedResourceClient(
            join(env.root, "authority"),
            provider,
            env.writerId,
          ),
      ).toThrow("WRONG_STORE_ROLE");
    } finally {
      provider.close();
    }
  });
});
