import { describe, expect, it } from "vitest";
import {
  blankDoc,
  type Page,
  type RecordProjection,
} from "../src/shared/types";
import { PendingEdits } from "../src/renderer/pending-edits";
import {
  RecordSaveCoordinator,
  type RecordSaveRequest,
} from "../src/renderer/record-save-coordinator";

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
function page(value: RecordProjection): Page {
  return {
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
}

function snapshot(value: RecordProjection = record()) {
  return { page: page(value), record: value };
}

describe("trusted owner-bound list record", () => {
  it("rejects ACKs that alter untouched projection fields and retains later input", async () => {
    const base = { ...record(), values: { status: "old", keep: "untouched", remove: "old" } };
    const correct = { ...base, revision: 5, values: { status: "new", keep: "untouched" } };
    const variants = [
      { ...correct, values: { status: "new" } },
      { ...correct, values: { ...correct.values, extra: "unexpected" } },
      { ...correct, values: { ...correct.values, keep: "external" } },
      { ...correct, values: { ...correct.values, remove: "old" } },
      { ...correct, title: "unexpected title" },
      { ...correct, icon: "unexpected icon" },
    ];
    for (const badAck of variants) {
      const edits = new PendingEdits();
      const response = deferred<RecordProjection>();
      const started = deferred<void>();
      const save = new RecordSaveCoordinator(edits, () => {
        started.resolve();
        return response.promise;
      });
      await save.bindListRecord("record", "db", base, async () => snapshot(base));
      const first = save.enqueueBound("db", "record", 4, { values: { status: "new", remove: null } });
      const pending = save.flush("record", first);
      await started.promise;
      const later = save.enqueueBound("db", "record", 4, { title: "later input" });
      response.resolve(badAck);
      await expect(pending).rejects.toThrow("Record ACK differs from trusted base");
      expect(edits.snapshotRecords("record").map((entry) => entry.seq)).toEqual([first, later]);
      expect(save.lastAcknowledged("record")).toEqual(base);
      expect(edits.failed.has("record")).toBe(true);
    }
  });

  it("advances a trusted base only after an exact projection ACK", async () => {
    const base = { ...record(), values: { status: "old", keep: "untouched", remove: "old" } };
    const calls: RecordSaveRequest[] = [];
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async (request) => {
      calls.push(request);
      return calls.length === 1
        ? { ...base, revision: 5, values: { status: "new", keep: "untouched" } }
        : { ...base, revision: 6, title: "later", values: { status: "new", keep: "untouched" } };
    });
    await save.bindListRecord("record", "db", base, async () => snapshot(base));
    const first = save.enqueueBound("db", "record", 4, { values: { status: "new", remove: null } });
    await save.flush("record", first);
    const second = save.enqueueBound("db", "record", 5, { title: "later" });
    await save.flush("record", second);
    expect(calls.map((request) => request.revision)).toEqual([4, 5]);
    expect(save.lastAcknowledged("record")).toMatchObject({ revision: 6, title: "later", values: { status: "new", keep: "untouched" } });
    expect(edits.hasAny("record")).toBe(false);
  });

  it("binds the exact displayed record from its owner and validates the first ACK owner", async () => {
    const edits = new PendingEdits();
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      calls.push(request);
      return { ...record(5), title: "changed", databasePageId: "other" };
    });
    const observed = record();
    const bound = await save.bindListRecord(
      "record",
      "db",
      observed,
      async (id) => {
        expect(id).toBe("record");
        return snapshot();
      },
    );
    expect(bound).toEqual(observed);
    const seq = save.enqueueBound("db", "record", 4, { title: "changed" });
    await expect(save.flush("record", seq)).rejects.toThrow(
      "Invalid record ACK",
    );
    expect(calls).toHaveLength(1);
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq, observedKnown: true, patch: { title: "changed" } },
    ]);
    expect(edits.failed.has("record")).toBe(true);
    expect(save.lastAcknowledged("record")).toEqual(observed);
  });

  it("requires live membership and rejects wrong owner, stale display, Page mismatches or deleted records", async () => {
    const variants = [
      {
        displayed: record(),
        value: snapshot({ ...record(), databasePageId: "other" }),
      },
      { displayed: record(3), value: snapshot(record(4)) },
      {
        displayed: record(),
        value: snapshot({ ...record(), values: { status: "external" } }),
      },
      {
        displayed: record(),
        value: { ...snapshot(), page: { ...page(record()), id: "other" } },
      },
      {
        displayed: record(),
        value: { ...snapshot(), page: { ...page(record()), revision: 9 } },
      },
      {
        displayed: record(),
        value: { ...snapshot(), record: { ...record(), deletedAt: 10 } },
      },
    ];
    for (const test of variants) {
      const edits = new PendingEdits();
      const save = new RecordSaveCoordinator(edits, async () => record());
      await expect(
        save.bindListRecord(
          "record",
          "db",
          test.displayed,
          async () => test.value,
        ),
      ).rejects.toThrow();
      expect(save.lastAcknowledged("record")).toBeUndefined();
      expect(edits.size).toBe(0);
    }
  });

  it("retains unknown edits received during bind and refuses adoption after the read completes", async () => {
    const edits = new PendingEdits();
    const read = deferred<ReturnType<typeof snapshot>>();
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      calls.push(request);
      return record(5);
    });
    const reading = save.bindListRecord(
      "record",
      "db",
      record(),
      () => read.promise,
    );
    const rejected = expect(reading).rejects.toThrow(
      "existing, pending or failed",
    );
    const seq = save.enqueueBound("db", "record", 4, {
      values: { status: "draft" },
    });
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq, observedKnown: false, patch: { values: { status: "draft" } } },
    ]);
    expect(edits.failed.has("record")).toBe(true);
    read.resolve(snapshot());
    await rejected;
    await expect(save.flush("record", seq)).rejects.toThrow(
      "binding unavailable",
    );
    expect(calls).toHaveLength(0);
    expect(() => edits.snapshot()).toThrow("Page-only recovery");
  });

  it("refuses binding when Page, record, settings or failure already exist", async () => {
    for (const add of [
      (edits: PendingEdits) => edits.add("record", { doc: blankDoc() }),
      (edits: PendingEdits) =>
        edits.addRecord("record", 4, { title: "draft" }, false),
      (edits: PendingEdits) => edits.addValues("record", { status: "draft" }),
      (edits: PendingEdits) => edits.failed.add("record"),
    ]) {
      const edits = new PendingEdits();
      add(edits);
      const save = new RecordSaveCoordinator(edits, async () => record());
      let reads = 0;
      await expect(
        save.bindListRecord("record", "db", record(), async () => {
          reads++;
          return snapshot();
        }),
      ).rejects.toThrow("existing, pending or failed");
      expect(reads).toBe(0);
    }
  });

  it("does not treat list binding as an installed document and retains a premature Page edit", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    await save.bindListRecord("record", "db", record(), async () => snapshot());
    const seq = save.enqueueBoundPage("db", "record", 4, { doc: blankDoc() });
    expect(edits.snapshotPages()).toMatchObject([
      { seq, observedKnown: false },
    ]);
    await expect(
      save.flushPage("record", 4, seq, async () => page(record(5))),
    ).rejects.toThrow();
    expect(edits.has("record", seq)).toBe(true);
    expect(edits.failed.has("record")).toBe(true);
  });

  it("permits Page editing only after a full matching record read and Editor installation", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => record(5));
    await save.bindListRecord("record", "db", record(), async () => snapshot());
    const fresh = await save.resync("record", "db", async () => ({
      page: page(record()),
      record: record(),
    }));
    save.confirmResync("record", fresh.token, fresh.page, fresh.page.doc);
    const seq = save.enqueueBoundPage("db", "record", 4, {
      title: "body title",
    });
    await expect(
      save.flushPage("record", 4, seq, async (request) => ({
        ...fresh.page,
        title: String(request.patch.title),
        revision: 5,
      })),
    ).resolves.toEqual({ id: "record", revision: 5 });
    expect(edits.hasAny("record")).toBe(false);
  });

  it("retains later record values when a Page ACK invalidates the trusted projection", async () => {
    const edits = new PendingEdits();
    const requests: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      requests.push(request);
      return { ...record(6), title: "page title", values: { status: "local" } };
    });
    await save.bindListRecord("record", "db", record(), async () => snapshot());
    const fresh = await save.resync("record", "db", async () => ({
      page: page(record()),
      record: record(),
    }));
    save.confirmResync("record", fresh.token, fresh.page, fresh.page.doc);
    const pageSeq = save.enqueueBoundPage("db", "record", 4, {
      title: "page title",
    });
    const valueSeq = save.enqueueBound("db", "record", 4, {
      values: { status: "local" },
    });
    expect(valueSeq).toBeGreaterThan(pageSeq);
    await save.flushPage("record", 4, pageSeq, async (request) => ({
      ...fresh.page,
      title: String(request.patch.title),
      revision: 5,
    }));
    expect(edits.snapshotRecords("record")).toMatchObject([{ seq: valueSeq }]);
    await expect(save.flush("record", valueSeq)).rejects.toThrow("Trusted record base unavailable");
    expect(requests).toEqual([]);
    expect(edits.snapshotRecords("record")).toMatchObject([{ seq: valueSeq, patch: { values: { status: "local" } } }]);
  });

  it("refuses a list bind while a different record write is in flight", async () => {
    const edits = new PendingEdits();
    const response = deferred<RecordProjection>();
    const started = deferred<void>();
    const save = new RecordSaveCoordinator(edits, () => {
      started.resolve(undefined);
      return response.promise;
    });
    await save.bindListRecord("record", "db", record(), async () => snapshot());
    const seq = save.enqueueBound("db", "record", 4, { title: "first" });
    const writing = save.flush("record", seq);
    await started.promise;
    const other = { ...record(), pageId: "other" };
    await expect(
      save.bindListRecord("other", "db", other, async () => snapshot(other)),
    ).rejects.toThrow("serialization queue");
    response.resolve({ ...record(5), title: "first" });
    await writing;
  });

  it("keeps an edit submitted before any trusted bind, without sending it", async () => {
    const edits = new PendingEdits();
    const requests: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      requests.push(request);
      return record(5);
    });
    const seq = save.enqueueBound("db", "record", 4, {
      title: "offline draft",
    });
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq, observedKnown: false, patch: { title: "offline draft" } },
    ]);
    await expect(save.flush("record", seq)).rejects.toThrow(
      "binding unavailable",
    );
    expect(requests).toHaveLength(0);
    expect(() => edits.discardThrough(seq)).toThrow("Record commands");
  });

  it("retains an unbound or wrong-owner App input and blocks a late stale revision", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async (request) => ({
      ...record(request.revision + 1),
      title: "first",
    }));
    await save.bindListRecord("record", "db", record(), async () => snapshot());
    const first = save.enqueueBound("db", "record", 4, { title: "first" });
    await save.flush("record", first);
    const stale = save.enqueueBound("db", "record", 4, { title: "late" });
    await expect(save.flush("record", stale)).rejects.toThrow(
      "Unknown external record revision",
    );
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq: stale, observedKnown: false },
    ]);
    const otherEdits = new PendingEdits();
    const other = new RecordSaveCoordinator(otherEdits, async () => record(5));
    await other.bindListRecord("record", "db", record(), async () =>
      snapshot(),
    );
    const wrong = other.enqueueBound("other", "record", 4, {
      title: "must retain",
    });
    await expect(other.flush("record", wrong)).rejects.toThrow(
      "binding unavailable",
    );
    expect(otherEdits.snapshotRecords("record")).toMatchObject([
      { seq: wrong, observedKnown: false },
    ]);
  });
});
