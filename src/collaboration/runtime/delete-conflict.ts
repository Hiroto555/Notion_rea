import type { Doc } from "../../shared/types";
import { locate } from "./document";
import {
  demand,
  sameScope,
  type Attempt,
  type DocumentState,
  type RuntimeEvent,
  type Command,
} from "./contract";
function ids(node: Doc, out = new Set<string>()): Set<string> {
  if (typeof node.attrs?.id === "string") out.add(node.attrs.id);
  for (const child of node.content ?? []) ids(child, out);
  return out;
}
/** A destructive intent must not silently erase edits its author never observed. */
export function assertDeleteBase(
  state: DocumentState,
  attempt: Attempt,
  events: RuntimeEvent[],
): void {
  const command = attempt.intent.command;
  let target: Set<string> | null = null;
  if (command.kind === "block.delete")
    target = ids(locate(state.document, command.blockId).node);
  else if (command.kind === "block.frame") {
    target = new Set<string>();
    for (const id of command.beforeIds) ids(locate(state.document, id).node, target);
    // Retained subtrees are transported live, while wrapper shells survive by
    // identity. Only actual removals require the destructive event witness.
    for (const id of command.retainIds)
      for (const retained of ids(locate(state.document, id).node)) target.delete(retained);
    for (const node of command.after)
      for (const surviving of ids(node)) target.delete(surviving);
  } else if (command.kind === "table.row.delete") {
    const table = locate(state.document, command.tableId).node;
    const row = (table.content ?? []).find(
      (r) => r.attrs?.id === command.rowId,
    );
    if (row) target = ids(row);
  } else if (command.kind === "table.column.delete") {
    const table = locate(state.document, command.tableId).node;
    const meta = state.tables.find((t) => t.tableId === command.tableId);
    const index = meta?.columnIds.indexOf(command.columnId) ?? -1;
    if (index >= 0) {
      target = new Set();
      for (const row of table.content ?? []) {
        const cell = row.content?.[index];
        if (cell) ids(cell, target);
      }
    }
  } else if (
    command.kind === "resource" &&
    ["document.trash", "record.trash"].includes(command.action)
  )
    target = ids(state.document);
  if (!target) return;
  for (const e of events) {
    if (
      e.seq <= attempt.intent.base.seq ||
      e.receipt.status !== "SERVER_ACCEPTED" ||
      !sameScope(e.scope, attempt.intent.scope)
    )
      continue;
    const commands = e.command.kind === "batch" ? e.command.commands : [e.command];
    for (const atom of commands) {
      if (atom.kind === "block.frame") demand(![...atom.beforeIds, ...atom.retainIds].some(id => target!.has(id)), "DELETE_CONFLICT");
      if ("blockId" in atom) demand(!target.has(atom.blockId), "DELETE_CONFLICT");
      if ("tableId" in atom) demand(!target.has(atom.tableId), "DELETE_CONFLICT");
      if (atom.kind === "block.join") demand(!target.has(atom.leftId) && !target.has(atom.rightId), "DELETE_CONFLICT");
    }
    const c = e.command;
    if (e.appliedText)
      demand(!target.has(e.appliedText.blockId), "DELETE_CONFLICT");
    if (c.kind === "block.insert")
      demand(
        ![...ids(c.node)].some((id) => target!.has(id)) &&
          !(c.parentId && target.has(c.parentId)),
        "DELETE_CONFLICT",
      );
    else if ("blockId" in c) demand(!target.has(c.blockId), "DELETE_CONFLICT");
    else if (c.kind === "block.join")
      demand(
        !target.has(c.leftId) && !target.has(c.rightId),
        "DELETE_CONFLICT",
      );
    else if (c.kind === "table.row.insert")
      demand(!target.has(c.rowId), "DELETE_CONFLICT");
    else if (c.kind === "table.row.restore")
      demand(!target.has(c.newRowId), "DELETE_CONFLICT");
    else if (c.kind === "table.column.restore" && e.state) {
      const table = locate(e.state.document, c.tableId).node,
        meta = e.state.tables.find((t) => t.tableId === c.tableId);
      const index = meta?.columnIds.indexOf(c.newColumnId) ?? -1;
      for (const row of table.content ?? []) {
        const cell = row.content?.[index];
        if (cell)
          demand(
            ![...ids(cell)].some((id) => target!.has(id)),
            "DELETE_CONFLICT",
          );
      }
    } else if (
      c.kind === "resource" &&
      ["record.patch", "record.restore", "document.restore"].includes(c.action)
    )
      demand(false, "DELETE_CONFLICT");
  }
}
