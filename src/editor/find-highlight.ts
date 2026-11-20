import type { EditorView } from "@tiptap/pm/view";

type LooseRange = {
  setStart: (node: unknown, offset: number) => void;
  setEnd: (node: unknown, offset: number) => void;
};
type HighlightEnv = {
  CSS?: { highlights?: { delete: (name: string) => void; set: (name: string, highlight: unknown) => void } };
  Highlight?: new (...ranges: unknown[]) => unknown;
  document?: { createRange: () => LooseRange };
};

/** Current-match marker via the CSS Custom Highlight API: the editor selection
 * moves to a match, and this paints a distinct band without touching the DOM. */
export function setFindHighlight(
  view: Pick<EditorView, "domAtPos"> | null,
  match: { from: number; to: number } | null,
  env: HighlightEnv = globalThis as HighlightEnv,
): void {
  try {
    const highlights = env.CSS?.highlights;
    if (!highlights) return;
    highlights.delete("folio-find");
    if (!view || !match || !env.Highlight || !env.document) return;
    const from = view.domAtPos(match.from), to = view.domAtPos(match.to);
    const range = env.document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    highlights.set("folio-find", new env.Highlight(range));
  } catch {
    // Progressive enhancement: older Chromium simply keeps the text selection.
  }
}
