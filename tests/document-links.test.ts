import { describe, expect, it } from "vitest";
import {
  describeDocumentLink,
  documentLinkClickAction,
  normalizeWebLink,
  parseDocumentLink,
} from "../src/renderer/document-links";
import { validDocument } from "../src/shared/validation";

describe("parseDocumentLink", () => {
  it("parses folio-page links, tolerating one trailing slash", () => {
    expect(parseDocumentLink("folio-page://abc-123")).toEqual({ kind: "page", id: "abc-123" });
    expect(parseDocumentLink("folio-page://abc-123/")).toEqual({ kind: "page", id: "abc-123" });
    expect(parseDocumentLink("folio-page://")).toBeNull();
    expect(parseDocumentLink("folio-page:///")).toBeNull();
  });
  it("parses asset and web links", () => {
    expect(parseDocumentLink("folio-asset://file.png")).toEqual({ kind: "asset", url: "folio-asset://file.png" });
    expect(parseDocumentLink("https://example.com/a?b=1")).toEqual({ kind: "web", url: "https://example.com/a?b=1" });
    expect(parseDocumentLink("http://example.com")).toEqual({ kind: "web", url: "http://example.com" });
    expect(parseDocumentLink("HTTPS://example.com")).toEqual({ kind: "web", url: "HTTPS://example.com" });
  });
  it("rejects other schemes and plain text", () => {
    for (const href of ["javascript:alert(1)", "mailto:a@b.c", "ftp://x", "example.com", ""])
      expect(parseDocumentLink(href)).toBeNull();
  });
});

describe("documentLinkClickAction", () => {
  const act = (href: string, inEditableEditor: boolean, modifier: boolean) =>
    documentLinkClickAction({ href, inEditableEditor, modifier });
  it("keeps plain clicks inside an editable editor in place", () => {
    expect(act("folio-page://p1", true, false)).toBe("none");
    expect(act("https://example.com/", true, false)).toBe("none");
  });
  it("opens page and web links on modified or read-only clicks", () => {
    expect(act("folio-page://p1", true, true)).toBe("open");
    expect(act("https://example.com/", true, true)).toBe("open");
    expect(act("folio-page://p1", false, false)).toBe("open");
    expect(act("https://example.com/", false, false)).toBe("open");
  });
  it("always opens attachment links, even on a plain editable click", () => {
    expect(act("folio-asset://file.png", true, false)).toBe("open");
    expect(act("folio-asset://file.png", false, false)).toBe("open");
  });
  it("never opens unparseable hrefs", () => {
    expect(act("javascript:alert(1)", false, true)).toBe("none");
    expect(act("mailto:a@b.c", false, false)).toBe("none");
  });
});

describe("normalizeWebLink", () => {
  it("trims and canonicalizes http(s) input", () => {
    expect(normalizeWebLink("  https://example.com ")).toBe("https://example.com/");
    expect(normalizeWebLink("http://example.com/path")).toBe("http://example.com/path");
    expect(normalizeWebLink("HTTPS://Example.COM/x")).toBe("https://example.com/x");
  });
  it("rejects non-http input and malformed URLs", () => {
    for (const input of [
      "example.com",
      "javascript:alert(1)",
      "ftp://x",
      "https://",
      "folio-page://x",
      "   ",
      "https://example.com/" + "a".repeat(2050),
    ])
      expect(normalizeWebLink(input)).toBeNull();
  });
});

describe("describeDocumentLink", () => {
  const titles = new Map([["p1", "企画書"], ["p2", ""]]);
  const lookup = (id: string) => titles.get(id);
  it("describes each link kind for the current-link bar", () => {
    expect(describeDocumentLink("folio-page://p1", lookup)).toBe("ページ「企画書」");
    expect(describeDocumentLink("folio-page://p2", lookup)).toBe("ページ「無題」");
    expect(describeDocumentLink("folio-page://missing", lookup)).toBe("見つからないページ");
    expect(describeDocumentLink("https://example.com/", lookup)).toBe("https://example.com/");
    expect(describeDocumentLink("folio-asset://file.png", lookup)).toBe("添付ファイル");
    expect(describeDocumentLink("???", lookup)).toBe("???");
  });
});

describe("link mark document validation", () => {
  const doc = (href: string) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href } }] }],
      },
    ],
  });
  it("accepts an http(s) link mark and rejects a javascript: href", () => {
    expect(validDocument(doc("https://example.com/"))).toBe(true);
    expect(validDocument(doc("javascript:alert(1)"))).toBe(false);
  });
});
