import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  defaultClientStoreFactory,
  type ClientStoreFactory,
  type ClientStoreHostDeps,
} from "../src/collaboration/runtime/client-store-factory";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import {
  CollaborationError,
  scopeKey,
  type Attempt,
  type Cut,
  type Receipt,
  type ResourceCommand,
  type Scope,
  type Snapshot,
  type TextCommand,
} from "../src/collaboration/runtime/contract";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import {
  createSharedHttpServer,
  type SharedHttpServer,
} from "../src/collaboration/runtime/http-server";
import type {
  SharedProvider,
  WorkspaceListing,
} from "../src/collaboration/runtime/provider-port";
import { SharedResourceClient } from "../src/collaboration/runtime/resource-client";
import {
  RuntimeStore,
  type RuntimeStoreOptions,
} from "../src/collaboration/runtime/store";
import type { Doc } from "../src/shared/types";

const SCOPE: Scope = {
  orgId: "org1",
  workspaceId: "ws1",
  documentId: "doc1",
  incarnationId: "inc1",
};
const WRITER = "writer1";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

function unusedProvider(): SharedProvider {
  const fail = () => Promise.reject(new Error("provider unused"));
  return {
    snapshot: fail,
    submit: fail,
    receipt: fail,
    invalidate: fail,
    proof: fail,
    workspaces: fail,
    close: () => {},
  };
}

type FactoryCall = { directory: string; options: RuntimeStoreOptions };

function recordingFactory(calls: FactoryCall[]): ClientStoreFactory {
  return (directory, options) => {
    calls.push({ directory, options });
    return defaultClientStoreFactory(directory, options);
  };
}

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

type Fixture = {
  tmp: string;
  authority: SharedAuthority;
  server: SharedHttpServer;
  url: string;
  token: string;
  scope: Scope;
  writerId: string;
};

async function fixture(): Promise<Fixture> {
  const tmp = tempDir("folio-w08-factory-");
  const authority = new SharedAuthority(join(tmp, "authority"));
  const boot = authority.bootstrap({
    orgId: "org1",
    userId: "owner",
    deviceId: "owner-device",
    workspaceId: "ws1",
    documentId: "doc1",
    document: documentWith("p1", "Hello"),
  });
  const server = createSharedHttpServer(authority);
  const { url } = await server.listen();
  return {
    tmp,
    authority,
    server,
    url,
    token: boot.token,
    scope: boot.scope,
    writerId: boot.auth.writerId,
  };
}

class LostAckProvider implements SharedProvider {
  submits = 0;
  private lost = false;
  constructor(private readonly inner: HttpSharedProvider) {}
  snapshot(scope: Scope, after?: number): Promise<Snapshot> {
    return this.inner.snapshot(scope, after);
  }
  async submit(attempt: Attempt): Promise<Receipt> {
    this.submits++;
    const receipt = await this.inner.submit(attempt);
    if (!this.lost) {
      this.lost = true;
      throw new CollaborationError("LOST_RESPONSE");
    }
    return receipt;
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

class CountingProvider implements SharedProvider {
  submits = 0;
  receipts = 0;
  constructor(private readonly inner: HttpSharedProvider) {}
  snapshot(scope: Scope, after?: number): Promise<Snapshot> {
    return this.inner.snapshot(scope, after);
  }
  async submit(attempt: Attempt): Promise<Receipt> {
    this.submits++;
    return this.inner.submit(attempt);
  }
  async receipt(attempt: Attempt): Promise<Receipt | null> {
    this.receipts++;
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

const createDatabase = (databaseId: string): ResourceCommand => ({
  kind: "resource",
  action: "db.create",
  payload: {
    databaseId,
    revision: 0,
    properties: [{ id: "name", name: "Name", type: "text" }],
  },
});

describe("shared client store factory", () => {
  it("passes the exact directory and options reference once to the document client factory", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "doc-client");
    const options: RuntimeStoreOptions = { maxRows: 20_000 };
    const calls: FactoryCall[] = [];
    const client = new SharedRuntimeClient(
      directory,
      unusedProvider(),
      SCOPE,
      WRITER,
      options,
      { createStore: recordingFactory(calls) },
    );
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].directory).toBe(directory);
      expect(calls[0].options).toBe(options);
      expect(client.store).toBeInstanceOf(RuntimeStore);
      expect(client.store.path).toBe(
        join(realpathSync(directory), "shared-runtime.sqlite"),
      );
      client.store.transaction(() =>
        client.store.set("meta", "probe", "ok"),
      );
      expect(client.store.get("meta", "probe")).toBe("ok");
    } finally {
      client.close();
    }
  });

  it("passes the exact directory and options reference once to the resource client factory", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "resource-client");
    const options: RuntimeStoreOptions = { maxBytes: 128 * 1024 * 1024 };
    const calls: FactoryCall[] = [];
    const client = new SharedResourceClient(
      directory,
      unusedProvider(),
      WRITER,
      options,
      { createStore: recordingFactory(calls) },
    );
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].directory).toBe(directory);
      expect(calls[0].options).toBe(options);
      expect(client.store).toBeInstanceOf(RuntimeStore);
      expect(client.store.path).toBe(
        join(realpathSync(directory), "shared-runtime.sqlite"),
      );
    } finally {
      client.close();
    }
  });

  it("uses the default concrete RuntimeStore factory without host deps", () => {
    const root = tempDir("folio-w08-factory-");
    const document = new SharedRuntimeClient(
      join(root, "default-doc"),
      unusedProvider(),
      SCOPE,
      WRITER,
    );
    try {
      expect(document.store).toBeInstanceOf(RuntimeStore);
    } finally {
      document.close();
    }
    const resource = new SharedResourceClient(
      join(root, "default-resource"),
      unusedProvider(),
      WRITER,
    );
    try {
      expect(resource.store).toBeInstanceOf(RuntimeStore);
    } finally {
      resource.close();
    }
  });

  it("never calls the factory when scope or writer validation fails", () => {
    const root = tempDir("folio-w08-factory-");
    const calls: FactoryCall[] = [];
    const deps: ClientStoreHostDeps = { createStore: recordingFactory(calls) };
    expect(
      () =>
        new SharedRuntimeClient(
          join(root, "bad-scope"),
          unusedProvider(),
          { ...SCOPE, orgId: "bad id" },
          WRITER,
          {},
          deps,
        ),
    ).toThrow();
    expect(
      () =>
        new SharedRuntimeClient(
          join(root, "bad-writer"),
          unusedProvider(),
          SCOPE,
          "bad writer!",
          {},
          deps,
        ),
    ).toThrow("INVALID_ID");
    expect(
      () =>
        new SharedResourceClient(
          join(root, "bad-resource-writer"),
          unusedProvider(),
          "bad writer!",
          {},
          deps,
        ),
    ).toThrow("INVALID_ID");
    expect(calls).toHaveLength(0);
  });

  it("does not close a store the document factory never returned", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "doc-throw");
    let leaked: RuntimeStore | undefined;
    const createStore: ClientStoreFactory = (dir, options) => {
      leaked = new RuntimeStore(dir, options);
      vi.spyOn(leaked, "close");
      throw new Error("FACTORY_FAILED");
    };
    expect(
      () =>
        new SharedRuntimeClient(directory, unusedProvider(), SCOPE, WRITER, {}, {
          createStore,
        }),
    ).toThrow("FACTORY_FAILED");
    expect(leaked).toBeDefined();
    expect(vi.mocked(leaked!.close)).not.toHaveBeenCalled();
    leaked!.close();
  });

  it("does not close a store the resource factory never returned", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "resource-throw");
    let leaked: RuntimeStore | undefined;
    const createStore: ClientStoreFactory = (dir, options) => {
      leaked = new RuntimeStore(dir, options);
      vi.spyOn(leaked, "close");
      throw new Error("FACTORY_FAILED");
    };
    expect(
      () =>
        new SharedResourceClient(directory, unusedProvider(), WRITER, {}, {
          createStore,
        }),
    ).toThrow("FACTORY_FAILED");
    expect(leaked).toBeDefined();
    expect(vi.mocked(leaked!.close)).not.toHaveBeenCalled();
    leaked!.close();
  });

  it("closes the exact returned store once when document role initialization fails", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "doc-role");
    const seed = new RuntimeStore(directory);
    seed.transaction(() => seed.set("meta", "role", "authority"));
    seed.close();

    const calls: FactoryCall[] = [];
    let returned: RuntimeStore | undefined;
    const createStore: ClientStoreFactory = (dir, options) => {
      calls.push({ directory: dir, options });
      returned = new RuntimeStore(dir, options);
      vi.spyOn(returned, "close");
      return returned;
    };
    expect(
      () =>
        new SharedRuntimeClient(directory, unusedProvider(), SCOPE, WRITER, {}, {
          createStore,
        }),
    ).toThrow("WRONG_STORE_ROLE");
    expect(calls).toHaveLength(1);
    expect(vi.mocked(returned!.close)).toHaveBeenCalledTimes(1);
    expect(returned!.db.isOpen).toBe(false);
  });

  it("closes the exact returned store once when document queue recovery fails", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "doc-queue");
    const seed = new RuntimeStore(directory);
    seed.transaction(() =>
      seed.set(
        "client.queue",
        `${scopeKey(SCOPE)}:${WRITER}:seeded`,
        "corrupt",
      ),
    );
    seed.close();

    let returned: RuntimeStore | undefined;
    const createStore: ClientStoreFactory = (dir, options) => {
      returned = new RuntimeStore(dir, options);
      vi.spyOn(returned, "close");
      return returned;
    };
    expect(
      () =>
        new SharedRuntimeClient(directory, unusedProvider(), SCOPE, WRITER, {}, {
          createStore,
        }),
    ).toThrow("CORRUPT_QUEUE");
    expect(vi.mocked(returned!.close)).toHaveBeenCalledTimes(1);
    expect(returned!.db.isOpen).toBe(false);
  });

  it("closes the exact returned store once when resource role initialization fails", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "resource-role");
    const seed = new RuntimeStore(directory);
    seed.transaction(() => seed.set("meta", "role", "client"));
    seed.close();

    let returned: RuntimeStore | undefined;
    const createStore: ClientStoreFactory = (dir, options) => {
      returned = new RuntimeStore(dir, options);
      vi.spyOn(returned, "close");
      return returned;
    };
    expect(
      () =>
        new SharedResourceClient(directory, unusedProvider(), WRITER, {}, {
          createStore,
        }),
    ).toThrow("WRONG_STORE_ROLE");
    expect(vi.mocked(returned!.close)).toHaveBeenCalledTimes(1);
    expect(returned!.db.isOpen).toBe(false);
  });

  it("closes the exact returned store once when resource scope discovery fails", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "resource-queue");
    const seed = new RuntimeStore(directory);
    seed.transaction(() => seed.set("client.queue", "bad", {}));
    seed.close();

    let returned: RuntimeStore | undefined;
    const createStore: ClientStoreFactory = (dir, options) => {
      returned = new RuntimeStore(dir, options);
      vi.spyOn(returned, "close");
      return returned;
    };
    expect(
      () =>
        new SharedResourceClient(directory, unusedProvider(), WRITER, {}, {
          createStore,
        }),
    ).toThrow("CORRUPT_QUEUE");
    expect(vi.mocked(returned!.close)).toHaveBeenCalledTimes(1);
    expect(returned!.db.isOpen).toBe(false);
  });

  it("surfaces a returned-store close failure instead of faking cleanup success", () => {
    const root = tempDir("folio-w08-factory-");
    const directory = join(root, "close-fails");
    const seed = new RuntimeStore(directory);
    seed.transaction(() => seed.set("meta", "role", "authority"));
    seed.close();

    const createStore: ClientStoreFactory = (dir, options) => {
      const store = new RuntimeStore(dir, options);
      vi.spyOn(store, "close").mockImplementation(() => {
        throw new Error("CLOSE_FAILED");
      });
      return store;
    };
    expect(
      () =>
        new SharedRuntimeClient(directory, unusedProvider(), SCOPE, WRITER, {}, {
          createStore,
        }),
    ).toThrow("CLOSE_FAILED");
  });

  it("rejects a promise-returning factory at compile time", () => {
    const asyncFactory = async (
      directory: string,
      options: RuntimeStoreOptions,
    ) => new RuntimeStore(directory, options);
    // @ts-expect-error the client store factory contract is synchronous
    const rejected: ClientStoreFactory = asyncFactory;
    expect(typeof rejected).toBe("function");
  });

  it("keeps save, reopen, UNKNOWN and no-resubmit semantics through the injected factory", async () => {
    const f = await fixture();
    try {
      const directory = join(f.tmp, "client");
      const options: RuntimeStoreOptions = { maxRows: 20_000 };
      const calls: FactoryCall[] = [];
      const deps: ClientStoreHostDeps = {
        createStore: recordingFactory(calls),
      };

      const firstProvider = new LostAckProvider(
        new HttpSharedProvider(f.url, f.token),
      );
      const first = new SharedRuntimeClient(
        directory,
        firstProvider,
        f.scope,
        f.writerId,
        options,
        deps,
      );
      await first.open();
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
      expect(firstProvider.submits).toBe(1);
      expect(first.entries()).toHaveLength(1);
      expect(first.entries()[0].state).toBe("UNKNOWN");
      const raw = first.entries()[0].raw;
      first.close();

      const secondProvider = new CountingProvider(
        new HttpSharedProvider(f.url, f.token),
      );
      const second = new SharedRuntimeClient(
        directory,
        secondProvider,
        f.scope,
        f.writerId,
        options,
        deps,
      );
      await second.open();
      await second.reconcile();
      expect(second.entries()).toHaveLength(1);
      const entry = second.entries()[0];
      expect(entry.state).toBe("CLIENT_RECEIPT_DURABLE");
      expect(entry.attempts[0].state).toBe("ACCEPTED");
      expect(entry.attempts[0].receipt?.status).toBe("SERVER_ACCEPTED");
      expect(entry.raw).toBe(raw);
      expect(canonical(entry.intent.command)).toBe(canonical(command));
      expect(secondProvider.submits).toBe(0);
      expect(secondProvider.receipts).toBeGreaterThanOrEqual(1);
      second.close();

      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.directory).toBe(directory);
        expect(call.options).toBe(options);
      }
    } finally {
      await f.server.close();
      f.authority.close();
    }
  });

  it("persists resource queue entries through the injected factory across reopen", async () => {
    const f = await fixture();
    try {
      const directory = join(f.tmp, "resources");
      const calls: FactoryCall[] = [];
      const deps: ClientStoreHostDeps = {
        createStore: recordingFactory(calls),
      };

      const first = new SharedResourceClient(
        directory,
        new HttpSharedProvider(f.url, f.token),
        f.writerId,
        {},
        deps,
      );
      const receipt = await first.execute(
        f.scope,
        createDatabase("db1"),
        f.authority.head(),
      );
      expect(receipt.status).toBe("SERVER_ACCEPTED");
      expect(first.hasPending()).toBe(false);
      first.close();

      const second = new SharedResourceClient(
        directory,
        new HttpSharedProvider(f.url, f.token),
        f.writerId,
        {},
        deps,
      );
      try {
        expect(second.entries()).toHaveLength(1);
        expect(second.entries()[0].state).toBe("CLIENT_RECEIPT_DURABLE");
        expect(second.hasPending()).toBe(false);
      } finally {
        second.close();
      }
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call.directory).toBe(directory);
    } finally {
      await f.server.close();
      f.authority.close();
    }
  });
});
