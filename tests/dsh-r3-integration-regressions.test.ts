import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { WorkspaceStoragePressure } from "../src/main/storage-pressure";
import { assertRequestStorage } from "../src/main/storage-write-policy";
import { WorkspaceBackupService } from "../src/main/workspace-backup-service";
import { createRichDocumentProtection } from "../src/main/rich-document-protection";
import { PageOperationCoordinator } from "../src/renderer/page-operation-coordinator";
import {
  retryReliableSave,
  sendReliableSave,
} from "../src/renderer/reliable-save";
import { preparePageCreation } from "../src/shared/page-operation";
import type { Doc, Request } from "../src/shared/types";
import { saveFixture } from "./fixtures/r4-save-fixture";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-r3-review-"));
  const source = join(root, "source");
  mkdirSync(source);
  const store = new Store(join(source, "workspace.sqlite"));
  disposers.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let available = 0n;
  const pressure = new WorkspaceStoragePressure(source, {
    reserveBytes: 100,
    probe: () => ({ bsize: 1n, bavail: available }),
  });
  const sent: Request[] = [];
  const send = async (request: Request) => {
    sent.push(structuredClone(request));
    assertRequestStorage(request, pressure);
    return store.handle(request);
  };
  return {
    root,
    source,
    store,
    pressure,
    send,
    sent,
    recover: () => {
      available = 1000n;
    },
  };
}

it("explicit create retry re-checkpoints the original input and serializes repeated clicks", async () => {
  const f = fixture();
  let hold: (() => void) | undefined;
  let blockCheckpoint = false;
  const persisted: unknown[] = [];
  const coordinator = new PageOperationCoordinator(f.send, {
    persist: async () => {
      persisted.push(structuredClone(coordinator.unresolvedOperations()));
      if (blockCheckpoint)
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
    },
  });
  const doc: Doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "容量回復まで保持" }],
      },
    ],
  };
  await expect(coordinator.create(null, "保留", doc)).rejects.toThrow(
    /capacity-exceeded/,
  );
  const retained = structuredClone(coordinator.unresolvedOperations()[0]);
  expect(f.store.pages()).toHaveLength(0);
  f.recover();
  blockCheckpoint = true;
  const retry = coordinator.retryUnknown();
  expect(await coordinator.retryUnknown()).toBeUndefined();
  expect(f.sent.map((r) => r.type)).toEqual(["page:commit"]);
  hold!();
  expect(await retry).toMatchObject({
    status: "applied",
    operationId: retained.operationId,
    page: { doc },
  });
  expect(f.sent.map((r) => r.type)).toEqual([
    "page:commit",
    "page:resolve",
    "page:commit",
  ]);
  for (const request of f.sent)
    if (request.type === "page:commit" || request.type === "page:resolve")
      expect(request.operation).toEqual(retained);
  expect(persisted).toEqual([[retained], [retained]]);
  expect(coordinator.hasRetained()).toBe(false);
  expect(f.store.pages()).toHaveLength(1);
  expect(await coordinator.retryUnknown()).toBeUndefined();
});

it("retry checkpoint failure preserves unknown input and sends nothing", async () => {
  const f = fixture();
  let failCheckpoint = false;
  const coordinator = new PageOperationCoordinator(f.send, {
    persist: async () => {
      if (failCheckpoint) throw new Error("checkpoint unavailable");
    },
  });
  await expect(coordinator.create(null, "保存不能")).rejects.toThrow();
  const retained = structuredClone(coordinator.unresolvedOperations());
  failCheckpoint = true;
  f.sent.length = 0;
  f.recover();
  await expect(coordinator.retryUnknown()).rejects.toThrow(
    /checkpoint unavailable/,
  );
  expect(f.sent).toEqual([]);
  expect(coordinator.firstUnknown()?.message).toMatch(/復旧記録/);
  expect(coordinator.unresolvedOperations()).toEqual(retained);
  expect(f.store.pages()).toHaveLength(0);
});

it("retry keeps an unknown create while capacity remains low and resolves a lost ACK without another commit", async () => {
  const f = fixture();
  const coordinator = new PageOperationCoordinator(f.send);
  await expect(coordinator.create(null, "同じ作成")).rejects.toThrow();
  const operation = coordinator.unresolvedOperations()[0];
  expect(await coordinator.retryUnknown()).toMatchObject({
    status: "unknown",
    operationId: operation.operationId,
  });
  expect(coordinator.hasRetained()).toBe(true);
  expect(f.store.pages()).toHaveLength(0);
  // Simulate a first attempt that committed but whose ACK was lost.
  expect(f.store.commitPageOperation(operation).status).toBe("applied");
  f.sent.length = 0;
  expect(await coordinator.retryUnknown()).toMatchObject({ status: "applied" });
  expect(f.sent.map((r) => r.type)).toEqual(["page:resolve"]);
  expect(f.store.pages()).toHaveLength(1);
});

it("a known rejected create is retained and cannot be silently retried", async () => {
  const f = fixture();
  f.recover();
  const coordinator = new PageOperationCoordinator(f.send);
  await expect(
    coordinator.create("missing-parent", "拒否入力"),
  ).rejects.toThrow();
  expect(coordinator.firstRejected()).toBeDefined();
  f.sent.length = 0;
  expect(await coordinator.retryUnknown()).toBeUndefined();
  expect(f.sent).toEqual([]);
  expect(coordinator.hasRetained()).toBe(true);
});

it("ordinary save retries the exact revision and resolves an applied receipt without writing twice", async () => {
  const f = saveFixture();
  disposers.push(() => f.dispose());
  let available = 0n;
  const pressure = new WorkspaceStoragePressure(f.root, {
    reserveBytes: 100,
    probe: () => ({ bsize: 1n, bavail: available }),
  });
  const sent: Request[] = [];
  const send = async (request: Request) => {
    sent.push(structuredClone(request));
    assertRequestStorage(request, pressure);
    return f.store.handle(request);
  };
  const operation = f.operation();
  expect((await sendReliableSave(operation, send)).status).toBe("unknown");
  expect(f.store.get(f.page.id)).toEqual(f.page);
  expect(f.store.resolveSave(operation).status).toBe("unknown");
  available = 1000n;
  sent.length = 0;
  expect(await retryReliableSave(operation, send)).toMatchObject({
    status: "applied",
    operationId: operation.operationId,
  });
  expect(sent.map((r) => r.type)).toEqual(["save:resolve", "save:commit"]);
  for (const request of sent)
    if (request.type === "save:resolve" || request.type === "save:commit")
      expect(request.operation).toEqual(operation);
  sent.length = 0;
  available = 0n;
  expect((await retryReliableSave(operation, send)).status).toBe("applied");
  expect(sent.map((r) => r.type)).toEqual(["save:resolve"]);
  expect(f.store.get(f.page.id).revision).toBe(1);
  expect(f.store.versions(f.page.id)).toHaveLength(1);
});

it("ordinary save retry never rebases onto a newer revision and never resends a rejection", async () => {
  const f = saveFixture();
  disposers.push(() => f.dispose());
  const operation = f.operation();
  f.store.update(f.page.id, 0, { title: "別の新しい編集" });
  const sent: Request[] = [];
  const send = async (request: Request) => {
    sent.push(request);
    return f.store.handle(request);
  };
  expect((await retryReliableSave(operation, send)).status).toBe("rejected");
  expect(f.store.get(f.page.id).title).toBe("別の新しい編集");
  sent.length = 0;
  expect((await retryReliableSave(operation, send)).status).toBe("rejected");
  expect(sent.map((r) => r.type)).toEqual(["save:resolve"]);
  expect(f.store.get(f.page.id).revision).toBe(1);
});

it("automatic rich backup admission refuses before backup files or Page receipts exist", () => {
  const f = fixture();
  const service = new WorkspaceBackupService(f.store.db, f.source, {
    beforeCreate: () => f.pressure.assertWritable(),
  });
  const protection = createRichDocumentProtection(() =>
    service.create("before-rich-blocks"),
  );
  const operation = preparePageCreation("rich", null, {
    type: "doc",
    schemaVersion: 2,
    content: [
      {
        type: "callout",
        attrs: { tone: "note" },
        content: [
          { type: "paragraph", content: [{ type: "text", text: "未保存" }] },
        ],
      },
    ],
  });
  const request: Request = { type: "page:commit", operation };
  expect(() => protection.protectRequest(request)).toThrow(/capacity-exceeded/);
  expect(existsSync(join(f.source, "backups"))).toBe(false);
  expect(f.store.pages()).toHaveLength(0);
  expect(f.store.resolvePageOperation(operation).status).toBe("unknown");
  f.recover();
  expect(() => protection.protectRequest(request)).not.toThrow();
  expect(readdirSync(join(f.source, "backups"))).toHaveLength(1);
  expect(f.store.commitPageOperation(operation).status).toBe("applied");
});

it("restore checks the destination volume and can rescue a blocked source without changing it", () => {
  const f = fixture();
  f.store.create(null, "page", "原本");
  const original = f.store.pages();
  const backup = new WorkspaceBackupService(f.store.db, f.source).create();
  let destinationReady = false;
  const probe = vi.fn((directory: string) => {
    expect(directory).toBe(f.root);
    return { bsize: 1n, bavail: destinationReady ? 1000n : 0n };
  });
  const service = new WorkspaceBackupService(f.store.db, f.source, {
    beforeCreate: () => f.pressure.assertWritable(),
    beforeRestore: (parent) =>
      new WorkspaceStoragePressure(parent, {
        reserveBytes: 100,
        probe,
      }).assertWritable(),
  });
  const chosen = service.choose(backup.directory);
  const before = readdirSync(f.root);
  expect(() => service.restore(chosen.ticket, f.root)).toThrow(
    /capacity-exceeded/,
  );
  expect(readdirSync(f.root)).toEqual(before);
  expect(f.store.pages()).toEqual(original);
  destinationReady = true;
  const restored = service.restore(chosen.ticket, f.root);
  expect(restored.directory).not.toBe(f.source);
  expect(probe).toHaveBeenCalledTimes(2);
  const target = new Store(join(restored.directory, "workspace.sqlite"));
  try {
    expect(target.pages()).toEqual(original);
  } finally {
    target.close();
  }
  expect(f.store.pages()).toEqual(original);
  expect(() => service.create()).toThrow(/capacity-exceeded/);
});
