import type { Doc } from "./types";

export const RICH_BLOCK_TYPES = [
  "callout",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
] as const;
export const MAX_TABLE_ROWS = 100;
export const MAX_TABLE_COLUMNS = 20;
/** A bounded walk also handles validated request/recovery envelopes. */
export function containsRichBlocks(value: unknown): boolean {
  const stack: unknown[] = [value];
  let count = 0;
  while (stack.length && ++count <= 500000) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (
      RICH_BLOCK_TYPES.includes(
        (node as { type?: string }).type as (typeof RICH_BLOCK_TYPES)[number],
      )
    )
      return true;
    for (const child of Object.values(node))
      if (child && typeof child === "object") stack.push(child);
  }
  return false;
}
/** Only document schema changes; the enclosing Page remains schemaVersion 1. */
export function versionDocument(doc: Doc): Doc {
  return { ...doc, schemaVersion: containsRichBlocks(doc) ? 2 : 1 };
}
/** Structural constraints beyond ProseMirror's content expressions. */
export function validRichNode(node: Doc): boolean {
  if (
    node.type === "callout" &&
    node.attrs?.tone !== undefined &&
    !["note", "tip", "warning"].includes(node.attrs.tone as string)
  )
    return false;
  if (node.type === "table") {
    const rows = node.content;
    if (!rows?.length || rows.length > MAX_TABLE_ROWS) return false;
    const width = rows[0].content?.length ?? 0;
    if (!width || width > MAX_TABLE_COLUMNS) return false;
    if (
      rows.some(
        (row) => row.type !== "tableRow" || row.content?.length !== width,
      )
    )
      return false;
  }
  if (node.type === "tableCell" || node.type === "tableHeader") {
    if (node.attrs?.colspan !== undefined && node.attrs.colspan !== 1)
      return false;
    if (node.attrs?.rowspan !== undefined && node.attrs.rowspan !== 1)
      return false;
    if (node.attrs?.colwidth !== undefined && node.attrs.colwidth !== null)
      return false;
  }
  return true;
}
