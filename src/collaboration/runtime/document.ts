import { versionDocument } from "../../shared/rich-document";
import { documentSchema } from "../../shared/editor-schema";
import { validDocument } from "../../shared/validation";
import { inspectSharedDocument } from "../document-input";
import type { Doc } from "../../shared/types";
import { clone, demand, type DocumentState } from "./contract";
import { canonical } from "./canonical";
export type LocatedNode = {
  node: Doc;
  parent: Doc;
  index: number;
  ancestors: string[];
};
export function locate(document: Doc, id: string): LocatedNode {
  let found: LocatedNode | undefined;
  function walk(parent: Doc, ancestors: string[]) {
    for (let i = 0; i < (parent.content?.length ?? 0); i++) {
      const node = parent.content![i];
      if (node.attrs?.id === id) {
        demand(!found, "DUPLICATE_ID");
        found = { node, parent, index: i, ancestors };
      }
      walk(node, [
        ...ancestors,
        ...(typeof node.attrs?.id === "string" ? [node.attrs.id] : []),
      ]);
    }
  }
  walk(document, []);
  demand(found, "NODE_MISSING");
  return found;
}
export function nodeText(node: Doc): string {
  return node.type === "text"
    ? (node.text ?? "")
    : (node.content ?? []).map(nodeText).join("");
}
export function checkedState(state: DocumentState): DocumentState {
  const parsed = inspectSharedDocument(canonical(state.document, 2_000_000));
  demand(parsed.ok, parsed.ok ? "" : "UNSUPPORTED_DOCUMENT:" + parsed.code);
  return { ...clone(state), document: parsed.document };
}
export function initialState(document: Doc): DocumentState {
  return checkedState({ document, tables: [], tombstones: [] });
}

/** Only engine-generated transforms may normalize adjacent equivalent text runs.
 * External/raw documents still go through initialState/checkedState lossless checks. */
export function materializedState(state: DocumentState): DocumentState {
  state = {...state, document: versionDocument(state.document)};
  demand(validDocument(state.document), "UNSUPPORTED_DOCUMENT");
  const document = documentSchema.nodeFromJSON(state.document).toJSON() as Doc;
  document.schemaVersion = state.document.schemaVersion;
  return checkedState({ ...state, document });
}
