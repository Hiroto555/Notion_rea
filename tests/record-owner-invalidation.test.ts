import { describe, expect, it } from "vitest";
import {
  blankDoc,
  type Page,
  type RecordProjection,
} from "../src/shared/types";
import { PendingEdits } from "../src/renderer/pending-edits";
import { RecordSaveCoordinator } from "../src/renderer/record-save-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function record(revision = 4): RecordProjection {
  return {
    pageId: "record",
    databasePageId: "db",
    revision,
    title: "original",
    icon: "📄",
    values: { status: "old" },
    deletedAt: null,
  };
}
function snapshot(value = record()) {
  const page: Page = {
    id: value.pageId,
    schemaVersion: 1,
    parentId: null,
    title: value.title,
    icon: value.icon,
    cover: "",
    position: 0,
    doc: blankDoc(),
    kind: "page",
    database: null,
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    revision: value.revision,
    deletedAt: null,
  };
  return { page, record: value };
}
async function boundEditor(save: RecordSaveCoordinator) {
  await save.bindListRecord("record", "db", record(), async () => snapshot());
  const fresh = await save.resync("record", "db", async () => snapshot());
  save.confirmResync("record", fresh.token, fresh.page, fresh.page.doc);
  return fresh;
}

describe("owner provenance and Editor invalidation", () => {
  it("guards legacy unbound Page drafts from Page-only recovery", () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    const seq = save.enqueuePage("record", 4, { title: "draft" });
    expect(edits.snapshotPages()[0]).toMatchObject({
      seq,
      recoveryKind: "record",
    });
    expect(() => edits.snapshot()).toThrow();
    expect(() => edits.discardThrough(seq)).toThrow();
    expect(edits.has("record", seq)).toBe(true);
  });
  it("retains each unbound record and Page input's expected owner and generation, refusing Page-only recovery", () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    const a = save.enqueueBound("db-a", "record", 4, { title: "A" });
    const b = save.enqueueBound("db-b", "record", 4, {
      values: { status: "B" },
    });
    const c = save.enqueueBoundPage("db-c", "record", 4, { doc: blankDoc() });
    expect([a, b, c]).toEqual([1, 2, 3]);
    expect(edits.snapshotRecords("record")).toMatchObject([
      {
        seq: a,
        expectedOwnerId: "db-a",
        observedKnown: false,
        patch: { title: "A" },
      },
      {
        seq: b,
        expectedOwnerId: "db-b",
        observedKnown: false,
        patch: { values: { status: "B" } },
      },
    ]);
    expect(edits.snapshotPages()).toMatchObject([
      { seq: c, expectedOwnerId: "db-c", observedKnown: false },
    ]);
    expect(() => edits.snapshot()).toThrow("Page-only recovery");
    expect(() => edits.discardThrough(c)).toThrow();
    expect(edits.size).toBe(3);
  });

  it("retains input owners while bind is in flight and rejects the bind without dropping drafts", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    const read = deferred<ReturnType<typeof snapshot>>();
    const binding = save.bindListRecord(
      "record",
      "db",
      record(),
      () => read.promise,
    );
    const rejected = expect(binding).rejects.toThrow(
      "existing, pending or failed",
    );
    const r = save.enqueueBound("db", "record", 4, { title: "record draft" });
    const p = save.enqueueBoundPage("wrong-db", "record", 4, {
      doc: blankDoc(),
    });
    read.resolve(snapshot());
    await rejected;
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq: r, expectedOwnerId: "db", observedKnown: false },
    ]);
    expect(edits.snapshotPages()).toMatchObject([
      { seq: p, expectedOwnerId: "wrong-db", observedKnown: false },
    ]);
    expect(edits.failed.has("record")).toBe(true);
  });

  it("stores owner for a successful bound entry and the caller's different owner for rejected input", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    await boundEditor(save);
    const correct = save.enqueueBound("db", "record", 4, { title: "known" });
    const wrong = save.enqueueBound("wrong-db", "record", 4, {
      values: { status: "unknown" },
    });
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq: correct, expectedOwnerId: "db", observedKnown: true },
      { seq: wrong, expectedOwnerId: "wrong-db", observedKnown: false },
    ]);
    await expect(save.flush("record", wrong)).rejects.toThrow(
      "binding unavailable",
    );
    expect(edits.snapshotRecords("record")).toHaveLength(2);
  });

  it("keeps the legacy PendingEdits API and only permits Page-only recovery for unowned Page inputs", () => {
    const edits = new PendingEdits();
    const legacyPage = edits.addObservedPage(
      "page",
      1,
      { title: "legacy" },
      true,
    );
    const legacyRecord = edits.addRecord(
      "record",
      1,
      { title: "legacy" },
      true,
    );
    expect(edits.snapshotPages()).toEqual([
      {
        seq: legacyPage,
        id: "page",
        observedRevision: 1,
        observedKnown: true,
        patch: { title: "legacy" },
      },
    ]);
    expect(edits.snapshotRecords()).toEqual([
      {
        seq: legacyRecord,
        id: "record",
        observedRevision: 1,
        observedKnown: true,
        patch: { title: "legacy" },
      },
    ]);
    edits.ackRecord("record", legacyRecord);
    expect(edits.snapshot()).toHaveLength(1);
    edits.addObservedPage("record", 4, { doc: blankDoc() }, false, "db");
    expect(() => edits.snapshot()).toThrow("Page-only recovery");
    expect(() => edits.discardThrough(edits.sequence)).toThrow(
      "Record Page drafts",
    );
    expect(edits.has("page", legacyPage)).toBe(true);
  });

  it("invalidates during a Page write without dropping the acknowledged cutoff or a later pending body", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    const fresh = await boundEditor(save);
    const response = deferred<Page>();
    const started = deferred<void>();
    const first = save.enqueueBoundPage("db", "record", 4, { title: "saved" });
    const writing = save.flushPage("record", 4, first, () => {
      started.resolve(undefined);
      return response.promise;
    });
    await started.promise;
    const later = save.enqueueBoundPage("db", "record", 4, { doc: blankDoc() });
    save.invalidateEditor("db", "record");
    expect(edits.snapshotPages()).toMatchObject([
      { seq: first, expectedOwnerId: "db" },
      { seq: later, expectedOwnerId: "db" },
    ]);
    response.resolve({ ...fresh.page, title: "saved", revision: 5 });
    await writing;
    expect(edits.snapshotPages()).toMatchObject([
      { seq: later, expectedOwnerId: "db" },
    ]);
    await expect(
      save.flushPage("record", 5, later, async () => fresh.page),
    ).rejects.toThrow("revision or order conflict");
    expect(edits.has("record", later)).toBe(true);
    expect(() => edits.snapshot()).toThrow("Page-only recovery");
  });

  it("cancels a pending resync ticket on unmount, rejects the old confirm, and permits a new read", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    await save.bindListRecord("record", "db", record(), async () => snapshot());
    const fresh = await save.resync("record", "db", async () => snapshot());
    expect(() => save.invalidateEditor("wrong-db", "record")).toThrow(
      "owner mismatch",
    );
    save.invalidateEditor("db", "record");
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, fresh.page.doc),
    ).toThrow("ticket mismatch");
    const retry = await save.resync("record", "db", async () => snapshot());
    save.confirmResync("record", retry.token, retry.page, retry.page.doc);
    const seq = save.enqueueBoundPage("db", "record", 4, {
      title: "new editor",
    });
    expect(edits.snapshotPages()).toMatchObject([
      { seq, expectedOwnerId: "db", observedKnown: true },
    ]);
  });

  it("rejects a resync read that completes after unmount, even when no lane existed yet", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    const pending = deferred<ReturnType<typeof snapshot>>();
    const reading = save.resync("record", "db", () => pending.promise);
    const rejected = expect(reading).rejects.toThrow(
      "invalidated during resync",
    );
    save.invalidateEditor("db", "record");
    pending.resolve(snapshot());
    await rejected;
    expect(save.lastAcknowledged("record")).toBeUndefined();
    const fresh = await save.resync("record", "db", async () => snapshot());
    save.confirmResync("record", fresh.token, fresh.page, fresh.page.doc);
  });
});
