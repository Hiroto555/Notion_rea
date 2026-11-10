import type { Doc } from "../../shared/types";
import type { TextCommand } from "./contract";
import { demand, clone } from "./contract";
import { canonical } from "./canonical";
import { initialState, nodeText } from "./document";
/** Narrow normal-Editor seam: same structure/marks, one plain textblock change.
 * Rejected rich/structural drafts are retained by main before this conversion. */
export function editorTextIntent(before: Doc, after: Doc): TextCommand | null {
  before = initialState(before).document;
  after = initialState(after).document;
  let result: TextCommand | null = null;
  function visit(a: Doc, b: Doc) {
    if (canonical(a) === canonical(b)) return;
    demand(
      a.type === b.type &&
        canonical(a.attrs ?? null) === canonical(b.attrs ?? null),
      "EDITOR_STRUCTURE_NOT_ADOPTED",
    );
    const textblock = [
      "paragraph",
      "heading",
      "codeBlock",
      "detailsSummary",
    ].includes(a.type);
    if (textblock) {
      demand(typeof a.attrs?.id === "string", "MISSING_BLOCK_ID");
      for (const n of [...(a.content ?? []), ...(b.content ?? [])])
        demand(
          n.type === "text" && !n.marks?.length,
          "EDITOR_RICH_NOT_ADOPTED",
        );
      const old = nodeText(a),
        next = nodeText(b);
      let from = 0;
      while (
        from < old.length &&
        from < next.length &&
        old[from] === next[from]
      )
        from++;
      let suffix = 0;
      while (
        suffix < old.length - from &&
        suffix < next.length - from &&
        old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
      )
        suffix++;
      // expand a shared surrogate half into the replacement rather than splitting it.
      if (from > 0 && /[\uDC00-\uDFFF]/.test(old[from] ?? next[from] ?? ""))
        from--;
      if (
        suffix > 0 &&
        /[\uDC00-\uDFFF]/.test(
          old[old.length - suffix] ?? next[next.length - suffix] ?? "",
        )
      )
        suffix--;
      demand(result === null, "EDITOR_MULTI_BLOCK_NOT_ADOPTED");
      result = {
        kind: "text",
        blockId: a.attrs!.id as string,
        before: old,
        from,
        to: old.length - suffix,
        text: next.slice(from, next.length - suffix),
      };
      return;
    }
    const left = clone(a),
      right = clone(b);
    delete left.content;
    delete right.content;
    demand(
      canonical(left) === canonical(right),
      "EDITOR_STRUCTURE_NOT_ADOPTED",
    );
    demand(
      (a.content?.length ?? 0) === (b.content?.length ?? 0),
      "EDITOR_STRUCTURE_NOT_ADOPTED",
    );
    for (let i = 0; i < (a.content?.length ?? 0); i++)
      visit(a.content![i], b.content![i]);
  }
  visit(before, after);
  return result;
}
