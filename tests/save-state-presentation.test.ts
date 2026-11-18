import { describe, expect, it, vi } from "vitest";
import { PendingEdits } from "../src/renderer/pending-edits";
import { PageOperationCoordinator } from "../src/renderer/page-operation-coordinator";
import {
  settleOrdinaryPageSave,
  type OrdinaryPageSaveState,
} from "../src/renderer/ordinary-page-save-state";
import {
  saveStateRows,
  saveStateAlerts,
  type SaveStatePresentationInput,
} from "../src/renderer/save-state-presentation";
import { operationFingerprint } from "../src/shared/save-contract";
import { unclassifiedRequestFailure } from "../src/renderer/private-request";
import type { SaveOperation } from "../src/shared/save-contract";
import type { Page } from "../src/shared/types";
import type { SaveTransport } from "../src/renderer/reliable-save";

/** A baseline where every owner is quiet: only the clean per-target rows are
 * produced — used to isolate one counterexample at a time. */
const quiet = (
  overrides: Partial<SaveStatePresentationInput> = {},
): SaveStatePresentationInput => ({
  operations: new Map(),
  storageFailures: new Map(),
  failedPageIds: new Set(),
  recordPageIds: new Set(),
  databasePageIds: new Set(),
  liveDatabaseCount: 0,
  pendingInputCount: 0,
  ordinaryPageCount: 0,
  restoringCount: 0,
  recordLanes: [],
  creatingRecordCount: 0,
  hasNumberDrafts: false,
  databaseLanes: [],
  hasFilterDrafts: false,
  structuralPending: false,
  databaseCreation: undefined,
  pageCreations: [],
  creatingPageCount: 0,
  pendingRequests: 0,
  appError: "",
  recoveryState: "saved",
  recoveryError: undefined,
  pageTitle: () => undefined,
  ...overrides,
});

/** A minimal real Page — the loaded snapshot rows App filters on, including
 * the deletedAt field that separates classification from live presence. */
const makePage = (overrides: Partial<Page> = {}): Page => ({
  id: "p-1",
  parentId: null,
  title: "ページ",
  icon: "",
  cover: "",
  position: 0,
  doc: { type: "doc", content: [] },
  kind: "database",
  database: null,
  favorite: false,
  createdAt: 0,
  updatedAt: 0,
  revision: 0,
  deletedAt: null,
  ...overrides,
});

const makeOperation = (seq: number, pageId = "p1"): SaveOperation => ({
  operationId: `op-${pageId}`,
  sessionId: "session-1",
  seq,
  pageId,
  databasePageId: null,
  revision: 0,
  patch: { title: "入力した本文" },
});

describe("retained ordinary-Page operations", () => {
  it("an unknown settlement without a diagnostic is unknown, never saving", () => {
    // Drive the real owner state: the exchange kept the operation and its
    // settlement retained it WITHOUT latching a bounded diagnostic — the
    // exact shape review F3(a) flagged. The same catch path then marks the
    // owner failed.
    const edits = new PendingEdits();
    const seq = edits.addObservedPage("p1", 0, { title: "入力した本文" }, true);
    const operation = makeOperation(seq);
    const state: OrdinaryPageSaveState = {
      operations: new Map([["p1", operation]]),
      storageFailures: new Map(),
    };
    const settled = settleOrdinaryPageSave(
      state,
      operation,
      {
        status: "unknown",
        operationId: operation.operationId,
        sessionId: operation.sessionId,
        seq: operation.seq,
        pageId: operation.pageId,
        fingerprint: "fingerprint",
        message: "結果を確認できません",
      },
      { sessionId: "session-1", page: { revision: 0 } as never },
    );
    expect(settled).toMatchObject({ kind: "retained", outcome: "unknown" });
    expect(settled.kind === "retained" && settled.storageFailure).toBeFalsy();
    edits.failed.add("p1");

    const rows = saveStateRows(
      quiet({
        operations: state.operations,
        storageFailures: state.storageFailures,
        failedPageIds: edits.failed,
        pendingInputCount: edits.size,
        pageTitle: (id) => (id === "p1" ? "ページA" : undefined),
      }),
    );
    const row = rows.find((entry) => entry.id === "body:op-p1");
    expect(row).toMatchObject({
      target: "本文",
      label: "ページA",
      state: "unknown",
    });
    expect(row!.state).not.toBe("saving");
  });

  it("only a still-unsettled in-flight exchange shows saving", () => {
    const operation = makeOperation(1);
    const rows = saveStateRows(
      quiet({
        operations: new Map([["p1", operation]]),
        failedPageIds: new Set(),
      }),
    );
    expect(rows.find((entry) => entry.id === "body:op-p1")?.state).toBe(
      "saving",
    );
  });

  it("a latched bounded diagnostic is shown, the raw state is not", () => {
    const edits = new PendingEdits();
    const seq = edits.addObservedPage("p1", 0, { title: "x" }, true);
    const operation = makeOperation(seq);
    const state: OrdinaryPageSaveState = {
      operations: new Map([["p1", operation]]),
      storageFailures: new Map(),
    };
    const settled = settleOrdinaryPageSave(
      state,
      operation,
      {
        status: "unknown",
        operationId: operation.operationId,
        sessionId: operation.sessionId,
        seq: operation.seq,
        pageId: operation.pageId,
        fingerprint: "fingerprint",
        storageFailure: unclassifiedRequestFailure("save:commit"),
      },
      { sessionId: "session-1", page: { revision: 0 } as never },
    );
    expect(settled.kind === "retained" && settled.storageFailure).toBeTruthy();
    edits.failed.add("p1");
    const rows = saveStateRows(
      quiet({
        operations: state.operations,
        storageFailures: state.storageFailures,
        failedPageIds: edits.failed,
      }),
    );
    const row = rows.find((entry) => entry.id === "body:op-p1");
    expect(row?.state).toBe("unknown");
    // The bounded message is shown — never the generic in-flight detail.
    expect(row?.detail).toContain("未確認");
    expect(row?.detail).not.toContain("保存結果が不明です");
  });
});

describe("pending input and held failures", () => {
  it("one failed pending input is counted once, not as size + failed", () => {
    const edits = new PendingEdits();
    edits.addObservedPage("p1", 0, { title: "x" }, true);
    edits.addObservedPage("p2", 0, { title: "y" }, true);
    edits.failed.add("p1");
    edits.failed.add("p2");
    const operation = makeOperation(1);
    const rows = saveStateRows(
      quiet({
        operations: new Map([["p1", operation]]),
        failedPageIds: edits.failed,
        pendingInputCount: edits.size,
        pageTitle: (id) => `タイトル${id}`,
      }),
    );
    const pendingRow = rows.find((entry) => entry.id === "inputs:pending");
    // Two real inputs — never 4 from size + failed.size — under a neutral
    // workspace-wide target, not a body claim.
    expect(pendingRow).toMatchObject({
      target: "未保存入力",
      label: "2 件",
      state: "pending",
    });
    // The failure-only hold for p2 (no retained operation) is not dropped.
    const heldRow = rows.find((entry) => entry.id === "held:p2");
    expect(heldRow).toMatchObject({
      target: "本文",
      state: "blocked",
    });
    expect(heldRow?.label).toContain("タイトルp2");
  });

  it("a failure-only hold with no send is a neutral hold, never unknown", () => {
    // App.update holds input without any operation or dispatch for a stale
    // session, an unsupported document or a late record/database callback.
    // That failed flag must not be upgraded into 結果不明.
    const edits = new PendingEdits();
    edits.addObservedPage("p2", 0, { title: "保持する入力" }, true);
    edits.failed.add("p2");
    const input = quiet({
      failedPageIds: edits.failed,
      pendingInputCount: edits.size,
      pageTitle: (id) => (id === "p2" ? "保持ページ" : undefined),
    });
    const rows = saveStateRows(input);
    const heldRow = rows.find((entry) => entry.id === "held:p2");
    expect(heldRow).toMatchObject({
      target: "本文",
      label: "保持ページ の入力を保持",
      state: "blocked",
    });
    expect(heldRow?.state).not.toBe("unknown");
    expect(heldRow?.detail).toContain("停止");
    expect(heldRow?.detail).not.toContain("結果を確認");
    // Display only: the original sets are untouched, nothing mutated.
    expect([...edits.failed]).toEqual(["p2"]);
    expect(edits.size).toBe(1);
    expect(input.operations.size).toBe(0);
    expect(input.storageFailures.size).toBe(0);
  });

  it("a held record-page failure keeps its record target", () => {
    const edits = new PendingEdits();
    edits.addObservedPage("rec-1", 0, { title: "x" }, true);
    edits.failed.add("rec-1");
    const rows = saveStateRows(
      quiet({
        failedPageIds: edits.failed,
        recordPageIds: new Set(["rec-1"]),
        pendingInputCount: edits.size,
      }),
    );
    const heldRow = rows.find((entry) => entry.id === "held:rec-1");
    expect(heldRow).toMatchObject({ target: "レコード", state: "blocked" });
  });

  it("an unsupported database page's held input is not called 本文", () => {
    // The late-callback path keeps a database Page's unverified input under
    // the same failed set — its target is the database owner, not the body.
    const edits = new PendingEdits();
    edits.addObservedPage("db-1", 0, { title: "x" }, true, undefined, "database");
    edits.failed.add("db-1");
    const rows = saveStateRows(
      quiet({
        failedPageIds: edits.failed,
        databasePageIds: new Set(["db-1"]),
        pendingInputCount: edits.size,
        pageTitle: (id) => (id === "db-1" ? "データベースA" : undefined),
      }),
    );
    const heldRow = rows.find((entry) => entry.id === "held:db-1");
    expect(heldRow).toMatchObject({
      target: "データベース（行・設定）",
      state: "blocked",
    });
    expect(heldRow?.label).toContain("データベースA");
    expect(rows.some((entry) => entry.target === "本文" && entry.id.startsWith("held:"))).toBe(false);
  });
});

describe("legacy database owners in the ordinary Page save lane", () => {
  const legacyOperation = (seq: number): SaveOperation => ({
    operationId: "op-legacy",
    sessionId: "session-1",
    seq,
    pageId: "legacy-db",
    databasePageId: null,
    revision: 0,
    // Database.onChange hands the whole rows/settings payload to the Page
    // save lane as one patch.
    patch: {
      database: {
        rows: [{ id: "row-1" }],
      } as never,
    },
  });

  it("a patch.database operation is one atomic database target, never 本文", () => {
    const rows = saveStateRows(
      quiet({
        operations: new Map([["legacy-db", legacyOperation(1)]]),
        pageTitle: (id) => (id === "legacy-db" ? "旧DB" : undefined),
      }),
    );
    const opRows = rows.filter((entry) => entry.id === "body:op-legacy");
    expect(opRows).toHaveLength(1);
    expect(opRows[0]).toMatchObject({
      target: "データベース（行・設定）",
      label: "旧DB",
      state: "saving",
    });
    expect(rows.some((entry) => entry.target === "本文")).toBe(false);
  });

  it("a held legacy database operation stays unknown on the database target", () => {
    const rows = saveStateRows(
      quiet({
        operations: new Map([["legacy-db", legacyOperation(1)]]),
        failedPageIds: new Set(["legacy-db"]),
        databasePageIds: new Set(["legacy-db"]),
        pageTitle: (id) => (id === "legacy-db" ? "旧DB" : undefined),
      }),
    );
    const row = rows.find((entry) => entry.id === "body:op-legacy");
    expect(row).toMatchObject({
      target: "データベース（行・設定）",
      state: "unknown",
    });
  });

  it("a pre-operation legacy hold (documentError/stale session) is not 本文", () => {
    const edits = new PendingEdits();
    edits.addObservedPage("legacy-db", 0, { title: "x" }, true);
    edits.failed.add("legacy-db");
    const rows = saveStateRows(
      quiet({
        failedPageIds: edits.failed,
        databasePageIds: new Set(["legacy-db"]),
        pendingInputCount: edits.size,
        pageTitle: (id) => (id === "legacy-db" ? "旧DB" : undefined),
      }),
    );
    const heldRow = rows.find((entry) => entry.id === "held:legacy-db");
    expect(heldRow).toMatchObject({
      target: "データベース（行・設定）",
      state: "blocked",
    });
    expect(rows.some((entry) => entry.target === "本文" && entry.id.startsWith("held:"))).toBe(false);
  });
});

describe("deleted legacy databases still classify their inputs", () => {
  // App derives the sets from the loaded snapshot — the same filters, on
  // real Page rows whose deletedAt marks them trashed.
  const trashedDatabase = makePage({
    id: "trashed-db",
    title: "削除済みDB",
    deletedAt: 1700000000,
  });
  const classificationIds = new Set(
    [trashedDatabase]
      .filter((entry) => entry.kind === "database")
      .map((entry) => entry.id),
  );
  const liveDatabaseCount = [trashedDatabase].filter(
    (entry) => entry.kind === "database" && entry.deletedAt === null,
  ).length;

  it("a pre-operation hold on a deleted database is a blocked database target", () => {
    const edits = new PendingEdits();
    edits.addObservedPage("trashed-db", 0, { title: "x" }, true);
    edits.failed.add("trashed-db");
    const rows = saveStateRows(
      quiet({
        failedPageIds: edits.failed,
        databasePageIds: classificationIds,
        liveDatabaseCount,
        pendingInputCount: edits.size,
        pageTitle: (id) => (id === "trashed-db" ? "削除済みDB" : undefined),
      }),
    );
    const heldRow = rows.find((entry) => entry.id === "held:trashed-db");
    expect(heldRow).toMatchObject({
      target: "データベース（行・設定）",
      state: "blocked",
    });
    expect(
      rows.some((entry) => entry.target === "本文" && entry.id.startsWith("held:")),
    ).toBe(false);
  });

  it("a retained title-only operation on a deleted database keeps its owner state", () => {
    const operation: SaveOperation = {
      ...makeOperation(1, "trashed-db"),
      patch: { title: "改名" },
    };
    const rows = saveStateRows(
      quiet({
        operations: new Map([["trashed-db", operation]]),
        failedPageIds: new Set(["trashed-db"]),
        databasePageIds: classificationIds,
        liveDatabaseCount,
        pageTitle: (id) => (id === "trashed-db" ? "削除済みDB" : undefined),
      }),
    );
    const row = rows.find((entry) => entry.id === `body:${operation.operationId}`);
    expect(row).toMatchObject({
      target: "データベース（行・設定）",
      label: "削除済みDB",
      state: "unknown",
    });
    const inFlight = saveStateRows(
      quiet({
        operations: new Map([["trashed-db", operation]]),
        databasePageIds: classificationIds,
        liveDatabaseCount,
      }),
    );
    expect(inFlight.find((entry) => entry.id === `body:${operation.operationId}`)).toMatchObject(
      { target: "データベース（行・設定）", state: "saving" },
    );
  });

  it("a clean workspace whose only database is trashed is not a saved target", () => {
    const rows = saveStateRows(
      quiet({
        ordinaryPageCount: 1,
        databasePageIds: classificationIds,
        liveDatabaseCount,
      }),
    );
    expect(rows.find((entry) => entry.id === "target:database")).toMatchObject(
      { state: "none", detail: "対象なし" },
    );
  });
});

describe("empty targets never claim success", () => {
  it("a workspace with no ordinary pages is 対象なし, not 保存済み", () => {
    const rows = saveStateRows(quiet({ ordinaryPageCount: 0 }));
    expect(rows).toHaveLength(4);
    expect(rows.find((entry) => entry.id === "target:body")).toMatchObject({
      state: "none",
      detail: "対象なし",
    });
    expect(rows.find((entry) => entry.state === "saved")).toMatchObject({
      target: "復旧用保存",
    });
  });

  it("a workspace with ordinary pages reports them saved", () => {
    const rows = saveStateRows(quiet({ ordinaryPageCount: 3 }));
    expect(rows.find((entry) => entry.id === "target:body")?.state).toBe(
      "saved",
    );
  });

  it("a legacy-only database workspace is saved, never 対象なし", () => {
    const rows = saveStateRows(
      quiet({
        ordinaryPageCount: 0,
        databasePageIds: new Set(["legacy-db"]),
        liveDatabaseCount: 1,
      }),
    );
    expect(rows.find((entry) => entry.id === "target:database")).toMatchObject(
      { state: "saved" },
    );
    expect(rows.find((entry) => entry.id === "target:database")?.detail).not.toBe(
      "対象なし",
    );
  });
});

describe("neutral rows for workspace-wide facts", () => {
  it("the pending-input count row carries no fixed body target", () => {
    const rows = saveStateRows(quiet({ pendingInputCount: 3 }));
    const row = rows.find((entry) => entry.id === "inputs:pending");
    expect(row).toMatchObject({
      target: "未保存入力",
      label: "3 件",
      state: "pending",
    });
    expect(row?.target).not.toBe("本文");
  });

  it("a global error is a neutral row, never a fabricated body failure", () => {
    // fail() also fires for database creation, structural, search and raw
    // rescue — the row must not claim a body save failure.
    const rows = saveStateRows(
      quiet({ appError: "検索結果を読み込めませんでした。" }),
    );
    const errorRow = rows.find((entry) => entry.id === "app:error");
    expect(errorRow).toMatchObject({
      target: "全体",
      label: "最新のエラー",
      state: "error",
      detail: "検索結果を読み込めませんでした。",
    });
    expect(
      rows.some(
        (entry) => entry.target === "本文" && entry.state === "error",
      ),
    ).toBe(false);
  });
});

describe("retained page-creation entries", () => {
  /** A coordinator send that rejects the first create with a matching
   * rejection and lets the second create fail unknown. */
  async function coordinatorWithTwoRetained() {
    let calls = 0;
    const send = vi.fn<SaveTransport>(async (request) => {
      calls += 1;
      const operation = (
        request as unknown as { operation: unknown }
      ).operation as {
        operationId: string;
        sessionId: string;
        seq: number;
        command: { kind: string };
      };
      if (calls === 1)
        return {
          status: "rejected",
          operationId: operation.operationId,
          sessionId: operation.sessionId,
          seq: operation.seq,
          commandKind: operation.command.kind,
          fingerprint: await operationFingerprint(operation),
          message: "重複するため拒否されました",
        };
      throw new Error("transport unreachable");
    });
    const coordinator = new PageOperationCoordinator(send, {
      timeoutMs: 50,
    });
    await expect(coordinator.create(null, "拒否されるページ")).rejects.toThrow();
    await expect(coordinator.create(null, "結果不明のページ")).rejects.toThrow();
    return { coordinator, send };
  }

  it("every retained entry is enumerated — rejected AND unknown together", async () => {
    const { coordinator } = await coordinatorWithTwoRetained();
    const entries = coordinator.entries();
    expect(entries).toHaveLength(2);
    const rows = saveStateRows(quiet({ pageCreations: entries }));
    const creationRows = rows.filter(
      (entry) => entry.target === "ページ作成",
    );
    // The first* helpers would have shown only one of these.
    expect(creationRows).toHaveLength(2);
    expect(creationRows.map((entry) => entry.state).sort()).toEqual([
      "rejected",
      "unknown",
    ]);
    expect(creationRows.map((entry) => entry.label)).toContain(
      "重複するため拒否されました",
    );
    const unknownRow = creationRows.find(
      (entry) => entry.state === "unknown",
    );
    expect(unknownRow?.label).toContain("transport unreachable");
    expect(unknownRow?.detail).toBe(unknownRow?.label);
    expect(creationRows.every((entry) => entry.id.startsWith("pages:create:"))).toBe(
      true,
    );
    expect(
      new Set(creationRows.map((entry) => entry.id)).size,
    ).toBe(2);
  });
});

describe("record lanes share one commit result", () => {
  it("one record lane is one row — value and body are never split", () => {
    const rows = saveStateRows(
      quiet({
        recordLanes: [
          {
            id: "rec-1",
            label: "レコードA",
            state: "unknown",
            error: "画面内に未保存入力を保持しています。",
          },
        ],
      }),
    );
    const recordRows = rows.filter((entry) => entry.target === "レコード");
    expect(recordRows).toHaveLength(1);
    expect(recordRows[0].id).toBe("record:rec-1");
    expect(recordRows[0].state).toBe("unknown");
  });
});

describe("saveStateAlerts — concise chips outside the details", () => {
  it("groups simultaneous failures per target+state without merging them", () => {
    const rows = saveStateRows(
      quiet({
        operations: new Map([
          ["p1", makeOperation(1, "p1")],
          ["p2", makeOperation(2, "p2")],
        ]),
        failedPageIds: new Set(["p1", "p2"]),
        recordLanes: [
          { id: "r1", label: "レコードA", state: "conflict" },
        ],
        recoveryState: "error",
        recoveryError: "復旧記録を保存できません",
      }),
    );
    const alerts = saveStateAlerts(rows);
    expect(alerts).toEqual([
      { target: "本文", state: "unknown", count: 2 },
      { target: "レコード", state: "conflict", count: 1 },
      { target: "復旧用保存", state: "error", count: 1 },
    ]);
  });

  it("saved/pending/none rows never become alerts", () => {
    const rows = saveStateRows(
      quiet({ ordinaryPageCount: 2, pendingInputCount: 1 }),
    );
    expect(saveStateAlerts(rows)).toEqual([]);
  });
});
