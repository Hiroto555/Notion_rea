import { expect, it } from "vitest";
import { createPageTree, pageDropPosition } from "../src/renderer/page-tree";
import { blankDoc, type Page } from "../src/shared/types";

function page(
  id: string,
  parentId: string | null,
  position: number,
  patch: Partial<Page> = {},
): Page {
  return {
    id,
    parentId,
    position,
    title: id,
    icon: "",
    cover: "",
    doc: blankDoc(),
    database: null,
    kind: "page",
    favorite: false,
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...patch,
  };
}

it("uses the top and bottom quarters for before and after", () => {
  expect(
    [100, 109, 110, 120, 129, 130, 139].map((y) =>
      pageDropPosition(y, 100, 40),
    ),
  ).toEqual([
    "before",
    "before",
    "inside",
    "inside",
    "inside",
    "after",
    "after",
  ]);
});

it("resolves before, inside and after using the same ordered siblings as the tree", () => {
  const tree = createPageTree(
    [
      page("tail", "parent", 7),
      page("parent", null, 1),
      page("child", "target", 1),
      page("owner", "parent", 6, { kind: "database" }),
      page("target", "parent", 1),
      page("trash", "parent", 2, { deletedAt: 2 }),
      page("source", "parent", 3),
      page("record", "parent", 4),
    ],
    new Set(["record"]),
    new Set(["owner"]),
  );

  expect(tree.children("parent").map(({ id }) => id)).toEqual([
    "target",
    "source",
    "owner",
    "tail",
  ]);
  expect(tree.destination("source", "target", "before")).toEqual({
    parentId: "parent",
    beforeId: "target",
  });
  expect(tree.destination("source", "target", "inside")).toEqual({
    parentId: "target",
    beforeId: null,
  });
  expect(tree.destination("source", "target", "after")).toEqual({
    parentId: "parent",
    beforeId: "owner",
  });
  expect(tree.destination("source", "tail", "after")).toEqual({
    parentId: "parent",
    beforeId: null,
  });
  expect(tree.destination("source", null, "inside")).toEqual({
    parentId: null,
    beforeId: null,
  });
  expect(tree.destination("source", "owner", "before")).toEqual({
    parentId: "parent",
    beforeId: "owner",
  });
  expect(tree.destination("source", "owner", "after")).toEqual({
    parentId: "parent",
    beforeId: "tail",
  });
  expect(tree.destination("source", "owner", "inside")).toBeNull();
  expect(tree.destination("owner", "source", "before")).toBeNull();
});

it("rejects self, descendants and unavailable targets, including those in the move dialog", () => {
  const tree = createPageTree(
    [
      page("source", null, 1),
      page("child", "source", 1),
      page("grandchild", "child", 1),
      page("trash", null, 2, { deletedAt: 0 }),
      page("under-trash", "trash", 1),
      page("unreadable", null, 3, { documentError: "unsupported" }),
      page("record", null, 4),
      page("legacy-db", null, 5, { kind: "database" }),
    ],
    new Set(["record"]),
    new Set(),
  );

  for (const target of [
    "source",
    "child",
    "grandchild",
    "trash",
    "under-trash",
    "unreadable",
    "record",
    "missing",
  ]) {
    for (const position of ["before", "inside", "after"] as const) {
      expect(tree.destination("source", target, position)).toBeNull();
    }
  }
  expect(tree.destination("source", "legacy-db", "inside")).toEqual({
    parentId: "legacy-db",
    beforeId: null,
  });
});

it("blocks moving a subtree with a hidden record or trashed registered database", () => {
  const tree = createPageTree(
    [
      page("root", null, 1),
      page("branch", "root", 1),
      page("record", "branch", 1),
      page("other", null, 2),
      page("owner", "other", 1, { kind: "database", deletedAt: 1 }),
      page("ordinary", null, 3),
    ],
    new Set(["record"]),
    new Set(["owner"]),
  );

  for (const id of ["root", "branch", "record", "other", "owner", "missing"]) {
    expect(tree.canMove(id)).toBe(false);
    expect(tree.destination(id, null, "inside")).toBeNull();
  }
  expect(tree.canMove("ordinary")).toBe(true);
  expect(tree.destination("ordinary", "root", "inside")).toEqual({
    parentId: "root",
    beforeId: null,
  });
});
