import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { parseSharedInput } from "../src/collaboration/raw-json";
import { inspectSharedDocument } from "../src/collaboration/document-input";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  CollaborationError,
  wellFormed,
  type AppliedText,
  type DocumentState,
  type TextCommand,
} from "../src/collaboration/runtime/contract";
import {
  initialState,
  locate,
  materializedState,
} from "../src/collaboration/runtime/document";
import {
  applyText,
  rebaseText,
} from "../src/collaboration/runtime/text-intent";

const blockId = "p1";

function paragraph(children: Doc[]): Doc {
  return {
    type: "doc",
    content: [{ type: "paragraph", attrs: { id: blockId }, content: children }],
  };
}

function stateFor(children: Doc[]): DocumentState {
  return initialState(paragraph(children));
}

function textState(value: string): DocumentState {
  return stateFor([{ type: "text", text: value }]);
}

function blockOf(state: DocumentState): Doc {
  return locate(state.document, blockId).node;
}

function inlineText(node: Doc): string {
  return (node.content ?? [])
    .map((child) =>
      child.type === "text"
        ? (child.text ?? "")
        : child.type === "hardBreak"
          ? "\n"
          : "",
    )
    .join("");
}

function docText(state: DocumentState): string {
  return inlineText(blockOf(state));
}

function command(
  before: string,
  from: number,
  to: number,
  text: string,
  id: string = blockId,
): TextCommand {
  return { kind: "text", blockId: id, from, to, text, before };
}

function textPatch(
  from: number,
  to: number,
  text: string,
  id: string = blockId,
): AppliedText {
  return { kind: "text", blockId: id, from, to, text };
}

function errorOf(fn: () => unknown): CollaborationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    return error as CollaborationError;
  }
  throw new Error("expected a CollaborationError");
}

function expectRefusal(
  state: DocumentState,
  attempted: unknown,
  intervening: unknown,
): CollaborationError {
  const snapshot = JSON.stringify(state);
  const error = errorOf(() =>
    applyText(state, attempted as TextCommand, intervening as AppliedText[]),
  );
  expect(JSON.stringify(state)).toBe(snapshot);
  return error;
}

describe("legal text insert, delete and replace operations", () => {
  const inserts: { from: number; text: string; expected: string }[] = [
    { from: 0, text: "[", expected: "[hello" },
    { from: 2, text: "X", expected: "heXllo" },
    { from: 5, text: "!", expected: "hello!" },
  ];

  for (const item of inserts) {
    it(`inserts ${JSON.stringify(item.text)} at ${item.from}`, () => {
      const state = textState("hello");
      const snapshot = JSON.stringify(state);
      const requested = command("hello", item.from, item.from, item.text);
      const result = applyText(state, requested, []);
      expect(docText(result.state)).toBe(item.expected);
      expect(result.appliedText).toEqual({
        kind: "text",
        blockId,
        from: item.from,
        to: item.from,
        text: item.text,
      });
      expect(JSON.stringify(state)).toBe(snapshot);
      expect(requested).toEqual(
        command("hello", item.from, item.from, item.text),
      );
    });
  }

  const deletes: { from: number; to: number; expected: string }[] = [
    { from: 0, to: 2, expected: "llo" },
    { from: 1, to: 3, expected: "hlo" },
    { from: 3, to: 5, expected: "hel" },
    { from: 0, to: 5, expected: "" },
  ];

  for (const item of deletes) {
    it(`deletes ${item.from}..${item.to}`, () => {
      const state = textState("hello");
      const result = applyText(
        state,
        command("hello", item.from, item.to, ""),
        [],
      );
      expect(docText(result.state)).toBe(item.expected);
      expect(result.appliedText).toEqual({
        kind: "text",
        blockId,
        from: item.from,
        to: item.to,
        text: "",
      });
      expect(JSON.stringify(state)).toBe(JSON.stringify(textState("hello")));
    });
  }

  it("replaces a selection without retaining the removed range", () => {
    const result = applyText(
      textState("hello"),
      command("hello", 1, 4, "EY"),
      [],
    );
    expect(docText(result.state)).toBe("hEYo");
    expect(result.appliedText).toEqual({
      kind: "text",
      blockId,
      from: 1,
      to: 4,
      text: "EY",
    });
  });

  it("keeps marks on retained text and leaves inserted text unmarked", () => {
    const state = stateFor([
      { type: "text", text: "ab", marks: [{ type: "bold" }] },
      { type: "text", text: "cd" },
    ]);
    const result = applyText(state, command("abcd", 1, 1, "X"), []);
    expect(docText(result.state)).toBe("aXbcd");
    const content = blockOf(result.state).content ?? [];
    expect(content[0]).toMatchObject({
      type: "text",
      text: "a",
      marks: [{ type: "bold" }],
    });
    expect(content[1]).toMatchObject({ type: "text", text: "X" });
    expect(content[1]?.marks).toBeUndefined();
    expect(content[2]).toMatchObject({
      type: "text",
      text: "b",
      marks: [{ type: "bold" }],
    });
    expect(content[3]).toMatchObject({ type: "text", text: "cd" });
  });

  it("splits a marked run while deleting its first character", () => {
    const state = stateFor([
      { type: "text", text: "ab", marks: [{ type: "bold" }] },
      { type: "text", text: "cd" },
    ]);
    const result = applyText(state, command("abcd", 0, 1, ""), []);
    expect(docText(result.state)).toBe("bcd");
    const content = blockOf(result.state).content ?? [];
    expect(content[0]).toMatchObject({
      type: "text",
      text: "b",
      marks: [{ type: "bold" }],
    });
    expect(content[1]).toMatchObject({ type: "text", text: "cd" });
  });

  describe("hard breaks", () => {
    const hardBreakState = () =>
      stateFor([
        { type: "text", text: "a" },
        { type: "hardBreak" },
        { type: "text", text: "b" },
      ]);

    it("inserts at both sides of a hard break", () => {
      const before = applyText(
        hardBreakState(),
        command("a\nb", 1, 1, "X"),
        [],
      );
      expect(docText(before.state)).toBe("aX\nb");
      const after = applyText(hardBreakState(), command("a\nb", 2, 2, "Y"), []);
      expect(docText(after.state)).toBe("a\nYb");
    });

    it("deletes text that does not span the hard break", () => {
      const left = applyText(hardBreakState(), command("a\nb", 0, 1, ""), []);
      expect(docText(left.state)).toBe("\nb");
      const right = applyText(hardBreakState(), command("a\nb", 2, 3, ""), []);
      expect(docText(right.state)).toBe("a\n");
    });

    it("refuses a range spanning a hard break without mutation", () => {
      const state = hardBreakState();
      const error = expectRefusal(state, command("a\nb", 0, 2, ""), []);
      expect(error.code).toBe("UNSUPPORTED_HARD_BREAK");
      expect(docText(state)).toBe("a\nb");
    });
  });
});

describe("text intent rebasing", () => {
  it("keeps an insertion between its original neighbours after an earlier insert", () => {
    const remote = textPatch(0, 0, "YY");
    const rebased = rebaseText(command("abcd", 2, 2, "X"), [remote]);
    expect(rebased).toEqual(command("YYabcd", 4, 4, "X"));

    const remoteState = applyText(
      textState("abcd"),
      command("abcd", 0, 0, "YY"),
      [],
    ).state;
    const result = applyText(remoteState, command("abcd", 2, 2, "X"), [remote]);
    expect(docText(result.state)).toBe("YYabXcd");
    expect(result.appliedText).toEqual({
      kind: "text",
      blockId,
      from: 4,
      to: 4,
      text: "X",
    });
  });

  it("shifts an insertion after an earlier deletion", () => {
    const remote = textPatch(1, 2, "");
    const rebased = rebaseText(command("abcd", 3, 3, "X"), [remote]);
    expect(rebased).toEqual(command("acd", 2, 2, "X"));
    const remoteState = applyText(
      textState("abcd"),
      command("abcd", 1, 2, ""),
      [],
    ).state;
    const result = applyText(remoteState, command("abcd", 3, 3, "X"), [remote]);
    expect(docText(result.state)).toBe("acXd");
  });

  it("orders same-position inserts after the intervening insert", () => {
    const remote = textPatch(1, 1, "R");
    const rebased = rebaseText(command("ab", 1, 1, "O"), [remote]);
    expect(rebased).toEqual(command("aRb", 2, 2, "O"));
    const remoteState = applyText(
      textState("ab"),
      command("ab", 1, 1, "R"),
      [],
    ).state;
    const result = applyText(remoteState, command("ab", 1, 1, "O"), [remote]);
    expect(docText(result.state)).toBe("aROb");
  });

  it("moves a caret past an insert at the same position", () => {
    const remote = textPatch(2, 2, "X");
    const rebased = rebaseText(command("abc", 2, 2, "Z"), [remote]);
    expect(rebased).toEqual(command("abXc", 3, 3, "Z"));
  });

  it("maps a selection across a remote deletion before it", () => {
    const remote = textPatch(0, 1, "");
    const rebased = rebaseText(command("abcdef", 2, 4, "Z"), [remote]);
    expect(rebased).toEqual(command("bcdef", 1, 3, "Z"));
    const remoteState = applyText(
      textState("abcdef"),
      command("abcdef", 0, 1, ""),
      [],
    ).state;
    const result = applyText(remoteState, command("abcdef", 2, 4, "Z"), [
      remote,
    ]);
    expect(docText(result.state)).toBe("bZef");
  });

  describe("remote replacement at boundaries", () => {
    const base = "abcdef";
    const remote = textPatch(2, 4, "Z");
    const stateAfterRemote = () =>
      applyText(textState(base), command(base, 2, 4, "Z"), []).state;

    it("inserts at the left edge before the replacement", () => {
      expect(docText(stateAfterRemote())).toBe("abZef");
      const result = applyText(stateAfterRemote(), command(base, 2, 2, "L"), [
        remote,
      ]);
      expect(docText(result.state)).toBe("abLZef");
      expect(result.appliedText).toEqual({
        kind: "text",
        blockId,
        from: 2,
        to: 2,
        text: "L",
      });
    });

    it("inserts at the right edge after the replacement", () => {
      const result = applyText(stateAfterRemote(), command(base, 4, 4, "R"), [
        remote,
      ]);
      expect(docText(result.state)).toBe("abZRef");
      expect(result.appliedText).toEqual({
        kind: "text",
        blockId,
        from: 3,
        to: 3,
        text: "R",
      });
    });

    it("allows a selection touching the left edge", () => {
      const result = applyText(stateAfterRemote(), command(base, 1, 2, ""), [
        remote,
      ]);
      expect(docText(result.state)).toBe("aZef");
    });

    it("allows a selection touching the right edge", () => {
      const result = applyText(stateAfterRemote(), command(base, 4, 5, ""), [
        remote,
      ]);
      expect(docText(result.state)).toBe("abZf");
    });

    it("refuses a selection exactly equal to the replacement and retains it", () => {
      const state = stateAfterRemote();
      expect(docText(state)).toBe("abZef");
      const error = expectRefusal(state, command(base, 2, 4, ""), [remote]);
      expect(error.code).toBe("TEXT_CONFLICT");
      expect(docText(state)).toBe("abZef");
    });

    it("refuses a caret strictly inside the replacement", () => {
      const error = expectRefusal(
        stateAfterRemote(),
        command(base, 3, 3, "X"),
        [remote],
      );
      expect(error.code).toBe("TEXT_CONFLICT");
    });

    it("refuses a selection overlapping the replacement", () => {
      const error = expectRefusal(stateAfterRemote(), command(base, 1, 3, ""), [
        remote,
      ]);
      expect(error.code).toBe("TEXT_CONFLICT");
    });
  });

  it("refuses a delete intent that would swallow an intervening insert", () => {
    const remote = textPatch(3, 3, "XX");
    const remoteState = applyText(
      textState("abcdef"),
      command("abcdef", 3, 3, "XX"),
      [],
    ).state;
    expect(docText(remoteState)).toBe("abcXXdef");
    const error = expectRefusal(remoteState, command("abcdef", 2, 4, ""), [
      remote,
    ]);
    expect(error.code).toBe("TEXT_CONFLICT");
    expect(docText(remoteState)).toBe("abcXXdef");
  });

  it("refuses a delete intent overlapping an intervening replacement", () => {
    const remote = textPatch(3, 4, "Q");
    const remoteState = applyText(
      textState("abcdef"),
      command("abcdef", 3, 4, "Q"),
      [],
    ).state;
    const error = expectRefusal(remoteState, command("abcdef", 2, 5, ""), [
      remote,
    ]);
    expect(error.code).toBe("TEXT_CONFLICT");
  });
});

describe("unicode boundaries", () => {
  it("deletes a complete astral character", () => {
    const result = applyText(
      textState("a\u{1F600}b"),
      command("a\u{1F600}b", 1, 3, ""),
      [],
    );
    expect(docText(result.state)).toBe("ab");
    expect(result.appliedText).toEqual({
      kind: "text",
      blockId,
      from: 1,
      to: 3,
      text: "",
    });
  });

  it("inserts an astral character", () => {
    const result = applyText(
      textState("a\u{1F600}b"),
      command("a\u{1F600}b", 1, 1, "\u{1F600}"),
      [],
    );
    expect(docText(result.state)).toBe("a\u{1F600}\u{1F600}b");
  });

  it("refuses a range that splits a surrogate pair", () => {
    const state = textState("a\u{1F600}b");
    const error = expectRefusal(state, command("a\u{1F600}b", 2, 2, "X"), []);
    expect(error.code).toBe("UNICODE_SPLIT");
    expect(docText(state)).toBe("a\u{1F600}b");
  });

  it("refuses lone surrogates in the command text", () => {
    const state = textState("abc");
    const error = expectRefusal(state, command("abc", 1, 1, "\ud800"), []);
    expect(error.code).toBe("UNICODE");
  });

  it("refuses lone surrogates in an intervening patch", () => {
    const state = textState("abc");
    const error = expectRefusal(state, command("abc", 1, 1, "X"), [
      textPatch(0, 0, "\udc00"),
    ]);
    expect(error.code).toBe("UNICODE");
  });

  it("uses the shared well-formed predicate", () => {
    expect(wellFormed("a\u{1F600}b")).toBe(true);
    expect(wellFormed("\ud83d\ude00")).toBe(true);
    expect(wellFormed("\ud800")).toBe(false);
    expect(wellFormed("\udc00")).toBe(false);
    expect(wellFormed("a\ud800b")).toBe(false);
  });
});

describe("malformed commands and history", () => {
  it("refuses malformed command shapes", () => {
    const state = textState("abc");
    const cases: { attempted: unknown; code: string }[] = [
      { attempted: null, code: "INVALID_COMMAND" },
      {
        attempted: { kind: "block.delete", blockId },
        code: "INVALID_COMMAND",
      },
      {
        attempted: { ...command("abc", 1, 1, "X"), blockId: "bad id!" },
        code: "INVALID_ID",
      },
      {
        attempted: { ...command("abc", 1, 1, "X"), before: "\ud800" },
        code: "UNICODE",
      },
      {
        attempted: { ...command("abc", 1, 1, "X"), from: -1 },
        code: "TEXT_RANGE",
      },
      {
        attempted: { ...command("abc", 1, 1, "X"), from: 1.5 },
        code: "TEXT_RANGE",
      },
      {
        attempted: { ...command("abc", 1, 1, "X"), from: 3, to: 2 },
        code: "TEXT_RANGE",
      },
      {
        attempted: { ...command("abc", 1, 1, "X"), to: 4 },
        code: "TEXT_RANGE",
      },
    ];
    for (const item of cases) {
      const error = expectRefusal(state, item.attempted, []);
      expect(error.code).toBe(item.code);
    }
  });

  it("refuses a non-array history", () => {
    const error = errorOf(() =>
      rebaseText(command("abc", 1, 1, "X"), null as unknown as AppliedText[]),
    );
    expect(error.code).toBe("INVALID_HISTORY");
  });

  it("allows well-formed history entries for other blocks", () => {
    const expected = command("abc", 1, 1, "X");
    expect(rebaseText(expected, [textPatch(0, 0, "R", "other")])).toEqual(
      expected,
    );
  });

  it("refuses null and non-text history entries even for other blocks", () => {
    const cases: unknown[] = [
      null,
      { kind: "block.delete", blockId },
      { kind: "text", blockId: "other", from: 0, to: 0 },
    ];
    for (const entry of cases) {
      const error = errorOf(() =>
        rebaseText(command("abc", 1, 1, "X"), [entry as AppliedText]),
      );
      expect(error.code).toBe("INVALID_HISTORY");
    }
  });

  it("refuses unknown history fields before applying anything", () => {
    const state = textState("abc");
    const snapshot = JSON.stringify(state);
    const error = expectRefusal(state, command("abc", 1, 1, "X"), [
      { ...textPatch(0, 0, "R"), unexpected: true } as unknown as AppliedText,
    ]);
    expect(error.code).toBe("INVALID_HISTORY");
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("refuses malformed text history ranges and text", () => {
    const malformedRange = errorOf(() =>
      rebaseText(command("abc", 1, 1, "X"), [
        { kind: "text", blockId, from: 0, to: 9, text: "R" } as AppliedText,
      ]),
    );
    expect(malformedRange.code).toBe("TEXT_RANGE");

    const malformedUnicode = errorOf(() =>
      rebaseText(command("abc", 1, 1, "X"), [
        {
          kind: "text",
          blockId,
          from: 0,
          to: 0,
          text: "\ud800",
        } as AppliedText,
      ]),
    );
    expect(malformedUnicode.code).toBe("UNICODE");
  });

  it("refuses a stale before text without mutation", () => {
    const state = textState("abc");
    const error = expectRefusal(state, command("abd", 1, 1, "X"), []);
    expect(error.code).toBe("TEXT_BASE_MISMATCH");
    expect(docText(state)).toBe("abc");
  });

  it("refuses unsupported inline nodes without mutation", () => {
    const state: DocumentState = {
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { id: blockId },
            content: [
              { type: "text", text: "a" },
              { type: "image", attrs: { src: "folio-asset://x" } },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      tables: [],
      tombstones: [],
    };
    const error = expectRefusal(state, command("ab", 0, 0, "X"), []);
    expect(error.code).toBe("UNSUPPORTED_INLINE");
    expect(docText(state)).toBe("ab");
  });

  it("refuses a missing block without mutation", () => {
    const state = textState("abc");
    const error = expectRefusal(state, command("abc", 0, 0, "X", "p9"), []);
    expect(error.code).toBe("NODE_MISSING");
  });

  it("rejects unknown command fields before mutation", () => {
    const hidden = command("abc", 1, 1, "X") as TextCommand &
      Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", {
      enumerable: false,
      value: "evil",
    });
    const cases: Record<string, unknown>[] = [
      { ...command("abc", 1, 1, "X"), after: "evil" },
      { ...command("abc", 1, 1, "X"), fromOverride: 99 },
      hidden,
    ];
    for (const requested of cases) {
      const state = textState("abc");
      const error = expectRefusal(state, requested, []);
      expect(error.code).toBe("INVALID_COMMAND");
      expect(docText(state)).toBe("abc");
      expect(canonical(state)).not.toContain("evil");
    }
  });

  it("does not mutate state when an accessor-backed command throws", () => {
    const state = textState("abc");
    const snapshot = JSON.stringify(state);
    const accessor = {
      kind: "text",
      blockId,
      from: 1,
      to: 1,
      before: "abc",
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "text", {
      enumerable: true,
      get() {
        throw new Error("GETTER");
      },
    });
    expect(() =>
      applyText(state, accessor as unknown as TextCommand, []),
    ).toThrow("GETTER");
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("raw input boundary", () => {
  const adjacentRaw = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: blockId },
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ],
  });

  it("refuses raw adjacent unmarked text as a lossy projection", () => {
    const inspected = inspectSharedDocument(adjacentRaw);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) {
      expect(inspected.code).toBe("LOSSY_PROJECTION");
      expect(inspected.raw).toBe(adjacentRaw);
    }
  });

  it("normalizes adjacent unmarked text only in an internal state projection", () => {
    const rawState: DocumentState = {
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { id: blockId },
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      tables: [],
      tombstones: [],
    };
    const snapshot = JSON.stringify(rawState);
    const normalized = materializedState(rawState);
    expect(docText(normalized)).toBe("ab");
    expect(blockOf(normalized).content).toHaveLength(1);
    expect(JSON.stringify(rawState)).toBe(snapshot);
  });

  it("produces one normalized unmarked run after a legal engine edit", () => {
    const result = applyText(textState("abc"), command("abc", 0, 0, "X"), []);
    expect(docText(result.state)).toBe("Xabc");
    expect(blockOf(result.state).content).toHaveLength(1);
  });

  it("accepts a faithful raw document and preserves its schema version", () => {
    const raw = JSON.stringify({
      type: "doc",
      schemaVersion: 1,
      content: [
        {
          type: "paragraph",
          attrs: { id: blockId },
          content: [{ type: "text", text: "ok" }],
        },
      ],
    });
    const inspected = inspectSharedDocument(raw);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.document.schemaVersion).toBe(1);
      expect(inlineText(inspected.document.content![0])).toBe("ok");
    }
  });

  it("preserves raw text for unsupported numeric and structural input", () => {
    const cases: { raw: string; code: string }[] = [
      { raw: '{"type":"doc","width":1.5}', code: "UNSAFE_NUMBER" },
      { raw: '{"type":"doc","type":"doc"}', code: "DUPLICATE_KEY" },
      { raw: '{"type":"doc","text":"\\ud800"}', code: "UNICODE" },
      { raw: '{"type":"doc"} trailing', code: "JSON" },
    ];
    for (const item of cases) {
      const parsed = parseSharedInput(item.raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.code).toBe(item.code);
        expect(parsed.raw).toBe(item.raw);
      }
    }
  });

  it("refuses unsupported raw documents without rewriting the raw value", () => {
    const raw = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: blockId, unknown: true },
          content: [{ type: "text", text: "a" }],
        },
      ],
    });
    const inspected = inspectSharedDocument(raw);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) {
      expect(inspected.code).toBe("UNSUPPORTED_DOCUMENT");
      expect(inspected.raw).toBe(raw);
    }
  });

  it("refuses canonical accessors, unsafe numbers and lone surrogates", () => {
    expect(
      errorOf(() => canonical({ value: Number.MAX_SAFE_INTEGER + 1 })).code,
    ).toBe("UNSAFE_NUMBER");
    expect(errorOf(() => canonical({ value: -0 })).code).toBe("UNSAFE_NUMBER");
    expect(errorOf(() => canonical("\ud800")).code).toBe("UNICODE");

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "x", {
      enumerable: true,
      get() {
        return 1;
      },
    });
    expect(errorOf(() => canonical(accessor)).code).toBe("INVALID_ACCESSOR");
  });

  it("refuses an accessor-backed raw document without invoking or mutating it", () => {
    const document = { type: "doc" } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(document, "content", {
      enumerable: true,
      get() {
        reads += 1;
        return [];
      },
    });
    const error = errorOf(() => initialState(document as unknown as Doc));
    expect(error.code).toBe("INVALID_ACCESSOR");
    expect(reads).toBe(0);
    expect(Object.keys(document)).toEqual(["type", "content"]);
  });
});
