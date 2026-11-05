import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { Page } from "../shared/types";
import { canonicalOperation } from "../shared/save-contract";
import {
  pageOperationSchema,
  type PageOperation,
  type PageOperationResult,
} from "../shared/page-operation";

function result(
  operation: PageOperation,
  fingerprint: string,
  status: PageOperationResult["status"],
  message?: string,
): PageOperationResult {
  return {
    status,
    operationId: operation.operationId,
    sessionId: operation.sessionId,
    seq: operation.seq,
    commandKind: operation.command.kind,
    fingerprint,
    ...(message ? { message } : {}),
  };
}

function fingerprint(operation: PageOperation): string {
  return createHash("sha256").update(canonicalOperation(operation)).digest("hex");
}

function readReceipt(
  store: Store,
  operation: PageOperation,
  hash: string,
): PageOperationResult | undefined {
  const row = store.db
    .prepare("SELECT fingerprint,result_json FROM save_receipts WHERE operation_id=?")
    .get(operation.operationId) as { fingerprint: string; result_json: string } | undefined;
  if (!row) return undefined;
  if (row.fingerprint !== hash)
    return result(
      operation,
      hash,
      "rejected",
      "同じ操作IDに異なる要求があります。入力を保持しています。",
    );
  return JSON.parse(row.result_json) as PageOperationResult;
}

function hasTable(store: Store, name: string): boolean {
  return !!store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

/**
 * Page IDs that the ordinary duplicate path cannot copy safely. Records and
 * registered databases have their own owner-bound lifecycle commands.
 */
function isRecordOwned(store: Store, id: string): boolean {
  if (hasTable(store, "record_memberships") &&
      store.db.prepare("SELECT 1 FROM record_memberships WHERE page_id=?").get(id))
    return true;
  return hasTable(store, "record_databases") &&
    !!store.db.prepare("SELECT 1 FROM record_databases WHERE database_page_id=?").get(id);
}

function requirePagePlain(store: Store, id: string): Page {
  const page = store.get(id);
  if (page.documentError)
    throw new Error("未対応または不正なページは複製できません。原本を保持しています。");
  if (page.deletedAt !== null) throw new Error("削除済みのページは複製できません。");
  if (page.kind !== "page" || page.database !== null)
    throw new Error("通常ページ以外は複製できません。");
  if (isRecordOwned(store, id))
    throw new Error("レコードまたは登録済みデータベースはこの複製経路では扱えません。");
  return page;
}

function duplicatePrecondition(store: Store, command: {
  pageId: string;
  revision: number;
}): string | undefined {
  let source: Page;
  try {
    source = requirePagePlain(store, command.pageId);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (source.revision !== command.revision)
    return "複製元の版が変わりました。入力を保持しています。";
  // Copying a subtree that contains records would silently duplicate owner
  // data. Refuse before any write instead of failing halfway through copies.
  for (const id of store.descendants(command.pageId))
    if (isRecordOwned(store, id))
      return "レコードまたは登録済みデータベースを含むページは複製できません。";
  return undefined;
}

/** Local confirmation for an operation whose COMMIT outcome was lost. */
export function resolvePageOperation(
  store: Store,
  input: PageOperation,
): PageOperationResult {
  const operation = pageOperationSchema.parse(input);
  const hash = fingerprint(operation);
  return readReceipt(store, operation, hash) ??
    result(operation, hash, "unknown", "作成結果を確認できません。入力を保持しています。");
}

/**
 * Apply at most one Page change per operation ID. The Page change and its
 * receipt commit in one SQLite transaction. A command-level rejection is
 * terminal and durable; an unexpected mutation failure rolls back everything,
 * including the receipt, so a later retry cannot observe a half-copied tree.
 */
export function commitPageOperation(
  store: Store,
  input: PageOperation,
): PageOperationResult {
  const operation = pageOperationSchema.parse(input);
  const hash = fingerprint(operation);
  const already = readReceipt(store, operation, hash);
  if (already) return already;
  return store.transaction(() => {
    const existing = readReceipt(store, operation, hash);
    if (existing) return existing;
    let outcome: PageOperationResult;
    if (operation.command.kind === "duplicatePage") {
      const rejection = duplicatePrecondition(store, operation.command);
      if (rejection) {
        outcome = result(operation, hash, "rejected", rejection);
        writeReceipt(store, operation, hash, outcome);
        return outcome;
      }
      // A partial descendant copy must leave neither Pages nor a receipt.
      const page = store.duplicateInTransaction(operation.command.pageId);
      outcome = { ...result(operation, hash, "applied"), page };
    } else {
      // Even one failing INSERT can retain effects (for example SQLite
      // RAISE(FAIL) in an AFTER trigger). Prove the Page mutation was undone
      // before committing a terminal rejection receipt.
      store.db.exec("SAVEPOINT page_operation_create");
      try {
        // Store.create validates the parent classification inside this same
        // write transaction. Its single INSERT writes the Page JSON, its
        // search body and the optional initial document together; the receipt
        // below is written before the same transaction commits.
        const page = store.create(
          operation.command.parentId,
          "page",
          operation.command.title,
          operation.command.doc,
        );
        store.db.exec("RELEASE SAVEPOINT page_operation_create");
        outcome = { ...result(operation, hash, "applied"), page };
      } catch (error) {
        // Cleanup failure escapes to the owning transaction; never turn an
        // uncertain mutation into a durable claim that nothing was created.
        store.db.exec("ROLLBACK TO SAVEPOINT page_operation_create");
        store.db.exec("RELEASE SAVEPOINT page_operation_create");
        outcome = result(
          operation,
          hash,
          "rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    writeReceipt(store, operation, hash, outcome);
    return outcome;
  });
}

function writeReceipt(
  store: Store,
  operation: PageOperation,
  hash: string,
  outcome: PageOperationResult,
) {
  store.db
    .prepare(
      "INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES(?,?,?)",
    )
    .run(operation.operationId, hash, JSON.stringify(outcome));
}
