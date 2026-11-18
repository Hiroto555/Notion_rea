import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import { mapInlinePosition } from "../src/collaboration/runtime/rich-inline";

function text(value: string, marks?: Doc["marks"]): Doc {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

const hardBreak: Doc = { type: "hardBreak" };

function expectCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CollaborationError);
  expect((caught as CollaborationError).code).toBe(code);
}

describe("mapInlinePosition", () => {
  it("rebases through two disjoint inserts including Japanese text and an emoji", () => {
    const before = [text("a日本b")];
    const current = [text("aX日本😀b")];
    expect(mapInlinePosition(before, current, 2)).toBe(3);
  });

  it("counts hard breaks as one unit and places same-point inserts by association", () => {
    const before = [text("a"), hardBreak, text("b")];
    const current = [text("Za"), hardBreak, text("😀b")];
    expect(mapInlinePosition(before, current, 2)).toBe(4);
    expect(mapInlinePosition(before, current, 2, -1)).toBe(3);
  });

  it("refuses a UTF-16 offset inside a surrogate pair", () => {
    const before = [text("😀x")];
    expectCode(
      () => mapInlinePosition(before, [text("😀x")], 1),
      "INLINE_ANCHOR_UNICODE",
    );
  });

  it("shifts after a deletion before the split and keeps a deletion at the anchor", () => {
    const before = [text("abcdef")];
    expect(mapInlinePosition(before, [text("acdef")], 4)).toBe(3);
    expect(mapInlinePosition(before, [text("abcdf")], 4)).toBe(4);
  });

  it("accounts for multiple disjoint remote spans at once", () => {
    const before = [text("abcdef")];
    const current = [text("日acde😀f")];
    expect(mapInlinePosition(before, current, 4)).toBe(4);
  });

  it("fails when the split boundary is strictly inside a remotely deleted run", () => {
    const before = [text("abcdef")];
    expectCode(
      () => mapInlinePosition(before, [text("abc")], 4),
      "INLINE_ANCHOR_CONFLICT",
    );
  });

  it("does not move the offset for marks-only changes", () => {
    const before = [text("abc")];
    const current = [
      text("ab", [{ type: "bold" }]),
      text("c", [{ type: "italic" }]),
    ];
    expect(mapInlinePosition(before, current, 2)).toBe(2);
  });

  it("handles insertions exactly at the split point remote-first", () => {
    const before = [text("ab")];
    const current = [text("aXb")];
    expect(mapInlinePosition(before, current, 1)).toBe(2);
    expect(mapInlinePosition(before, current, 1, -1)).toBe(1);
  });

  it("stays bounded when a huge common prefix precedes a small insert", () => {
    const prefix = "あ".repeat(5000);
    const before = [text(`${prefix}x`)];
    const current = [text(`${prefix}xy`)];
    expect(mapInlinePosition(before, current, 4000)).toBe(4000);
  });
});
