import type { StoragePort } from "./storage-port";
import { locate } from "./document";
import { canonical } from "./canonical";
import {
  clone,
  demand,
  scopeKey,
  type Attempt,
  type AuthContext,
  type Cut,
  type DocumentState,
  type TableCommand,
} from "./contract";
type Restore = Extract<
  TableCommand,
  { kind: "table.row.restore" | "table.column.restore" }
>;
type Template =
  | Omit<
      Extract<TableCommand, { kind: "table.row.restore" }>,
      "undoOf" | "newRowId"
    >
  | Omit<
      Extract<TableCommand, { kind: "table.column.restore" }>,
      "undoOf" | "newColumnId"
    >;
type Witness = {
  userId: string;
  writerId: string;
  template: Template;
  cut: Cut | null;
  usedBy: string | null;
};
const ns = "authority.undo";
const key = (attempt: Attempt, intentId = attempt.intent.intentId) =>
  scopeKey(attempt.intent.scope) +
  ":" +
  attempt.intent.writerId +
  ":" +
  intentId;
export function captureDeleteWitness(
  state: DocumentState,
  command: TableCommand,
): Template | null {
  if (
    command.kind !== "table.row.delete" &&
    command.kind !== "table.column.delete"
  )
    return null;
  const table = locate(state.document, command.tableId).node;
  const metadata = state.tables.find((t) => t.tableId === command.tableId);
  demand(metadata, "TABLE_METADATA_MISSING");
  if (command.kind === "table.row.delete") {
    const index = metadata.rowIds.indexOf(command.rowId);
    demand(index >= 0, "ROW_MISSING");
    const row = table.content?.[index];
    demand(row, "ROW_MISSING");
    return {
      kind: "table.row.restore",
      tableId: command.tableId,
      beforeId: metadata.rowIds[index + 1] ?? null,
      sourceRow: clone(row),
      columnIds: clone(metadata.columnIds),
    };
  }
  const index = metadata.columnIds.indexOf(command.columnId);
  demand(index >= 0, "COLUMN_MISSING");
  return {
    kind: "table.column.restore",
    tableId: command.tableId,
    beforeId: metadata.columnIds[index + 1] ?? null,
    sourceColumnId: command.columnId,
    rows: (table.content ?? []).map((row, i) => {
      const cell = row.content?.[index];
      demand(cell, "CELL_MISSING");
      return { rowId: metadata.rowIds[i], cell: clone(cell) };
    }),
  };
}
export function storeDeleteWitness(
  store: StoragePort,
  attempt: Attempt,
  auth: AuthContext,
  template: Template,
): void {
  demand(store.get(ns, key(attempt)) === null, "UNDO_WITNESS_EXISTS");
  store.set(ns, key(attempt), {
    userId: auth.userId,
    writerId: auth.writerId,
    template,
    cut: null,
    usedBy: null,
  } satisfies Witness);
}
export function sealDeleteWitness(
  store: StoragePort,
  attempt: Attempt,
  cut: Cut,
): void {
  const value = store.get(ns, key(attempt)) as Witness | null;
  if (value && value.cut === null)
    store.set(ns, key(attempt), { ...value, cut });
}
export function validateRestoreWitness(
  store: StoragePort,
  attempt: Attempt,
  auth: AuthContext,
  command: Restore,
): void {
  const witness = store.get(ns, key(attempt, command.undoOf)) as Witness | null;
  demand(witness && witness.cut, "UNDO_PROOF_MISSING");
  demand(
    witness.userId === auth.userId && witness.writerId === auth.writerId,
    "UNDO_OWNER_MISMATCH",
  );
  demand(witness.usedBy === null, "UNDO_ALREADY_USED");
  demand(
    witness.cut.epoch === attempt.intent.base.epoch &&
      witness.cut.seq <= attempt.intent.base.seq,
    "UNDO_BASE_MISMATCH",
  );
  const candidate: Template =
    command.kind === "table.row.restore"
      ? {
          kind: command.kind,
          tableId: command.tableId,
          beforeId: command.beforeId,
          sourceRow: command.sourceRow,
          columnIds: command.columnIds,
        }
      : {
          kind: command.kind,
          tableId: command.tableId,
          beforeId: command.beforeId,
          sourceColumnId: command.sourceColumnId,
          rows: command.rows,
        };
  demand(
    canonical(candidate) === canonical(witness.template),
    "UNDO_SOURCE_MISMATCH",
  );
}
export function markRestoreUsed(
  store: StoragePort,
  attempt: Attempt,
  command: Restore,
): void {
  const entry = store.get(ns, key(attempt, command.undoOf)) as Witness | null;
  demand(entry && entry.usedBy === null, "UNDO_ALREADY_USED");
  store.set(ns, key(attempt, command.undoOf), {
    ...entry,
    usedBy: attempt.intent.intentId,
  });
}
