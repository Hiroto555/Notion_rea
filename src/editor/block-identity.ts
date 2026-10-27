import { Extension } from "@tiptap/core";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";

// IDs are scoped to one document. Containers get IDs too, so nested moves and
// descendant identities remain distinguishable from their text children.
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
  "horizontalRule",
  "image",
  "details",
  "detailsSummary",
  "detailsContent",
];
const key = new PluginKey("folioBlockIdentity");
const newId = () => globalThis.crypto.randomUUID();

export function assignBlockIds(tr: Transaction): boolean {
  const seen = new Set<string>();
  let changed = false;
  tr.doc.descendants((node, pos) => {
    if (!BLOCK_TYPES.includes(node.type.name)) return;
    let id = node.attrs.id;
    if (typeof id !== "string" || !id || seen.has(id)) {
      do {
        id = newId();
      } while (seen.has(id));
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, id }, node.marks);
      changed = true;
    }
    seen.add(id);
  });
  return changed;
}
function copyNode(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isText) return node;
  const children: ProseMirrorNode[] = [];
  node.content.forEach((child) => children.push(copyNode(child)));
  const attrs = BLOCK_TYPES.includes(node.type.name)
    ? { ...node.attrs, id: newId() }
    : node.attrs;
  return node.type.create(attrs, Fragment.fromArray(children), node.marks);
}
export function freshPastedSlice(slice: Slice): Slice {
  const nodes: ProseMirrorNode[] = [];
  slice.content.forEach((node) => nodes.push(copyNode(node)));
  return new Slice(Fragment.fromArray(nodes), slice.openStart, slice.openEnd);
}
function hasBlockId(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (BLOCK_TYPES.includes(node.type.name) && node.attrs.id) found = true;
  });
  return found;
}
export function blockIdentityPlugin() {
  return new Plugin({
    key,
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const tr = state.tr;
      return assignBlockIds(tr) ? tr : null;
    },
    props: {
      // Handle clipboard paste only; ProseMirror's transformPasted also runs on
      // drag moves, where changing IDs would destroy identity.
      handlePaste(view, _event, slice) {
        if (!hasBlockId(slice)) return false;
        view.dispatch(
          view.state.tr
            .replaceSelection(freshPastedSlice(slice))
            .scrollIntoView()
            .setMeta("paste", true)
            .setMeta("uiEvent", "paste"),
        );
        return true;
      },
      handleDrop(view, event, slice, moved) {
        // A move must keep IDs; a copy (including an external HTML drop) must
        // not steal an existing node's identity even when inserted before it.
        if (moved || !hasBlockId(slice)) return false;
        const hit = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (!hit) return false;
        const insertion = dropPoint(view.state.doc, hit.pos, slice) ?? hit.pos;
        const tr = view.state.tr.replaceRange(
          insertion,
          insertion,
          freshPastedSlice(slice),
        );
        if (!tr.doc.eq(view.state.doc))
          view.dispatch(tr.setMeta("uiEvent", "drop").scrollIntoView());
        return true;
      },
    },
  });
}
export const BlockIdentity = Extension.create({
  name: "folioBlockIdentity",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          id: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-folio-block-id"),
            renderHTML: (attrs) =>
              attrs.id ? { "data-folio-block-id": attrs.id } : {},
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [blockIdentityPlugin()];
  },
  onCreate() {
    // Populate the editor's in-memory legacy representation without writing to
    // the store. The first real edit sends it through the normal pending queue.
    const tr = this.editor.state.tr;
    if (assignBlockIds(tr))
      this.editor.view.dispatch(
        tr.setMeta("addToHistory", false).setMeta("preventUpdate", true),
      );
  },
});
