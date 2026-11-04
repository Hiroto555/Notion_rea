import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from "../shared/rich-document";
/** Reject an invalid shape before tableEditing can silently repair it. IDs are
 * deliberately left to BlockIdentity's appendTransaction. */
export const RichStructureGuard = Extension.create<{ onRejected: () => void }>({
  name: "folioRichStructureGuard",
  addOptions() {
    return { onRejected: () => {} };
  },
  addProseMirrorPlugins() {
    const reject = this.options.onRejected;
    return [
      new Plugin({
        filterTransaction(tr) {
          if (!tr.docChanged) return true;
          let valid = true;
          tr.doc.descendants((node) => {
            if (!valid) return false;
            if (node.type.name === "table") {
              const width = node.firstChild?.childCount ?? 0;
              if (
                !node.childCount ||
                node.childCount > MAX_TABLE_ROWS ||
                !width ||
                width > MAX_TABLE_COLUMNS
              )
                valid = false;
              node.forEach((row) => {
                if (row.childCount !== width) valid = false;
              });
            } else if (["tableCell", "tableHeader"].includes(node.type.name)) {
              if (
                node.attrs.colspan !== 1 ||
                node.attrs.rowspan !== 1 ||
                node.attrs.colwidth !== null
              )
                valid = false;
            } else if (
              node.type.name === "callout" &&
              !["note", "tip", "warning"].includes(node.attrs.tone)
            )
              valid = false;
            return valid;
          });
          if (!valid) queueMicrotask(reject);
          return valid;
        },
      }),
    ];
  },
});
