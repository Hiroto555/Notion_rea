export { documentSchema } from "../../../src/shared/editor-schema";
export { validDocument } from "../../../src/shared/validation";
export {
  versionDocument,
  validRichNode,
} from "../../../src/shared/rich-document";
export { BLOCK_TYPES } from "../../../src/editor/block-identity";
export {
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
} from "@tiptap/pm/state";
export { EditorView } from "@tiptap/pm/view";
export { Step, Transform } from "@tiptap/pm/transform";
export { Slice, Fragment } from "@tiptap/pm/model";
export { history, undo, redo, closeHistory } from "@tiptap/pm/history";
export {
  collab,
  sendableSteps,
  receiveTransaction,
  getVersion,
} from "prosemirror-collab";
export * as Y from "yjs";
export {
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  undo as yUndo,
  redo as yRedo,
  prosemirrorToYDoc,
  prosemirrorToYXmlFragment,
  yDocToProsemirrorJSON,
} from "y-prosemirror";
export { richStructureGuardPlugin } from "../../../src/editor/rich-structure-guard";
export { inspectSharedDocument } from "../../../src/collaboration/document-input";
export { SharedDraftStore } from "../../../src/collaboration/draft-store";
export { SharedPreparationService } from "../../../src/main/shared-preparation";
