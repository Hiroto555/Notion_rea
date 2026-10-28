import { expect, it } from "vitest";
import { PendingEdits } from "../src/renderer/pending-edits";
import type { Page } from "../src/shared/types";

it("overlays Page and atomic record edits in shared generation order without modifying document, revision or source", () => {
  const edits = new PendingEdits();
  const doc = { type: "doc", content: [{ type: "paragraph" }] };
  const source = { id: "a", title: "server", doc, revision: 12 } as Page;
  const values = { status: "old", due: "today", untouched: true };
  edits.add("a", { title: "page first" });
  const record = edits.addRecord(
    "a",
    12,
    { title: "record middle", values: { status: "open", due: null } },
    true,
  );
  edits.addValues("a", { status: "done", counter: 5 });
  edits.add("a", { title: "page later" });
  edits.addRecord(
    "a",
    12,
    { title: "record latest", values: { counter: null, final: true } },
    true,
  );
  const merged = edits.merge([source])[0];
  expect(merged).toMatchObject({
    id: "a",
    title: "record latest",
    revision: 12,
    doc,
  });
  expect(merged).not.toHaveProperty("values");
  expect(edits.valuesPatch("a", record)).toEqual({ status: "open", due: null });
  expect(edits.mergeValues("a", values)).toEqual({
    status: "done",
    untouched: true,
    final: true,
  });
  expect(source.title).toBe("server");
  expect(source.doc).toEqual(doc);
  expect(source.revision).toBe(12);
  expect(values).toEqual({ status: "old", due: "today", untouched: true });
});

it("isolates other records and preserves deletions through a generation cutoff", () => {
  const edits = new PendingEdits();
  const first = edits.addRecord(
    "a",
    0,
    { values: { status: null, prior: "value" } },
    true,
  );
  edits.addRecord(
    "b",
    0,
    { title: "other", values: { status: "foreign" } },
    true,
  );
  edits.addValues("a", { status: "restored", prior: null });
  expect(edits.mergeValues("a", { status: "server", keep: 1 }, first)).toEqual({
    keep: 1,
    prior: "value",
  });
  expect(edits.mergeValues("a", { status: "server", keep: 1 })).toEqual({
    status: "restored",
    keep: 1,
  });
  expect(edits.valuesPatch("b")).toEqual({ status: "foreign" });
});
