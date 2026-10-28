import { describe, expect, it } from "vitest";
import { PendingEdits } from "../src/renderer/pending-edits";
import { emptyDatabase, type DatabaseSettings } from "../src/shared/types";

function settings(): DatabaseSettings {
  const { rows, ...result } = emptyDatabase();
  void rows;
  return result;
}

describe("pending database settings", () => {
  it("coalesces consecutive drafts captured at the same revision and clones nested input and output", () => {
    const pending = new PendingEdits();
    const first = settings();
    first.views[0].name = "Table";
    const seq1 = pending.addSettings("db", 2, first);
    const second = structuredClone(first);
    second.views[0].name = "Projects";
    const seq2 = pending.addSettings("db", 2, second);
    first.views[0].name = "mutated input";
    second.views[0].name = "mutated input";
    expect(pending.settingsDraft("db", 2, seq1)?.settings.views[0].name).toBe(
      "Table",
    );
    const draft = pending.settingsDraft("db", 2, seq2)!;
    expect(draft).toMatchObject({ seq: seq2, id: "db", baseRevision: 2 });
    expect(draft.settings.views[0].name).toBe("Projects");
    draft.settings.views[0].name = "mutated output";
    expect(pending.settingsDraft("db", 2)?.settings.views[0].name).toBe(
      "Projects",
    );
    expect(
      pending.snapshotSettings().map((entry) => entry.baseRevision),
    ).toEqual([2, 2]);
  });

  it("clears coalesced settings only after the matching ACK", () => {
    const pending = new PendingEdits();
    pending.addSettings("db", 3, settings());
    const newer = settings();
    newer.views[0].name = "A renamed view";
    const seq = pending.addSettings("db", 3, newer);
    pending.failed.add("db");
    const request = pending.settingsDraft("db", 3)!;
    expect(request.seq).toBe(seq);
    expect(request.settings.views[0].name).toBe("A renamed view");
    pending.ackSettings("db", request.seq, request.baseRevision, 4);
    expect(pending.size).toBe(0);
    expect(pending.hasSettings("db")).toBe(false);
    expect(pending.failed.has("db")).toBe(false);
  });

  it("rejects unrelated revision advancement without rebasing or discarding either snapshot", () => {
    const pending = new PendingEdits();
    const original = settings();
    const first = pending.addSettings("db", 4, original);
    const next = structuredClone(original);
    next.views[0].name = "local change";
    const second = pending.addSettings("db", 4, next);
    pending.failed.add("db");
    const before = pending.snapshotSettings();
    expect(() => pending.settingsDraft("db", 5)).toThrow("revision conflict");
    expect(() => pending.ackSettings("db", second, 5, 6)).toThrow(
      "acknowledgement mismatch",
    );
    expect(pending.snapshotSettings()).toEqual(before);
    expect(pending.failed.has("db")).toBe(true);
    expect(pending.settingsDraft("db", 4, first)?.settings).toEqual(original);
    expect(pending.sequence).toBe(second);
  });

  it("acknowledges only included settings while preserving later settings, Page and record values", () => {
    const pending = new PendingEdits();
    const one = pending.addSettings("db", 7, settings());
    const page = pending.add("db", { title: "new title" });
    const values = pending.addValues("db", { status: "new" });
    const later = settings();
    later.views[0].name = "newer local view";
    const two = pending.addSettings("db", 7, later);
    pending.failed.add("db");
    expect(pending.settingsDraft("db", 7, one)?.seq).toBe(one);
    pending.ackSettings("db", one, 7, 8);
    expect(pending.snapshotSettings().map((entry) => entry.seq)).toEqual([two]);
    expect(pending.patch("db")).toEqual({ title: "new title" });
    expect(pending.valuesPatch("db")).toEqual({ status: "new" });
    expect(pending.failed.has("db")).toBe(true);
    expect(() => pending.settingsDraft("db", 8)).toThrow("revision conflict");
    expect(pending.snapshotSettings()[0]).toMatchObject({
      seq: two,
      baseRevision: 7,
    });
    expect(pending.has("db", page)).toBe(true);
    expect(pending.hasValues("db", values)).toBe(true);
  });

  it("refuses Page-only recovery discard before any settings or values are removed", () => {
    const pending = new PendingEdits();
    const page = pending.add("db", { title: "unsaved" });
    const setting = pending.addSettings("db", 0, settings());
    const value = pending.addValues("other", { state: "unsaved" });
    expect(() => pending.snapshot()).toThrow("Page-only recovery");
    const snapshots = [
      pending.snapshotPages(),
      pending.snapshotSettings(),
      pending.snapshotValues(),
    ];
    pending.failed.add("db");
    expect(() => pending.discardThrough(setting)).toThrow(
      "Database settings have not been included in recovery",
    );
    expect([
      pending.snapshotPages(),
      pending.snapshotSettings(),
      pending.snapshotValues(),
    ]).toEqual(snapshots);
    expect(pending.failed.has("db")).toBe(true);
    expect(() => pending.discardThrough(value)).toThrow(
      "Record values have not been included in recovery",
    );
    expect([
      pending.snapshotPages(),
      pending.snapshotSettings(),
      pending.snapshotValues(),
    ]).toEqual(snapshots);
    pending.discardThrough(page);
    expect(pending.snapshotPages()).toHaveLength(0);
    expect(pending.snapshotSettings()).toHaveLength(1);
    expect(pending.snapshotValues()).toHaveLength(1);
    expect(pending.failed.has("db")).toBe(true);
  });

  it("rejects ambiguous mixed bases, invalid ACKs and rows payloads while preserving drafts", () => {
    const pending = new PendingEdits();
    const a = pending.addSettings("db", 0, settings());
    const b = pending.addSettings("db", 1, settings());
    expect(() => pending.settingsDraft("db", 1)).toThrow("revision conflict");
    expect(() => pending.ackSettings("db", b, 0, 1)).toThrow(
      "acknowledgement mismatch",
    );
    expect(() => pending.ackSettings("db", a, 0, 2)).toThrow(
      "acknowledgement mismatch",
    );
    expect(() =>
      pending.addSettings("db", 1, { ...settings(), rows: [] } as any),
    ).toThrow("cannot include rows");
    expect(pending.snapshotSettings().map((entry) => entry.seq)).toEqual([
      a,
      b,
    ]);
    expect(pending.sequence).toBe(b);
  });
});
