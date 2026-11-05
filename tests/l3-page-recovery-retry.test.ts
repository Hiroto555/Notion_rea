import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import {
  CrashRecoveryFile,
  crashRecoveryWorkspaceId,
} from "../src/persistence/crash-recovery-file";
import { PageOperationCoordinator } from "../src/renderer/page-operation-coordinator";
import { retryUnconfirmedPageOperations } from "../src/renderer/page-operation-recovery";
import { prepareCrashRecovery } from "../src/renderer/prepare-crash-recovery";
import {
  describePageOperation,
  preparePageCreation,
} from "../src/shared/page-operation";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import {
  emptyCrashRecoverySnapshot,
  type CrashRecoverySnapshot,
} from "../src/shared/crash-recovery";
import type { Doc, Request } from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-l3-page-retry-"),
  );
  const store = new Store(join(root, "workspace.sqlite"));
  return {
    root,
    store,
    recoveryPath: join(root, "recovery.json"),
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function initialDoc(text: string): Doc {
  return {
    type: "doc",
    schemaVersion: 1,
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "見出し" }] },
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

it("retries a checkpointed unsent create only on an explicit call, reusing the exact operation", async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const doc = initialDoc("明示再試行の本文");
    const workspaceId = crashRecoveryWorkspaceId(f.store);
    const file = new CrashRecoveryFile(f.recoveryPath, workspaceId);
    const coordinator = new PageOperationCoordinator(
      async (request) => {
        if (request.type === "page:commit")
          throw new Error("the commit was never sent");
        return f.store.handle(request);
      },
      {
        persist: async () => {
          const snapshot: CrashRecoverySnapshot = {
            ...emptyCrashRecoverySnapshot(),
            pageOperations: coordinator.unresolvedOperations(),
          };
          file.write(0, snapshot);
        },
      },
    );
    await expect(
      coordinator.create(null, "未送信の作成", doc),
    ).rejects.toThrow(/不明/);
    expect(f.store.pages()).toHaveLength(0);
    const retained = coordinator.unresolvedOperations()[0];
    expect(retained.command).toMatchObject({
      kind: "createPage",
      title: "未送信の作成",
    });

    f.store.close();
    reopened = new Store(join(f.root, "workspace.sqlite"));
    const read = file.read();
    expect(read.status).toBe("ready");
    expect(read.snapshot!.pageOperations![0].operationId).toBe(
      retained.operationId,
    );

    // Normal startup recovery is query-only: it resolves the same ID and keeps
    // the unknown input without sending a commit.
    const resolveOnly: Request[] = [];
    await expect(
      prepareCrashRecovery(read.snapshot!, async <T,>(request: Request): Promise<T> => {
        resolveOnly.push(structuredClone(request));
        return reopened!.handle(request) as T;
      }),
    ).rejects.toThrow(/確認できません/);
    expect(resolveOnly.map((request) => request.type)).toEqual([
      "page:resolve",
    ]);
    expect(reopened.pages()).toHaveLength(0);

    // The explicit user retry resolves first, then commits only the unknown
    // operation with the same identity and payload.
    const requests: Request[] = [];
    const api = async (request: Request): Promise<unknown> => {
      requests.push(structuredClone(request));
      return reopened!.handle(request);
    };
    const report = await retryUnconfirmedPageOperations(read.snapshot!, api);
    expect(report).toEqual({
      resolvedApplied: 0,
      committed: 1,
      retainedUnknown: 0,
      rejected: 0,
    });
    expect(requests.map((request) => request.type)).toEqual([
      "page:resolve",
      "page:commit",
    ]);
    const committed = requests[1] as Extract<Request, { type: "page:commit" }>;
    expect(committed.operation).toEqual(retained);
    expect(reopened.pages()).toHaveLength(1);
    expect(reopened.pages()[0].doc).toEqual(doc);

    // Already applied: a second explicit call only resolves and never commits.
    requests.length = 0;
    const again = await retryUnconfirmedPageOperations(read.snapshot!, api);
    expect(again).toEqual({
      resolvedApplied: 1,
      committed: 0,
      retainedUnknown: 0,
      rejected: 0,
    });
    expect(requests.map((request) => request.type)).toEqual(["page:resolve"]);
    expect(reopened.pages()).toHaveLength(1);
  } finally {
    reopened?.close();
    f.dispose();
  }
});

it("does not commit a retained operation that already has an applied receipt", async () => {
  const f = fixture();
  try {
    const doc = initialDoc("適用済みの本文");
    const operation = preparePageCreation("適用済み", null, doc);
    expect(f.store.commitPageOperation(operation).status).toBe("applied");
    const snapshot: CrashRecoverySnapshot = {
      ...emptyCrashRecoverySnapshot(),
      pageOperations: [operation],
    };
    const requests: Request[] = [];
    const report = await retryUnconfirmedPageOperations(
      snapshot,
      async (request: Request): Promise<unknown> => {
        requests.push(structuredClone(request));
        return f.store.handle(request);
      },
    );
    expect(report.resolvedApplied).toBe(1);
    expect(report.committed).toBe(0);
    expect(requests.map((request) => request.type)).toEqual(["page:resolve"]);
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("retains the exact operation when the explicit retry also loses its ACK", async () => {
  const f = fixture();
  try {
    const doc = initialDoc("再試行ACK喪失");
    const operation = preparePageCreation("再試行ACK喪失", null, doc);
    const snapshot: CrashRecoverySnapshot = {
      ...emptyCrashRecoverySnapshot(),
      pageOperations: [operation],
    };
    const requests: Request[] = [];
    let lose = true;
    const api = async (request: Request): Promise<unknown> => {
      requests.push(structuredClone(request));
      const result = f.store.handle(request);
      if (request.type === "page:commit" && lose) {
        lose = false;
        throw new Error("lost retry ACK");
      }
      return result;
    };
    await expect(retryUnconfirmedPageOperations(snapshot, api)).rejects.toThrow(
      /保持/,
    );
    expect(f.store.pages()).toHaveLength(1);
    expect(f.store.pages()[0].doc).toEqual(doc);
    expect(snapshot.pageOperations).toHaveLength(1);

    requests.length = 0;
    const report = await retryUnconfirmedPageOperations(snapshot, api);
    expect(report.resolvedApplied).toBe(1);
    expect(report.committed).toBe(0);
    expect(requests.map((request) => request.type)).toEqual(["page:resolve"]);
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("reports a rejected operation with its reason and never re-sends it", async () => {
  const f = fixture();
  try {
    const doc = initialDoc("拒否される本文");
    const operation = preparePageCreation("拒否される子", "missing-parent", doc);
    const rejected = f.store.commitPageOperation(operation);
    expect(rejected.status).toBe("rejected");
    const snapshot: CrashRecoverySnapshot = {
      ...emptyCrashRecoverySnapshot(),
      pageOperations: [operation],
    };
    const requests: Request[] = [];
    await expect(
      retryUnconfirmedPageOperations(snapshot, async (request: Request): Promise<unknown> => {
        requests.push(structuredClone(request));
        return f.store.handle(request);
      }),
    ).rejects.toThrow(/ページが見つかりません/);
    expect(requests.map((request) => request.type)).toEqual(["page:resolve"]);
    expect(f.store.pages()).toHaveLength(0);
    expect(snapshot.pageOperations).toHaveLength(1);
    expect(describePageOperation(operation)).toContain("拒否される子");
  } finally {
    f.dispose();
  }
});

it("does not retry save, database, property or migration lanes", async () => {
  const f = fixture();
  try {
    const doc = initialDoc("ページだけ");
    const operation = preparePageCreation("ページだけ", null, doc);
    expect(f.store.commitPageOperation(operation).status).toBe("applied");
    const snapshot: CrashRecoverySnapshot = {
      ...emptyCrashRecoverySnapshot(),
      pageOperations: [operation],
      creations: [prepareDatabaseCreation("未作成のDB")],
    };
    const requests: Request[] = [];
    await retryUnconfirmedPageOperations(snapshot, async (request: Request): Promise<unknown> => {
      requests.push(structuredClone(request));
      return f.store.handle(request);
    });
    expect(requests.map((request) => request.type)).toEqual(["page:resolve"]);
  } finally {
    f.dispose();
  }
});

it("keeps a rejected operation as retained input until the user preserves or discards it", async () => {
  const f = fixture();
  try {
    const source = f.store.create(null, "page", "原本");
    const coordinator = new PageOperationCoordinator(async (request) =>
      f.store.handle(request),
    );
    await expect(
      coordinator.duplicate(source.id, source.revision + 1),
    ).rejects.toThrow(/版/);
    expect(coordinator.hasUnresolved()).toBe(false);
    expect(coordinator.hasRetained()).toBe(true);
    const entry = coordinator.firstRejected();
    expect(entry?.state).toBe("rejected");
    expect(coordinator.unresolvedOperations()).toHaveLength(1);

    // Checking the durable result explains the rejection but does not turn it
    // into success or silently drop the input.
    const resolved = await coordinator.resolveNext();
    expect(resolved?.status).toBe("rejected");
    expect(coordinator.hasRetained()).toBe(true);

    // A new explicit user action is not blocked by a terminal rejection.
    const created = await coordinator.create(null, "次の作成");
    expect(created.title).toBe("次の作成");
    expect(f.store.pages()).toHaveLength(2);

    expect(coordinator.discard(entry!.operation.operationId)).toBe(true);
    expect(coordinator.hasRetained()).toBe(false);
    expect(coordinator.entries()).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it("retries an old-style operation without a document with the same identity", async () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("旧形式の再試行");
    const snapshot: CrashRecoverySnapshot = {
      ...emptyCrashRecoverySnapshot(),
      pageOperations: [operation],
    };
    const requests: Request[] = [];
    const report = await retryUnconfirmedPageOperations(
      snapshot,
      async (request: Request): Promise<unknown> => {
        requests.push(structuredClone(request));
        return f.store.handle(request);
      },
    );
    expect(report.committed).toBe(1);
    expect(requests.map((request) => request.type)).toEqual([
      "page:resolve",
      "page:commit",
    ]);
    expect(f.store.pages()).toHaveLength(1);
    expect(f.store.pages()[0].title).toBe("旧形式の再試行");
    expect(f.store.pages()[0].doc).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  } finally {
    f.dispose();
  }
});

it("keeps a rejected page operation query-only at startup", async () => {
  const f = fixture();
  try {
    const operation = preparePageCreation(
      "起動時の拒否",
      "missing-parent",
      initialDoc("保持する本文"),
    );
    expect(f.store.commitPageOperation(operation).status).toBe("rejected");
    const snapshot: CrashRecoverySnapshot = {
      ...emptyCrashRecoverySnapshot(),
      pageOperations: [operation],
    };
    const requests: Request[] = [];
    await expect(
      prepareCrashRecovery(snapshot, async <T,>(request: Request): Promise<T> => {
        requests.push(structuredClone(request));
        return f.store.handle(request) as T;
      }),
    ).rejects.toThrow(/ページが見つかりません/);
    expect(requests.map((request) => request.type)).toEqual(["page:resolve"]);
    expect(f.store.pages()).toHaveLength(0);
    expect(snapshot.pageOperations).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("resolves a committed page operation at startup without writing", async () => {
  const f = fixture();
  try {
    const doc = initialDoc("起動時の照合");
    const operation = preparePageCreation("起動時の照合", null, doc);
    expect(f.store.commitPageOperation(operation).status).toBe("applied");
    const snapshot: CrashRecoverySnapshot = {
      ...emptyCrashRecoverySnapshot(),
      pageOperations: [operation],
    };
    const requests: Request[] = [];
    const prepared = await prepareCrashRecovery(snapshot, async <T,>(request: Request): Promise<T> => {
      requests.push(structuredClone(request));
      return f.store.handle(request) as T;
    });
    expect(requests.map((request) => request.type)).toEqual([
      "page:resolve",
      "load",
    ]);
    expect(prepared.pageOperations).toEqual([]);
    expect(f.store.pages()).toHaveLength(1);
    expect(f.store.pages()[0].doc).toEqual(doc);
  } finally {
    f.dispose();
  }
});
