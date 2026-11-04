import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { queryBacklinks } from "../src/persistence/backlinks-query";
import { BacklinksPanel } from "../src/renderer/BacklinksPanel";
import type { BacklinkGroup } from "../src/shared/backlinks";
import type { Doc, Page } from "../src/shared/types";

const target = "target-page";
const href = (id = target, slash = false) =>
  `folio-page://${id}${slash ? "/" : ""}`;

function text(value: string): Doc {
  return { type: "text", text: value };
}

function linked(
  value: string,
  id = target,
  extraMarks: Doc["marks"] = [],
  slash = false,
): Doc {
  return {
    type: "text",
    text: value,
    marks: [{ type: "link", attrs: { href: href(id, slash) } }, ...extraMarks],
  };
}

function paragraph(id?: string, content: Doc[] = []): Doc {
  return { type: "paragraph", attrs: id ? { id } : undefined, content };
}

function listItem(id: string, content: Doc[]): Doc {
  return { type: "listItem", attrs: { id }, content };
}

function doc(...content: Doc[]): Doc {
  return { type: "doc", content };
}

function page(overrides: Partial<Page> & Pick<Page, "id">): Page {
  return {
    parentId: null,
    title: "",
    icon: "📄",
    cover: "",
    position: 0,
    doc: doc(paragraph()),
    kind: "page",
    database: null,
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    deletedAt: null,
    ...overrides,
  };
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("R8 contextual backlinks query", () => {
  it("locates the actual occurrence, not a repeated earlier text, and accepts one trailing slash", () => {
    const source = page({
      id: "source",
      title: "Source",
      icon: "🔗",
      doc: doc(
        paragraph("block-1", [
          text("target first, then "),
          linked("target", target, [], true),
        ]),
      ),
    });

    const groups = queryBacklinks([source], target);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      pageId: "source",
      title: "Source",
      icon: "🔗",
    });
    const occurrence = groups[0].occurrences[0];
    expect(occurrence.blockId).toBe("block-1");
    expect(occurrence.linkText).toBe("target");
    expect(occurrence.context).toContain("target first, then");
    const [range] = occurrence.ranges;
    expect(occurrence.context.slice(range.start, range.end)).toBe("target");
    expect(range.start).toBeGreaterThan(occurrence.context.indexOf("target"));
  });

  it("coalesces adjacent marks of one link but keeps separated links separate", () => {
    const source = page({
      id: "source",
      doc: doc(
        paragraph("block-1", [
          text("Read "),
          linked("Folio"),
          linked(" notes", target, [{ type: "bold" }]),
          text(" and "),
          linked("Folio"),
        ]),
      ),
    });

    const occurrences = queryBacklinks([source], target)[0].occurrences;
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((occurrence) => occurrence.linkText)).toEqual([
      "Folio notes",
      "Folio",
    ]);
    expect(occurrences.map((occurrence) => occurrence.blockId)).toEqual([
      "block-1",
      "block-1",
    ]);
    for (const occurrence of occurrences) {
      const [range] = occurrence.ranges;
      expect(occurrence.context.slice(range.start, range.end)).toBe(
        occurrence.linkText,
      );
    }
  });

  it("uses the nearest block id in nested lists without duplicating ancestor text", () => {
    const source = page({
      id: "source",
      doc: doc(
        paragraph("top-block", [linked("top")]),
        {
          type: "bulletList",
          content: [
            listItem("item-1", [paragraph("nested-1", [linked("nested")])]),
            listItem("item-2", [
              paragraph(undefined, [linked("fallback")]),
              {
                type: "bulletList",
                content: [
                  listItem("item-3", [paragraph("deep-block", [linked("deep")])]),
                ],
              },
            ]),
          ],
        },
      ),
    });

    const occurrences = queryBacklinks([source], target)[0].occurrences;
    expect(occurrences.map((occurrence) => occurrence.linkText)).toEqual([
      "top",
      "nested",
      "fallback",
      "deep",
    ]);
    expect(occurrences.map((occurrence) => occurrence.blockId)).toEqual([
      "top-block",
      "nested-1",
      "item-2",
      "deep-block",
    ]);
  });

  it("returns a null block id when no block contains an id", () => {
    const source = page({
      id: "source",
      doc: doc(paragraph(undefined, [linked("plain")])),
    });
    expect(queryBacklinks([source], target)[0].occurrences[0].blockId).toBeNull();
  });

  it("excludes deleted, document-error and self sources while preserving page order", () => {
    const linkedPage = (id: string, overrides: Partial<Page> = {}) =>
      page({
        id,
        doc: doc(paragraph(`${id}-block`, [linked("linked")])),
        ...overrides,
      });
    const deleted = linkedPage("deleted", { deletedAt: 10 });
    const self = linkedPage(target);
    const error = linkedPage("error", { documentError: "unsupported" });
    const first = linkedPage("first");
    const second = linkedPage("second");

    expect(
      queryBacklinks([deleted, self, error, first, second], target).map(
        (group) => group.pageId,
      ),
    ).toEqual(["first", "second"]);
  });

  it("does not accept a second trailing slash or another page id", () => {
    const source = page({
      id: "source",
      doc: doc(
        paragraph("block-1", [
          {
            type: "text",
            text: "double",
            marks: [{ type: "link", attrs: { href: `${href(target)}//` } }],
          },
          {
            type: "text",
            text: "other",
            marks: [{ type: "link", attrs: { href: href("other") } }],
          },
          linked("valid"),
        ]),
      ),
    });

    const occurrences = queryBacklinks([source], target)[0].occurrences;
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].linkText).toBe("valid");
  });

  it("keeps short Japanese context intact and highlights the actual character", () => {
    const source = page({
      id: "jp",
      title: "会議メモ",
      doc: doc(paragraph("jp-block", [text("本日の"), linked("議"), text("題")])),
    });

    const occurrence = queryBacklinks([source], target)[0].occurrences[0];
    expect(occurrence.context).toBe("本日の議題");
    expect(occurrence.linkText).toBe("議");
    expect(occurrence.ranges).toEqual([{ start: 3, end: 4 }]);
  });

  it("does not split surrogate pairs at context window boundaries", () => {
    const source = page({
      id: "emoji",
      doc: doc(
        paragraph("emoji-block", [
          text("👍".repeat(80)),
          linked("target"),
          text("👍".repeat(80)),
        ]),
      ),
    });

    const occurrence = queryBacklinks([source], target)[0].occurrences[0];
    expect(hasLoneSurrogate(occurrence.context)).toBe(false);
    const [range] = occurrence.ranges;
    expect(occurrence.context.slice(range.start, range.end)).toBe("target");
    expect(occurrence.context.length).toBeLessThanOrEqual(140);
  });

  it("reads the current document on every call so live edits update immediately", () => {
    const source = page({
      id: "source",
      doc: doc(paragraph("block-1", [linked("linked")])),
    });
    expect(queryBacklinks([source], target)).toHaveLength(1);

    source.doc = doc(paragraph("block-1", [text("link removed")]));
    expect(queryBacklinks([source], target)).toHaveLength(0);

    source.doc = doc(paragraph("block-1", [linked("linked again")]));
    expect(queryBacklinks([source], target)[0].occurrences[0].linkText).toBe(
      "linked again",
    );
  });
});

describe("R8 contextual backlinks panel", () => {
  it("renders source-page count, titles, highlighted React text and accessible navigation", () => {
    const groups: BacklinkGroup[] = [
      {
        pageId: "source",
        title: "Source page",
        icon: "🔗",
        occurrences: [
          {
            blockId: "block-1",
            context: "Read the linked note",
            linkText: "linked",
            ranges: [{ start: 9, end: 15 }],
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      createElement(BacklinksPanel, {
        groups,
        onNavigate: () => undefined,
      }),
    );

    expect(html).toContain("バックリンク");
    expect(html).toContain("1ページ");
    expect(html).toContain("Source page");
    expect(html).toContain("🔗");
    expect(html).toContain("<mark>linked</mark>");
    expect(html).toContain("Source page を開く");
    expect(html).toContain("参照箇所を開く");
  });

  it("escapes markup in titles and context instead of interpolating HTML", () => {
    const source = page({
      id: "source",
      title: '<img src=x onerror="alert(1)">',
      icon: "<svg>",
      doc: doc(
        paragraph("block-1", [
          linked('<script>alert("x")</script>'),
        ]),
      ),
    });
    const html = renderToStaticMarkup(
      createElement(BacklinksPanel, {
        groups: queryBacklinks([source], target),
        onNavigate: () => undefined,
      }),
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain("<svg>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;svg&gt;");
    expect(html).toContain("<mark>");
  });

  it("renders a readable empty state with a zero source-page count", () => {
    const html = renderToStaticMarkup(
      createElement(BacklinksPanel, {
        groups: [],
        onNavigate: () => undefined,
      }),
    );

    expect(html).toContain("0ページ");
    expect(html).toContain("このページへのリンクはまだありません");
  });
});
