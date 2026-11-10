import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  clone,
  CollaborationError,
  scopeKey,
  type Attempt,
  type AuthContext,
  type Command,
  type Cut,
  type DocumentState,
  type Receipt,
  type Scope,
  type TableCommand,
  type TableMetadata,
} from "../src/collaboration/runtime/contract";
import { locate } from "../src/collaboration/runtime/document";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import {
  createSharedHttpServer,
  type SharedHttpServer,
} from "../src/collaboration/runtime/http-server";
import type {
  SharedProvider,
  WorkspaceListing,
} from "../src/collaboration/runtime/provider-port";
import type { Doc } from "../src/shared/types";

type Cleanup = () => void | Promise<void>;
const cleanups: Cleanup[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!;
    try {
      await cleanup();
    } catch {
      void 0;
    }
  }
});

type World = Readonly<{
  root: string;
  directory: string;
  authority: SharedAuthority;
  server: SharedHttpServer;
  url: string;
  scope: Scope;
  token: string;
  auth: AuthContext;
}>;

type Identity = Readonly<{ token: string; writerId: string }>;

type Mark = { type: string; attrs?: Record<string, unknown> };

function textNode(value: string, marks?: Mark[]): Doc {
  return marks
    ? { type: "text", text: value, marks: marks.map((mark) => ({ ...mark })) }
    : { type: "text", text: value };
}

function paragraph(id: string, content: Doc[] = []): Doc {
  return content.length
    ? { type: "paragraph", attrs: { id }, content }
    : { type: "paragraph", attrs: { id } };
}

function tableCell(id: string, paragraphId: string, content: Doc[]): Doc {
  return {
    type: "tableCell",
    attrs: { id },
    content: [paragraph(paragraphId, content)],
  };
}

function tableRow(id: string, cells: Doc[]): Doc {
  return { type: "tableRow", attrs: { id }, content: cells };
}

function tableNode(id: string, rows: Doc[]): Doc {
  return { type: "table", attrs: { id }, content: rows };
}

function markedTableDocument(): Doc {
  return {
    type: "doc",
    content: [
      paragraph("p0", [textNode("intro")]),
      tableNode("t1", [
        tableRow("r1", [
          tableCell("c11", "p11", [textNode("A1", [{ type: "bold" }])]),
          tableCell("c12", "p12", [textNode("B1", [{ type: "italic" }])]),
        ]),
        tableRow("r2", [
          tableCell("c21", "p21", [textNode("A2")]),
          tableCell("c22", "p22", [textNode("B2")]),
        ]),
      ]),
    ],
  };
}

function plainTextDocument(value: string, id = "p1"): Doc {
  return { type: "doc", content: [paragraph(id, [textNode(value)])] };
}

function markedTextDocument(): Doc {
  return {
    type: "doc",
    content: [
      paragraph("p1", [
        textNode("plain "),
        textNode("BOLD", [{ type: "bold" }]),
        textNode(" mid "),
        textNode("KEEP", [{ type: "bold" }]),
      ]),
    ],
  };
}

function blockDocument(): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "blockquote",
        attrs: { id: "b1" },
        content: [paragraph("p1", [textNode("quoted")])],
      },
      paragraph("p2", [textNode("keep me")]),
    ],
  };
}

async function createWorld(document: Doc): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "folio-r13-undo-"));
  const directory = join(root, "authority");
  const authority = new SharedAuthority(directory);
  try {
    const boot = authority.bootstrap({
      orgId: "org1",
      userId: "user1",
      deviceId: "device1",
      workspaceId: "ws1",
      documentId: "doc1",
      document,
    });
    const server = createSharedHttpServer(authority);
    const { url } = await server.listen();
    cleanups.push(async () => {
      await server.close().catch(() => undefined);
      try {
        authority.close();
      } catch {
        void 0;
      }
      rmSync(root, { recursive: true, force: true });
    });
    return {
      root,
      directory,
      authority,
      server,
      url,
      scope: boot.scope,
      token: boot.token,
      auth: boot.auth,
    };
  } catch (error) {
    try {
      authority.close();
    } catch {
      void 0;
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function clientFor(
  world: World,
  identity: Identity = { token: world.token, writerId: world.auth.writerId },
  provider?: SharedProvider,
): SharedRuntimeClient {
  const directory = join(world.root, "writer-" + randomUUID());
  const actualProvider =
    provider ?? new HttpSharedProvider(world.url, identity.token);
  const client = new SharedRuntimeClient(
    directory,
    actualProvider,
    world.scope,
    identity.writerId,
  );
  cleanups.push(() => client.close());
  return client;
}

async function addEditor(
  world: World,
  userId: string,
  deviceId: string,
): Promise<Identity> {
  const invite = world.authority.invite(world.token, world.scope.orgId, userId);
  const joined = world.authority.join(invite, world.scope.orgId, deviceId);
  world.authority.grant(world.token, world.scope, userId, "editor");
  return { token: joined.token, writerId: joined.auth.writerId };
}

function attemptFor(
  writerId: string,
  scope: Scope,
  base: Cut,
  command: Command,
): Attempt {
  return {
    v: 1,
    attemptId: randomUUID(),
    intent: {
      v: 1,
      intentId: randomUUID(),
      writerId,
      scope,
      base: clone(base),
      command: clone(command),
    },
    base: clone(base),
  };
}

function rowRestore(params: {
  tableId: string;
  undoOf: string;
  newRowId: string;
  beforeId: string | null;
  sourceRow: Doc;
  columnIds: string[];
}): Extract<TableCommand, { kind: "table.row.restore" }> {
  return {
    kind: "table.row.restore",
    tableId: params.tableId,
    undoOf: params.undoOf,
    newRowId: params.newRowId,
    beforeId: params.beforeId,
    sourceRow: clone(params.sourceRow),
    columnIds: [...params.columnIds],
  };
}

function expectAccepted(receipt: Receipt): Receipt {
  expect(receipt.status).toBe("SERVER_ACCEPTED");
  expect(receipt.code).toBeNull();
  return receipt;
}

function expectRejected(receipt: Receipt, code: string): Receipt {
  expect(receipt.status).toBe("REJECTED");
  expect(receipt.code).toBe(code);
  return receipt;
}

function tableNodeOf(state: DocumentState): Doc {
  return locate(state.document, "t1").node;
}

function tableMetadataOf(state: DocumentState): TableMetadata {
  const metadata = state.tables.find((value) => value.tableId === "t1");
  if (!metadata) throw new Error("TABLE_METADATA_MISSING");
  return metadata;
}

function rowById(state: DocumentState, rowId: string): Doc {
  const row = (tableNodeOf(state).content ?? []).find(
    (value) => value.attrs?.id === rowId,
  );
  if (!row) throw new Error("ROW_MISSING");
  return row;
}

function allIds(node: Doc): string[] {
  const ids: string[] = [];
  const stack: Doc[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current.attrs?.id === "string") ids.push(current.attrs.id);
    for (const child of current.content ?? []) stack.push(child);
  }
  return ids;
}

function textOf(node: Doc): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join("");
}

function textNodes(node: Doc): Doc[] {
  const found: Doc[] = [];
  const stack: Doc[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "text") found.push(current);
    for (const child of current.content ?? []) stack.push(child);
  }
  return found;
}

function firstText(node: Doc): Doc {
  const found = textNodes(node)[0];
  if (!found) throw new Error("TEXT_MISSING");
  return found;
}

function markTypes(node: Doc): string[] {
  return (firstText(node).marks ?? []).map((mark) => mark.type);
}

function witnessKey(scope: Scope, writerId: string, intentId: string): string {
  return scopeKey(scope) + ":" + writerId + ":" + intentId;
}

function parseRecovery(raw: string): { queue: { raw: string }[] } {
  return JSON.parse(raw) as { queue: { raw: string }[] };
}

class LostAckProvider implements SharedProvider {
  private lost = false;
  constructor(private readonly inner: HttpSharedProvider) {}
  snapshot(scope: Scope, after?: number) {
    return this.inner.snapshot(scope, after);
  }
  async submit(attempt: Attempt): Promise<Receipt> {
    const receipt = await this.inner.submit(attempt);
    if (!this.lost) {
      this.lost = true;
      throw new Error("LOST_ACK");
    }
    return receipt;
  }
  receipt(attempt: Attempt) {
    return this.inner.receipt(attempt);
  }
  invalidate(attempt: Attempt) {
    return this.inner.invalidate(attempt);
  }
  proof(scope: Scope, seq: number) {
    return this.inner.proof(scope, seq);
  }
  workspaces(orgId: string): Promise<WorkspaceListing[]> {
    return this.inner.workspaces(orgId);
  }
  close(): void {
    this.inner.close();
  }
}

describe("shared runtime undo proof", () => {
  it("restores a deleted marked row with fresh IDs and keeps a column added by another writer", async () => {
    const world = await createWorld(markedTableDocument());
    const owner = clientFor(world);
    const first = await owner.open();
    const originalIds = new Set(allIds(rowById(first.state, "r1")));

    const deleted = expectAccepted(
      (
        await owner.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );

    const afterDelete = owner.snapshot();
    expect(tableMetadataOf(afterDelete.state).rowIds).toEqual(["r2"]);
    for (const id of originalIds)
      expect(afterDelete.state.tombstones).toContain(id);

    const otherIdentity = await addEditor(world, "user2", "device2");
    const other = clientFor(world, otherIdentity);
    await other.open();
    expectAccepted(
      (
        await other.submit({
          kind: "table.column.insert",
          tableId: "t1",
          columnId: "c3",
          beforeId: null,
        })
      ).receipt,
    );

    const undo = await owner.historyStep("undo");
    expectAccepted(undo.receipt);
    expect(undo.receipt.intentId).not.toBe(deleted.intentId);

    const restoredMetadata = tableMetadataOf(undo.snapshot.state);
    expect(restoredMetadata.columnIds).toHaveLength(3);
    expect(restoredMetadata.columnIds).toContain("c3");
    expect(restoredMetadata.rowIds[0]).not.toBe("r1");

    const restoredRow = rowById(
      undo.snapshot.state,
      restoredMetadata.rowIds[0],
    );
    const restoredIds = allIds(restoredRow);
    expect(new Set(restoredIds).size).toBe(restoredIds.length);
    for (const id of restoredIds) {
      expect(originalIds.has(id)).toBe(false);
      expect(undo.snapshot.state.tombstones).not.toContain(id);
    }
    for (const id of originalIds)
      expect(undo.snapshot.state.tombstones).toContain(id);

    const cells = restoredRow.content ?? [];
    expect(cells).toHaveLength(3);
    expect(textOf(cells[0])).toBe("A1");
    expect(markTypes(cells[0])).toContain("bold");
    expect(textOf(cells[1])).toBe("B1");
    expect(markTypes(cells[1])).toContain("italic");
    expect(textOf(cells[2])).toBe("");
  });

  it("undoes and redoes a row insertion through receipt-backed restore", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    await client.open();

    const inserted = expectAccepted(
      (
        await client.submit({
          kind: "table.row.insert",
          tableId: "t1",
          rowId: "r3",
          beforeId: null,
        })
      ).receipt,
    );
    expect(tableMetadataOf(client.snapshot().state).rowIds).toEqual([
      "r1",
      "r2",
      "r3",
    ]);

    const undo = await client.historyStep("undo");
    expectAccepted(undo.receipt);
    expect(tableMetadataOf(undo.snapshot.state).rowIds).toEqual(["r1", "r2"]);
    const deleteEvent = undo.snapshot.events.find(
      (event) => event.attemptId === undo.receipt.attemptId,
    );
    expect(deleteEvent?.command.kind).toBe("table.row.delete");

    const redo = await client.historyStep("redo");
    expectAccepted(redo.receipt);
    expect(redo.receipt.cut.seq).toBeGreaterThan(inserted.cut.seq);
    const restoreEvent = redo.snapshot.events.find(
      (event) => event.attemptId === redo.receipt.attemptId,
    );
    expect(restoreEvent?.command.kind).toBe("table.row.restore");
    if (restoreEvent?.command.kind === "table.row.restore")
      expect(restoreEvent.command.undoOf).toBe(undo.receipt.intentId);

    const restoredMetadata = tableMetadataOf(redo.snapshot.state);
    expect(restoredMetadata.rowIds).toHaveLength(3);
    expect(restoredMetadata.rowIds).not.toContain("r3");
    expect(redo.snapshot.state.tombstones).toContain("r3");
  });

  it("undoes a column deletion after another writer adds a row", async () => {
    const world = await createWorld(markedTableDocument());
    const owner = clientFor(world);
    const first = await owner.open();
    const metadata = tableMetadataOf(first.state);
    const deletedColumn = metadata.columnIds[1];
    const deletedIds = new Set<string>([deletedColumn]);
    for (const row of tableNodeOf(first.state).content ?? []) {
      const cell = row.content?.[1];
      if (cell) for (const id of allIds(cell)) deletedIds.add(id);
    }

    expectAccepted(
      (
        await owner.submit({
          kind: "table.column.delete",
          tableId: "t1",
          columnId: deletedColumn,
        })
      ).receipt,
    );

    const otherIdentity = await addEditor(world, "user2", "device2");
    const other = clientFor(world, otherIdentity);
    await other.open();
    expectAccepted(
      (
        await other.submit({
          kind: "table.row.insert",
          tableId: "t1",
          rowId: "r3",
          beforeId: null,
        })
      ).receipt,
    );

    const undo = await owner.historyStep("undo");
    expectAccepted(undo.receipt);
    const restoredMetadata = tableMetadataOf(undo.snapshot.state);
    expect(restoredMetadata.rowIds).toEqual(["r1", "r2", "r3"]);
    expect(restoredMetadata.columnIds).toHaveLength(2);
    const newColumnId = restoredMetadata.columnIds[1];
    expect(deletedIds.has(newColumnId)).toBe(false);
    expect(undo.snapshot.state.tombstones).not.toContain(newColumnId);
    for (const id of deletedIds)
      expect(undo.snapshot.state.tombstones).toContain(id);

    const firstRow = rowById(undo.snapshot.state, "r1");
    expect(textOf(firstRow.content?.[1] as Doc)).toBe("B1");
    expect(markTypes(firstRow.content?.[1] as Doc)).toContain("italic");
    const secondRow = rowById(undo.snapshot.state, "r2");
    expect(textOf(secondRow.content?.[1] as Doc)).toBe("B2");
    const addedRow = rowById(undo.snapshot.state, "r3");
    expect(textOf(addedRow.content?.[1] as Doc)).toBe("");
  });

  it("refuses a changed source payload for the same undoOf", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    const before = await client.open();
    const source = clone(rowById(before.state, "r1"));
    const columnIds = [...tableMetadataOf(before.state).columnIds];

    const deleted = expectAccepted(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );
    const current = client.snapshot();
    firstText(source).text = "TAMPERED";
    const attempt = attemptFor(
      world.auth.writerId,
      world.scope,
      current.cut,
      rowRestore({
        tableId: "t1",
        undoOf: deleted.intentId,
        newRowId: "xr1",
        beforeId: "r2",
        sourceRow: source,
        columnIds,
      }),
    );

    expectRejected(
      await client.provider.submit(attempt),
      "UNDO_SOURCE_MISMATCH",
    );
    const after = await client.open();
    expect(tableMetadataOf(after.state).rowIds).toEqual(["r2"]);
  });

  it("refuses a foreign writer proof and a foreign token impersonating the writer", async () => {
    const world = await createWorld(markedTableDocument());
    const owner = clientFor(world);
    const before = await owner.open();
    const source = clone(rowById(before.state, "r1"));
    const columnIds = [...tableMetadataOf(before.state).columnIds];

    const deleted = expectAccepted(
      (
        await owner.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );

    const otherIdentity = await addEditor(world, "user2", "device2");
    const other = clientFor(world, otherIdentity);
    const foreign = await other.open();
    const command = rowRestore({
      tableId: "t1",
      undoOf: deleted.intentId,
      newRowId: "xr1",
      beforeId: "r2",
      sourceRow: source,
      columnIds,
    });

    const foreignAttempt = attemptFor(
      otherIdentity.writerId,
      world.scope,
      foreign.cut,
      command,
    );
    expectRejected(
      await other.provider.submit(foreignAttempt),
      "UNDO_PROOF_MISSING",
    );

    const impersonation = attemptFor(
      world.auth.writerId,
      world.scope,
      foreign.cut,
      command,
    );
    await expect(other.provider.submit(impersonation)).rejects.toMatchObject({
      code: "WRITER_MISMATCH",
    });
  });

  it("does not create or accept a proof for a rejected delete", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    const first = await client.open();
    const columnIds = [...tableMetadataOf(first.state).columnIds];

    expectAccepted(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );
    const beforeRejected = client.snapshot();
    const source = clone(rowById(beforeRejected.state, "r2"));

    const rejected = expectRejected(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r2",
        })
      ).receipt,
      "TABLE_ROW_MIN",
    );
    expect(
      world.authority.store.get(
        "authority.undo",
        witnessKey(world.scope, world.auth.writerId, rejected.intentId),
      ),
    ).toBeNull();

    const current = client.snapshot();
    const attempt = attemptFor(
      world.auth.writerId,
      world.scope,
      current.cut,
      rowRestore({
        tableId: "t1",
        undoOf: rejected.intentId,
        newRowId: "xr2",
        beforeId: null,
        sourceRow: source,
        columnIds,
      }),
    );
    expectRejected(await client.provider.submit(attempt), "UNDO_PROOF_MISSING");
  });

  it("refuses a base before the delete receipt", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    const before = await client.open();
    const source = clone(rowById(before.state, "r1"));
    const columnIds = [...tableMetadataOf(before.state).columnIds];

    const deleted = expectAccepted(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );
    const current = client.snapshot();
    const attempt = attemptFor(
      world.auth.writerId,
      world.scope,
      before.cut,
      rowRestore({
        tableId: "t1",
        undoOf: deleted.intentId,
        newRowId: "xr1",
        beforeId: "r2",
        sourceRow: source,
        columnIds,
      }),
    );

    expectRejected(await client.provider.submit(attempt), "UNDO_BASE_MISMATCH");
    const after = world.authority.snapshot(world.token, world.scope);
    expect(tableMetadataOf(after.state).rowIds).toEqual(["r2"]);
    expect(after.cut.seq).toBeGreaterThan(current.cut.seq);
  });

  it("refuses live and tombstoned fresh IDs without consuming the proof", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    const before = await client.open();
    const source = clone(rowById(before.state, "r1"));
    const columnIds = [...tableMetadataOf(before.state).columnIds];

    const deleted = expectAccepted(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );
    const base = client.snapshot().cut;

    for (const newRowId of ["r2", "r1"]) {
      const attempt = attemptFor(
        world.auth.writerId,
        world.scope,
        base,
        rowRestore({
          tableId: "t1",
          undoOf: deleted.intentId,
          newRowId,
          beforeId: "r2",
          sourceRow: source,
          columnIds,
        }),
      );
      expectRejected(await client.provider.submit(attempt), "ID_COLLISION");
    }

    const legal = attemptFor(
      world.auth.writerId,
      world.scope,
      world.authority.head(),
      rowRestore({
        tableId: "t1",
        undoOf: deleted.intentId,
        newRowId: "xr1",
        beforeId: "r2",
        sourceRow: source,
        columnIds,
      }),
    );
    expectAccepted(await client.provider.submit(legal));
    const state = world.authority.snapshot(world.token, world.scope).state;
    expect(tableMetadataOf(state).rowIds).toHaveLength(2);
  });

  it("returns the same receipt for a duplicate restore attempt without rematerializing", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    const before = await client.open();
    const source = clone(rowById(before.state, "r1"));
    const columnIds = [...tableMetadataOf(before.state).columnIds];

    const deleted = expectAccepted(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );
    const base = client.snapshot().cut;
    const attempt = attemptFor(
      world.auth.writerId,
      world.scope,
      base,
      rowRestore({
        tableId: "t1",
        undoOf: deleted.intentId,
        newRowId: "xr1",
        beforeId: "r2",
        sourceRow: source,
        columnIds,
      }),
    );

    const first = expectAccepted(await client.provider.submit(attempt));
    const second = expectAccepted(await client.provider.submit(attempt));
    expect(canonical(second)).toBe(canonical(first));
    expect(world.authority.head().seq).toBe(first.cut.seq);

    const snapshot = world.authority.snapshot(world.token, world.scope);
    expect(
      snapshot.events.filter((event) => event.attemptId === attempt.attemptId),
    ).toHaveLength(1);
    expect(tableMetadataOf(snapshot.state).rowIds).toHaveLength(2);
  });

  it("refuses a second logical restore for the same undoOf with different IDs", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    const before = await client.open();
    const source = clone(rowById(before.state, "r1"));
    const columnIds = [...tableMetadataOf(before.state).columnIds];

    const deleted = expectAccepted(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );
    const firstAttempt = attemptFor(
      world.auth.writerId,
      world.scope,
      client.snapshot().cut,
      rowRestore({
        tableId: "t1",
        undoOf: deleted.intentId,
        newRowId: "xr1",
        beforeId: "r2",
        sourceRow: source,
        columnIds,
      }),
    );
    expectAccepted(await client.provider.submit(firstAttempt));

    const secondAttempt = attemptFor(
      world.auth.writerId,
      world.scope,
      world.authority.head(),
      rowRestore({
        tableId: "t1",
        undoOf: deleted.intentId,
        newRowId: "xr2",
        beforeId: "r2",
        sourceRow: source,
        columnIds,
      }),
    );
    expectRejected(
      await client.provider.submit(secondAttempt),
      "UNDO_ALREADY_USED",
    );
    const snapshot = world.authority.snapshot(world.token, world.scope);
    expect(tableMetadataOf(snapshot.state).rowIds).toHaveLength(2);
  });

  it("recovers an accepted restore after a lost acknowledgement without rematerializing", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    const before = await client.open();
    const source = clone(rowById(before.state, "r1"));
    const columnIds = [...tableMetadataOf(before.state).columnIds];

    const deleted = expectAccepted(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );
    const base = client.snapshot().cut;
    client.close();

    const attempt = attemptFor(
      world.auth.writerId,
      world.scope,
      base,
      rowRestore({
        tableId: "t1",
        undoOf: deleted.intentId,
        newRowId: "xr1",
        beforeId: "r2",
        sourceRow: source,
        columnIds,
      }),
    );

    expect(() =>
      world.authority.submit(world.token, attempt, {
        afterCommit: () => {
          throw new Error("lost-ack");
        },
      }),
    ).toThrow("UNKNOWN");

    await world.server.close();
    world.authority.close();
    const reopened = new SharedAuthority(world.directory);
    cleanups.push(() => reopened.close());

    const receipt = reopened.receipt(world.token, attempt);
    expect(receipt).not.toBeNull();
    expectAccepted(receipt!);
    const snapshot = reopened.snapshot(world.token, world.scope);
    expect(tableMetadataOf(snapshot.state).rowIds).toHaveLength(2);
    expect(
      snapshot.events.filter((event) => event.attemptId === attempt.attemptId),
    ).toHaveLength(1);

    const again = expectAccepted(reopened.submit(world.token, attempt));
    expect(canonical(again)).toBe(canonical(receipt!));
    const after = reopened.snapshot(world.token, world.scope);
    expect(tableMetadataOf(after.state).rowIds).toHaveLength(2);
    expect(
      after.events.filter((event) => event.attemptId === attempt.attemptId),
    ).toHaveLength(1);
  });

  it("leaves the proof unused when the commit is rolled back before returning", async () => {
    const world = await createWorld(markedTableDocument());
    const client = clientFor(world);
    const before = await client.open();
    const source = clone(rowById(before.state, "r1"));
    const columnIds = [...tableMetadataOf(before.state).columnIds];

    const deleted = expectAccepted(
      (
        await client.submit({
          kind: "table.row.delete",
          tableId: "t1",
          rowId: "r1",
        })
      ).receipt,
    );
    const base = client.snapshot().cut;
    const attempt = attemptFor(
      world.auth.writerId,
      world.scope,
      base,
      rowRestore({
        tableId: "t1",
        undoOf: deleted.intentId,
        newRowId: "xr1",
        beforeId: "r2",
        sourceRow: source,
        columnIds,
      }),
    );

    expect(() =>
      world.authority.submit(world.token, attempt, {
        beforeCommit: () => {
          throw new Error("rollback");
        },
      }),
    ).toThrow("rollback");

    const rolledBack = world.authority.snapshot(world.token, world.scope);
    expect(tableMetadataOf(rolledBack.state).rowIds).toHaveLength(1);
    expect(
      rolledBack.events.filter(
        (event) => event.attemptId === attempt.attemptId,
      ),
    ).toHaveLength(0);
    const witness = world.authority.store.get(
      "authority.undo",
      witnessKey(world.scope, world.auth.writerId, deleted.intentId),
    ) as { usedBy: string | null } | null;
    expect(witness).not.toBeNull();
    expect(witness?.usedBy).toBeNull();

    expectAccepted(await client.provider.submit(attempt));
    const after = world.authority.snapshot(world.token, world.scope);
    expect(tableMetadataOf(after.state).rowIds).toHaveLength(2);
  });

  it("retains the exact unknown intent raw after a real lost acknowledgement and reconciles it", async () => {
    const world = await createWorld(plainTextDocument("hello"));
    const inner = new HttpSharedProvider(world.url, world.token);
    const provider = new LostAckProvider(inner);
    const client = clientFor(world, undefined, provider);
    await client.open();

    const command: Command = {
      kind: "text",
      blockId: "p1",
      from: 5,
      to: 5,
      text: "!",
      before: "hello",
    };
    await expect(client.submit(command)).rejects.toThrow("LOST_ACK");

    const entries = client.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.state).toBe("UNKNOWN");
    expect(entry.attempts[0]?.state).toBe("UNKNOWN");
    expect(entry.raw).toBe(canonical(entry.intent));
    expect(entry.raw).toContain('"kind":"text"');
    expect(client.canWrite()).toBe(false);
    expect(
      parseRecovery(client.recover()).queue.some(
        (queued) => queued.raw === entry.raw,
      ),
    ).toBe(true);

    await client.reconcile();
    const recovered = client.entries()[0];
    expect(recovered.state).toBe("CLIENT_RECEIPT_DURABLE");
    expect(recovered.attempts[0]?.state).toBe("ACCEPTED");
    expect(client.canWrite()).toBe(true);
    const snapshot = client.snapshot();
    expect(textOf(locate(snapshot.state.document, "p1").node)).toBe("hello!");
  });

  it("rejects a stale block delete that would erase a concurrently inserted KEEP and accepts a latest base delete", async () => {
    const world = await createWorld(blockDocument());
    const owner = clientFor(world);
    await owner.open();

    const otherIdentity = await addEditor(world, "user2", "device2");
    const other = clientFor(world, otherIdentity);
    await other.open();
    expectAccepted(
      (
        await other.submit({
          kind: "block.insert",
          parentId: "b1",
          beforeId: null,
          node: paragraph("keep", [textNode("KEEP")]),
        })
      ).receipt,
    );

    const conflict = await owner.submit({
      kind: "block.delete",
      blockId: "b1",
    });
    expectRejected(conflict.receipt, "DELETE_CONFLICT");
    const retained = owner
      .entries()
      .find((entry) => entry.intent.intentId === conflict.receipt.intentId);
    expect(retained).toBeDefined();
    expect(retained?.state).toBe("REJECTED");
    expect(retained?.raw).toBe(canonical(retained!.intent));
    expect(
      parseRecovery(owner.recover()).queue.some(
        (queued) => queued.raw === retained!.raw,
      ),
    ).toBe(true);
    owner.archive(conflict.receipt.intentId);

    const success = expectAccepted(
      (
        await owner.submit({
          kind: "block.delete",
          blockId: "p2",
        })
      ).receipt,
    );
    expect(() => locate(owner.snapshot().state.document, "p2")).toThrow(
      CollaborationError,
    );
    const blockquote = locate(owner.snapshot().state.document, "b1").node;
    expect(allIds(blockquote)).toContain("keep");
  });

  it("undoes only the locally applied substring after a remote prefix rebase", async () => {
    const world = await createWorld(plainTextDocument("hello world"));
    const owner = clientFor(world);
    await owner.open();
    const otherIdentity = await addEditor(world, "user2", "device2");
    const other = clientFor(world, otherIdentity);
    await other.open();

    expectAccepted(
      (
        await other.submit({
          kind: "text",
          blockId: "p1",
          from: 0,
          to: 0,
          text: "R",
          before: "hello world",
        })
      ).receipt,
    );
    expectAccepted(
      (
        await owner.submit({
          kind: "text",
          blockId: "p1",
          from: 0,
          to: 5,
          text: "HI",
          before: "hello world",
        })
      ).receipt,
    );
    expect(textOf(locate(owner.snapshot().state.document, "p1").node)).toBe(
      "RHI world",
    );

    const undo = await owner.historyStep("undo");
    expectAccepted(undo.receipt);
    expect(textOf(locate(undo.snapshot.state.document, "p1").node)).toBe(
      "Rhello world",
    );
  });

  it("refuses to undo deletion of marked text without flattening the remaining marks", async () => {
    const world = await createWorld(markedTextDocument());
    const client = clientFor(world);
    const before = await client.open();
    const beforeText = textOf(locate(before.state.document, "p1").node);
    expect(beforeText).toBe("plain BOLD mid KEEP");

    const deleted = expectAccepted(
      (
        await client.submit({
          kind: "text",
          blockId: "p1",
          from: 6,
          to: 10,
          text: "",
          before: beforeText,
        })
      ).receipt,
    );
    const afterDelete = client.snapshot();
    expect(textOf(locate(afterDelete.state.document, "p1").node)).toBe(
      "plain  mid KEEP",
    );

    await expect(client.historyStep("undo")).rejects.toMatchObject({
      code: "HISTORY_UNSUPPORTED",
    });
    const afterRefusal = client.snapshot();
    expect(afterRefusal.cut.seq).toBe(deleted.cut.seq);
    const node = locate(afterRefusal.state.document, "p1").node;
    expect(textOf(node)).toBe("plain  mid KEEP");
    const keep = textNodes(node).find((candidate) => candidate.text === "KEEP");
    expect(keep?.marks?.map((mark) => mark.type)).toContain("bold");
    expect(textNodes(node).some((candidate) => candidate.text === "BOLD")).toBe(
      false,
    );
  });
});
