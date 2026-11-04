import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { history, redo, undo } from "@tiptap/pm/history";
import { extensions } from "../src/shared/editor-schema";
import { Callout } from "../src/editor/callout";

const baseExtensions = extensions();
// The parent integration step adds Callout to the shared extension list. Keep
// this focused test valid both before and after that merge.
const schema: Schema = getSchema(
  baseExtensions.some((extension) => extension.name === "callout")
    ? baseExtensions
    : [...baseExtensions, Callout],
);
const config = (Callout as unknown as { config: Record<string, any> }).config;
const rawCommands = config.addCommands.call({
  name: "callout",
  options: {},
  storage: {},
  editor: {},
  type: schema.nodes.callout,
  parent: undefined,
}) as Record<string, (...args: any[]) => (props: any) => boolean>;

type Result = { ok: boolean; state: EditorState; tr: Transaction };

function invoke(
  command: (props: any) => boolean,
  state: EditorState,
  dryRun = false,
): Result {
  const tr = state.tr;
  const ok = command({
    state,
    tr,
    editor: { isEditable: true, view: { composing: false } },
    dispatch: dryRun ? undefined : () => undefined,
  });
  return { ok, state: dryRun ? state : state.applyTransaction(tr).state, tr };
}

function stateWith(
  content: unknown[],
  selection?: { from: number; to?: number },
): EditorState {
  const doc = schema.nodeFromJSON({ type: "doc", content });
  let state = EditorState.create({ schema, doc, plugins: [history()] });
  if (selection) {
    const to = selection.to ?? selection.from;
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, selection.from, to),
      ),
    );
  }
  return state;
}

function textPosition(doc: ProseMirrorNode, text: string): number {
  let position = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      position = pos;
      return false;
    }
  });
  if (position < 0) throw new Error(`missing text: ${text}`);
  return position;
}

function ids(doc: ProseMirrorNode): string[] {
  const result: string[] = [];
  doc.descendants((node) => {
    if (typeof node.attrs.id === "string") result.push(node.attrs.id);
  });
  return result;
}

function undoState(state: EditorState): { ok: boolean; state: EditorState } {
  let result = state;
  const ok = undo(state, (tr) => {
    result = state.applyTransaction(tr).state;
  });
  return { ok, state: result };
}

function redoState(state: EditorState): { ok: boolean; state: EditorState } {
  let result = state;
  const ok = redo(state, (tr) => {
    result = state.applyTransaction(tr).state;
  });
  return { ok, state: result };
}

const paragraph = (id: string, text: string, marks?: { type: string }[]) => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
});

const callout = (
  tone: string,
  content: unknown[],
  attrs: Record<string, unknown> = {},
) => ({
  type: "callout",
  attrs: { tone, ...attrs },
  content,
});

describe("Callout extension", () => {
  it("defines the frozen schema and safe HTML attribute mapping", () => {
    expect(schema.nodes.callout.spec.content).toBe("block+");
    expect(schema.nodes.callout.spec.group).toBe("block");
    expect(schema.nodes.callout.create().attrs.tone).toBe("note");

    const attributes = config.addAttributes.call({ options: {} });
    const tone = attributes.tone;
    expect(tone.default).toBe("note");
    const element = (value: string | null) => ({
      getAttribute: (name: string) => (name === "data-tone" ? value : null),
    });
    expect(tone.parseHTML(element(null))).toBe("note");
    expect(tone.parseHTML(element("tip"))).toBe("tip");
    expect(tone.parseHTML(element("danger"))).toBe("danger");
    expect(tone.renderHTML({ tone: "warning" })).toEqual({
      "data-tone": "warning",
    });
    expect(tone.renderHTML({ tone: "danger" })).toEqual({
      "data-tone": "note",
    });

    expect(config.parseHTML.call({})).toEqual([
      { tag: "aside[data-folio-callout]" },
    ]);
    expect(
      config.renderHTML.call(
        { options: { HTMLAttributes: {} } },
        { HTMLAttributes: { "data-tone": "tip" } },
      ),
    ).toEqual(["aside", { "data-tone": "tip", "data-folio-callout": "" }, 0]);
  });

  it("renders Markdown through the shared rich-block helper", () => {
    const node = callout("tip", [paragraph("p1", "Hello")]);
    expect(config.renderMarkdown.call({}, node, {}, {})).toBe(
      '<aside data-folio-callout="" data-tone="tip">\n<p>Hello</p>\n</aside>',
    );
  });

  it("wraps selected blocks without changing their IDs or content and supports undo", () => {
    const blocks = [
      paragraph("a", "Alpha", [{ type: "bold" }]),
      paragraph("b", "Beta"),
    ];
    const original = structuredClone(blocks);
    const source = schema.nodeFromJSON({ type: "doc", content: blocks });
    let state = stateWith(blocks, {
      from: textPosition(source, "Alpha"),
      to: textPosition(source, "Beta") + 4,
    });
    const before = state.doc;

    const result = invoke(rawCommands.setCallout("tip"), state);
    expect(result.ok).toBe(true);
    state = result.state;

    expect(state.doc.childCount).toBe(1);
    const wrapper = state.doc.child(0);
    expect(wrapper.type.name).toBe("callout");
    expect(wrapper.attrs.tone).toBe("tip");
    expect(wrapper.childCount).toBe(2);
    expect(wrapper.child(0).toJSON()).toEqual(original[0]);
    expect(wrapper.child(1).toJSON()).toEqual(original[1]);
    expect(ids(state.doc)).toEqual(["a", "b"]);
    expect(state.selection.empty).toBe(false);
    expect(state.selection.$from.node(1).type.name).toBe("callout");

    const undone = undoState(state);
    expect(undone.ok).toBe(true);
    expect(undone.state.doc.eq(before)).toBe(true);
    const redone = redoState(undone.state);
    expect(redone.ok).toBe(true);
    expect(redone.state.doc.eq(state.doc)).toBe(true);
  });

  it("updates the nearest callout instead of nesting when already inside", () => {
    const blocks = [
      callout("note", [paragraph("a", "Alpha"), paragraph("b", "Beta")]),
    ];
    let state = stateWith(blocks);
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, textPosition(state.doc, "Alpha")),
      ),
    );
    const before = state.doc;

    const result = invoke(rawCommands.setCallout("warning"), state);
    expect(result.ok).toBe(true);
    state = result.state;

    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe("callout");
    expect(state.doc.child(0).attrs.tone).toBe("warning");
    expect(state.doc.child(0).childCount).toBe(2);
    let nested = 0;
    state.doc.descendants((node) => {
      if (node.type.name === "callout") nested++;
    });
    expect(nested).toBe(1);
    expect(ids(state.doc)).toEqual(["a", "b"]);
    expect(state.selection.$from.node(1).type.name).toBe("callout");
    expect(before.child(0).attrs.tone).toBe("note");

    const defaults = invoke(rawCommands.setCallout(), state);
    expect(defaults.ok).toBe(true);
    expect(defaults.state.doc.child(0).attrs.tone).toBe("note");
  });

  it("updates only the nearest nested callout with setCalloutTone", () => {
    const blocks = [
      callout("note", [
        paragraph("outer", "Outside"),
        callout("tip", [paragraph("inner", "Inside")]),
      ]),
    ];
    let state = stateWith(blocks);
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, textPosition(state.doc, "Inside")),
      ),
    );

    const result = invoke(rawCommands.setCalloutTone("warning"), state);
    expect(result.ok).toBe(true);
    state = result.state;
    const outer = state.doc.child(0);
    const inner = outer.child(1);
    expect(outer.attrs.tone).toBe("note");
    expect(inner.type.name).toBe("callout");
    expect(inner.attrs.tone).toBe("warning");
    expect(ids(state.doc)).toEqual(["outer", "inner"]);
  });

  it("handles a node-selected callout without nesting and keeps a valid selection on lift", () => {
    const blocks = [
      callout("note", [paragraph("first", "One"), paragraph("second", "Two")]),
    ];
    const doc = schema.nodeFromJSON({ type: "doc", content: blocks });
    let state = EditorState.create({ schema, doc, plugins: [history()] });
    state = state.apply(
      state.tr.setSelection(NodeSelection.create(state.doc, 0)),
    );

    const toned = invoke(rawCommands.setCalloutTone("tip"), state);
    expect(toned.ok).toBe(true);
    state = toned.state;
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).attrs.tone).toBe("tip");

    const lifted = invoke(rawCommands.unsetCallout(), state);
    expect(lifted.ok).toBe(true);
    state = lifted.state;
    expect(state.doc.childCount).toBe(2);
    expect(ids(state.doc)).toEqual(["first", "second"]);
    expect(state.selection.$from.parent.attrs.id).toBe("first");
  });

  it("rejects missing or invalid tones without mutation", () => {
    const blocks = [paragraph("a", "Alpha")];
    const source = schema.nodeFromJSON({ type: "doc", content: blocks });
    const base = stateWith(blocks, {
      from: textPosition(source, "Alpha"),
    });
    const invalid = invoke(rawCommands.setCallout("danger" as never), base);
    expect(invalid.ok).toBe(false);
    expect(invalid.tr.doc.eq(base.doc)).toBe(true);
    expect(invalid.tr.steps).toHaveLength(0);

    const invalidTone = invoke(
      rawCommands.setCalloutTone("danger" as never),
      base,
    );
    expect(invalidTone.ok).toBe(false);
    expect(invalidTone.tr.steps).toHaveLength(0);

    const outside = invoke(rawCommands.setCalloutTone("tip"), base);
    expect(outside.ok).toBe(false);
    expect(outside.tr.steps).toHaveLength(0);
  });

  it("dry-runs commands without mutating the selected document", () => {
    const blocks = [paragraph("a", "Alpha"), paragraph("b", "Beta")];
    const doc = schema.nodeFromJSON({ type: "doc", content: blocks });
    const state = stateWith(blocks, {
      from: textPosition(doc, "Alpha"),
      to: textPosition(doc, "Beta") + 4,
    });

    const wrap = invoke(rawCommands.setCallout("tip"), state, true);
    expect(wrap.ok).toBe(true);
    // A dry run may build steps on its private transaction, but it must never
    // update the state the caller will keep displaying.
    expect(wrap.state).toBe(state);
    expect(wrap.state.doc.eq(state.doc)).toBe(true);

    const noCallout = invoke(rawCommands.unsetCallout(), state, true);
    expect(noCallout.ok).toBe(false);
    expect(noCallout.tr.steps).toHaveLength(0);
  });

  it("lifts every child out of the nearest callout, preserving IDs and undo", () => {
    const blocks = [
      callout("warning", [
        paragraph("first", "One"),
        paragraph("second", "Two", [{ type: "italic" }]),
      ]),
    ];
    const original = structuredClone(blocks[0].content);
    let state = stateWith(blocks);
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, textPosition(state.doc, "One")),
      ),
    );

    const result = invoke(rawCommands.unsetCallout(), state);
    expect(result.ok).toBe(true);
    state = result.state;

    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(0).toJSON()).toEqual(original[0]);
    expect(state.doc.child(1).toJSON()).toEqual(original[1]);
    expect(ids(state.doc)).toEqual(["first", "second"]);
    expect(state.selection.$from.parent.attrs.id).toBe("first");

    const undone = undoState(state);
    expect(undone.ok).toBe(true);
    expect(undone.state.doc.child(0).type.name).toBe("callout");
    expect(undone.state.doc.child(0).attrs.tone).toBe("warning");
    expect(ids(undone.state.doc)).toEqual(["first", "second"]);
  });

  it("removes only the inner callout when the cursor is nested", () => {
    const blocks = [
      callout("note", [
        paragraph("outer", "Outside"),
        callout("tip", [paragraph("inner", "Inside")]),
      ]),
    ];
    let state = stateWith(blocks);
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, textPosition(state.doc, "Inside")),
      ),
    );

    const result = invoke(rawCommands.unsetCallout(), state);
    expect(result.ok).toBe(true);
    state = result.state;

    const outer = state.doc.child(0);
    expect(outer.type.name).toBe("callout");
    expect(outer.attrs.tone).toBe("note");
    expect(outer.childCount).toBe(2);
    expect(outer.child(1).type.name).toBe("paragraph");
    expect(outer.child(1).attrs.id).toBe("inner");
    expect(ids(state.doc)).toEqual(["outer", "inner"]);
  });

  it("returns false for unsetCallout outside a callout with no mutation", () => {
    const blocks = [paragraph("a", "Alpha")];
    const state = stateWith(blocks, {
      from: textPosition(
        schema.nodeFromJSON({ type: "doc", content: blocks }),
        "Alpha",
      ),
    });
    const result = invoke(rawCommands.unsetCallout(), state);
    expect(result.ok).toBe(false);
    expect(result.tr.doc.eq(state.doc)).toBe(true);
    expect(result.tr.steps).toHaveLength(0);
  });
});
