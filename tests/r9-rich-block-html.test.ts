import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { renderRichBlockHTML } from "../src/document-io/rich-block-html";

type Marks = JSONContent["marks"];

const text = (value: string, marks?: Marks): JSONContent => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});

const paragraph = (...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  content,
});

const callout = (content: JSONContent[], tone?: string): JSONContent => ({
  type: "callout",
  ...(tone === undefined ? {} : { attrs: { tone } }),
  content,
});

const cell = (
  type: "tableCell" | "tableHeader",
  content: JSONContent[],
  attrs?: Record<string, unknown>,
): JSONContent => ({
  type,
  ...(attrs ? { attrs } : {}),
  content,
});

const row = (...cells: JSONContent[]): JSONContent => ({
  type: "tableRow",
  content: cells,
});

const table = (...rows: JSONContent[]): JSONContent => ({
  type: "table",
  content: rows,
});

describe("callout HTML", () => {
  it("defaults the tone to note", () => {
    expect(renderRichBlockHTML(callout([paragraph(text("Hello"))]))).toBe(
      [
        '<aside data-folio-callout="" data-tone="note">',
        "<p>Hello</p>",
        "</aside>",
      ].join("\n"),
    );
  });

  it("renders every supported tone and keeps nested blocks", () => {
    for (const tone of ["note", "tip", "warning"]) {
      const html = renderRichBlockHTML(
        callout([paragraph(text("a")), paragraph(text("b"))], tone),
      );
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain("<p>a</p>\n<p>b</p>");
    }
    expect(() => renderRichBlockHTML(callout([], "danger"))).toThrow(
      /Unsupported callout tone/,
    );
  });

  it("does not emit block IDs", () => {
    const html = renderRichBlockHTML({
      type: "callout",
      attrs: { tone: "tip", id: "callout-id" },
      content: [
        { type: "paragraph", attrs: { id: "paragraph-id" }, content: [] },
      ],
    });
    expect(html).not.toContain("callout-id");
    expect(html).not.toContain("paragraph-id");
    expect(html).not.toContain("data-folio-block-id");
  });
});

describe("simple table HTML", () => {
  it("renders standard table/tbody/tr/th/td markup", () => {
    const html = renderRichBlockHTML(
      table(
        row(
          cell("tableHeader", [paragraph(text("Name"))]),
          cell("tableHeader", [paragraph(text("Note"))]),
        ),
        row(
          cell("tableCell", [paragraph(text("A"))]),
          cell("tableCell", [paragraph(text("B"))]),
        ),
      ),
    );

    expect(html).toBe(
      [
        "<table>",
        "<tbody>",
        "<tr>",
        "<th>",
        "<p>Name</p>",
        "</th>",
        "<th>",
        "<p>Note</p>",
        "</th>",
        "</tr>",
        "<tr>",
        "<td>",
        "<p>A</p>",
        "</td>",
        "<td>",
        "<p>B</p>",
        "</td>",
        "</tr>",
        "</tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("accepts the default cell attributes but rejects merged cells", () => {
    const html = renderRichBlockHTML(
      table(
        row(
          cell("tableCell", [paragraph(text("ok"))], {
            colspan: 1,
            rowspan: 1,
            colwidth: null,
          }),
        ),
      ),
    );
    expect(html).toContain("<p>ok</p>");

    for (const attrs of [{ colspan: 2 }, { rowspan: 2 }, { colwidth: [100] }]) {
      expect(() =>
        renderRichBlockHTML(
          table(row(cell("tableCell", [paragraph(text("no"))], attrs))),
        ),
      ).toThrow(/not supported/);
    }
  });

  it("rejects non-rectangular, empty, and oversized tables", () => {
    expect(() =>
      renderRichBlockHTML(
        table(
          row(
            cell("tableCell", [paragraph(text("one"))]),
            cell("tableCell", [paragraph(text("two"))]),
          ),
          row(cell("tableCell", [paragraph(text("three"))])),
        ),
      ),
    ).toThrow(/same number of cells/);

    expect(() => renderRichBlockHTML(table())).toThrow(/at least one row/);

    const tooManyRows = Array.from({ length: 101 }, () =>
      row(cell("tableCell", [paragraph(text("x"))])),
    );
    expect(() => renderRichBlockHTML(table(...tooManyRows))).toThrow(
      /may not exceed 100 rows/,
    );
  });

  it("rejects nested tables inside a cell", () => {
    expect(() =>
      renderRichBlockHTML(
        table(
          row(
            cell("tableCell", [
              paragraph(text("outer")),
              table(row(cell("tableCell", [paragraph(text("inner"))]))),
            ]),
          ),
        ),
      ),
    ).toThrow(/Table cells may only contain paragraphs/);
  });

  it("preserves multiline cell content, links, emphasis, pipes, backslashes, and Japanese", () => {
    const html = renderRichBlockHTML(
      callout(
        [
          table(
            row(
              cell("tableCell", [
                paragraph(
                  text("日本語 | 列 \\ "),
                  text("強調", [{ type: "italic" }]),
                  text("リンク", [
                    {
                      type: "link",
                      attrs: { href: "folio-page:page-1" },
                    },
                  ]),
                  { type: "hardBreak" },
                  text("二行目"),
                ),
              ]),
            ),
          ),
        ],
        "tip",
      ),
    );

    expect(html).toContain("<td>");
    expect(html).toContain("日本語 | 列 \\ ");
    expect(html).toContain("<em>強調</em>");
    expect(html).toContain('<a href="folio-page:page-1">リンク</a>');
    expect(html).toContain("<br>二行目");
    expect(html).not.toMatch(/\n[^\S\n]*\n/);
  });
});

describe("text and attribute escaping", () => {
  it("escapes markup characters in text and attributes", () => {
    const html = renderRichBlockHTML(
      callout([
        paragraph(
          text("<script>alert(\"x\") & 'y'</script>"),
          text("link", [
            {
              type: "link",
              attrs: {
                href: 'https://example.com/?a=1&b="2"',
                target: "_blank",
                rel: 'noopener"',
                class: "external",
              },
            },
          ]),
        ),
      ]),
    );

    expect(html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;",
    );
    expect(html).toContain(
      'href="https://example.com/?a=1&amp;b=&quot;2&quot;"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener&quot;"');
    expect(html).toContain('class="external"');
    expect(html).not.toContain("<script>");
  });

  it("blocks javascript and vbscript URLs but preserves Folio URLs", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "java\nscript:alert(1)",
      " \u0000vbscript:msgbox(1)",
    ]) {
      const html = renderRichBlockHTML(
        paragraph(text("click", [{ type: "link", attrs: { href } }])),
      );
      expect(html).toBe("<p><a>click</a></p>");
    }

    for (const href of ["folio-page:page-1", "folio-asset:asset-1"]) {
      expect(
        renderRichBlockHTML(
          paragraph(text("safe", [{ type: "link", attrs: { href } }])),
        ),
      ).toContain(`href="${href}"`);
    }
  });

  it("escapes images and drops dangerous image sources", () => {
    const html = renderRichBlockHTML({
      type: "image",
      attrs: {
        src: "javascript:alert(1)",
        alt: "<alt>",
        title: '"title"',
        width: 320,
      },
    });
    expect(html).toBe(
      '<img alt="&lt;alt&gt;" title="&quot;title&quot;" width="320">',
    );
    expect(html).not.toContain("javascript:");

    expect(
      renderRichBlockHTML({
        type: "image",
        attrs: { src: "folio-asset:image-1", alt: "a" },
      }),
    ).toBe('<img src="folio-asset:image-1" alt="a">');
  });
});

describe("marks and inline nodes", () => {
  it("renders all supported marks and hard breaks", () => {
    const html = renderRichBlockHTML(
      paragraph(
        text("bold", [{ type: "bold" }]),
        text("italic", [{ type: "italic" }]),
        text("strike", [{ type: "strike" }]),
        text("under", [{ type: "underline" }]),
        text("code", [{ type: "code" }]),
        text("link", [
          { type: "link", attrs: { href: "folio-asset:asset-1" } },
        ]),
        { type: "hardBreak" },
        text("after"),
      ),
    );

    expect(html).toBe(
      '<p><strong>bold</strong><em>italic</em><s>strike</s><u>under</u><code>code</code><a href="folio-asset:asset-1">link</a><br>after</p>',
    );
  });

  it("throws for unsupported nodes and marks instead of flattening", () => {
    expect(() =>
      renderRichBlockHTML(callout([{ type: "mention", attrs: {} }])),
    ).toThrow(/Unsupported rich block node/);

    expect(() =>
      renderRichBlockHTML(
        paragraph(text("x", [{ type: "highlight", attrs: {} }])),
      ),
    ).toThrow(/Unsupported rich block mark/);

    expect(() =>
      renderRichBlockHTML(paragraph(text("x", [{ type: "link", attrs: {} }]))),
    ).toThrow(/Link mark requires a string href/);

    expect(() =>
      renderRichBlockHTML(paragraph({ type: "image", attrs: { src: "x" } })),
    ).toThrow(/Unsupported inline node/);
  });
});

describe("lists, code blocks, details, and rich nesting", () => {
  it("renders nested lists, ordered list attributes, and task items", () => {
    const html = renderRichBlockHTML(
      callout([
        {
          type: "orderedList",
          attrs: { start: 3, type: "a" },
          content: [
            {
              type: "listItem",
              content: [
                paragraph(text("first")),
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [paragraph(text("nested"))],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [paragraph(text("done"))],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [paragraph(text("todo"))],
            },
          ],
        },
      ]),
    );

    expect(html).toContain('<ol start="3" type="a">');
    expect(html).toContain("<li>\n<p>first</p>\n<ul>");
    expect(html).toContain("<li>\n<p>nested</p>\n</li>");
    expect(html).toContain('<ul data-type="taskList">');
    expect(html).toContain('<li data-type="taskItem" data-checked="true">');
    expect(html).toContain('<li data-type="taskItem" data-checked="false">');
  });

  it("preserves code language, escaping, and blank lines without literal blank lines", () => {
    const source =
      'const html = "<b>&";\n\nline 2\n   \nline 3 </code></pre><script>alert("x")</script>';
    const html = renderRichBlockHTML({
      type: "codeBlock",
      attrs: { language: 'ts"x' },
      content: [text(source)],
    });

    expect(html).toContain('<pre><code class="language-ts&quot;x">');
    expect(html).toContain("&lt;b&gt;&amp;");
    expect(html).toContain("&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#10;line 2");
    expect(html).toContain("&#32;&#32;&#32;&#10;line 3");
    expect(html).not.toMatch(/\n[^\S\n]*\n/);
  });

  it("renders details with the schema's content wrapper", () => {
    const html = renderRichBlockHTML({
      type: "details",
      attrs: { open: true },
      content: [
        {
          type: "detailsSummary",
          content: [text("Title", [{ type: "bold" }])],
        },
        {
          type: "detailsContent",
          content: [paragraph(text("Body"))],
        },
      ],
    });

    expect(html).toBe(
      [
        "<details open>",
        "<summary><strong>Title</strong></summary>",
        '<div data-type="detailsContent">',
        "<p>Body</p>",
        "</div>",
        "</details>",
      ].join("\n"),
    );
  });

  it("keeps callout nesting, code, lists, and tables in one HTML block", () => {
    const html = renderRichBlockHTML(
      callout(
        [
          paragraph(text("Intro")),
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [paragraph(text("item"))],
              },
            ],
          },
          {
            type: "codeBlock",
            attrs: { language: "ts" },
            content: [text("const a = 1;\n\nconst b = 2;")],
          },
          table(row(cell("tableCell", [paragraph(text("cell"))]))),
        ],
        "warning",
      ),
    );

    expect(html).toContain('<aside data-folio-callout="" data-tone="warning">');
    expect(html).toContain("<ul>\n<li>\n<p>item</p>\n</li>\n</ul>");
    expect(html).toContain(
      '<pre><code class="language-ts">const a = 1;\n&#10;const b = 2;</code></pre>',
    );
    expect(html).toContain("<table>\n<tbody>");
    expect(html).not.toMatch(/\n[^\S\n]*\n/);
  });

  it("lexes as a single HTML block with the installed Markdown lexer", () => {
    const html = renderRichBlockHTML(
      callout(
        [
          {
            type: "codeBlock",
            content: [text("a\n\nb\n   \nc")],
          },
          table(row(cell("tableCell", [paragraph(text("cell"))]))),
        ],
        "note",
      ),
    );

    const manager = new MarkdownManager({ extensions: [] });
    const lexer = new manager.instance.Lexer(manager.instance.defaults);
    const tokens = lexer.lex(html);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe("html");
  });
});
