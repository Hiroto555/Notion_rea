import { describe, expect, it } from "vitest";
import { PendingEdits } from "../src/renderer/pending-edits";
import { blankDoc, emptyDatabase } from "../src/shared/types";
import { capturePendingJournal, parsePendingJournal, serializePendingJournal, type PendingJournal, type PendingJournalSource } from "../src/shared/pending-journal";

function mixed() {
  const pending = new PendingEdits();
  const { rows: _rows, ...settings } = emptyDatabase();
  pending.add("ordinary", { title: "保存前のページ", doc: blankDoc() });
  pending.addValues("record", { status: "new", deleted: null });
  pending.addObservedPage("record", 4, { doc: blankDoc(), title: "本文" }, true, "db", "record");
  pending.addRecord("record", 4, { title: "記録", values: { status: "processing", check: true } }, true, "db");
  pending.addSettings("db", 7, settings);
  pending.addSettingsIntent("db", 7, { kind: "viewPatch", viewId: settings.activeViewId, base: { name: settings.views[0].name }, patch: { name: "予定表" } }, true);
  pending.failed.add("record");
  return pending;
}

describe("manual pending journal", () => {
  it("preserves every captured kind, generation, owner, revision and failure without acknowledgement", () => {
    const pending = mixed();
    const before = {
      pages: pending.snapshotPages(), values: pending.snapshotValues(), records: pending.snapshotRecords(),
      settings: pending.snapshotSettings(), intents: pending.snapshotSettingsIntents(), failed: [...pending.failed],
    };
    const capture = capturePendingJournal(pending);
    const text = serializePendingJournal(capture);
    const read = parsePendingJournal(text);
    expect(read.format).toBe("folio-pending-journal");
    expect(read.use).toBe("manual-inspection-only");
    expect(read.capturedThrough).toBe(6);
    expect(read.entries.map((entry) => entry.kind)).toEqual(["page", "values", "page", "record", "settings", "settingsIntent"]);
    expect(read.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(read.entries[2]).toMatchObject({ expectedOwnerId: "db", observedRevision: 4, observedKnown: true, recoveryKind: "record" });
    expect(read.entries[3]).toMatchObject({ expectedOwnerId: "db", observedRevision: 4, patch: { title: "記録", values: { status: "processing", check: true } } });
    expect(read.failedIds).toEqual(["record"]);
    expect(pending.size).toBe(6);
    expect(pending.snapshotPages()).toEqual(before.pages);
    expect(pending.snapshotValues()).toEqual(before.values);
    expect(pending.snapshotRecords()).toEqual(before.records);
    expect(pending.snapshotSettings()).toEqual(before.settings);
    expect(pending.snapshotSettingsIntents()).toEqual(before.intents);
    expect([...pending.failed]).toEqual(before.failed);
  });

  it("retains unknown provenance and earlier acknowledged generation gaps instead of inventing a base", () => {
    const pending = new PendingEdits();
    const first = pending.add("page", { title: "already acknowledged" });
    pending.ack("page", first);
    pending.addRecord("record", 3, { values: { status: "local" } }, false);
    const journal = parsePendingJournal(serializePendingJournal(capturePendingJournal(pending)));
    expect(journal.capturedThrough).toBe(2);
    expect(journal.entries).toEqual([{ kind: "record", seq: 2, id: "record", observedRevision: 3, observedKnown: false, patch: { values: { status: "local" } } }]);
    expect(pending.size).toBe(1);
  });

  it("makes independent snapshots when more inputs arrive after capture", () => {
    const pending = mixed();
    const capture = capturePendingJournal(pending);
    pending.add("later", { title: "after snapshot" });
    const recovered = parsePendingJournal(serializePendingJournal(capture));
    expect(recovered.capturedThrough).toBe(6);
    expect(recovered.entries).toHaveLength(6);
    expect(pending.size).toBe(7);
    expect(pending.snapshotPages().at(-1)?.patch.title).toBe("after snapshot");
  });

  it("fails closed if an input arrives while individual queues are being captured", () => {
    const pending = mixed();
    const source: PendingJournalSource = {
      get sequence() { return pending.sequence; },
      get size() { return pending.size; },
      get failed() { return pending.failed; },
      snapshotPages() { const pages = pending.snapshotPages(); pending.add("later", { title: "not lost" }); return pages; },
      snapshotValues: () => pending.snapshotValues(), snapshotRecords: () => pending.snapshotRecords(),
      snapshotSettings: () => pending.snapshotSettings(), snapshotSettingsIntents: () => pending.snapshotSettingsIntents(),
    };
    expect(() => capturePendingJournal(source)).toThrow("changed during capture");
    expect(pending.size).toBe(7);
    expect(pending.snapshotPages().at(-1)?.patch.title).toBe("not lost");
  });

  it("rejects empty drafts, duplicate/out-of-order/future generations and unknown fields", () => {
    expect(() => capturePendingJournal(new PendingEdits())).toThrow();
    const valid = capturePendingJournal(mixed());
    const invalid: unknown[] = [
      { ...valid, entries: [] },
      { ...valid, surprise: 1 },
      { ...valid, entries: valid.entries.map((entry, index) => index === 1 ? { ...entry, seq: 1 } : entry) },
      { ...valid, entries: [...valid.entries].reverse() },
      { ...valid, capturedThrough: 1 },
      { ...valid, entries: [{ kind: "page", seq: 1, id: "x", patch: {} }] },
      { ...valid, entries: [{ kind: "record", seq: 1, id: "x", observedRevision: 0, observedKnown: true, patch: { values: {} } }] },
      { ...valid, entries: [{ kind: "future", seq: 1, id: "x" }] },
      { ...valid, entries: [{ kind: "page", seq: 1, id: "x", observedRevision: 1, patch: { title: "x" } }] },
    ];
    for (const item of invalid) expect(() => serializePendingJournal(item as PendingJournal)).toThrow();
  });

  it("rejects unsupported or lossy nested data and malformed settings intents", () => {
    const valid = capturePendingJournal(mixed());
    const invalid: unknown[] = [
      { ...valid, entries: [{ kind: "page", seq: 1, id: "x", patch: { title: "ok", future: "no" } }] },
      { ...valid, entries: [{ kind: "page", seq: 1, id: "x", patch: { doc: { type: "doc", future: true } } }] },
      { ...valid, entries: [{ kind: "values", seq: 1, id: "x", values: { v: NaN } }] },
      { ...valid, entries: [{ kind: "values", seq: 1, id: "x", values: { v: -0 } }] },
      { ...valid, entries: [{ kind: "settingsIntent", seq: 1, id: "db", observedRevision: 0, observedKnown: true, intent: { kind: "viewPatch", viewId: "view", base: { name: "old" }, patch: { type: "table" } } }] },
      { ...valid, entries: [{ kind: "settingsIntent", seq: 1, id: "db", observedRevision: 0, observedKnown: true, intent: { kind: "activeView", base: "old", viewId: "new", future: true } }] },
    ];
    for (const item of invalid) expect(() => serializePendingJournal(item as PendingJournal)).toThrow();
    const undefinedInput = { ...valid, entries: [{ kind: "page", seq: 1, id: "x", patch: { title: undefined } }] };
    expect(() => serializePendingJournal(undefinedInput as unknown as PendingJournal)).toThrow();
  });

  it("refuses noncanonical JSON, duplicate keys, corrupt JSON, and oversized UTF-8 without touching the source", () => {
    const pending = mixed();
    const content = serializePendingJournal(capturePendingJournal(pending));
    expect(() => parsePendingJournal(" {" + content.slice(1))).toThrow();
    expect(() => parsePendingJournal(content.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))).toThrow();
    expect(() => parsePendingJournal("{" )).toThrow();
    expect(() => parsePendingJournal("あ".repeat(10_000_001))).toThrow();
    const oversized = { ...capturePendingJournal(pending), entries: [{ kind: "values", seq: 1, id: "x", values: { text: "あ".repeat(10_000_001) } }] };
    expect(() => serializePendingJournal(oversized as PendingJournal)).toThrow();
    expect(pending.size).toBe(6);
    expect(pending.failed.has("record")).toBe(true);
  });
});
