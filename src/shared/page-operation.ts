import type { z } from "zod";
import { canonicalOperation } from "./save-contract";
import { pageOperationSchema, type Doc, type Page } from "./types";

export { pageOperationSchema };

/**
 * Contract for the two ordinary Page commands whose retry must not create a
 * second Page. The operation itself is immutable: its identity and the exact
 * command are hashed into the durable receipt fingerprint.
 */
export type PageOperation = z.infer<typeof pageOperationSchema>;

export type PageOperationResult = {
  status: "applied" | "rejected" | "unknown";
  operationId: string;
  sessionId: string;
  seq: number;
  fingerprint: string;
  commandKind: PageOperation["command"]["kind"];
  /** Created Page (createPage) or copied root Page (duplicatePage). */
  page?: Page;
  message?: string;
};

/**
 * Create once per explicit user action. Retrying the same action must reuse the
 * returned operation; generating a fresh operation ID would allow a second
 * Page after a lost ACK. An optional initial document is cloned into the
 * immutable command so a later caller mutation cannot change its identity.
 */
export function preparePageCreation(
  title: string,
  parentId: string | null = null,
  doc?: Doc,
): PageOperation {
  return {
    operationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    seq: 1,
    command:
      doc === undefined
        ? { kind: "createPage", parentId, title }
        : { kind: "createPage", parentId, title, doc: structuredClone(doc) },
  };
}

/**
 * One explicit duplicate action. `revision` is the revision the user actually
 * saw; the backend refuses the command if the source moved on before commit.
 */
export function preparePageDuplication(
  pageId: string,
  revision: number,
): PageOperation {
  return {
    operationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    seq: 1,
    command: { kind: "duplicatePage", pageId, revision },
  };
}

/** Compare an ACK with the retained request before accepting any Page data. */
export function matchesPageOperation(
  result: PageOperationResult,
  operation: PageOperation,
  fingerprint: string,
): boolean {
  return (
    !!result &&
    result.operationId === operation.operationId &&
    result.sessionId === operation.sessionId &&
    result.seq === operation.seq &&
    result.fingerprint === fingerprint &&
    result.commandKind === operation.command.kind &&
    ["applied", "rejected", "unknown"].includes(result.status)
  );
}

/** The applied Page must be a fresh ordinary Page that matches the command. */
export function validAppliedPage(
  operation: PageOperation,
  page: Page | undefined,
): boolean {
  if (!page || typeof page.id !== "string" || page.id.length === 0 || page.id.length > 500 ||
      typeof page.title !== "string" || page.documentError || page.deletedAt !== null)
    return false;
  if (page.kind !== "page" || page.database !== null) return false;
  if (page.revision !== 0) return false;
  const command = operation.command;
  if (command.kind === "createPage") {
    if (page.parentId !== command.parentId || page.title !== command.title)
      return false;
    // A new command's ACK must carry the exact initial body. Commands written
    // before this field existed keep the previous title/parent check only.
    return (
      command.doc === undefined ||
      canonicalOperation(page.doc) === canonicalOperation(command.doc)
    );
  }
  return (
    page.id !== command.pageId &&
    page.title.endsWith(" のコピー") &&
    page.title.length <= 500
  );
}

/** Human-readable, bounded description shared by the recovery dialog. */
export function describePageOperation(operation: PageOperation): string {
  const command = operation.command;
  if (command.kind === "createPage") {
    const title = command.title.trim() || "無題";
    return `ページ「${title.slice(0, 100)}」の作成${
      command.doc ? "（初期本文あり）" : ""
    }`;
  }
  return `ページの複製（元ページ ${command.pageId.slice(0, 100)}）`;
}
