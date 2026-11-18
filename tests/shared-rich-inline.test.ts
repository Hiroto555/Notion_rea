import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { canonical } from "../src/collaboration/runtime/canonical";
import { initialState, locate } from "../src/collaboration/runtime/document";
import {
  applyInline,
  EDITOR_DIFF_LIMIT,
  type RichInlineCommand,
} from "../src/collaboration/runtime/rich-inline";
import {
  applyBlockFormat,
  type BlockFormatCommand,
} from "../src/collaboration/runtime/block-format";

function text(value: string, marks?: Doc["marks"]): Doc {
  return marks
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function paragraph(id: string, content: Doc[] = []): Doc {
  return { type: "paragraph", attrs: { id }, content };
}

function state(block: Doc) {
  return initialState({ type: "doc", content: [block] });
}

function inline(blockId: string, before: Doc[], after: Doc[]): RichInlineCommand {
  return { kind: "inline", blockId, before, after };
}

function blockNode(current: ReturnType<typeof state>, id: string): Doc {
  return locate(current.document, id).node;
}

function blockText(current: ReturnType<typeof state>, id: string): string {
  const node = blockNode(current, id);
  const walk = (value: Doc): string => {
    if (value.type === "text") return value.text ?? "";
    if (value.type === "hardBreak") return "\n";
    return (value.content ?? []).map(walk).join("");
  };
  return (node.content ?? []).map(walk).join("");
}

function charMarks(
  current: ReturnType<typeof state>,
  id: string,
): { char: string; types: string[] }[] {
  const out: { char: string; types: string[] }[] = [];
  for (const node of blockNode(current, id).content ?? []) {
    if (node.type !== "text") continue;
    for (const char of node.text ?? "")
      out.push({
        char,
        types: (node.marks ?? []).map((mark) => mark.type),
      });
  }
  return out;
}

function allMarkTypes(current: ReturnType<typeof state>, id: string): Set<string> {
  const types = new Set<string>();
  for (const entry of charMarks(current, id))
    for (const type of entry.types) types.add(type);
  return types;
}

function hardBreaks(current: ReturnType<typeof state>, id: string): number {
  return (blockNode(current, id).content ?? []).filter(
    (node) => node.type === "hardBreak",
  ).length;
}

describe("applyInline", () => {
  it("commutes bold and italic on untouched text (both actor orders)", () => {
    const base = [text("hello")];
    const bolded = [text("hello", [{ type: "bold" }])];
    const italicized = [text("hello", [{ type: "italic" }])];

    const remoteBold = state(paragraph("p1", bolded));
    const localItalic = applyInline(
      remoteBold,
      inline("p1", base, italicized),
    );
    expect(blockText(localItalic.state, "p1")).toBe("hello");
    expect(allMarkTypes(localItalic.state, "p1")).toEqual(
      new Set(["bold", "italic"]),
    );

    const remoteItalic = state(paragraph("p1", italicized));
    const localBold = applyInline(remoteItalic, inline("p1", base, bolded));
    expect(blockText(localBold.state, "p1")).toBe("hello");
    expect(allMarkTypes(localBold.state, "p1")).toEqual(
      new Set(["bold", "italic"]),
    );
  });

  it("inserts styled Japanese and emoji without flattening or splitting surrogates", () => {
    const base = [text("abc")];
    const after = [
      text("日本", [{ type: "bold" }]),
      text("🎉", [{ type: "italic" }]),
    ];
    const current = state(paragraph("p1", base));
    const result = applyInline(current, inline("p1", base, after));
    expect(blockText(result.state, "p1")).toBe("日本🎉");
    expect(allMarkTypes(result.state, "p1")).toEqual(
      new Set(["bold", "italic"]),
    );
    expect(blockText(result.state, "p1")).not.toContain("\uFFFD");
  });

  it("puts remote same-position insertions first during a divergent merge", () => {
    const base = [text("abc")];
    const remote = state(paragraph("p1", [text("abc!")]));
    const result = applyInline(
      remote,
      inline("p1", base, [text("abc🎉")]),
    );
    expect(blockText(result.state, "p1")).toBe("abc!🎉");
  });

  it("merges multiple disjoint text replacements", () => {
    const before = [text("The quick brown fox")];
    const after = [text("The slow brown fox")];
    const current = state(paragraph("p1", [text("The quick brown cat")]));
    const result = applyInline(current, inline("p1", before, after));
    expect(blockText(result.state, "p1")).toBe("The slow brown cat");
  });

  it("refuses destructive overlap with unseen concurrent text", () => {
    const before = [text("abcd")];
    const current = state(paragraph("p1", [text("abXYcd")]));
    const snapshot = canonical(current);
    expect(() =>
      applyInline(current, inline("p1", before, [text("ad")])),
    ).toThrowError("INLINE_CONFLICT");
    expect(canonical(current)).toBe(snapshot);
  });

  it("fails EDITOR_DIFF_LIMIT on hard cases and keeps raw state", () => {
    const before = [text("ab".repeat(2000))];
    const after = [text("cd".repeat(2000))];
    const current = state(paragraph("p1", [text("ab".repeat(2000) + "!")]));
    const snapshot = canonical(current);
    expect(() =>
      applyInline(current, inline("p1", before, after)),
    ).toThrowError("EDITOR_DIFF_LIMIT");
    expect(canonical(current)).toBe(snapshot);
    expect(EDITOR_DIFF_LIMIT).toBeGreaterThan(0);
  });

  it("refuses contradictory concurrent changes to the same mark type", () => {
    const before = [text("hi")];
    const after = [
      text("hi", [
        { type: "link", attrs: { href: "https://a.example" } },
      ]),
    ];
    const current = state(
      paragraph("p1", [
        text("hi", [
          { type: "link", attrs: { href: "https://b.example" } },
        ]),
      ]),
    );
    expect(() =>
      applyInline(current, inline("p1", before, after)),
    ).toThrowError("INLINE_MARK_CONFLICT");
  });

  it("preserves other actor's marks on independent text", () => {
    const before = [text("abcdef")];
    const after = [
      text("ab"),
      text("cd", [{ type: "italic" }]),
      text("ef"),
    ];
    const current = state(
      paragraph("p1", [text("ab", [{ type: "bold" }]), text("cdef")]),
    );
    const result = applyInline(current, inline("p1", before, after));
    const marks = charMarks(result.state, "p1");
    expect(marks.map((entry) => entry.char).join("")).toBe("abcdef");
    expect(marks[0].types).toEqual(["bold"]);
    expect(marks[2].types).toEqual(["italic"]);
    expect(marks[4].types).toEqual([]);
  });

  it("preserves hardBreak across concurrent text edits", () => {
    const before = [text("a"), { type: "hardBreak" }, text("b")];
    const after = [text("a"), { type: "hardBreak" }, text("B")];
    const current = state(
      paragraph("p1", [text("A"), { type: "hardBreak" }, text("b")]),
    );
    const result = applyInline(current, inline("p1", before, after));
    expect(blockText(result.state, "p1")).toBe("A\nB");
    expect(hardBreaks(result.state, "p1")).toBe(1);
  });

  it("returns actual current-before and merged-after history", () => {
    const base = [text("hello")];
    const bolded = [text("hello", [{ type: "bold" }])];
    const italicized = [text("hello", [{ type: "italic" }])];
    const current = state(paragraph("p1", bolded));
    const result = applyInline(current, inline("p1", base, italicized));
    expect(result.applied.blockId).toBe("p1");
    expect(result.applied.before).toEqual(bolded);
    expect(result.applied.after).toEqual(
      blockNode(result.state, "p1").content,
    );
  });

  it("rejects non-strict command keys and non-array fragments", () => {
    const current = state(paragraph("p1", [text("a")]));
    expect(() =>
      applyInline(current, {
        kind: "inline",
        blockId: "p1",
        before: [text("a")],
        after: [text("b")],
        extra: true,
      } as unknown as RichInlineCommand),
    ).toThrowError("INVALID_COMMAND");
    expect(() =>
      applyInline(current, {
        kind: "inline",
        blockId: "p1",
        before: "a",
        after: [],
      } as unknown as RichInlineCommand),
    ).toThrowError("INVALID_COMMAND");
  });

  it("leaves the input state untouched on success", () => {
    const before = [text("abc")];
    const current = state(paragraph("p1", before));
    const snapshot = canonical(current);
    applyInline(current, inline("p1", before, [text("abd")]));
    expect(canonical(current)).toBe(snapshot);
  });
});

function format(
  blockId: string,
  beforeType: string,
  beforeAttrs: Record<string, unknown>,
  type: string,
  attrs: Record<string, unknown>,
): BlockFormatCommand {
  return {
    kind: "block.format",
    blockId,
    beforeType,
    beforeAttrs,
    type,
    attrs,
  };
}

function heading(id: string, level: number, content: Doc[] = []): Doc {
  return { type: "heading", attrs: { id, level }, content };
}

describe("applyBlockFormat", () => {
  it("changes only the type/attr delta and preserves children and marks", () => {
    const current = state(
      paragraph("p1", [text("hello", [{ type: "bold" }])]),
    );
    const result = applyBlockFormat(
      current,
      format("p1", "paragraph", { id: "p1" }, "heading", {
        id: "p1",
        level: 2,
      }),
    );
    const node = blockNode(result.state, "p1");
    expect(node.type).toBe("heading");
    expect(node.attrs).toEqual({ id: "p1", level: 2 });
    expect(blockText(result.state, "p1")).toBe("hello");
    expect(allMarkTypes(result.state, "p1")).toEqual(new Set(["bold"]));
    expect(result.appliedText).toBeNull();
  });

  it("retains unrelated remote attribute fields when local did not change them", () => {
    const current = state(heading("h1", 4, [text("body")]));
    const result = applyBlockFormat(
      current,
      format("h1", "heading", { id: "h1", level: 1 }, "heading", {
        id: "h1",
        level: 1,
      }),
    );
    const node = blockNode(result.state, "h1");
    expect(node.type).toBe("heading");
    expect(node.attrs).toEqual({ id: "h1", level: 4 });
    expect(blockText(result.state, "h1")).toBe("body");
  });

  it("refuses same changed-field conflicts", () => {
    const current = state(heading("h1", 3, [text("body")]));
    expect(() =>
      applyBlockFormat(
        current,
        format("h1", "heading", { id: "h1", level: 1 }, "heading", {
          id: "h1",
          level: 2,
        }),
      ),
    ).toThrowError("BLOCK_FORMAT_CONFLICT");
  });

  it("refuses table structural resizing through format", () => {
    const current = state(paragraph("p1", [text("x")]));
    expect(() =>
      applyBlockFormat(
        current,
        format("p1", "paragraph", { id: "p1" }, "table", { id: "p1" }),
      ),
    ).toThrowError("TABLE_STRUCTURAL");
  });

  it("rejects strict-key violations and id changes", () => {
    const current = state(paragraph("p1", [text("x")]));
    expect(() =>
      applyBlockFormat(current, {
        kind: "block.format",
        blockId: "p1",
        beforeType: "paragraph",
        beforeAttrs: { id: "p1" },
        type: "paragraph",
        attrs: { id: "p1" },
        extra: 1,
      } as unknown as BlockFormatCommand),
    ).toThrowError("INVALID_COMMAND");
    expect(() =>
      applyBlockFormat(
        current,
        format("p1", "paragraph", { id: "p1" }, "paragraph", {
          id: "other",
        }),
      ),
    ).toThrowError("INVALID_COMMAND");
  });
});
