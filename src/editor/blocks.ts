import type { Doc } from "../shared/types";
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
      set.has(i) ? [n, structuredClone(n)] : [n],
    );
  const kept = content.filter((_, i) => !set.has(i)),
    at = Math.max(
      0,
      Math.min(kept.length, target - selected.filter((i) => i < target).length),
    );
  kept.splice(at, 0, ...selected.map((i) => content[i]));
  return kept;
}
