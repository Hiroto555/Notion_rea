import { Node, mergeAttributes, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { findWrapping } from "@tiptap/pm/transform";
import { renderRichBlockHTML } from "../document-io/rich-block-html";

export const CALLOUT_TONES = ["note", "tip", "warning"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

export function isCalloutTone(value: unknown): value is CalloutTone {
  return (
    typeof value === "string" &&
    (CALLOUT_TONES as readonly string[]).includes(value)
  );
}

type CalloutLocation = {
  pos: number;
  node: ProseMirrorNode;
};

function findCalloutAncestor(
  state: EditorState,
  type: NodeType,
  pos: number,
): CalloutLocation | null {
  const safe = Math.max(0, Math.min(pos, state.doc.content.size));
  const $pos = state.doc.resolve(safe);
  // Deepest callout wins: an inner callout is the nearest one to the cursor.
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type === type) return { pos: $pos.before(depth), node };
  }
  return null;
}

function selectedCallout(
  state: EditorState,
  type: NodeType,
): CalloutLocation | null {
  const selection = state.selection;
  if (selection instanceof NodeSelection && selection.node.type === type)
    return { pos: selection.from, node: selection.node };
  // Checking both ends avoids wrapping a callout around blocks that are
  // already inside it when a selection is dragged outward from its content.
  return (
    findCalloutAncestor(state, type, selection.from) ??
    findCalloutAncestor(state, type, selection.to)
  );
}

function applyTone(
  tr: Transaction,
  location: CalloutLocation,
  tone: CalloutTone,
): true {
  if (location.node.attrs.tone !== tone)
    tr.setNodeMarkup(
      location.pos,
      undefined,
      { ...location.node.attrs, tone },
      location.node.marks,
    );
  return true;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (tone?: CalloutTone) => ReturnType;
      setCalloutTone: (tone: CalloutTone) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: "callout",
  content: "block+",
  group: "block",
  defining: true,
  addOptions() {
    return { HTMLAttributes: {} };
  },
  addAttributes() {
    return {
      tone: {
        default: "note" as CalloutTone,
        // Preserve an unknown data-tone in the JSON. The parent validator is
        // responsible for rejecting it; silently relabeling it as "note"
        // would hide corrupt input.
        parseHTML: (element) => {
          const tone = element.getAttribute("data-tone");
          return tone === null ? "note" : tone;
        },
        // HTML output is always restricted to the known enum.
        renderHTML: (attributes) => ({
          "data-tone": isCalloutTone(attributes.tone)
            ? attributes.tone
            : "note",
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "aside[data-folio-callout]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "aside",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-folio-callout": "",
      }),
      0,
    ];
  },
  renderMarkdown(node: JSONContent) {
    return renderRichBlockHTML(node);
  },
  addCommands() {
    return {
      setCallout:
        (tone = "note") =>
        ({ state, tr, editor }) => {
          if (!editor.isEditable || editor.view.composing) return false;
          if (!isCalloutTone(tone)) return false;

          // Wrapping an existing callout would create an accidental nested
          // callout. Change the nearest one instead.
          const existing = selectedCallout(state, this.type);
          if (existing) return applyTone(tr, existing, tone);

          const { $from, $to } = state.selection;
          const range = $from.blockRange($to);
          if (!range) return false;
          const wrapping = findWrapping(range, this.type, { tone });
          if (!wrapping) return false;
          tr.wrap(range, wrapping);
          return true;
        },
      setCalloutTone:
        (tone) =>
        ({ state, tr, editor }) => {
          if (!editor.isEditable || editor.view.composing) return false;
          if (!isCalloutTone(tone)) return false;
          const existing = selectedCallout(state, this.type);
          if (!existing) return false;
          return applyTone(tr, existing, tone);
        },
      unsetCallout:
        () =>
        ({ state, tr, editor }) => {
          if (!editor.isEditable || editor.view.composing) return false;
          const existing = selectedCallout(state, this.type);
          if (!existing) return false;

          const { pos, node } = existing;
          // Replace only the wrapper. Child nodes are reused verbatim, so
          // every block and inline ID survives the lift.
          const $pos = state.doc.resolve(pos);
          if (
            !$pos.parent.canReplace(
              $pos.index(),
              $pos.index() + 1,
              node.content,
            )
          )
            return false;

          // The removed wrapper occupies one token on each side of its
          // content. Remember a selection inside it before replaceWith maps
          // the collapsed range to its end.
          const previous = state.selection;
          const nodeSelected =
            previous instanceof NodeSelection && previous.node === node;
          const inside =
            !nodeSelected &&
            previous.from >= pos &&
            previous.to <= pos + node.nodeSize;
          tr.replaceWith(pos, pos + node.nodeSize, node.content);
          if (nodeSelected) {
            tr.setSelection(
              Selection.near(
                tr.doc.resolve(Math.min(pos, tr.doc.content.size)),
                1,
              ),
            );
          } else if (inside) {
            const from = Math.min(
              tr.doc.content.size,
              Math.max(pos, previous.from - 1),
            );
            const to = Math.min(
              tr.doc.content.size,
              Math.max(pos, previous.to - 1),
            );
            const $from = tr.doc.resolve(from);
            tr.setSelection(
              from !== to &&
                $from.parent.inlineContent &&
                tr.doc.resolve(to).parent.inlineContent
                ? TextSelection.create(tr.doc, from, to)
                : Selection.near($from, 1),
            );
          }
          return true;
        },
    };
  },
});
