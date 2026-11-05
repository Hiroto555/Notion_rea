import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { readStorageUsage } from "../src/persistence/storage-usage";
import { evaluateStorageCapacity } from "../src/shared/storage-usage";
import { PageOperationCoordinator } from "../src/renderer/page-operation-coordinator";
import type { Doc } from "../src/shared/types";
import { createRichDocumentProtection } from "../src/main/rich-document-protection";
import { WorkspaceBackupService } from "../src/main/workspace-backup-service";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { preparePageCreation } from "../src/shared/page-operation";
import { requestSchema, type Request } from "../src/shared/types";

const fixtures: { root: string; store: Store }[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-r2-review-"));
  mkdirSync(join(root, "assets"));
  const store = new Store(join(root, "workspace.sqlite"));
  fixtures.push({ root, store });
  return { root, store };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("does not certify complete usage when an existing optional table fails to read", () => {
  const { store } = fixture();
  store.db.exec(
    "CREATE TABLE crash_recovery_copies(recovery_id TEXT, page_json TEXT)",
  );
  store.db
    .prepare("INSERT INTO crash_recovery_copies VALUES(?,?)")
    .run("pending", "protected input");
  const original = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string) => {
    if (sql.includes('FROM "crash_recovery_copies"'))
      throw new Error("injected table read failure");
    return original(sql);
  }) as typeof store.db.prepare;
  let report;
  try {
    report = readStorageUsage(store);
  } finally {
    store.db.prepare = original;
  }
  expect(
    report.database.tables.find((t) => t.name === "crash_recovery_copies")
      ?.state,
  ).toBe("unknown");
  expect(report.state).toBe("unknown");
  expect(report.database.storedTextBytes).toBeNull();
  expect(evaluateStorageCapacity(report, { maxReceiptRows: 100 }).status).toBe(
    "unknown",
  );
  expect(
    store.db.prepare("SELECT page_json FROM crash_recovery_copies").get()
      ?.page_json,
  ).toBe("protected input");
});

it("reports unreadable backup bytes as null instead of a measured zero", () => {
  const { root, store } = fixture();
  const report = readStorageUsage(store, {
    operations: {
      lstatSync: ((path: unknown) => {
        if (String(path) === join(root, "backups"))
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return lstatSync(path as string);
      }) as typeof import("node:fs").lstatSync,
    },
  });
  expect(report.workspace.backups.root).toBe("unknown");
  expect(report.workspace.backups.bytes.bytes).toBeNull();
  expect(report.totals.backupFileBytes).toBeNull();
  expect(report.totals.totalFileBytes).toBeNull();
});

it("retains the initial document in memory when its pre-send checkpoint fails", async () => {
  const { store } = fixture();
  let sends = 0;
  const doc: Doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "未保存の初期本文" }],
      },
    ],
  };
  const coordinator = new PageOperationCoordinator(
    async (req) => {
      sends++;
      return store.handle(req);
    },
    {
      persist: async () => {
        throw new Error("checkpoint disk full");
      },
    },
  );
  await expect(coordinator.create(null, "保全", doc)).rejects.toThrow(
    /復旧記録/,
  );
  expect(sends).toBe(0);
  expect(store.pages()).toHaveLength(0);
  expect(coordinator.hasRetained()).toBe(true);
  expect(coordinator.unresolvedOperations()).toHaveLength(1);
  expect(coordinator.unresolvedOperations()[0].command).toMatchObject({
    kind: "createPage",
    doc,
  });
});

it("re-checkpoints the exact retained input before an explicit retry and serializes repeated clicks", async () => {
  const { store } = fixture();
  let attempts = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const persisted: unknown[] = [];
  const sent: unknown[] = [];
  const doc: Doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "保持して再試行" }],
      },
    ],
  };
  const coordinator = new PageOperationCoordinator(
    async (req) => {
      sent.push(structuredClone(req));
      return store.handle(req);
    },
    {
      persist: async () => {
        persisted.push(structuredClone(coordinator.unresolvedOperations()));
        if (++attempts === 1) throw new Error("checkpoint unavailable");
        await barrier;
      },
    },
  );
  await expect(coordinator.create(null, "同じ作成", doc)).rejects.toThrow(
    /復旧記録/,
  );
  const original = structuredClone(coordinator.unresolvedOperations()[0]);
  expect(coordinator.firstUncheckpointed()?.state).toBe("uncheckpointed");
  expect(await coordinator.resolveNext()).toBeUndefined();
  expect(sent).toHaveLength(0);
  const retry = coordinator.retryUncheckpointed();
  expect(await coordinator.retryUncheckpointed()).toBeUndefined();
  expect(sent).toHaveLength(0);
  release();
  const page = await retry;
  expect(page?.doc).toEqual(doc);
  expect(sent).toEqual([{ type: "page:commit", operation: original }]);
  expect(persisted).toEqual([[original], [original]]);
  expect(store.pages()).toHaveLength(1);
  expect(coordinator.hasRetained()).toBe(false);
});

const richDoc: Doc = {
  type: "doc",
  schemaVersion: 2,
  content: [
    {
      type: "callout",
      attrs: { tone: "note" },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "初期リッチ本文" }],
        },
      ],
    },
  ],
};

it("backs up before a rich initial document is committed, while resolve stays read-only", () => {
  const { root, store } = fixture();
  store.create(null, "page", "原本");
  const service = new WorkspaceBackupService(store.db, root);
  let backups = 0;
  const guard = createRichDocumentProtection(() => {
    backups++;
    expect(store.pages()).toHaveLength(1);
    return service.create("before-rich-blocks");
  });
  const operation = preparePageCreation("リッチ作成", null, richDoc);
  guard.protectRequest(
    requestSchema.parse({ type: "page:resolve", operation }),
  );
  expect(backups).toBe(0);
  const request = requestSchema.parse({ type: "page:commit", operation });
  guard.protectRequest(request);
  expect(store.handle(request)).toMatchObject({
    status: "applied",
    page: { doc: richDoc },
  });
  guard.protectRequest(request);
  expect(store.handle(request)).toMatchObject({ status: "applied" });
  expect(backups).toBe(1);
  expect(store.pages()).toHaveLength(2);
  const directories = readdirSync(join(root, "backups"));
  expect(directories).toHaveLength(1);
  expect(
    verifyFullBackup(join(root, "backups", directories[0])).manifest.inventory
      .pages,
  ).toBe(1);
});

it("a failed rich-document backup prevents the mutation and keeps protection enabled for retry", () => {
  const { store } = fixture();
  let attempts = 0;
  const guard = createRichDocumentProtection(() => {
    if (++attempts === 1) throw new Error("backup disk full");
  });
  const operation = preparePageCreation("保護", null, richDoc);
  const request: Request = { type: "page:commit", operation };
  const guardedCommit = () => {
    guard.protectRequest(request);
    return store.handle(request);
  };
  expect(guardedCommit).toThrow(/backup disk full/);
  expect(store.pages()).toHaveLength(0);
  expect(store.resolvePageOperation(operation).status).toBe("unknown");
  expect(guardedCommit()).toMatchObject({
    status: "applied",
    page: { doc: richDoc },
  });
  expect(attempts).toBe(2);
});
