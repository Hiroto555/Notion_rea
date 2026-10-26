import { it, expect } from "vitest";
import { PendingEdits } from "../src/renderer/pending-edits";
import { blankDoc, type Page } from "../src/shared/types";
import { documentSchema } from "../src/shared/editor-schema";
import { findText } from "../src/editor/text-search";
import { composing } from "../src/shared/keyboard";
it("F11 old ACK and refresh preserve newer patches; failed entries remain exportable", () => {
  const edits = new PendingEdits(),
    old = edits.add("p", { title: "first" }),
    latest = edits.add("p", { title: "latest" });
  edits.failed.add("p");
  expect(edits.patch("p", old)).toEqual({ title: "first" });
  edits.ack("p", old);
  expect(
    edits.merge([
      { id: "p", revision: 5, title: "stale", doc: blankDoc() } as Page,
    ])[0],
  ).toMatchObject({ title: "latest", revision: 5 });
  expect(edits.snapshot()[0].patch.title).toBe("latest");
  edits.discardThrough(old);
  expect(edits.has("p")).toBe(true);
  edits.ack("p", latest);
  expect(edits.size).toBe(0);
});
it("F02 page search spans formatting and hardBreak with matching positions", () => {
  const doc = documentSchema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "不" },
          { type: "text", text: "動", marks: [{ type: "bold" }] },
          { type: "text", text: "産" },
          { type: "hardBreak" },
          { type: "text", text: "software" },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "next" }] },
    ],
  });
  expect(findText(doc, "不動産")).toEqual([{ from: 1, to: 4 }]);
  expect(findText(doc, "産\nsoft")).toEqual([{ from: 3, to: 9 }]);
  expect(findText(doc, "softwarenext")).toEqual([]);
});
it("F06 IME flags and legacy keyCode 229 suppress commands", () => {
  expect(composing({ isComposing: true })).toBe(true);
  expect(composing({ keyCode: 229 })).toBe(true);
  expect(composing({}, true)).toBe(true);
  expect(composing({})).toBe(false);
});
