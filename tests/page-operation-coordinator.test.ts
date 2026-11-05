import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import {
  PageOperationCoordinator,
  resolvePageOperation,
} from "../src/renderer/page-operation-coordinator";
import { preparePageCreation, preparePageDuplication } from "../src/shared/page-operation";
import {
  emptyCrashRecoverySnapshot,
  hasCrashRecoveryInput,
  validateCrashRecoverySnapshot,
} from "../src/shared/crash-recovery";
import { prepareCrashRecovery } from "../src/renderer/prepare-crash-recovery";
import type { Request } from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(resolve("output/page-operation-coordinator-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const api = <T,>(request: Request) => Promise.resolve(store.handle(request) as T);
  return {
    root,
    store,
    api,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

it("writes the operation to recovery before sending and resolves the same ID after a lost ACK", async () => {
  const f = fixture();
  try {
    const requests: Request[] = [];
    let persisted: string[] = [];
    const coordinator = new PageOperationCoordinator(
      async (request) => {
        requests.push(request);
        const result = f.store.handle(request);
        // The workspace committed, but the renderer never received this ACK.
        if (request.type === "page:commit") throw new Error("lost ACK");
        return result;
      },
      {
        persist: async () => {
          expect(requests).toHaveLength(0);
          persisted = coordinator.unresolvedOperations().map((op) => op.operationId);
        },
      },
    );
    await expect(coordinator.create(null, "失われたACK")).rejects.toThrow();
    expect(persisted).toHaveLength(1);
    expect(coordinator.hasUnresolved()).toBe(true);
    expect(coordinator.firstUnknown()?.state).toBe("unknown");
    expect(f.store.pages()).toHaveLength(1);

    const retained = coordinator.unresolvedOperations()[0];
    const resolved = await coordinator.resolveNext();
    expect(resolved).toMatchObject({ status: "applied", page: { title: "失われたACK" } });
    const last = requests.at(-1);
    expect(last?.type).toBe("page:resolve");
    if (last?.type === "page:resolve")
      expect(last.operation.operationId).toBe(retained.operationId);
    expect(coordinator.hasUnresolved()).toBe(false);
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("turns a timeout into unknown and resolves the committed Page later", async () => {
  const f = fixture();
  try {
    const coordinator = new PageOperationCoordinator(
      async (request) => {
        const result = f.store.handle(request);
        if (request.type === "page:commit") await sleep(30);
        return result;
      },
      { timeoutMs: 5 },
    );
    await expect(coordinator.create(null, "時間切れ")).rejects.toThrow(/不明/);
    expect(coordinator.firstUnknown()).toBeDefined();
    const resolved = await coordinator.resolveNext();
    expect(resolved).toMatchObject({ status: "applied" });
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("retains an operation whose ACK identity is corrupted until a real commit exists", async () => {
  const f = fixture();
  try {
    const coordinator = new PageOperationCoordinator(async (request) => {
      if (request.type === "page:commit")
        return {
          ...(f.store.resolvePageOperation(request.operation) as object),
          operationId: "other-operation",
        };
      return f.store.handle(request);
    });
    await expect(coordinator.create(null, "ACK不一致")).rejects.toThrow(/一致しません/);
    const retained = coordinator.unresolvedOperations()[0];
    expect(coordinator.hasUnresolved()).toBe(true);
    expect(f.store.pages()).toHaveLength(0);

    const missing = await coordinator.resolveNext();
    expect(missing?.status).toBe("unknown");
    expect(coordinator.hasUnresolved()).toBe(true);

    // The commit did land under the retained operation ID; resolve is safe.
    const applied = f.store.commitPageOperation(retained);
    expect(applied.status).toBe("applied");
    expect(f.store.pages()).toHaveLength(1);
    expect((await coordinator.resolveNext())?.status).toBe("applied");
    expect(coordinator.hasUnresolved()).toBe(false);
  } finally {
    f.dispose();
  }
});

it("refuses an unrepresentable operation before journaling or sending", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const coordinator = new PageOperationCoordinator(async (request) => {
      sent++;
      return f.store.handle(request);
    });
    await expect(coordinator.create(null, "x".repeat(501))).rejects.toThrow(/上限/);
    expect(sent).toBe(0);
    expect(coordinator.hasUnresolved()).toBe(false);
    expect(f.store.pages()).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it("sends nothing when the recovery journal cannot be written", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const coordinator = new PageOperationCoordinator(
      async (request) => {
        sent++;
        return f.store.handle(request);
      },
      { persist: async () => Promise.reject(new Error("journal unavailable")) },
    );
    await expect(coordinator.create(null, "送信しない")).rejects.toThrow(/復旧記録/);
    expect(sent).toBe(0);
    expect(coordinator.hasUnresolved()).toBe(true);
    expect(coordinator.firstUncheckpointed()?.operation.command).toMatchObject({ title: "送信しない" });
    expect(f.store.pages()).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it("rejects a duplicate of a stale revision without copying or retrying under a new ID", async () => {
  const f = fixture();
  try {
    const source = f.store.create(null, "page", "原本");
    const requests: Request[] = [];
    const coordinator = new PageOperationCoordinator(async (request) => {
      requests.push(request);
      return f.store.handle(request);
    });
    await expect(coordinator.duplicate(source.id, source.revision + 1)).rejects.toThrow(/版/);
    expect(coordinator.hasUnresolved()).toBe(false);
    expect(f.store.pages()).toHaveLength(1);
    expect(requests).toHaveLength(1);
    if (requests[0].type === "page:commit")
      expect(requests[0].operation.command).toEqual({
        kind: "duplicatePage",
        pageId: source.id,
        revision: source.revision + 1,
      });

    const copy = await coordinator.duplicate(source.id, source.revision);
    expect(copy.title).toBe("原本 のコピー");
    expect(f.store.pages()).toHaveLength(2);
  } finally {
    f.dispose();
  }
});

it("stores unresolved page operations in crash recovery and resolves them at startup", async () => {
  const f = fixture();
  try {
    const unknownOperation = preparePageDuplication("missing-page", 0);
    expect(() => validateCrashRecoverySnapshot(emptyCrashRecoverySnapshot())).not.toThrow();
    const snapshot = {
      ...emptyCrashRecoverySnapshot(),
      pageOperations: [unknownOperation],
    };
    expect(hasCrashRecoveryInput(snapshot)).toBe(true);
    expect(validateCrashRecoverySnapshot(snapshot).pageOperations).toEqual([unknownOperation]);
    expect(() =>
      validateCrashRecoverySnapshot({ ...snapshot, pageOperations: [unknownOperation, unknownOperation] }),
    ).toThrow();

    // An unresolved duplicate keeps the recovery dialog available.
    await expect(prepareCrashRecovery(snapshot, f.api)).rejects.toThrow(/確認できません/);

    const applied = preparePageCreation("復旧で確認", null);
    expect(f.store.commitPageOperation(applied).status).toBe("applied");
    const restored = await prepareCrashRecovery(
      { ...emptyCrashRecoverySnapshot(), pageOperations: [applied] },
      f.api,
    );
    expect(restored.pageOperations).toEqual([]);
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("does not generate a new operation when the retained operation is resolved", async () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("同一性", null);
    f.store.commitPageOperation(operation);
    const seen: string[] = [];
    const result = await resolvePageOperation(operation, async (request) => {
      if (request.type === "page:resolve") seen.push(request.operation.operationId);
      return f.store.handle(request);
    });
    expect(result.status).toBe("applied");
    expect(seen).toEqual([operation.operationId]);
  } finally {
    f.dispose();
  }
});
