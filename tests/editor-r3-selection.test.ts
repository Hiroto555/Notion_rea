import { expect, it } from "vitest";
import {
  nestedSiblingRange,
  editNestedSiblings,
  topSiblingRange,
} from "../src/editor/blocks";
import { validDocument } from "../src/shared/validation";
import type { Doc } from "../src/shared/types";
const item = (id: string): Doc => ({
  type: "listItem",
  attrs: { id },
  content: [
    {
      type: "paragraph",
      attrs: { id: id + "-p" },
      content: [{ type: "text", text: id }],
    },
  ],
});
const doc = (): Doc => ({
  type: "doc",
  content: [
    {
      type: "bulletList",
      attrs: { id: "list" },
      content: [item("a"), item("b"), item("c"), item("d")],
    },
    { type: "paragraph", attrs: { id: "other" } },
  ],
});
it("selects and moves only current contiguous sibling identities", () => {
  const original = doc();
  expect(nestedSiblingRange(original, "a", "c")).toEqual(["a", "b", "c"]);
  expect(nestedSiblingRange(original, "a", "other")).toEqual([]);
  expect(nestedSiblingRange(original, "a", "a-p")).toEqual([]);
  const moved = editNestedSiblings(original, ["b", "c"], "up");
  expect(moved.content![0].content!.map((n) => n.attrs?.id)).toEqual([
    "b",
    "c",
    "a",
    "d",
  ]);
  expect(original.content![0].content!.map((n) => n.attrs?.id)).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
  expect(validDocument(moved)).toBe(true);
  expect(() => editNestedSiblings(original, ["a", "c"], "delete")).toThrow();
  expect(() =>
    editNestedSiblings(original, ["a", "b", "c", "d"], "delete"),
  ).toThrow();
});
it("duplicates sibling subtrees with new child identities", () => {
  const duplicated = editNestedSiblings(doc(), ["b", "c"], "duplicate");
  const nodes = duplicated.content![0].content!;
  expect(nodes.map((n) => n.content?.[0].content?.[0].text)).toEqual([
    "a",
    "b",
    "b",
    "c",
    "c",
    "d",
  ]);
  expect(nodes[2].attrs?.id).not.toBe("b");
  expect(nodes[2].content?.[0].attrs?.id).not.toBe("b-p");
  expect(validDocument(duplicated)).toBe(true);
});

it("resolves shift selection from current IDs after insertion and rejects removed endpoints", () => {
  const content = ["new", "a", "b", "c"].map((id) => ({
    type: "paragraph",
    attrs: { id },
  }));
  expect(topSiblingRange(content, "a", "c")).toEqual(["a", "b", "c"]);
  expect(topSiblingRange(content, "a", "removed")).toEqual([]);
  expect(topSiblingRange(content, "removed", "c")).toEqual([]);
});
