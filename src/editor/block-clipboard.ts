import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { validDocument } from "../shared/validation";
import { fileFits } from "../shared/limits";
import { freshPastedSlice } from "./block-identity";

export const BLOCK_CLIPBOARD_TYPE = "application/x-folio-blocks+json";
const EXPIRY_MS = 5 * 60_000;
type Payload = {
  format: "folio-blocks";
  version: 1;
  documentId: string;
  operation: "copy" | "cut";
  token: string;
  nodes: unknown[];
  context?: "bulletList" | "orderedList" | "taskList";
};
type Token = { raw: string; expires: number };

/** Tokens are scoped to the mounted editor instance, never trusted from HTML. */
export class BlockClipboard {
  private cut: Token | null = null;
  constructor(private readonly documentId: string) {}

  serialize(
    nodes: PMNode[],
    operation: "copy" | "cut",
    context?: Payload["context"],
  ): string {
    if (!nodes.length) throw new Error("ブロックが選択されていません。");
    const raw = JSON.stringify({
      format: "folio-blocks",
      version: 1,
      documentId: this.documentId,
      operation,
      token: globalThis.crypto.randomUUID(),
      nodes: nodes.map((n) => n.toJSON()),
      ...(context ? { context } : {}),
    } satisfies Payload);
    if (!fileFits(raw)) throw new Error("クリップボードの内容が大きすぎます。");
    return raw;
  }

  forget(): void {
    this.cut = null;
  }

  /** Call only after the clipboard write and cut transaction both succeed. */
  confirmCut(raw: string, now = Date.now()): void {
    this.cut = { raw, expires: now + EXPIRY_MS };
  }

  preparePaste(
    state: EditorState,
    raw: string,
    now = Date.now(),
  ): { tr: Transaction; consume: () => void; preserved: boolean } {
    // Observing another clipboard payload invalidates the previous cut token;
    // an unsuccessful paste of the original payload must retain it.
    if (this.cut && this.cut.raw !== raw) this.cut = null;
    if (!fileFits(raw)) throw new Error("クリップボードの内容が大きすぎます。");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("クリップボードの形式が不正です。");
    }
    const p = value as Payload;
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      p.format !== "folio-blocks" ||
      p.version !== 1 ||
      typeof p.documentId !== "string" ||
      typeof p.token !== "string" ||
      !p.token ||
      !["copy", "cut"].includes(p.operation) ||
      !Array.isArray(p.nodes) ||
      !p.nodes.length ||
      (p.context !== undefined &&
        !["bulletList", "orderedList", "taskList"].includes(p.context)) ||
      Object.keys(p).some(
        (k) =>
          ![
            "format",
            "version",
            "documentId",
            "operation",
            "token",
            "nodes",
            "context",
          ].includes(k),
      )
    )
      throw new Error("クリップボードの形式が不正です。");
    if (p.operation === "cut" && p.documentId !== this.documentId)
      throw new Error(
        "ページ間の切り取り移動には対応していません。元の内容はクリップボードに残っています。",
      );
    const source = {
      type: "doc",
      content: p.context ? [{ type: p.context, content: p.nodes }] : p.nodes,
    };
    if (!validDocument(source))
      throw new Error("クリップボードの文書を読み込めません。");
    const sourceDoc = state.schema.nodeFromJSON(source);
    sourceDoc.check();
    const sourceIds = collectIds(sourceDoc);
    const present = collectIds(state.doc);
    const preserved =
      p.operation === "cut" &&
      p.documentId === this.documentId &&
      this.cut?.raw === raw &&
      this.cut.expires >= now &&
      sourceIds.every((id) => !present.includes(id));
    let slice = new Slice(
      p.context ? sourceDoc.firstChild!.content : sourceDoc.content,
      0,
      0,
    );
    if (!preserved) slice = freshPastedSlice(slice);
    const inserted: PMNode[] = [];
    slice.content.forEach((node) => inserted.push(node));
    let tr: Transaction;
    try {
      tr = closeHistory(state.tr).replaceSelection(slice);
      tr.doc.check();
      if (
        !validDocument(tr.doc.toJSON()) ||
        !fileFits(JSON.stringify(tr.doc.toJSON()))
      )
        throw new Error();
      // ProseMirror may fit or split the slice; never silently lose a block.
      for (const node of inserted) {
        const id = node.attrs.id;
        let found: PMNode | null = null;
        tr.doc.descendants((candidate) => {
          if (candidate.attrs.id === id) found = candidate;
        });
        if (!id || !found || !(found as PMNode).eq(node)) throw new Error();
      }
    } catch {
      throw new Error(
        "この位置にはブロックを貼り付けられません。内容は保持しています。",
      );
    }
    return {
      tr: tr
        .setMeta("paste", true)
        .setMeta("uiEvent", "paste")
        .scrollIntoView(),
      preserved: !!preserved,
      consume: () => {
        if (this.cut?.raw === raw) this.cut = null;
      },
    };
  }
}

function collectIds(doc: PMNode): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (typeof node.attrs.id === "string" && node.attrs.id)
      ids.push(node.attrs.id);
  });
  return ids;
}
