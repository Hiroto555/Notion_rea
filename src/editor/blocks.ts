import type { Doc } from "../shared/types";
function cloneWithFreshIds(node: Doc): Doc {
  const copy = structuredClone(node);
  const visit = (n: Doc) => {
    if (n.attrs?.id) n.attrs.id = globalThis.crypto.randomUUID();
    n.content?.forEach(visit);
  };
  visit(copy);
  return copy;
}
export function editBlocks(
  content: Doc[],
  indices: number[],
  action: "duplicate" | "delete" | "move",
  target = 0,
): Doc[] {
  const selected = [...new Set(indices)]
    .filter((i) => i >= 0 && i < content.length)
    .sort((a, b) => a - b);
  if (!selected.length) return content;
  const set = new Set(selected);
  if (action === "delete") {
    const rest = content.filter((_, i) => !set.has(i));
    return rest.length ? rest : [{ type: "paragraph" }];
  }
  if (action === "duplicate")
    return content.flatMap((n, i) =>
      set.has(i) ? [n, cloneWithFreshIds(n)] : [n],
    );
  const kept = content.filter((_, i) => !set.has(i)),
    at = Math.max(
      0,
      Math.min(kept.length, target - selected.filter((i) => i < target).length),
    );
  kept.splice(at, 0, ...selected.map((i) => content[i]));
  return kept;
}

// Nested actions address a stable ID, not a stale screen position. Movement is
// between parents is accepted only if the caller validates the resulting schema.
// Cycles and stale targets are rejected before the saved document is replaced.
export function editNestedBlock(
  doc: Doc,
  id: string,
  action: "duplicate" | "delete" | "up" | "down" | "before",
  beforeId?: string,
): Doc {
  const copy = structuredClone(doc);
  type Location = { siblings: Doc[]; index: number };
  const find = (nodes: Doc[], wanted: string): Location | undefined => {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].attrs?.id === wanted) return { siblings: nodes, index: i };
      const nested = nodes[i].content && find(nodes[i].content!, wanted);
      if (nested) return nested;
    }
  };
  const source = find(copy.content ?? [], id);
  if (!source) throw new Error("対象ブロックが見つかりません");
  if (action === "duplicate") {
    source.siblings.splice(
      source.index + 1,
      0,
      cloneWithFreshIds(source.siblings[source.index]),
    );
  } else if (action === "delete") {
    if (source.siblings.length === 1)
      throw new Error("最後のブロックは削除できません");
    source.siblings.splice(source.index, 1);
  } else {
    let target = action === "up" ? source.index - 1 : source.index + 2;
    if (action === "before") {
      const destination = beforeId && find(copy.content ?? [], beforeId);
      if (!destination) throw new Error("移動先のブロックが見つかりません");
      const node = source.siblings[source.index];
      if (node.attrs?.id === beforeId) return doc;
      if (node.content && beforeId && find(node.content, beforeId))
        throw new Error("ブロックを自身の子孫へは移動できません");
      if (destination.siblings !== source.siblings) {
        source.siblings.splice(source.index, 1);
        destination.siblings.splice(destination.index, 0, node);
        return copy;
      }
      target = destination.index;
    }
    const moved = editBlocks(source.siblings, [source.index], "move", target);
    source.siblings.splice(0, source.siblings.length, ...moved);
  }
  return copy;
}
