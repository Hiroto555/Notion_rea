import { describe, expect, it } from "vitest";
import {
  RecordSaveCoordinator,
  type RecordSaveRequest,
  type RecordResyncSnapshot,
} from "../src/renderer/record-save-coordinator";
import {
  blankDoc,
  emptyDatabase,
  type Doc,
  type RecordProjection,
} from "../src/shared/types";
import { PendingEdits } from "../src/renderer/pending-edits";
import { documentSchema } from "../src/shared/editor-schema";
import { BLOCK_TYPES } from "../src/editor/block-identity";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (failure: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function projection(
  revision: number,
  title = "Original",
  values: Record<string, string | number | boolean> = {
    status: "old",
    due: "today",
  },
): RecordProjection {
  return {
    pageId: "record",
    databasePageId: "db",
    revision,
    title,
    icon: "📄",
    values,
    deletedAt: null,
  };
}

function snapshot(
  record: RecordProjection,
  doc: Doc = blankDoc(),
): RecordResyncSnapshot {
  return {
    record,
    page: {
      id: record.pageId,
      schemaVersion: 1,
      parentId: null,
      title: record.title,
      icon: record.icon,
      cover: "",
      position: 0,
      doc,
      kind: "page",
      database: null,
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
      revision: record.revision,
      deletedAt: null,
    },
  };
}
async function install(
  save: RecordSaveCoordinator,
  value: RecordResyncSnapshot,
) {
  const read = await save.resync("record", "db", async () => value);
  save.confirmResync("record", read.token, read.page, read.page.doc);
  return read;
}

describe("record save coordinator", () => {
  it("retains an ownerless draft and never sends it", async () => {
    const edits = new PendingEdits();
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      calls.push(request);
      return projection(1, "local");
    });
    const seq = save.enqueue("record", 0, { title: "local" });
    await expect(save.flush("record", seq)).rejects.toThrow("Unknown external record revision");
    expect(calls).toEqual([]);
    expect(edits.snapshotRecords("record")).toMatchObject([{ seq, patch: { title: "local" } }]);
  });
  it("retains a simultaneous title and per-key values patch, then sends it atomically without returning a doc", async () => {
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(
      new PendingEdits(),
      async (request) => {
        calls.push(request);
        return {
          ...projection(3, "Edited", { status: "new" }),
          doc: { type: "doc" },
        } as RecordProjection;
      },
    );
    const patch = { title: "Edited", values: { status: "new", due: null } };
    save.enqueue("record", 2, patch, "db");
    patch.values.status = "caller mutated";
    expect(save.pending("record")[0].patch).toEqual({
      title: "Edited",
      values: { status: "new", due: null },
    });
    const ack = await save.flush("record");
    expect(calls).toEqual([
      {
        type: "record:patch",
        pageId: "record",
        databasePageId: "db",
        revision: 2,
        patch: { title: "Edited", values: { status: "new", due: null } },
      },
    ]);
    expect(ack).toMatchObject({
      revision: 3,
      title: "Edited",
      values: { status: "new" },
    });
    expect(ack).not.toHaveProperty("doc");
    expect(save.pending("record")).toEqual([]);
  });

  it("preserves a newer edit while the previous ACK is delayed and rebases it only on that ACK", async () => {
    const first = deferred<RecordProjection>(),
      second = deferred<RecordProjection>(),
      started = deferred<void>(),
      firstStarted = deferred<void>();
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(new PendingEdits(), (request) => {
      calls.push(request);
      if (calls.length === 1) {
        firstStarted.resolve(undefined);
        return first.promise;
      }
      started.resolve(undefined);
      return second.promise;
    });
    const firstSeq = save.enqueue("record", 7, { title: "First" }, "db");
    const draining = save.flush("record");
    await firstStarted.promise;
    const latestSeq = save.enqueue("record", 7, {
      title: "Latest",
      values: { due: null },
    }, "db");
    const alsoDraining = save.flush("record");
    expect(save.pending("record").map((entry) => entry.seq)).toEqual([
      firstSeq,
      latestSeq,
    ]);
    first.resolve(projection(8, "First"));
    await started.promise;
    expect(save.pending("record").map((entry) => entry.seq)).toEqual([
      latestSeq,
    ]);
    expect(calls[1]).toMatchObject({
      revision: 8,
      patch: { title: "Latest", values: { due: null } },
    });
    second.resolve(projection(9, "Latest", { status: "old" }));
    expect((await draining)?.title).toBe("First");
    expect((await alsoDraining)?.revision).toBe(9);
    expect(save.pending("record")).toEqual([]);
  });

  it("retains a failed IPC patch, blocks automatic retries and retries at the unchanged revision", async () => {
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(
      new PendingEdits(),
      async (request) => {
        calls.push(request);
        if (calls.length === 1) throw new Error("write failed");
        return projection(11, "Retry");
      },
    );
    save.enqueue("record", 10, { title: "Retry" }, "db");
    await expect(save.flush("record")).rejects.toThrow("write failed");
    expect(save.pending("record")).toHaveLength(1);
    expect(save.error("record")?.message).toBe("write failed");
    await expect(save.flush("record")).rejects.toThrow("write failed");
    expect(calls).toHaveLength(1);
    expect((await save.retry("record"))?.revision).toBe(11);
    expect(calls.map((call) => call.revision)).toEqual([10, 10]);
    expect(save.pending("record")).toHaveLength(0);
  });

  it("rejects an unknown externally observed revision and retains its patch without sending it", async () => {
    const first = deferred<RecordProjection>(),
      started = deferred<void>(),
      calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(new PendingEdits(), (request) => {
      calls.push(request);
      started.resolve(undefined);
      return first.promise;
    });
    save.enqueue("record", 4, { title: "First" }, "db");
    const draining = save.flush("record");
    await started.promise;
    const seq = save.enqueue("record", 5, {
      values: { status: "unknown observed" },
    }, "db");
    const subsequent = save.flush("record", seq);
    const rejection = expect(subsequent).rejects.toThrow(
      "Unknown external record revision",
    );
    first.resolve(projection(5, "First"));
    await expect(draining).resolves.toMatchObject({ revision: 5 });
    await rejection;
    expect(calls).toHaveLength(1);
    expect(save.pending("record")).toMatchObject([
      {
        seq,
        observedRevision: 5,
        observedKnown: false,
        patch: { values: { status: "unknown observed" } },
      },
    ]);
    await expect(save.retry("record")).rejects.toThrow(
      "Unknown external record revision",
    );
    expect(calls).toHaveLength(1);
  });

  it("keeps representable content that IPC rejects for exceeding a storage limit", async () => {
    const save = new RecordSaveCoordinator(new PendingEdits(), async () => {
      throw new Error("title exceeds 500 characters");
    });
    const title = "x".repeat(501);
    save.enqueue("record", 0, { title }, "db");
    await expect(save.flush("record")).rejects.toThrow("title exceeds");
    expect(save.pending("record")[0].patch.title).toBe(title);
  });

  it("retains changes when storage rejects stale revision or returns an inconsistent ACK", async () => {
    const stale = new RecordSaveCoordinator(new PendingEdits(), async () => {
      throw new Error("保存の競合");
    });
    stale.enqueue("record", 1, { values: { due: null } }, "db");
    await expect(stale.flush("record")).rejects.toThrow("競合");
    expect(stale.pending("record")[0].patch).toEqual({ values: { due: null } });
    const mismatch = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(9, "wrong"),
    );
    mismatch.enqueue("record", 3, { title: "local" }, "db");
    await expect(mismatch.flush("record")).rejects.toThrow(
      "Invalid record ACK",
    );
    expect(mismatch.pending("record")).toHaveLength(1);
    expect(mismatch.lastAcknowledged("record")).toBeUndefined();
  });

  it("respects the captured cutoff when App schedules a Page action between record flushes", async () => {
    const first = deferred<RecordProjection>();
    const started = deferred<void>();
    const order: string[] = [];
    const save = new RecordSaveCoordinator(new PendingEdits(), (request) => {
      order.push("record:" + request.patch.title);
      if (request.patch.title === "first") {
        started.resolve(undefined);
        return first.promise;
      }
      return Promise.resolve(projection(2, "second"));
    });
    let appQueue: Promise<unknown> = Promise.resolve();
    const one = save.enqueue("record", 0, { title: "first" }, "db");
    appQueue = appQueue.then(() => save.flush("record", one));
    await started.promise;
    appQueue = appQueue.then(() => {
      order.push("page-action");
    });
    const two = save.enqueue("record", 0, { title: "second" }, "db");
    appQueue = appQueue.then(() => save.flush("record", two));
    first.resolve(projection(1, "first"));
    await appQueue;
    expect(order).toEqual(["record:first", "page-action", "record:second"]);
    expect(save.pending("record")).toEqual([]);
  });

  it("rejects overlapping cross-record flushes so App's queue remains the only scheduler", async () => {
    const first = deferred<RecordProjection>();
    const started = deferred<void>();
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(new PendingEdits(), (request) => {
      calls.push(request);
      if (request.pageId === "record") {
        started.resolve(undefined);
        return first.promise;
      }
      return Promise.resolve({ ...projection(3, "Second"), pageId: "other" });
    });
    save.enqueue("record", 0, { title: "First" }, "db");
    const run1 = save.flush("record");
    await started.promise;
    save.enqueue("other", 2, { title: "Second" }, "db");
    await expect(save.flush("other")).rejects.toThrow(
      "App serialization queue",
    );
    expect(calls).toHaveLength(1);
    expect(save.pending("other")).toHaveLength(1);
    first.resolve(projection(1, "First"));
    await run1;
    await save.flush("other");
    expect(calls.map((call) => call.pageId)).toEqual(["record", "other"]);
    expect(save.pending("record")).toHaveLength(0);
    expect(save.pending("other")).toHaveLength(0);
  });
});

describe("shared PendingEdits ownership", () => {
  it("uses the shared generation and a record ACK cannot clear an earlier unsaved Page document", () => {
    const edits = new PendingEdits();
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "unsaved" }] },
      ],
    };
    const docSeq = edits.add("record", { doc });
    const save = new RecordSaveCoordinator(edits, async () =>
      projection(2, "saved", { status: "new" }),
    );
    const recordSeq = save.enqueue("record", 1, {
      title: "saved",
      values: { status: "new", due: null },
    }, "db");
    expect(recordSeq).toBe(docSeq + 1);
    expect(edits.snapshotRecords("record")[0].patch).toEqual({
      title: "saved",
      values: { status: "new", due: null },
    });
    edits.ackRecord("record", recordSeq);
    expect(edits.patch("record").doc).toEqual(doc);
    expect(edits.has("record", docSeq)).toBe(true);
    expect(edits.hasRecord("record")).toBe(false);
  });

  it("blocks record IPC behind earlier pending doc and fails closed before Page-only recovery", async () => {
    const edits = new PendingEdits();
    const doc = { type: "doc", content: [{ type: "paragraph" }] };
    const docSeq = edits.add("record", { doc });
    let calls = 0;
    const save = new RecordSaveCoordinator(edits, async () => {
      calls++;
      return projection(2, "saved");
    });
    const recordSeq = save.enqueue("record", 1, { title: "saved" }, "db");
    expect(() => edits.snapshot()).toThrow(
      "Page-only recovery cannot include pending record",
    );
    expect(() => edits.discardThrough(recordSeq)).toThrow(
      "Record commands have not been included in recovery",
    );
    await expect(save.flush("record", recordSeq)).rejects.toThrow(
      "Earlier page or value edits are pending",
    );
    expect(calls).toBe(0);
    expect(edits.patch("record").doc).toEqual(doc);
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq: recordSeq, patch: { title: "saved" } },
    ]);
    expect(edits.failed.has("record")).toBe(true);
    edits.ack("record", docSeq);
    expect((await save.retry("record", recordSeq))?.title).toBe("saved");
    expect(edits.size).toBe(0);
    expect(edits.failed.has("record")).toBe(false);
  });

  it("retains the atomic command and later Page edit when the ACK is malformed", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () =>
      projection(99, "incorrect"),
    );
    const command = save.enqueue("record", 1, {
      title: "local",
      values: { status: "new" },
    }, "db");
    const page = edits.add("record", { title: "later" });
    await expect(save.flush("record", command)).rejects.toThrow(
      "Invalid record ACK",
    );
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq: command, patch: { title: "local", values: { status: "new" } } },
    ]);
    expect(edits.has("record", page)).toBe(true);
    expect(edits.patch("record").title).toBe("later");
    expect(edits.failed.has("record")).toBe(true);
    expect(() => edits.snapshot()).toThrow("Page-only recovery");
  });

  it("retains record and Page edits when IPC fails, and exposes the record entry through the shared owner", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => {
      throw new Error("offline");
    });
    const recordSeq = save.enqueue("record", 3, {
      title: "local",
      values: { status: "new" },
    }, "db");
    const pageSeq = edits.add("record", { title: "later page title" });
    await expect(save.flush("record", recordSeq)).rejects.toThrow("offline");
    expect(edits.sequence).toBe(pageSeq);
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq: recordSeq, patch: { title: "local", values: { status: "new" } } },
    ]);
    expect(edits.patch("record").title).toBe("later page title");
    expect(edits.failed.has("record")).toBe(true);
    expect(() => edits.snapshot()).toThrow("Page-only recovery");
  });
});

describe("record and Page revision provenance", () => {
  const doc = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }],
  };
  const page = (
    id: string,
    revision: number,
    patch: Record<string, unknown> = {},
  ) =>
    ({
      id,
      revision,
      deletedAt: null,
      title: "Original",
      doc,
      ...patch,
    }) as any;

  it("rejects an input from an old UI revision when it arrives after the coordinator's own ACK", async () => {
    const edits = new PendingEdits();
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      calls.push(request);
      return projection(1, "First");
    });
    const first = save.enqueue("record", 0, { title: "First" }, "db");
    await save.flush("record", first);
    const late = save.enqueue("record", 0, { title: "stale same field" }, "db");
    await expect(save.flush("record", late)).rejects.toThrow(
      "Unknown external record revision",
    );
    expect(calls).toHaveLength(1);
    expect(edits.snapshotRecords("record")).toMatchObject([
      {
        seq: late,
        observedRevision: 0,
        observedKnown: false,
        patch: { title: "stale same field" },
      },
    ]);
    expect(edits.failed.has("record")).toBe(true);
  });

  it("accepts only its serialized Page ACK and advances an already captured record edit without replacing the document", async () => {
    const edits = new PendingEdits();
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      calls.push(request);
      return projection(9, "Original", { status: "new", due: "today" });
    });
    const pageSeq = save.enqueuePage("record", 7, { doc });
    const recordSeq = save.enqueue("record", 7, { values: { status: "new" } }, "db");
    const ready = deferred<void>(),
      response = deferred<ReturnType<typeof page>>();
    const pageSave = save.flushPage("record", 7, pageSeq, async (request) => {
      expect(request).toEqual({
        type: "update",
        id: "record",
        revision: 7,
        patch: { doc },
      });
      ready.resolve(undefined);
      return response.promise;
    });
    await ready.promise;
    await expect(save.flush("record", recordSeq)).rejects.toThrow(
      "App serialization queue",
    );
    expect(edits.patch("record").doc).toEqual(doc);
    response.resolve(page("record", 8, { doc }));
    await expect(pageSave).resolves.toEqual({ id: "record", revision: 8 });
    expect(edits.has("record")).toBe(false);
    expect(edits.snapshotRecords("record")).toHaveLength(1);
    const ack = await save.flush("record", recordSeq);
    expect(calls[0].revision).toBe(8);
    expect(ack).not.toHaveProperty("doc");
    expect(edits.size).toBe(0);
  });

  it("retains a late stale Page title instead of overwriting a newer record title", async () => {
    const edits = new PendingEdits();
    let recordCalls = 0,
      pageCalls = 0;
    const save = new RecordSaveCoordinator(edits, async () => {
      recordCalls++;
      return projection(1, "record title");
    });
    const recordSeq = save.enqueue("record", 0, { title: "record title" }, "db");
    await save.flush("record", recordSeq);
    const stalePage = save.enqueuePage("record", 0, {
      title: "stale Page title",
    });
    await expect(
      save.flushPage("record", 1, stalePage, async () => {
        pageCalls++;
        return page("record", 2, { title: "stale Page title" });
      }),
    ).rejects.toThrow("Page edit revision provenance conflict");
    expect(recordCalls).toBe(1);
    expect(pageCalls).toBe(0);
    expect(edits.patch("record").title).toBe("stale Page title");
    expect(
      edits.snapshotPages().find((entry) => entry.seq === stalePage),
    ).toMatchObject({ observedRevision: 0, observedKnown: false });
    expect(edits.failed.has("record")).toBe(true);
    const newerRecord = save.enqueue("record", 1, { title: "later" }, "db");
    await expect(save.flush("record", newerRecord)).rejects.toThrow(
      "Page edit revision provenance conflict",
    );
    expect(recordCalls).toBe(1);
    expect(edits.hasRecord("record", newerRecord)).toBe(true);
  });

  it("allows a Page edit captured during an earlier record save to follow its own ordered ACK", async () => {
    const edits = new PendingEdits();
    const first = deferred<RecordProjection>();
    const started = deferred<void>();
    const save = new RecordSaveCoordinator(edits, async () => {
      started.resolve(undefined);
      return first.promise;
    });
    const recordSeq = save.enqueue("record", 0, { title: "first" }, "db");
    const saving = save.flush("record", recordSeq);
    await started.promise;
    const pageSeq = save.enqueuePage("record", 0, { title: "second" });
    first.resolve(projection(1, "first"));
    await saving;
    const ack = await save.flushPage("record", 1, pageSeq, async (request) => {
      expect(request.revision).toBe(1);
      expect(request.patch).toEqual({ title: "second" });
      return page("record", 2, { title: "second" });
    });
    expect(ack).toEqual({ id: "record", revision: 2 });
    expect(edits.size).toBe(0);
  });

  it("allows a second Page edit captured before the first Page ACK, without clearing it", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => projection(1));
    const first = save.enqueuePage("record", 0, { title: "first" });
    const started = deferred<void>();
    const result = deferred<ReturnType<typeof page>>();
    const saving = save.flushPage("record", 0, first, async () => {
      started.resolve(undefined);
      return result.promise;
    });
    await started.promise;
    const second = save.enqueuePage("record", 0, { title: "second" });
    result.resolve(page("record", 1, { title: "first" }));
    await saving;
    expect(edits.patch("record").title).toBe("second");
    const ack = await save.flushPage("record", 1, second, async () =>
      page("record", 2, { title: "second" }),
    );
    expect(ack.revision).toBe(2);
    expect(edits.size).toBe(0);
  });

  it("blocks following record sends when Page preflight fails during an in-flight record write", async () => {
    const edits = new PendingEdits();
    const first = deferred<RecordProjection>();
    const started = deferred<void>();
    let calls = 0;
    const save = new RecordSaveCoordinator(edits, async () => {
      calls++;
      started.resolve(undefined);
      return first.promise;
    });
    const record = save.enqueue("record", 0, { title: "first" }, "db");
    const saving = save.flush("record", record);
    const failedSaving = expect(saving).rejects.toThrow(
      "App serialization queue",
    );
    await started.promise;
    const pageSeq = save.enqueuePage("record", 0, { title: "second" });
    await expect(
      save.flushPage("record", 0, pageSeq, async () => page("record", 1)),
    ).rejects.toThrow("App serialization queue");
    const later = save.enqueue("record", 0, { values: { status: "later" } }, "db");
    first.resolve(projection(1, "first"));
    await failedSaving;
    expect(edits.hasRecord("record", record)).toBe(false);
    expect(edits.hasRecord("record", later)).toBe(true);
    expect(edits.has("record", pageSeq)).toBe(true);
    expect(edits.failed.has("record")).toBe(true);
    await expect(save.flush("record", later)).rejects.toThrow(
      "App serialization queue",
    );
    expect(calls).toBe(1);
  });

  it("preserves an invalid-revision preflight failure even before a lane exists", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () =>
      projection(1, "later"),
    );
    await expect(
      save.flushPage("record", -1, 1, async () => page("record", 0)),
    ).rejects.toThrow("Invalid page write");
    expect(edits.failed.has("record")).toBe(true);
    const seq = save.enqueue("record", 0, { title: "later" }, "db");
    await expect(save.flush("record", seq)).rejects.toThrow(
      "Invalid page write",
    );
    expect(edits.hasRecord("record", seq)).toBe(true);
  });

  it("marks unproven legacy Page edits failed and blocks subsequent sends until explicitly resolved", async () => {
    const edits = new PendingEdits();
    const legacySeq = edits.add("record", { doc });
    let calls = 0;
    const save = new RecordSaveCoordinator(edits, async () => {
      calls++;
      return projection(1, "new");
    });
    await expect(
      save.flushPage("record", 0, legacySeq, async () => page("record", 1)),
    ).rejects.toThrow("Page edit revision provenance conflict");
    expect(edits.patch("record").doc).toEqual(doc);
    expect(edits.failed.has("record")).toBe(true);
    const recordSeq = save.enqueue("record", 0, { title: "new" }, "db");
    await expect(save.flush("record", recordSeq)).rejects.toThrow(
      "Page edit revision provenance conflict",
    );
    expect(calls).toBe(0);
    expect(edits.hasRecord("record", recordSeq)).toBe(true);
  });

  it("rejects database patches for a record Page before IPC, retaining the original input", async () => {
    const edits = new PendingEdits();
    let calls = 0;
    const save = new RecordSaveCoordinator(edits, async () => projection(1));
    const db = emptyDatabase();
    const seq = save.enqueuePage("record", 0, { database: db });
    await expect(
      save.flushPage("record", 0, seq, async () => {
        calls++;
        return page("record", 1);
      }),
    ).rejects.toThrow("Record Page cannot save a database patch");
    expect(calls).toBe(0);
    expect(edits.patch("record").database).toEqual(db);
    expect(edits.failed.has("record")).toBe(true);
  });

  it("rejects a newly arriving old revision after a successful Page ACK", async () => {
    const edits = new PendingEdits();
    let calls = 0;
    const save = new RecordSaveCoordinator(edits, async () => {
      calls++;
      return projection(2, "later");
    });
    const seq = save.enqueuePage("record", 0, { doc });
    await save.flushPage("record", 0, seq, async () => page("record", 1));
    const stale = save.enqueue("record", 0, { title: "stale" }, "db");
    await expect(save.flush("record", stale)).rejects.toThrow(
      "Unknown external record revision",
    );
    expect(calls).toBe(0);
    expect(edits.snapshotRecords("record")).toMatchObject([
      {
        seq: stale,
        observedRevision: 0,
        observedKnown: false,
        patch: { title: "stale" },
      },
    ]);
  });

  it("rejects wrong, out-of-order or other-page Page ACKs without dropping edits", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () =>
      projection(1, "record"),
    );
    const recordSeq = save.enqueue("record", 0, { title: "record" }, "db");
    const docSeq = save.enqueuePage("record", 0, { doc });
    let calls = 0;
    await expect(
      save.flushPage("record", 0, docSeq, async () => {
        calls++;
        return page("record", 1);
      }),
    ).rejects.toThrow("Earlier record");
    expect(calls).toBe(0);
    expect(edits.hasRecord("record", recordSeq)).toBe(true);
    expect(edits.has("record", docSeq)).toBe(true);
    await expect(save.flush("record", recordSeq)).rejects.toThrow(
      "Earlier record",
    );
    await save.retry("record", recordSeq);
    await expect(
      save.flushPage("record", 0, docSeq, async () => {
        calls++;
        return page("record", 1);
      }),
    ).rejects.toThrow("revision or order conflict");
    expect(calls).toBe(0);
    await expect(
      save.retryPage("record", 1, docSeq, async () => page("other", 2)),
    ).rejects.toThrow("identity, revision or order mismatch");
    expect(edits.has("record", docSeq)).toBe(true);
    expect(edits.failed.has("record")).toBe(true);
  });

  it("rejects a Page ACK with the wrong revision or wrong submitted content and retains every draft", async () => {
    for (const response of [
      page("record", 9),
      page("record", 1, { doc: { type: "doc", content: [] } }),
    ]) {
      const edits = new PendingEdits();
      const save = new RecordSaveCoordinator(edits, async () => projection(1));
      const seq = save.enqueuePage("record", 0, { doc });
      await expect(
        save.flushPage("record", 0, seq, async () => response),
      ).rejects.toThrow("Page acknowledgement");
      expect(edits.has("record", seq)).toBe(true);
      expect(edits.patch("record").doc).toEqual(doc);
      expect(edits.failed.has("record")).toBe(true);
    }
  });

  it("retries an acknowledged Page write only explicitly after failure, preserving pending state until then", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => projection(1));
    const seq = save.enqueuePage("record", 0, { doc });
    await expect(
      save.flushPage("record", 0, seq, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    await expect(
      save.flushPage("record", 0, seq, async () => page("record", 1)),
    ).rejects.toThrow("revision or order conflict");
    expect(edits.has("record", seq)).toBe(true);
    await expect(
      save.retryPage("record", 0, seq, async () => page("record", 1)),
    ).resolves.toEqual({ id: "record", revision: 1 });
    expect(edits.has("record", seq)).toBe(false);
    expect(edits.failed.has("record")).toBe(false);
  });

  it("retains pending Page and record edits if the Page IPC fails", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => projection(1));
    const seq = save.enqueuePage("record", 0, { doc });
    const recordSeq = save.enqueue("record", 0, { title: "pending" }, "db");
    await expect(
      save.flushPage("record", 0, seq, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(edits.patch("record").doc).toEqual(doc);
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq: recordSeq, patch: { title: "pending" } },
    ]);
    expect(edits.failed.has("record")).toBe(true);
    await expect(save.flush("record", recordSeq)).rejects.toThrow("offline");
  });
});

describe("explicit record resynchronization", () => {
  it("installs a complete same-owner snapshot before saving at its revision", async () => {
    const edits = new PendingEdits();
    const requests: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      requests.push(request);
      return projection(request.revision + 1, String(request.patch.title));
    });
    await install(save, snapshot(projection(2, "initial")));
    const first = save.enqueue("record", 2, { title: "first" }, "db");
    await save.flush("record", first);
    const external = await install(save, snapshot(projection(6, "external")));
    expect(external.record).toMatchObject({
      pageId: "record",
      databasePageId: "db",
      revision: 6,
      title: "external",
    });
    const later = save.enqueue("record", 6, { title: "after resync" }, "db");
    await save.flush("record", later);
    expect(requests.map((request) => request.revision)).toEqual([2, 6]);
    expect(edits.size).toBe(0);
  });

  it("does not accept the new revision until the external body is actually installed", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => projection(2));
    const oldDoc: Doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "old" }] },
      ],
    };
    const externalDoc: Doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "external body" }],
        },
      ],
    };
    await install(save, snapshot(projection(0), oldDoc));
    const fresh = await save.resync("record", "db", async () =>
      snapshot(projection(1), externalDoc),
    );
    expect(fresh.page.doc).toEqual(externalDoc);
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, oldDoc),
    ).toThrow("Editor document");
    expect(save.lastAcknowledged("record")?.revision).toBe(0);
    save.confirmResync("record", fresh.token, fresh.page, externalDoc);
    const edited = structuredClone(externalDoc);
    edited.content![0].content![0].text = "external body + local";
    const seq = save.enqueuePage("record", 1, { doc: edited });
    await save.flushPage("record", 1, seq, async (request) => {
      expect(request.revision).toBe(1);
      expect(request.patch.doc).toEqual(edited);
      return { ...fresh.page, doc: edited, revision: 2 };
    });
    expect(edits.size).toBe(0);
  });

  it("accepts only the known schema version difference in actual Editor documents", async () => {
    const documents: Doc[] = [
      { ...blankDoc(), schemaVersion: 1 },
      {
        type: "doc",
        schemaVersion: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "body" }] },
        ],
      },
      {
        type: "doc",
        schemaVersion: 1,
        content: [
          {
            type: "heading",
            attrs: { level: 2, id: "block-1" },
            content: [
              { type: "text", text: "Title", marks: [{ type: "bold" }] },
            ],
          },
        ],
      },
    ];
    for (const doc of documents) {
      const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
        projection(1),
      );
      const fresh = await save.resync("record", "db", async () =>
        snapshot(projection(0), doc),
      );
      const editorDoc = structuredClone(doc);
      delete editorDoc.schemaVersion;
      save.confirmResync("record", fresh.token, fresh.page, editorDoc);
      expect(save.lastAcknowledged("record")?.revision).toBe(0);
    }
  });

  it("rejects changed attributes, unsupported editor nodes and unknown document versions", async () => {
    const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(1),
    );
    const doc: Doc = {
      type: "doc",
      schemaVersion: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 2, id: "block-1" },
          content: [{ type: "text", text: "Title" }],
        },
      ],
    };
    const fresh = await save.resync("record", "db", async () =>
      snapshot(projection(0), doc),
    );
    const changed = structuredClone(doc);
    changed.content![0].attrs!.id = "other";
    delete changed.schemaVersion;
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, changed),
    ).toThrow("Editor document");
    const unknown: Doc = { type: "doc", content: [{ type: "unknownNode" }] };
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, unknown),
    ).toThrow("Editor document");
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, {
        ...doc,
        schemaVersion: 99,
      }),
    ).toThrow("Editor document");
    expect(save.lastAcknowledged("record")).toBeUndefined();
    save.cancelResync("record", fresh.token);
  });

  it("accepts only additive unique IDs in ProseMirror-normalized blank and mixed legacy documents", async () => {
    const documents: Doc[] = [
      { ...blankDoc(), schemaVersion: 1 },
      {
        type: "doc",
        schemaVersion: 1,
        content: [
          {
            type: "heading",
            attrs: { level: 2, id: "existing" },
            content: [
              { type: "text", text: "Title", marks: [{ type: "bold" }] },
            ],
          },
          { type: "paragraph", content: [{ type: "text", text: "legacy" }] },
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                attrs: { id: "nested-existing" },
                content: [{ type: "text", text: "nested" }],
              },
            ],
          },
        ],
      },
    ];
    for (const source of documents) {
      const original = structuredClone(source);
      const editor = documentSchema.nodeFromJSON(source).toJSON() as Doc;
      let serial = 0;
      const addMissingIds = (node: Doc) => {
        if (BLOCK_TYPES.includes(node.type) && !node.attrs?.id)
          node.attrs = { ...node.attrs, id: `new-${++serial}` };
        node.content?.forEach(addMissingIds);
      };
      addMissingIds(editor);
      const edits = new PendingEdits();
      const save = new RecordSaveCoordinator(edits, async () => projection(1));
      const fresh = await save.resync("record", "db", async () =>
        snapshot(projection(0), source),
      );
      save.confirmResync("record", fresh.token, fresh.page, editor);
      expect(fresh.page.doc).toEqual(original);
      expect(source).toEqual(original);
      expect(save.lastAcknowledged("record")?.revision).toBe(0);
      // Installing does not persist IDs. A separate Page write must do that.
      const seq = save.enqueuePage("record", 0, {
        doc: { ...editor, schemaVersion: 1 },
      });
      await save.flushPage("record", 0, seq, async (request) => {
        expect(request.patch.doc).toEqual({ ...editor, schemaVersion: 1 });
        return { ...fresh.page, doc: request.patch.doc!, revision: 1 };
      });
    }
  });

  it("rejects duplicate or changed IDs, unknown formats and edited or dropped content", async () => {
    const source: Doc = {
      type: "doc",
      schemaVersion: 1,
      content: [
        {
          type: "heading",
          attrs: { id: "existing", level: 2 },
          content: [{ type: "text", text: "Title", marks: [{ type: "bold" }] }],
        },
        { type: "paragraph", content: [{ type: "text", text: "body" }] },
      ],
    };
    const editor = documentSchema.nodeFromJSON(source).toJSON() as Doc;
    editor.content![1].attrs = { ...editor.content![1].attrs, id: "added" };
    const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(1),
    );
    const fresh = await save.resync("record", "db", async () =>
      snapshot(projection(0), source),
    );
    const attempts: Doc[] = [];
    const duplicate = structuredClone(editor);
    duplicate.content![1].attrs!.id = "existing";
    attempts.push(duplicate);
    const changedId = structuredClone(editor);
    changedId.content![0].attrs!.id = "replaced";
    attempts.push(changedId);
    const unknownAttr = structuredClone(editor);
    unknownAttr.content![1].attrs!.unexpected = "loss";
    attempts.push(unknownAttr);
    const unknownNode = structuredClone(editor);
    unknownNode.content![1].type = "unknownNode";
    attempts.push(unknownNode);
    const contentEdit = structuredClone(editor);
    contentEdit.content![1].content![0].text = "changed";
    attempts.push(contentEdit);
    const dropMark = structuredClone(editor);
    delete dropMark.content![0].content![0].marks;
    attempts.push(dropMark);
    const dropNode = structuredClone(editor);
    dropNode.content!.pop();
    attempts.push(dropNode);
    const changedAttr = structuredClone(editor);
    changedAttr.content![0].attrs!.level = 3;
    attempts.push(changedAttr);
    for (const attempt of attempts)
      expect(() =>
        save.confirmResync("record", fresh.token, fresh.page, attempt),
      ).toThrow("Editor document");
    expect(save.lastAcknowledged("record")).toBeUndefined();
    save.confirmResync("record", fresh.token, fresh.page, editor);
  });

  it("rejects unsupported source nodes and attributes instead of normalizing away data", async () => {
    const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(1),
    );
    const unknownNode: Doc = {
      type: "doc",
      content: [{ type: "futureWidget" }],
    };
    const unknownAttr: Doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "kept", futureData: "must not disappear" },
        },
      ],
    };
    for (const doc of [unknownNode, unknownAttr])
      await expect(
        save.resync("record", "db", async () => snapshot(projection(0), doc)),
      ).rejects.toThrow("Invalid record Page");
    expect(save.lastAcknowledged("record")).toBeUndefined();
  });

  it("retains and blocks input received while installation is unconfirmed", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => projection(2));
    await install(save, snapshot(projection(0)));
    const fresh = await save.resync("record", "db", async () =>
      snapshot(projection(1)),
    );
    const seq = save.enqueuePage("record", 1, { title: "draft" });
    expect(edits.snapshotPages()).toMatchObject([
      { seq, observedKnown: false, patch: { title: "draft" } },
    ]);
    expect(edits.failed.has("record")).toBe(true);
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, fresh.page.doc),
    ).toThrow("pending, failed or in-flight");
    expect(() => save.clearSettledFailure("record")).toThrow(
      "pending or in-flight",
    );
    await expect(
      save.flushPage("record", 1, seq, async () => fresh.page),
    ).rejects.toThrow();
    expect(edits.has("record", seq)).toBe(true);
  });

  it("keeps record inputs captured during installation and refuses forged tickets", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => projection(2));
    await install(save, snapshot(projection(0)));
    const fresh = await save.resync("record", "db", async () =>
      snapshot(projection(1)),
    );
    expect(() =>
      save.confirmResync("record", {}, fresh.page, fresh.page.doc),
    ).toThrow("ticket mismatch");
    const seq = save.enqueue("record", 1, { values: { status: "draft" } }, "db");
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq, observedKnown: false, patch: { values: { status: "draft" } } },
    ]);
    await expect(save.flush("record", seq)).rejects.toThrow(
      "installation not confirmed",
    );
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, fresh.page.doc),
    ).toThrow("pending, failed or in-flight");
    expect(edits.hasRecord("record", seq)).toBe(true);
  });

  it("cancels after concurrent input while retaining the prior revision, failure and recoverable drafts", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => projection(1));
    await install(save, snapshot(projection(0)));
    const fresh = await save.resync("record", "db", async () =>
      snapshot(projection(1)),
    );
    const pageSeq = save.enqueuePage("record", 1, { doc: blankDoc() });
    const recordSeq = save.enqueue("record", 1, {
      title: "local",
      values: { status: "draft", due: null },
    }, "db");
    const priorError = save.error("record");
    save.cancelResync("record", fresh.token);
    expect(save.lastAcknowledged("record")?.revision).toBe(0);
    expect(save.error("record")).toBe(priorError);
    expect(edits.failed.has("record")).toBe(true);
    expect(edits.snapshotPages()).toMatchObject([
      { seq: pageSeq, observedKnown: false, patch: { doc: blankDoc() } },
    ]);
    expect(edits.snapshotRecords("record")).toMatchObject([
      {
        seq: recordSeq,
        observedKnown: false,
        patch: { title: "local", values: { status: "draft", due: null } },
      },
    ]);
    expect(() => edits.snapshot()).toThrow();
    await expect(
      save.retryPage("record", 0, pageSeq, async () => fresh.page),
    ).rejects.toThrow("provenance conflict");
    expect(edits.has("record", pageSeq)).toBe(true);
    expect(edits.hasRecord("record", recordSeq)).toBe(true);
    expect(edits.failed.has("record")).toBe(true);
    await expect(
      save.resync("record", "db", async () => snapshot(projection(1))),
    ).rejects.toThrow("pending, failed or in-flight");
  });

  it("cancels an installation failure and allows a fresh read without adopting its revision", async () => {
    const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(1),
    );
    await install(save, snapshot(projection(0)));
    const fresh = await save.resync("record", "db", async () =>
      snapshot(projection(2)),
    );
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, {
        type: "doc",
        content: [],
      }),
    ).toThrow();
    save.cancelResync("record", fresh.token);
    expect(save.lastAcknowledged("record")?.revision).toBe(0);
    const next = await install(save, snapshot(projection(1)));
    expect(next.record.revision).toBe(1);
    expect(save.lastAcknowledged("record")?.revision).toBe(1);
  });

  it("refuses wrong or reused cancellation tickets and rejects confirmation after cancellation", async () => {
    const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(1),
    );
    await install(save, snapshot(projection(0)));
    const fresh = await save.resync("record", "db", async () =>
      snapshot(projection(1)),
    );
    expect(() => save.cancelResync("record", {})).toThrow("ticket mismatch");
    expect(() => save.cancelResync("other", fresh.token)).toThrow(
      "ticket mismatch",
    );
    expect(save.lastAcknowledged("record")?.revision).toBe(0);
    save.cancelResync("record", fresh.token);
    expect(() => save.cancelResync("record", fresh.token)).toThrow(
      "ticket mismatch",
    );
    expect(() =>
      save.confirmResync("record", fresh.token, fresh.page, fresh.page.doc),
    ).toThrow("ticket mismatch");
    await install(save, snapshot(projection(1)));
  });

  it("does not create a known revision by cancelling the first read and preserves unbound failures", async () => {
    const edits = new PendingEdits();
    const calls: RecordSaveRequest[] = [];
    const save = new RecordSaveCoordinator(edits, async (request) => {
      calls.push(request);
      return projection(request.revision + 1, String(request.patch.title));
    });
    const cancelled = await save.resync("record", "db", async () =>
      snapshot(projection(7)),
    );
    save.cancelResync("record", cancelled.token);
    const seq = save.enqueue("record", 0, { title: "local" }, "db");
    await save.flush("record", seq);
    expect(calls[0].revision).toBe(0);

    const otherEdits = new PendingEdits();
    const other = new RecordSaveCoordinator(otherEdits, async () =>
      projection(1),
    );
    const first = await other.resync("record", "db", async () =>
      snapshot(projection(7)),
    );
    const pending = other.enqueue("record", 7, { title: "retained" }, "db");
    other.cancelResync("record", first.token);
    expect(otherEdits.failed.has("record")).toBe(true);
    expect(otherEdits.snapshotRecords("record")).toMatchObject([
      { seq: pending, observedKnown: false, patch: { title: "retained" } },
    ]);
    await expect(other.flush("record", pending)).rejects.toThrow(
      "installation not confirmed",
    );
    expect(() => other.clearSettledFailure("record")).toThrow(
      "pending or in-flight",
    );
  });

  it("does not install unexpected document fields from the membership projection", async () => {
    const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(1),
    );
    const record = {
      ...projection(0),
      doc: { type: "doc" },
    } as RecordProjection;
    const fresh = await install(save, snapshot(record));
    expect(fresh.record).not.toHaveProperty("doc");
    expect(fresh.page.doc).toEqual(blankDoc());
  });

  it("refuses changed owner, wrong Page, backwards revision and changed content at an unchanged revision", async () => {
    const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(1),
    );
    await install(save, snapshot(projection(4, "known")));
    await expect(
      save.resync("record", "other", async () =>
        snapshot({ ...projection(5), databasePageId: "other" }),
      ),
    ).rejects.toThrow("owner mismatch");
    await expect(
      save.resync("record", "db", async () =>
        snapshot({ ...projection(5), pageId: "other" }),
      ),
    ).rejects.toThrow("Invalid record projection");
    await expect(
      save.resync("record", "db", async () => snapshot(projection(3))),
    ).rejects.toThrow("backwards");
    await expect(
      save.resync("record", "db", async () =>
        snapshot(projection(4, "different")),
      ),
    ).rejects.toThrow("disagrees");
    expect(save.lastAcknowledged("record")).toMatchObject({
      databasePageId: "db",
      revision: 4,
      title: "known",
    });
  });

  it("rejects mismatched Page identity, revision, title, deleted state, and unsupported document or schema", async () => {
    const save = new RecordSaveCoordinator(new PendingEdits(), async () =>
      projection(1),
    );
    await install(save, snapshot(projection(0)));
    const baseline = snapshot(projection(1));
    const badPages = [
      { ...baseline.page, id: "other" },
      { ...baseline.page, revision: 2 },
      { ...baseline.page, title: "different" },
      { ...baseline.page, deletedAt: 3 },
      { ...baseline.page, schemaVersion: 99 },
      { ...baseline.page, doc: { type: "doc", schemaVersion: 99 } },
      { ...baseline.page, documentError: "unsupported" },
    ];
    for (const page of badPages) {
      await expect(
        save.resync("record", "db", async () => ({ ...baseline, page })),
      ).rejects.toThrow("Invalid record Page");
      expect(save.lastAcknowledged("record")?.revision).toBe(0);
    }
    await expect(
      save.resync("record", "db", async () =>
        snapshot({ ...projection(1), values: { broken: NaN } }),
      ),
    ).rejects.toThrow("Invalid record projection");
  });

  it("rejects pending, failed and edits captured while a read is in flight", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () =>
      projection(1, "pending"),
    );
    await install(save, snapshot(projection(0)));
    const seq = save.enqueue("record", 0, { title: "pending" }, "db");
    await expect(
      save.resync("record", "db", async () => snapshot(projection(0))),
    ).rejects.toThrow("pending, failed or in-flight");
    await save.flush("record", seq);
    edits.failed.add("record");
    await expect(
      save.resync("record", "db", async () =>
        snapshot(projection(1, "pending")),
      ),
    ).rejects.toThrow("pending, failed or in-flight");
    save.clearSettledFailure("record");
    const read = deferred<RecordResyncSnapshot>();
    const reading = save.resync("record", "db", () => read.promise);
    const rejected = expect(reading).rejects.toThrow(
      "pending, failed or in-flight",
    );
    const local = save.enqueue("record", 1, { values: { status: "local" } }, "db");
    await expect(save.flush("record", local)).rejects.toThrow(
      "App serialization queue",
    );
    read.resolve(snapshot(projection(1, "pending")));
    await rejected;
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq: local, patch: { values: { status: "local" } } },
    ]);
  });

  it("refuses resync and failure clearing while a record IPC is in flight", async () => {
    const edits = new PendingEdits();
    const response = deferred<RecordProjection>();
    const started = deferred<void>();
    const save = new RecordSaveCoordinator(edits, () => {
      started.resolve(undefined);
      return response.promise;
    });
    await install(save, snapshot(projection(0)));
    const seq = save.enqueue("record", 0, { title: "local" }, "db");
    const saving = save.flush("record", seq);
    await started.promise;
    await expect(
      save.resync("record", "db", async () => snapshot(projection(0))),
    ).rejects.toThrow("App serialization queue");
    expect(() => save.clearSettledFailure("record")).toThrow(
      "pending or in-flight",
    );
    response.resolve(projection(1, "local"));
    await saving;
    expect(edits.size).toBe(0);
  });
});

describe("settled failures and visible drafts", () => {
  it("keeps ordered Page and record overlays visible across a delayed ACK", async () => {
    const edits = new PendingEdits();
    const deferredAck = deferred<RecordProjection>();
    const started = deferred<void>();
    const save = new RecordSaveCoordinator(edits, () => {
      started.resolve(undefined);
      return deferredAck.promise;
    });
    const first = save.enqueue("record", 0, {
      title: "first",
      values: { status: "one" },
    }, "db");
    const saving = save.flush("record", first);
    await started.promise;
    save.enqueuePage("record", 0, { title: "Page later" });
    const latest = save.enqueue("record", 0, {
      title: "record latest",
      values: { due: null },
    }, "db");
    const doc = { type: "doc", content: [{ type: "paragraph" }] };
    const source = { id: "record", title: "server", revision: 0, doc } as any;
    expect(edits.merge([source])[0]).toMatchObject({
      title: "record latest",
      revision: 0,
      doc,
    });
    expect(
      edits.mergeValues("record", { status: "old", due: "today" }),
    ).toEqual({ status: "one" });
    deferredAck.resolve(
      projection(1, "first", { status: "one", due: "today" }),
    );
    await saving;
    expect(edits.snapshotRecords("record").map((entry) => entry.seq)).toEqual([
      latest,
    ]);
    const after = edits.merge([{ ...source, title: "first", revision: 1 }])[0];
    expect(after).toMatchObject({ title: "record latest", revision: 1, doc });
    expect(after).not.toHaveProperty("values");
    expect(
      edits.mergeValues("record", { status: "one", due: "today" }),
    ).toEqual({ status: "one" });
  });

  it("clears a duplicate Page preflight failure only explicitly after the successful in-flight ACK and no pending work", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => projection(1));
    const seq = save.enqueuePage("record", 0, { title: "saved" });
    const first = deferred<any>(),
      started = deferred<void>();
    const saving = save.flushPage("record", 0, seq, () => {
      started.resolve(undefined);
      return first.promise;
    });
    await started.promise;
    await expect(
      save.flushPage("record", 0, seq, async () => ({}) as any),
    ).rejects.toThrow("App serialization queue");
    expect(() => save.clearSettledFailure("record")).toThrow(
      "pending or in-flight",
    );
    first.resolve({
      id: "record",
      revision: 1,
      deletedAt: null,
      title: "saved",
    });
    await saving;
    expect(edits.size).toBe(0);
    expect(edits.failed.has("record")).toBe(true);
    save.clearSettledFailure("record");
    expect(edits.failed.has("record")).toBe(false);
    expect(save.error("record")).toBeUndefined();
    await expect(
      save.resync("record", "db", async () => snapshot(projection(1, "saved"))),
    ).resolves.toMatchObject({ record: { revision: 1 } });
  });

  it("cannot clear failure or discard anything while an actual later draft remains", async () => {
    const edits = new PendingEdits();
    const save = new RecordSaveCoordinator(edits, async () => {
      throw new Error("failed");
    });
    const seq = save.enqueue("record", 0, { title: "local" }, "db");
    await expect(save.flush("record", seq)).rejects.toThrow("failed");
    expect(() => save.clearSettledFailure("record")).toThrow(
      "pending or in-flight",
    );
    expect(edits.snapshotRecords("record")).toMatchObject([
      { seq, patch: { title: "local" } },
    ]);
    expect(edits.failed.has("record")).toBe(true);
  });
});
