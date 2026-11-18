import type { Page, Request } from "../shared/types";

export type PageDropPosition = "before" | "inside" | "after";
type MoveDestination = Pick<
  Extract<Request, { type: "move" }>,
  "parentId" | "beforeId"
>;

export function pageDropPosition(
  clientY: number,
  top: number,
  height: number,
): PageDropPosition {
  const fraction = (clientY - top) / height;
  if (fraction < 0.25) return "before";
  if (fraction >= 0.75) return "after";
  return "inside";
}

export function createPageTree(
  pages: readonly Page[],
  recordIds: ReadonlySet<string>,
  databaseIds: ReadonlySet<string>,
) {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const byParent = new Map<string | null, Page[]>();
  for (const page of pages) {
    if (page.deletedAt !== null || recordIds.has(page.id)) continue;
    const siblings = byParent.get(page.parentId);
    if (siblings) siblings.push(page);
    else byParent.set(page.parentId, [page]);
  }
  for (const siblings of byParent.values())
    siblings.sort((a, b) => a.position - b.position);
  const children = (parentId: string | null) => byParent.get(parentId) ?? [];

  // Follow parent links from protected Pages, including trash and hidden
  // records. The Store also refuses moves that carry any of these descendants.
  const fixed = new Set([...recordIds, ...databaseIds]);
  for (const id of fixed) {
    const parent = byId.get(id)?.parentId;
    if (parent) fixed.add(parent);
  }
  const canMove = (id: string) => {
    const page = byId.get(id);
    return (
      !!page && page.deletedAt === null && !page.documentError && !fixed.has(id)
    );
  };

  function destination(
    id: string,
    targetId: string | null,
    position: PageDropPosition,
  ): MoveDestination | null {
    if (!canMove(id) || targetId === id) return null;
    if (targetId === null) return { parentId: null, beforeId: null };
    const target = byId.get(targetId);
    if (
      !target ||
      target.deletedAt !== null ||
      target.documentError ||
      recordIds.has(targetId)
    )
      return null;
    const parentId = position === "inside" ? targetId : target.parentId;
    if (
      parentId !== null &&
      (recordIds.has(parentId) || databaseIds.has(parentId))
    )
      return null;
    const seen = new Set([id]);
    for (let ancestor = parentId; ancestor !== null;) {
      const page = byId.get(ancestor);
      if (
        seen.has(ancestor) ||
        recordIds.has(ancestor) ||
        !page ||
        page.deletedAt !== null ||
        page.documentError
      )
        return null;
      seen.add(ancestor);
      ancestor = page.parentId;
    }
    if (position === "inside") return { parentId, beforeId: null };
    if (position === "before") return { parentId, beforeId: targetId };

    // "After" inserts before the next visible sibling of the target. Skip
    // the moving Page itself. Registered DBs are visible sibling anchors.
    const siblings = children(parentId);
    const index = siblings.findIndex((page) => page.id === targetId);
    const next = siblings.slice(index + 1).find((page) => page.id !== id);
    return { parentId, beforeId: next?.id ?? null };
  }

  return { children, canMove, destination };
}
