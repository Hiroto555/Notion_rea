import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import {
  commitPageOperation,
  resolvePageOperation,
} from "../src/persistence/page-operations";
import {
  describePageOperation,
  preparePageCreation,
  validAppliedPage,
  type PageOperation,
} from "../src/shared/page-operation";
import { PageOperationCoordinator } from "../src/renderer/page-operation-coordinator";
import { canonicalOperation } from "../src/shared/save-contract";
import {
  blankDoc,
  pageOperationSchema,
  type Doc,
  type Page,
} from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(resolve("output/l3-page-initial-doc-"));
  const store = new Store(join(root, "workspace.sqlite"));
  return {
    root,
    store,
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
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "テンプレート" }],
      },
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

function receipt(store: Store, operationId: string) {
  const row = store.db
    .prepare("SELECT result_json FROM save_receipts WHERE operation_id=?")
    .get(operationId) as { result_json: string } | undefined;
  return row ? JSON.parse(row.result_json) : undefined;
}

it("commits the initial document, search body and receipt in one operation", () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const doc = initialDoc("本文キーワード");
    const operation = preparePageCreation("初期本文", null, doc);
    const applied = commitPageOperation(f.store, operation);
    expect(applied).toMatchObject({
      status: "applied",
      commandKind: "createPage",
      page: { title: "初期本文", parentId: null, revision: 0 },
    });
    const page = f.store.get(applied.page!.id);
    expect(canonicalOperation(page.doc)).toBe(canonicalOperation(doc));
    expect(page.documentError).toBeUndefined();

    const body = (
      f.store.db
        .prepare("SELECT body FROM pages WHERE id=?")
        .get(page.id) as { body: string }
    ).body;
    expect(body).toContain("テンプレート");
    expect(body).toContain("本文キーワード");

    const storedReceipt = receipt(f.store, operation.operationId);
    expect(storedReceipt.status).toBe("applied");
    expect(canonicalOperation(storedReceipt.page.doc)).toBe(
      canonicalOperation(doc),
    );
    const search = f.store.handle({
      type: "search",
      query: "本文キーワード",
    }) as Page[];
    expect(search.map((entry) => entry.id)).toEqual([page.id]);
    expect(resolvePageOperation(f.store, operation)).toEqual(applied);
    expect(f.store.pages()).toHaveLength(1);

    f.store.close();
    reopened = new Store(join(f.root, "workspace.sqlite"));
    expect(reopened.pages()).toHaveLength(1);
    expect(canonicalOperation(reopened.get(page.id).doc)).toBe(
      canonicalOperation(doc),
    );
    expect(commitPageOperation(reopened, operation)).toEqual(applied);
    expect(reopened.pages()).toHaveLength(1);
  } finally {
    reopened?.close();
    f.dispose();
  }
});

it("keeps an old command without a document valid and creates the blank Page", () => {
  const f = fixture();
  try {
    const old: PageOperation = {
      operationId: "old-operation",
      sessionId: "old-session",
      seq: 1,
      command: { kind: "createPage", parentId: null, title: "旧形式" },
    };
    expect(pageOperationSchema.safeParse(old).success).toBe(true);
    expect("doc" in old.command).toBe(false);
    const applied = commitPageOperation(f.store, old);
    expect(applied.status).toBe("applied");
    expect(applied.page!.doc).toEqual(blankDoc());
    const body = (
      f.store.db
        .prepare("SELECT body FROM pages WHERE id=?")
        .get(applied.page!.id) as { body: string }
    ).body;
    expect(body).toContain("旧形式");
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("refuses an initial document on the database create path", () => {
  const f = fixture();
  try {
    expect(() =>
      f.store.create(null, "database", "DB", initialDoc("対象外")),
    ).toThrow(/通常ページ/);
    expect(f.store.pages()).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it("rolls the Page, initial body and receipt back when the receipt cannot be stored", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("失敗", null, initialDoc("残さない"));
    f.store.db.exec(
      "CREATE TRIGGER fail_page_receipt BEFORE INSERT ON save_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
    );
    expect(() => commitPageOperation(f.store, operation)).toThrow(/receipt failure/);
    expect(f.store.pages()).toHaveLength(0);
    expect(
      (f.store.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n,
    ).toBe(0);
    expect(resolvePageOperation(f.store, operation).status).toBe("unknown");
    f.store.db.exec("DROP TRIGGER fail_page_receipt");
    expect(commitPageOperation(f.store, operation).status).toBe("applied");
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("rolls the initial body back when the Page insert fails after the row was staged", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("途中失敗", null, initialDoc("残さない本文"));
    // SQLite FAIL retains earlier effects of a failing statement; the
    // operation's SAVEPOINT must still leave no Page, body or receipt.
    f.store.db.exec(
      "CREATE TRIGGER fail_after_page AFTER INSERT ON pages BEGIN SELECT RAISE(FAIL, 'after insert failure'); END",
    );
    const rejected = commitPageOperation(f.store, operation);
    expect(rejected.status).toBe("rejected");
    expect(f.store.pages()).toHaveLength(0);
    expect(
      (f.store.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n,
    ).toBe(0);
    expect(receipt(f.store, operation.operationId)?.status).toBe("rejected");
    expect(resolvePageOperation(f.store, operation)).toEqual(rejected);
  } finally {
    f.dispose();
  }
});

it("rolls the initial body back when the search body write fails", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("本文失敗", null, initialDoc("本文失敗の目印"));
    // The body is part of the same INSERT. A failure after SQLite staged the
    // row must not leave a Page or a rejected Page body behind.
    f.store.db.exec(
      "CREATE TRIGGER fail_after_body AFTER INSERT ON pages WHEN NEW.body LIKE '%本文失敗の目印%' BEGIN SELECT RAISE(FAIL, 'body write failure'); END",
    );
    const rejected = commitPageOperation(f.store, operation);
    expect(rejected.status).toBe("rejected");
    expect(f.store.pages()).toHaveLength(0);
    expect(
      (f.store.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n,
    ).toBe(0);
    expect(receipt(f.store, operation.operationId)?.status).toBe("rejected");
    // The rejection is terminal and durable; the input stays available for the
    // recovery-copy exit rather than being replayed automatically.
    f.store.db.exec("DROP TRIGGER fail_after_body");
    expect(commitPageOperation(f.store, operation).status).toBe("rejected");
    expect(f.store.pages()).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it("keeps one Page with its body across a lost ACK, reopen and the same resend", () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const doc = initialDoc("ACK喪失の本文");
    const operation = preparePageCreation("ACK喪失", null, doc);
    const exec = f.store.db.exec.bind(f.store.db);
    const spy = vi.spyOn(f.store.db, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql === "COMMIT") throw new Error("lost ACK after commit");
    });
    expect(() => commitPageOperation(f.store, operation)).toThrow(/lost ACK/);
    spy.mockRestore();
    expect(f.store.pages()).toHaveLength(1);
    expect(f.store.pages()[0].doc).toEqual(doc);

    f.store.close();
    reopened = new Store(join(f.root, "workspace.sqlite"));
    expect(resolvePageOperation(reopened, operation).status).toBe("applied");
    expect(commitPageOperation(reopened, operation).status).toBe("applied");
    expect(reopened.pages()).toHaveLength(1);
    expect(reopened.pages()[0].doc).toEqual(doc);
  } finally {
    reopened?.close();
    f.dispose();
  }
});

it("refuses the same operation ID with a different initial document", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("同一性", null, initialDoc("最初の本文"));
    const applied = commitPageOperation(f.store, operation);
    expect(applied.status).toBe("applied");
    const changed: PageOperation = {
      ...operation,
      command: {
        kind: "createPage",
        parentId: null,
        title: "同一性",
        doc: initialDoc("別の本文"),
      },
    };
    const rejected = commitPageOperation(f.store, changed);
    expect(rejected.status).toBe("rejected");
    expect(f.store.pages()).toHaveLength(1);
    expect(canonicalOperation(f.store.pages()[0].doc)).toBe(
      canonicalOperation(initialDoc("最初の本文")),
    );
    expect(validAppliedPage(operation, applied.page)).toBe(true);
    expect(
      validAppliedPage(operation, { ...applied.page!, doc: blankDoc() }),
    ).toBe(false);
  } finally {
    f.dispose();
  }
});

it("journals the initial document before the request is sent", async () => {
  const f = fixture();
  try {
    const doc = initialDoc("送信前checkpoint");
    const requests: unknown[] = [];
    let checkpointDoc: unknown;
    const coordinator = new PageOperationCoordinator(
      async (request) => {
        requests.push(request);
        return f.store.handle(request);
      },
      {
        persist: async () => {
          expect(requests).toHaveLength(0);
          const operation = coordinator.unresolvedOperations()[0];
          checkpointDoc =
            operation.command.kind === "createPage"
              ? operation.command.doc
              : undefined;
        },
      },
    );
    const page = await coordinator.create(null, "送信前", doc);
    expect(canonicalOperation(checkpointDoc)).toBe(canonicalOperation(doc));
    expect(page.doc).toEqual(doc);
    expect(requests).toHaveLength(1);
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("refuses an invalid initial document before journaling or sending", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const coordinator = new PageOperationCoordinator(async (request) => {
      sent++;
      return f.store.handle(request);
    });
    const invalid = { type: "doc", content: "invalid" } as unknown as Doc;
    await expect(coordinator.create(null, "不正", invalid)).rejects.toThrow(
      /上限または形式/,
    );
    expect(sent).toBe(0);
    expect(coordinator.hasRetained()).toBe(false);
    expect(f.store.pages()).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it("describes page operations without embedding the document", () => {
  const created = preparePageCreation("テンプレート", null, initialDoc("本文"));
  expect(describePageOperation(created)).toBe(
    "ページ「テンプレート」の作成（初期本文あり）",
  );
  expect(describePageOperation(preparePageCreation("空"))).toBe(
    "ページ「空」の作成",
  );
  expect(
    describePageOperation({
      operationId: "duplicate",
      sessionId: "session",
      seq: 1,
      command: { kind: "duplicatePage", pageId: "source-id", revision: 0 },
    }),
  ).toBe("ページの複製（元ページ source-id）");
});
