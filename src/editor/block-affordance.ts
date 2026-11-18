import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, type Selection } from "@tiptap/pm/state";

/** Which block-handle an interaction is currently targeting. */
export type BlockHandleTarget = { id: string; nested: boolean };

/**
 * The nested-handle eligibility rule shared by the handle layout and
 * pointer/caret targeting: textblocks, atoms and list/task items below the
 * top level, except contents of table cells (cell editing has dedicated
 * controls; paragraph handles would cover adjacent cells and expose generic
 * operations on table internals), the details wrappers, and a list item's
 * first paragraph, whose line is already covered by the item's own handle.
 */
export function nestedHandleEligible(
  node: PMNode,
  parent: PMNode | null | undefined,
  index: number,
): boolean {
  if (!parent || parent.type.name === "doc") return false;
  if (["tableCell", "tableHeader"].includes(parent.type.name)) return false;
  if (
    !(
      node.isTextblock ||
      node.isAtom ||
      ["listItem", "taskItem"].includes(node.type.name)
    )
  )
    return false;
  if (["detailsSummary", "detailsContent"].includes(node.type.name))
    return false;
  return !(
    node.type.name === "paragraph" &&
    index === 0 &&
    ["listItem", "taskItem"].includes(parent.type.name)
  );
}

const idOf = (node: PMNode | null | undefined): string | null =>
  node && typeof node.attrs.id === "string" && node.attrs.id
    ? node.attrs.id
    : null;

/**
 * Resolve the single block-handle target for a document position, following
 * the same eligibility the rendered handles use: the deepest eligible nested
 * ancestor first (so gaps, excluded list first paragraphs and table cell
 * contents resolve through their parents), then the top-level block.
 *
 * This is a pure read: it creates no transaction or selection and never
 * touches history, so pointer/visibility tracking cannot modify the
 * document, its IDs, the saved body or the undo stack.
 */
export function handleTargetAt(
  doc: PMNode,
  pos: number,
): BlockHandleTarget | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const depth = $pos.depth;
  // Positions at a block boundary (atom nodes, gaps between children) point
  // into the parent; an eligible adjacent block is the nearer target.
  if (depth >= 1) {
    const parent = $pos.parent;
    const next = $pos.index(depth);
    for (const [sibling, index] of [
      [$pos.nodeBefore, next - 1],
      [$pos.nodeAfter, next],
    ] as const) {
      const id = idOf(sibling);
      if (sibling && id && nestedHandleEligible(sibling, parent, index))
        return { id, nested: parent.type.name !== "doc" };
    }
  }
  for (let d = depth; d >= 2; d--) {
    const node = $pos.node(d);
    const id = idOf(node);
    if (id && nestedHandleEligible(node, $pos.node(d - 1), $pos.index(d - 1)))
      return { id, nested: true };
  }
  const top =
    depth >= 1
      ? $pos.node(1)
      : (doc.maybeChild($pos.index(0)) ?? doc.lastChild);
  const id = idOf(top);
  return id ? { id, nested: false } : null;
}

/**
 * The caret block for the localized keyboard cue, kept separate from pointer
 * targeting. Text selections anchor on the head so a reversed or extended
 * selection cues the block actually holding the caret.
 *
 * A NodeSelection's head sits *after* the selected node, so resolving head
 * would name the following block whenever the node is not last. Instead the
 * selected node itself resolves through the same eligibility the rendered
 * handles use: an eligible selected node cues its own handle, an excluded or
 * unidentifiable one ascends its real ancestors — never an adjacent sibling.
 */
export function caretTargetAt(
  doc: PMNode,
  selection: Selection,
): BlockHandleTarget | null {
  if (selection instanceof NodeSelection) {
    const $from = selection.$from;
    const node = selection.node;
    const id = idOf(node);
    if (
      id &&
      ($from.depth === 0 ||
        nestedHandleEligible(node, $from.parent, $from.index()))
    )
      return { id, nested: $from.depth > 0 };
    for (let d = $from.depth; d >= 1; d--) {
      const ancestor = $from.node(d);
      const aid = idOf(ancestor);
      if (
        aid &&
        nestedHandleEligible(ancestor, $from.node(d - 1), $from.index(d - 1))
      )
        return { id: aid, nested: true };
    }
    const top =
      $from.depth >= 1 ? $from.node(1) : doc.maybeChild($from.index(0));
    const tid = idOf(top);
    return tid ? { id: tid, nested: false } : null;
  }
  return handleTargetAt(doc, selection.head);
}

/**
 * Decide the single handle id for a direct DOM hit, using the index the
 * layout built from the actually rendered block elements (nodeDOM of every
 * eligible handle). A hit on an own grip always wins — including during HTML5
 * drag when no pointermove is sent — but only while its id is still live, so
 * a stale pre-commit grip can never keep an old id. Otherwise the innermost
 * indexed ancestor wins: adjacent atoms, custom NodeViews (e.g. the shared
 * image span) and excluded children resolve to their nearest real block
 * without any document positions, coordinate mapping or sibling guesses.
 * Chrome outside the root, foreign elements and empty space return null and
 * must clear the hover.
 */
export function resolveElementHit(input: {
  hit: Element | null;
  root: Element | null;
  index: ReadonlyMap<Element, string>;
  live: ReadonlySet<string>;
}): string | null {
  const { hit, root, index, live } = input;
  if (!hit || !root || !root.contains(hit)) return null;
  const grip = hit.closest(".block-handle");
  if (grip && root.contains(grip)) {
    const id = grip.getAttribute("data-block-id");
    return id && live.has(id) ? id : null;
  }
  for (let n: Element | null = hit; n && n !== root; n = n.parentElement) {
    const id = index.get(n);
    if (id) return id;
  }
  return null;
}

/**
 * Whether this editor's localized caret cue is visible. It requires keyboard
 * modality AND this editor's own body holding DOM focus — a Tab into another
 * editor, a sidebar or pointer use elsewhere must not light the cue here.
 */
export function caretCueVisible(input: {
  keyboard: boolean;
  windowFocused: boolean;
  ownsBody: boolean;
}): boolean {
  return input.keyboard && input.windowFocused && input.ownsBody;
}

/**
 * The class list for one rendered handle. Explicit selection marks every
 * selected block, `nearby` marks the single pointer-resolved target and
 * `caret` marks the block holding the selection so keyboard navigation and
 * coarse-pointer devices keep a localized cue instead of a page-wide
 * affordance.
 */
export function blockHandleClass(input: {
  id: string;
  nearby: string | null;
  caret: string | null;
  selected: readonly string[];
}): string {
  const classes = ["block-handle"];
  if (input.selected.includes(input.id)) classes.push("selected");
  if (input.nearby === input.id) classes.push("nearby");
  if (input.caret === input.id) classes.push("caret");
  return classes.join(" ");
}
