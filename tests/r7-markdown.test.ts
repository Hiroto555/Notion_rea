import { describe, expect, it } from "vitest";
import { exportMarkdown, importMarkdown } from "../src/document-io/markdown";

const roundTrip = (title: string, body: string) =>
  importMarkdown("ignored.md", exportMarkdown(title, body));

describe("Markdown title round trip", () => {
  it.each([
    ["Simple title", "Simple body"],
    ["日本語のタイトル", "本文です。\n\n- 箇条書き"],
    ['# hash "quotes" `code` -->', "body with --> and <!-- comment -->"],
    ["  leading and trailing  ", "  body keeps spaces  "],
    ["line one\nline two\r\nline three", "body\r\nwith\nmixed endings"],
    ["", ""],
    ["", "body without title"],
    ["title without body", ""],
  ])("round trips title %j and body %j", (title, body) => {
    expect(roundTrip(title, body)).toEqual({ title, body });
  });

  it("does not duplicate the generated H1 in the imported body", () => {
    const title = "Repeated heading";
    const body = "# Repeated heading\n\nexternal heading stays";
    const exported = exportMarkdown(title, body);

    expect(exported).toContain("# " + title);
    expect(roundTrip(title, body)).toEqual({ title, body });
    expect(roundTrip(title, body).body.match(/^# /gm)).toHaveLength(1);
  });

  it("keeps metadata-like text in the body", () => {
    const body = [
      "<!-- folio:markdown:v1 title=not%20the%20real%20title -->",
      "",
      "# External heading",
      "",
      "title: fake",
      "---",
    ].join("\n");

    expect(roundTrip("Real title", body)).toEqual({
      title: "Real title",
      body,
    });
  });

  it("preserves CRLF in the body and accepts a fully CRLF-converted export", () => {
    const body = "line one\r\nline two\r\n";
    expect(roundTrip("CRLF body", body)).toEqual({
      title: "CRLF body",
      body,
    });

    const converted = exportMarkdown("CRLF export", "a\nb").replace(
      /\n/g,
      "\r\n",
    );
    expect(importMarkdown("ignored.md", converted)).toEqual({
      title: "CRLF export",
      body: "a\r\nb",
    });
  });

  it("encodes marker-sensitive title characters", () => {
    const title = "a-->b <tag> \"quoted\" 100% #hash\nsecond line";
    const exported = exportMarkdown(title, "body");
    const markerLine = exported.slice(0, exported.indexOf("\n"));

    expect(markerLine).not.toContain("-->b");
    expect(markerLine).not.toContain("<tag>");
    expect(roundTrip(title, "body")).toEqual({ title, body: "body" });
  });
});

describe("ordinary Markdown fallback", () => {
  it("returns the filename and the entire unchanged content", () => {
    const content = "# External title\r\n\r\nbody\r\n\r\n<!-- comment -->";
    expect(importMarkdown("external.markdown", content)).toEqual({
      title: "external.markdown",
      body: content,
    });
  });

  it("never strips an external H1 from ordinary Markdown", () => {
    const content = "# Do not remove\n\nbody";
    expect(importMarkdown("note.md", content)).toEqual({
      title: "note.md",
      body: content,
    });
  });

  it("falls back for an unknown marker version without eating content", () => {
    const content =
      "<!-- folio:markdown:v2 title=Future%20title -->\n# Future title\n\nbody";
    expect(importMarkdown("future.md", content)).toEqual({
      title: "future.md",
      body: content,
    });
  });

  it.each([
    ["invalid percent escape", "<!-- folio:markdown:v1 title=%ZZ -->\nbody"],
    ["non-canonical escape", "<!-- folio:markdown:v1 title=%2f -->\nbody"],
    ["raw whitespace", "<!-- folio:markdown:v1 title=two words -->\nbody"],
    ["missing suffix", "<!-- folio:markdown:v1 title=Title\nbody"],
    ["missing line ending", "<!-- folio:markdown:v1 title=Title -->"],
    ["leading whitespace", " <!-- folio:markdown:v1 title=Title -->\nbody"],
    ["oversized title", `<!-- folio:markdown:v1 title=${"a".repeat(501)} -->\nbody`],
    ["oversized marker", `<!-- folio:markdown:v1 title=${"a".repeat(10_000)} -->\nbody`],
  ])("falls back for malformed metadata: %s", (_name, content) => {
    expect(importMarkdown("malformed.md", content)).toEqual({
      title: "malformed.md",
      body: content,
    });
  });
});

describe("generated wrapper removal", () => {
  it("keeps an edited external H1 instead of stripping it", () => {
    const content =
      "<!-- folio:markdown:v1 title=Real%20title -->\n# Different heading\n\nbody";
    expect(importMarkdown("ignored.md", content)).toEqual({
      title: "Real title",
      body: "# Different heading\n\nbody",
    });
  });

  it("keeps content when the generated H1 was removed", () => {
    const content =
      "<!-- folio:markdown:v1 title=Real%20title -->\nbody without heading";
    expect(importMarkdown("ignored.md", content)).toEqual({
      title: "Real title",
      body: "body without heading",
    });
  });

  it("keeps an external H1 when the exported title was empty", () => {
    const content =
      "<!-- folio:markdown:v1 title= -->\n# External heading\n\nbody";
    expect(importMarkdown("ignored.md", content)).toEqual({
      title: "",
      body: "# External heading\n\nbody",
    });
  });
});
