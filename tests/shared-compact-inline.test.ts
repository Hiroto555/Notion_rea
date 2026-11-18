import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { canonical } from "../src/collaboration/runtime/canonical";
import { initialState, locate } from "../src/collaboration/runtime/document";
import { compactInline, expandInlinePatch, type InlinePatchCommand, type InlineMarkCommand } from "../src/collaboration/runtime/compact-inline";
import { applyInline, type RichInlineCommand } from "../src/collaboration/runtime/rich-inline";

const text = (value: string, marks?: Doc["marks"]): Doc => ({type: "text", text: value, ...(marks ? {marks} : {})});
const state = (content: Doc[]) => initialState({type: "doc", content: [{type: "paragraph", attrs: {id: "p"}, content}]});
const command = (before: Doc[], after: Doc[]): RichInlineCommand => ({kind: "inline", blockId: "p", before, after});
function delta(before: Doc[], after: Doc[]) {
  const result = compactInline(command(before, after));
  expect(result.kind).not.toBe("inline");
  return result as InlinePatchCommand | InlineMarkCommand;
}
function resultContent(before: Doc[], after: Doc[]) {
  const basis = state(before);
  const expanded = expandInlinePatch(basis, delta(before, after));
  return locate(applyInline(basis, expanded).state.document, "p").node.content ?? [];
}

describe("source-anchored compact inline wire commands", () => {
  it("edits one character in a 900k paragraph with a sub-1k patch", () => {
    const before = [text("a".repeat(450_000) + "x" + "b".repeat(449_999))];
    const after = [text("a".repeat(450_000) + "y" + "b".repeat(449_999))];
    const patch = delta(before, after);
    expect(patch.kind).toBe("inline.patch");
    expect(Buffer.byteLength(canonical(patch))).toBeLessThan(1_000);
    const basis = state(before);
    const expanded = expandInlinePatch(basis, patch);
    expect(expanded.after).toEqual(after);
    expect(locate(applyInline(basis, expanded).state.document, "p").node.content).toEqual(after);
  });
  it("bolds a 900k paragraph without shipping text and preserves italic", () => {
    const value = "a".repeat(900_000);
    const before = [text(value, [{type: "italic"}])];
    const after = [text(value, [{type: "bold"}, {type: "italic"}])];
    const patch = delta(before, after);
    expect(patch).toMatchObject({kind: "inline.mark", from: 0, to: 900_000, markType: "bold"});
    expect(Buffer.byteLength(canonical(patch))).toBeLessThan(1_000);
    expect(expandInlinePatch(state(before), patch).after).toEqual(after);
  });
  it("removes one mark across text and hard breaks without changing other marks", () => {
    const before = [text("ab", [{type: "bold"}, {type: "italic"}]), {type: "hardBreak", marks: [{type: "bold"}]}, text("cd", [{type: "bold"}])];
    const after = [text("ab", [{type: "italic"}]), {type: "hardBreak"}, text("cd")];
    const patch = delta(before, after);
    expect(patch).toMatchObject({kind: "inline.mark", from: 0, to: 5, markType: "bold", mark: null});
    expect(resultContent(before, after)).toEqual(after);
  });
  it("replaces emoji sharing a high surrogate without splitting Unicode", () => {
    const before = [text("a😀b")], after = [text("a😃b")];
    const patch = delta(before, after) as InlinePatchCommand;
    expect(patch).toMatchObject({kind: "inline.patch", from: 1, to: 3, content: [text("😃")]});
    expect(resultContent(before, after)).toEqual(after);
  });
  it("keeps marked inserts and hard breaks in a minimal replacement", () => {
    const before = [text("before"), {type: "hardBreak"}, text("after")];
    const after = [text("before"), {type: "hardBreak"}, text("日本😀", [{type: "bold"}]), text("after")];
    expect(resultContent(before, after)).toEqual(after);
  });
  it("supports deletion to empty content and insertion from empty", () => {
    expect(resultContent([text("😀abc")], [])).toEqual([]);
    expect(resultContent([], [text("日本😀")])).toEqual([text("日本😀")]);
  });
  it("supports a uniform mark range despite differently split unchanged text", () => {
    const before = [text("abc"), text("def", [{type: "italic"}])];
    const after = [text("a"), text("bc", [{type: "bold"}]), text("de", [{type: "bold"}, {type: "italic"}]), text("f", [{type: "italic"}])];
    const patch = delta(before, after);
    expect(patch).toMatchObject({kind: "inline.mark", from: 1, to: 5, markType: "bold"});
    expect(resultContent(before, after)).toEqual(after);
  });
  it("never represents two mark types as one lossy mark command", () => {
    const before = [text("abcdef")];
    const after = [text("abc", [{type: "bold"}]), text("def", [{type: "italic"}])];
    expect(delta(before, after).kind).toBe("inline.patch");
    expect(resultContent(before, after)).toEqual(after);
  });
  it("rejects source-hash mismatch against the trusted basis without mutation", () => {
    const basis = state([text("other")]), raw = canonical(basis);
    const patch = delta([text("abc")], [text("axc")]);
    expect(() => expandInlinePatch(basis, patch)).toThrow("EDITOR_SOURCE_MISMATCH");
    expect(canonical(basis)).toBe(raw);
  });
  it("rejects unknown authored inline/mark attrs instead of dropping them", () => {
    expect(() => compactInline(command([text("a")], [{...text("b"), attrs: {future: true}}]))).toThrow("UNSUPPORTED_INLINE");
    expect(() => compactInline(command([text("a")], [text("b", [{type: "bold", attrs: {future: true}}])]))).toThrow("UNSUPPORTED_INLINE");
  });
  it("rejects a malicious half-surrogate range atomically", () => {
    const basis = state([text("😀a")]), raw = canonical(basis);
    const patch = delta([text("😀a")], [text("😀b")]) as InlinePatchCommand;
    expect(() => expandInlinePatch(basis, {...patch, from: 1})).toThrow("INLINE_PATCH_RANGE");
    expect(canonical(basis)).toBe(raw);
  });
  it("expands at the trusted base then merges a later remote KEEP and italic", () => {
    const before = [text("abc def")], after = [text("abc XYZ")];
    const current = state([text("KEEP abc def", [{type: "italic"}])]);
    const expanded = expandInlinePatch(state(before), delta(before, after));
    const result = locate(applyInline(current, expanded).state.document, "p").node.content!;
    expect(result.map(node => node.text ?? "").join("")).toBe("KEEP abc XYZ");
    expect(result[0].marks).toEqual([{type: "italic"}]);
  });
});
