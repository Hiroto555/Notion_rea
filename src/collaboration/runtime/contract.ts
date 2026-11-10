import type { Doc } from "../../shared/types";
/** Shared runtime v1. Private SaveOperation/checkpoints and draft quarantine stay separate. */
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Scope = Readonly<{
  orgId: string;
  workspaceId: string;
  documentId: string;
  incarnationId: string;
}>;
export type Cut = Readonly<{ epoch: string; seq: number; hash: string }>;
export type TextCommand = {
  kind: "text";
  blockId: string;
  from: number;
  to: number;
  text: string;
  before: string;
};
export type BlockCommand =
  | {
      kind: "block.move";
      positionBase?: Cut;
      blockId: string;
      parentId: string | null;
      beforeId: string | null;
    }
  | { kind: "block.delete"; blockId: string }
  | {
      kind: "block.insert";
      parentId: string | null;
      beforeId: string | null;
      node: Doc;
    }
  | { kind: "block.replace"; blockId: string; before: Doc; node: Doc }
  | { kind: "block.split"; blockId: string; offset: number; newId: string }
  | { kind: "block.join"; leftId: string; rightId: string };
export type TableCommand =
  | {
      kind: "table.row.insert";
      tableId: string;
      rowId: string;
      beforeId: string | null;
    }
  | {
      kind: "table.column.insert";
      tableId: string;
      columnId: string;
      beforeId: string | null;
    }
  | { kind: "table.row.delete"; tableId: string; rowId: string }
  | { kind: "table.column.delete"; tableId: string; columnId: string }
  | {
      kind: "table.row.restore";
      tableId: string;
      undoOf: string;
      newRowId: string;
      beforeId: string | null;
      sourceRow: Doc;
      columnIds: string[];
    }
  | {
      kind: "table.column.restore";
      tableId: string;
      undoOf: string;
      newColumnId: string;
      beforeId: string | null;
      sourceColumnId: string;
      rows: { rowId: string; cell: Doc }[];
    };
export type ResourceCommand = {
  kind: "resource";
  action: string;
  payload: Json;
};
export type RichInlineCommand = import("./rich-inline").RichInlineCommand;
export type BlockFormatCommand = import("./block-format").BlockFormatCommand;
export type BlockFrameCommand = import("./block-frame").BlockFrameCommand;
export type InlinePatchCommand = import("./compact-inline").InlinePatchCommand;
export type InlineMarkCommand = import("./compact-inline").InlineMarkCommand;
export type EditorAtomic = BlockCommand | TableCommand | RichInlineCommand | InlinePatchCommand | InlineMarkCommand | BlockFormatCommand | BlockFrameCommand;
export type BatchCommand = { kind: "batch"; commands: EditorAtomic[] };
export type Command = TextCommand | EditorAtomic | BatchCommand | ResourceCommand;
export type Intent = Readonly<{
  v: 1;
  intentId: string;
  writerId: string;
  scope: Scope;
  base: Cut;
  command: Command;
}>;
export type Attempt = Readonly<{
  protocol?: 1004;
  v: 1;
  attemptId: string;
  intent: Intent;
  base: Cut;
}>;
export type AuthContext = Readonly<{
  userId: string;
  deviceId: string;
  writerId: string;
  sessionId: string;
}>;
export type TableMetadata = {
  tableId: string;
  rowIds: string[];
  columnIds: string[];
};
export type DocumentState = {
  document: Doc;
  tables: TableMetadata[];
  tombstones: string[];
};
export type AppliedText = {
  kind: "text";
  blockId: string;
  from: number;
  to: number;
  text: string;
};
export type Receipt = {
  v: 1;
  status: "SERVER_ACCEPTED" | "REJECTED" | "INVALIDATED";
  intentId: string;
  intentHash: string;
  attemptId: string;
  attemptHash: string;
  writerId: string;
  scope: Scope;
  cut: Cut;
  resultHash: string;
  code: string | null;
};
export type RuntimeEvent = {
  appliedBefore?: DocumentState;
  authorityStateHash?: string;
  seq: number;
  epoch: string;
  previousHash: string;
  hash: string;
  scope: Scope;
  intentId: string;
  attemptId: string;
  writerId: string;
  command: Command;
  appliedText: AppliedText | null;
  state: DocumentState | null;
  receipt: Receipt;
};
export type Snapshot = {
  scope: Scope;
  cut: Cut;
  state: DocumentState;
  events: RuntimeEvent[];
};
export type Role = "owner" | "editor" | "viewer";
export type SemanticResult = {
  state: DocumentState;
  appliedText: AppliedText | null;
};
export class CollaborationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CollaborationError";
  }
}
export function demand(value: unknown, code: string): asserts value {
  if (!value) throw new CollaborationError(code);
}
export function identifier(value: unknown): string {
  demand(
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    "INVALID_ID",
  );
  return value;
}
export function safeCounter(value: unknown): number {
  demand(Number.isSafeInteger(value) && Number(value) >= 0, "INVALID_COUNTER");
  return Number(value);
}
export function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.orgId === b.orgId &&
    a.workspaceId === b.workspaceId &&
    a.documentId === b.documentId &&
    a.incarnationId === b.incarnationId
  );
}
export function scopeKey(scope: Scope): string {
  return [scope.orgId, scope.workspaceId, scope.documentId, scope.incarnationId]
    .map(identifier)
    .join(":");
}
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const u = value.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (u >= 0xdc00 && u <= 0xdfff) return false;
  }
  return true;
}
