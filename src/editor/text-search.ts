import type { Node } from "@tiptap/pm/model";
// Position projection uses the same inline/block separators as textOf.
export function findText(
  doc: Node,
  query: string,
): { from: number; to: number }[] {
  const chars: string[] = [],
    positions: number[] = [];
  function walk(node: Node, pos: number) {
    if (node.isText) {
      for (let i = 0; i < node.text!.length; i++) {
        chars.push(node.text![i]);
        positions.push(pos + i);
      }
      return;
    }
    if (node.type.name === "hardBreak") {
      chars.push("\n");
      positions.push(pos);
      return;
    }
    let index = 0;
    node.forEach((child, offset) => {
      if (
        index++ &&
        !["paragraph", "heading", "codeBlock", "detailsSummary"].includes(
          node.type.name,
        )
      ) {
        chars.push("\n");
        positions.push(pos + offset);
      }
      walk(child, (node.type.name === "doc" ? pos : pos + 1) + offset);
    });
  }
  walk(doc, 0);
  if (!query) return [];
  const text = chars.join("").toLocaleLowerCase(),
    needle = query.toLocaleLowerCase(),
    result: { from: number; to: number }[] = [];
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + needle.length)
  )
    result.push({
      from: positions[at],
      to: positions[at + needle.length - 1] + 1,
    });
  return result;
}
