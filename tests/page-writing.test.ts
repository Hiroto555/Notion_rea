import { describe, expect, it } from "vitest";
import {
  customPageIcon,
  newPageTitleFocusAllowed,
  titleKeyMovesToBody,
} from "../src/renderer/page-writing";

describe("customPageIcon", () => {
  it("keeps a single grapheme, including multi-codepoint emoji", () => {
    expect(customPageIcon("🦊")).toBe("🦊");
    expect(customPageIcon("🦊🐱")).toBe("🦊");
    expect(customPageIcon("  🦊 ")).toBe("🦊");
    expect(customPageIcon("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(customPageIcon("🇯🇵")).toBe("🇯🇵");
    expect(customPageIcon("A")).toBe("A");
  });
  it("rejects empty, whitespace-only and overlong graphemes", () => {
    expect(customPageIcon("")).toBeNull();
    expect(customPageIcon("   ")).toBeNull();
    expect(customPageIcon("e" + "́".repeat(17))).toBeNull();
  });
});

describe("titleKeyMovesToBody", () => {
  it("moves on plain Enter and ArrowDown only", () => {
    expect(titleKeyMovesToBody({ key: "Enter" })).toBe(true);
    expect(titleKeyMovesToBody({ key: "ArrowDown" })).toBe(true);
    for (const event of [
      { key: "Enter", shiftKey: true },
      { key: "Enter", metaKey: true },
      { key: "Enter", ctrlKey: true },
      { key: "ArrowDown", altKey: true },
      { key: "Enter", isComposing: true },
      { key: "Enter", keyCode: 229 },
    ])
      expect(titleKeyMovesToBody(event)).toBe(false);
    expect(titleKeyMovesToBody({ key: "Enter" }, true)).toBe(false);
    expect(titleKeyMovesToBody({ key: "ArrowUp" })).toBe(false);
    expect(titleKeyMovesToBody({ key: "Tab" })).toBe(false);
    expect(titleKeyMovesToBody({ key: "a" })).toBe(false);
  });
});

describe("newPageTitleFocusAllowed", () => {
  const title = { tagName: "INPUT" };
  const body = { tagName: "BODY" };
  it("allows focus when nothing, the body or the title itself is active", () => {
    expect(newPageTitleFocusAllowed(null, title, body)).toBe(true);
    expect(newPageTitleFocusAllowed(undefined, title, body)).toBe(true);
    expect(newPageTitleFocusAllowed(body, title, body)).toBe(true);
    expect(newPageTitleFocusAllowed(title, title, body)).toBe(true);
  });
  it("refuses to steal focus from inputs, selects, textareas and editors", () => {
    expect(newPageTitleFocusAllowed({ tagName: "INPUT" }, title, body)).toBe(false);
    expect(newPageTitleFocusAllowed({ tagName: "textarea" }, title, body)).toBe(false);
    expect(newPageTitleFocusAllowed({ tagName: "SELECT" }, title, body)).toBe(false);
    expect(newPageTitleFocusAllowed({ tagName: "DIV", isContentEditable: true }, title, body)).toBe(false);
  });
  it("allows focus from neutral chrome elements", () => {
    expect(newPageTitleFocusAllowed({ tagName: "DIV" }, title, body)).toBe(true);
    expect(newPageTitleFocusAllowed({ tagName: "BUTTON" }, title)).toBe(true);
  });
});
