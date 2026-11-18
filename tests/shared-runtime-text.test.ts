import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import {
  CollaborationError,
  type AppliedText,
  type DocumentState,
  type TextCommand,
} from "../src/collaboration/runtime/contract";
import {
  applyText,
  rebaseText,
} from "../src/collaboration/runtime/text-intent";

const text = (value: string, marks?: Doc["marks"]): Doc =>
  marks ? { type: "text", text: value, marks } : { type: "text", text: value };

const paragraph = (id: string, ...content: Doc[]): Doc => ({
  type: "paragraph",
  attrs: { id },
  ...(content.length ? { content } : {}),
});

const document = (...content: Doc[]): Doc => ({ type: "doc", content });

const state = (...content: Doc[]): DocumentState => ({
  document: document(...content),
  tables: [],
  tombstones: [],
});

const block = (doc: Doc, id: string): Doc => {
  const stack: Doc[] = [doc];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.attrs?.id === id) return node;
    stack.push(...(node.content ?? []));
  }
  throw new Error("missing " + id);
};

const flat = (node: Doc): string =>
  node.type === "text"
    ? (node.text ?? "")
    : node.type === "hardBreak"
      ? "\n"
      : (node.content ?? []).map(flat).join("");

const command = (
  blockId: string,
  before: string,
  from: number,
  to: number,
  value: string,
): TextCommand => ({ kind: "text", blockId, before, from, to, text: value });

const patch = (
  blockId: string,
  from: number,
  to: number,
  value: string,
): AppliedText => ({ kind: "text", blockId, from, to, text: value });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return;
  }
  throw new Error("expected " + code);
};

describe("rebaseText", () => {
  it("maps an insertion after a same-position server insertion", () => {
    const rebased = rebaseText(command("p1", "abc", 1, 1, "Y"), [
      patch("p1", 1, 1, "X"),
    ]);
    expect(rebased).toEqual({
      kind: "text",
      blockId: "p1",
      from: 2,
      to: 2,
      text: "Y",
      before: "aXbc",
    });
  });

  it("retains both intervening same-block inserts and the local insert", () => {
    const original = state(paragraph("p1", text("aXYbc")));
    const result = applyText(original, command("p1", "abc", 1, 1, "Z"), [
      patch("p1", 1, 1, "X"),
      patch("p1", 2, 2, "Y"),
    ]);
    expect(flat(block(result.state.document, "p1"))).toBe("aXYZbc");
    expect(result.appliedText).toEqual(patch("p1", 3, 3, "Z"));
    expect(flat(block(original.document, "p1"))).toBe("aXYbc");
  });

  it("shifts a range around an insertion at its end", () => {
    const rebased = rebaseText(command("p1", "abcdef", 1, 3, "Q"), [
      patch("p1", 3, 3, "X"),
    ]);
    expect(rebased.from).toBe(1);
    expect(rebased.to).toBe(3);
    expect(rebased.before).toBe("abcXdef");
  });

  it("refuses an intervening insert inside the local deletion", () => {
    expectCode(
      () =>
        rebaseText(command("p1", "abcdef", 1, 4, ""), [patch("p1", 2, 2, "X")]),
      "TEXT_CONFLICT",
    );
  });

  it("ignores patches for other blocks", () => {
    const rebased = rebaseText(command("p1", "abc", 1, 1, "Y"), [
      patch("p2", 0, 0, "Q"),
    ]);
    expect(rebased.before).toBe("abc");
    expect(rebased.from).toBe(1);
    expect(rebased.to).toBe(1);
  });
});

describe("applyText", () => {
  it("keeps block id p1 across a state move", () => {
    const original = state(
      paragraph("p2", text("other")),
      paragraph("p1", text("abc")),
    );
    const result = applyText(original, command("p1", "abc", 3, 3, "!"), []);
    expect(result.state.document.content?.[1].attrs?.id).toBe("p1");
    expect(flat(block(result.state.document, "p1"))).toBe("abc!");
    expect(flat(block(result.state.document, "p2"))).toBe("other");
    expect(flat(block(original.document, "p1"))).toBe("abc");
  });

  it("applies a legal deletion", () => {
    const result = applyText(
      state(paragraph("p1", text("abcdef"))),
      command("p1", "abcdef", 1, 4, ""),
      [],
    );
    expect(flat(block(result.state.document, "p1"))).toBe("aef");
    expect(result.appliedText).toEqual(patch("p1", 1, 4, ""));
  });

  it("refuses a remote deletion intersecting a local delete", () => {
    const original = state(paragraph("p1", text("abcef")));
    const before = JSON.stringify(original);
    expectCode(
      () =>
        applyText(original, command("p1", "abcdef", 2, 5, ""), [
          patch("p1", 3, 4, ""),
        ]),
      "TEXT_CONFLICT",
    );
    expect(JSON.stringify(original)).toBe(before);
  });

  it("replaces an emoji and preserves marks outside the range", () => {
    const bold: Doc["marks"] = [{ type: "bold" }];
    const italic: Doc["marks"] = [{ type: "italic" }];
    const original = state(
      paragraph("p1", text("A😀B", bold), text("C", italic)),
    );
    const before = JSON.stringify(original);
    const result = applyText(original, command("p1", "A😀BC", 1, 3, "X"), []);
    const node = block(result.state.document, "p1");
    expect(flat(node)).toBe("AXBC");
    expect(node.content).toEqual([
      text("A", bold),
      text("X"),
      text("B", bold),
      text("C", italic),
    ]);
    expect(result.appliedText).toEqual(patch("p1", 1, 3, "X"));
    expect(JSON.stringify(original)).toBe(before);
  });

  it("refuses a surrogate-splitting offset", () => {
    expectCode(
      () =>
        applyText(
          state(paragraph("p1", text("A😀B"))),
          command("p1", "A😀B", 2, 3, "X"),
          [],
        ),
      "UNICODE_SPLIT",
    );
  });

  it("refuses unpaired Unicode", () => {
    expectCode(
      () => rebaseText(command("p1", "A\uD800B", 1, 2, ""), []),
      "UNICODE",
    );
  });

  it("refuses a base that does not match current text", () => {
    expectCode(
      () =>
        applyText(
          state(paragraph("p1", text("abXc"))),
          command("p1", "abc", 1, 2, ""),
          [],
        ),
      "TEXT_BASE_MISMATCH",
    );
  });

  it("refuses unknown inline nodes instead of flattening them", () => {
    expectCode(
      () =>
        applyText(
          state(
            paragraph("p1", text("ab"), {
              type: "emoticon",
              attrs: { name: "x" },
            }),
          ),
          command("p1", "ab", 1, 1, "X"),
          [],
        ),
      "UNSUPPORTED_INLINE",
    );
    expectCode(
      () =>
        applyText(
          state(paragraph("p1", text("ab"), { type: "emoticon" })),
          command("p1", "ab", 0, 1, "X"),
          [],
        ),
      "UNSUPPORTED_INLINE",
    );
  });

  it("allows insertion beside a hardBreak but refuses deleting it", () => {
    const original = state(
      paragraph("p1", text("ab"), { type: "hardBreak" }, text("cd")),
    );
    const inserted = applyText(
      original,
      command("p1", "ab\ncd", 2, 2, "X"),
      [],
    );
    const node = block(inserted.state.document, "p1");
    expect(node.content?.map(flat).join("")).toBe("abX\ncd");
    expect(node.content?.some((child) => child.type === "hardBreak")).toBe(
      true,
    );
    expectCode(
      () => applyText(original, command("p1", "ab\ncd", 1, 4, "X"), []),
      "UNSUPPORTED_HARD_BREAK",
    );
  });
});
