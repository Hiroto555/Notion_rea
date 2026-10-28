import { describe, expect, it } from "vitest";
import { PendingEdits } from "../src/renderer/pending-edits";
import { blankDoc, type Page } from "../src/shared/types";

describe("interleaved record and page pending edits", () => {
  it("acknowledges only the saved generation and kind, preserving the newer title, body and property", () => {
    const pending = new PendingEdits();
    const oldTitle = pending.add("record", { title: "old title" });
    const oldValues = pending.addValues("record", {
      status: "draft",
      due: "today",
    });
    const newDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "unsaved" }] },
      ],
    };
    const body = pending.add("record", { doc: newDoc });
    const newValues = pending.addValues("record", {
      status: "done",
      due: null,
    });
    const title = pending.add("record", { title: "latest title" });
    expect([oldTitle, oldValues, body, newValues, title]).toEqual([
      1, 2, 3, 4, 5,
    ]);

    pending.ack("record", oldTitle);
    pending.ackValues("record", oldValues);
    expect(pending.patch("record")).toEqual({
      doc: newDoc,
      title: "latest title",
    });
    expect(pending.valuesPatch("record")).toEqual({
      status: "done",
      due: null,
    });
    const page = {
      id: "record",
      title: "server",
      revision: 5,
      doc: blankDoc(),
    } as Page;
    const merged = pending.merge([page])[0];
    expect(merged).toMatchObject({
      id: "record",
      revision: 5,
      title: "latest title",
      doc: newDoc,
    });
    expect(merged).not.toHaveProperty("values");
    expect(
      pending.mergeValues("record", {
        status: "draft",
        due: "today",
        untouched: true,
      }),
    ).toEqual({ status: "done", untouched: true });
    expect(pending.size).toBe(3);
  });

  it("folds values per key at a requested generation and never treats a deletion as a value", () => {
    const pending = new PendingEdits();
    const first = pending.addValues("a", { status: "draft", date: "one" });
    pending.add("a", { title: "title" });
    const second = pending.addValues("a", { status: null, done: false });
    pending.addValues("b", { status: "other" });
    const third = pending.addValues("a", { status: "ready", date: null });
    const base = { status: "old", date: "old", keep: 1 };
    expect(pending.valuesPatch("a", first)).toEqual({
      status: "draft",
      date: "one",
    });
    expect(pending.mergeValues("a", base, second)).toEqual({
      date: "one",
      keep: 1,
      done: false,
    });
    expect(pending.valuesPatch("a", third)).toEqual({
      status: "ready",
      date: null,
      done: false,
    });
    expect(pending.mergeValues("a", base)).toEqual({
      status: "ready",
      keep: 1,
      done: false,
    });
    expect(base).toEqual({ status: "old", date: "old", keep: 1 });
    expect(pending.valuesPatch("b")).toEqual({ status: "other" });
  });

  it("retains failures while any newer page or value edit is pending and never acknowledges another record", () => {
    const pending = new PendingEdits();
    const old = pending.add("a", { title: "old" });
    const property = pending.addValues("a", { status: "local" });
    const other = pending.addValues("b", { status: "other" });
    const latest = pending.add("a", { doc: blankDoc() });
    pending.failed.add("a");
    pending.ack("a", old);
    pending.ackValues("a", property);
    expect(pending.failed.has("a")).toBe(true);
    expect(pending.has("a")).toBe(true);
    expect(pending.hasValues("b")).toBe(true);
    pending.ack("a", latest);
    expect(pending.failed.has("a")).toBe(false);
    expect(pending.hasValues("b", other)).toBe(true);
  });

  it("refuses Page-only discard if record values are within the cutoff and retains all entries", () => {
    const pending = new PendingEdits();
    const title = pending.add("a", { title: "saved" });
    const values = { status: "before" as string | null };
    const cutoff = pending.addValues("a", values);
    values.status = "changed outside";
    const laterValues = pending.addValues("a", { status: null });
    const laterPage = pending.add("a", { title: "later" });
    expect(pending.valuesPatch("a", cutoff)).toEqual({ status: "before" });
    const snapshot = pending.snapshotValues();
    snapshot[0].values.status = "changed snapshot";
    expect(pending.valuesPatch("a", cutoff)).toEqual({ status: "before" });
    expect(pending.snapshotPages().map((entry) => entry.seq)).toEqual([
      title,
      laterPage,
    ]);
    pending.failed.add("a");
    expect(() => pending.snapshot()).toThrow("Page-only recovery");
    const originalPages = pending.snapshotPages();
    const originalValues = pending.snapshotValues();
    expect(() => pending.discardThrough(cutoff)).toThrow(
      "Record values have not been included in recovery",
    );
    expect(pending.snapshotPages()).toEqual(originalPages);
    expect(pending.snapshotValues()).toEqual(originalValues);
    expect(pending.failed.has("a")).toBe(true);
    expect(pending.sequence).toBe(laterPage);
    // Only an actual successful values ACK can remove that generation.
    pending.ackValues("a", cutoff);
    pending.discardThrough(cutoff);
    expect(pending.snapshotValues().map((entry) => entry.seq)).toEqual([
      laterValues,
    ]);
    expect(pending.patch("a")).toEqual({ title: "later" });
    expect(pending.failed.has("a")).toBe(true);
    expect(() => pending.discardThrough(laterPage)).toThrow();
    expect(pending.patch("a")).toEqual({ title: "later" });
    expect(pending.snapshotValues().map((entry) => entry.seq)).toEqual([
      laterValues,
    ]);
    pending.ackValues("a", laterValues);
    pending.discardThrough(laterPage);
    expect(pending.size).toBe(0);
    expect(pending.failed.has("a")).toBe(false);
  });

  it("discards an earlier Page generation without touching later record values", () => {
    const pending = new PendingEdits();
    const page = pending.add("a", { title: "saved" });
    const values = pending.addValues("a", { status: "pending" });
    pending.failed.add("a");
    pending.discardThrough(page);
    expect(pending.has("a")).toBe(false);
    expect(pending.snapshotValues()).toEqual([
      { seq: values, id: "a", values: { status: "pending" } },
    ]);
    expect(pending.failed.has("a")).toBe(true);
  });

  it("rejects a record values object passed to the Page patch API", () => {
    const pending = new PendingEdits();
    expect(() =>
      pending.add("a", { title: "wrong", values: { status: "bad" } } as any),
    ).toThrow("Unsupported Page patch field");
    expect(pending.sequence).toBe(0);
    expect(pending.size).toBe(0);
    const page = { id: "a", title: "before", doc: blankDoc() } as Page;
    expect(pending.merge([page])[0]).not.toHaveProperty("values");
  });

  it("does not lose special property keys when folding changes", () => {
    const pending = new PendingEdits();
    pending.addValues(
      "a",
      JSON.parse('{"__proto__":"safe","constructor":"value"}'),
    );
    const result = pending.mergeValues("a", {});
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toBe("safe");
    expect(result.constructor).toBe("value");
  });
});
