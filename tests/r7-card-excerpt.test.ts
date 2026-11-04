import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DatabasePresentation } from "../src/database/DatabasePresentation";
import {
  CARD_EXCERPT_LIMIT,
  cardExcerpt,
} from "../src/database/card-excerpt";
import {
  emptyDatabase,
  type DatabaseCallbacks,
  type DatabaseProjection,
  type DatabaseSettings,
  type DatabaseViewType,
  type Doc,
  type RecordProjection,
} from "../src/shared/types";

function textDoc(text: string): Doc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const unused = async (): Promise<never> => {
  throw new Error("read-only card render must not call database callbacks");
};

const callbacks: DatabaseCallbacks = {
  openRecord() {},
  createRecord: unused,
  patchRecord: unused,
  trashRecord: unused,
  restoreRecord: unused,
  duplicateRecord: unused,
  updateSettings: unused,
};

const record: RecordProjection = {
  pageId: "rec-alpha",
  databasePageId: "db-projects",
  revision: 1,
  title: "Alpha",
  icon: "🌿",
  values: { status: "進行中" },
  deletedAt: null,
};

function projection(type: DatabaseViewType): DatabaseProjection {
  const { rows: _rows, ...base } = emptyDatabase();
  void _rows;
  const settings: DatabaseSettings = {
    ...base,
    properties: [
      {
        id: "status",
        name: "ステータス",
        type: "select",
        options: ["未着手", "進行中", "完了"],
      },
    ],
    views: [
      {
        id: "view-card",
        name: type === "board" ? "ボード" : "ギャラリー",
        type,
        filterText: "",
        filter: {
          kind: "group",
          id: "filter-card",
          conjunction: "and",
          conditions: [],
        },
        sorts: [],
        groupBy: { propertyId: "status", direction: "asc" },
      },
    ],
    activeViewId: "view-card",
    view: type,
    filter: "",
    sort: "",
  };
  return { settings, records: [record], revision: 1 };
}

function renderCard(
  type: DatabaseViewType,
  recordBodies?: Readonly<Record<string, Doc | undefined>>,
): string {
  return renderToStaticMarkup(
    createElement(DatabasePresentation, {
      value: projection(type),
      callbacks,
      databasePageId: "db-projects",
      readOnly: true,
      recordBodies,
    }),
  );
}

describe("cardExcerpt", () => {
  it("keeps block separation for nested documents", () => {
    const doc: Doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "最初の段落" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "項目 1" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "ネストした項目" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "一行目\n二行目" }],
        },
        { type: "heading", content: [{ type: "text", text: "見出し" }] },
      ],
    };

    expect(cardExcerpt(doc)).toBe(
      "最初の段落\n項目 1\nネストした項目\n一行目\n二行目\n見出し",
    );
  });

  it("keeps Japanese and combining text intact below the limit", () => {
    const text = "日本語の本文です。絵文字😊と結合文字e\u0301も含みます。";
    expect(cardExcerpt(textDoc(text))).toBe(text);
  });

  it("suppresses missing and empty-only bodies", () => {
    expect(cardExcerpt(undefined)).toBe("");
    expect(cardExcerpt(null)).toBe("");
    expect(
      cardExcerpt({
        type: "doc",
        content: [
          { type: "paragraph" },
          { type: "paragraph", content: [{ type: "text", text: " \n\t　" }] },
          { type: "paragraph", content: [{ type: "hardBreak" }] },
          { type: "heading" },
        ],
      }),
    ).toBe("");
  });

  it("keeps HTML-like text literal instead of interpreting it", () => {
    const text = '<img src=x onerror="alert(1)"> & <b>太字</b>';
    expect(cardExcerpt(textDoc(text))).toBe(text);
  });

  it("bounds text by grapheme cluster with the ellipsis included", () => {
    expect(cardExcerpt(textDoc("あ".repeat(300)))).toBe(
      "あ".repeat(CARD_EXCERPT_LIMIT - 1) + "…",
    );

    const family = "👨‍👩‍👧‍👦";
    const excerpt = cardExcerpt(textDoc(family.repeat(300)));
    expect(excerpt).toBe(family.repeat(CARD_EXCERPT_LIMIT - 1) + "…");
    expect(Buffer.from(excerpt, "utf8").toString("utf8")).toBe(excerpt);
  });
});

describe("read-only board/gallery card excerpts", () => {
  it.each(["board", "gallery"] as const)(
    "renders the body excerpt on %s cards",
    (type) => {
      const html = renderCard(type, {
        [record.pageId]: textDoc("本文の抜粋です。"),
      });
      expect(html).toContain('class="r3-card-open"');
      expect(html).toContain('<p class="r3-card-excerpt">本文の抜粋です。</p>');
      expect(html.search(/r3-card-open/)).toBeLessThan(
        html.indexOf("r3-card-excerpt"),
      );
    },
  );

  it("renders HTML-like body text as escaped text", () => {
    const html = renderCard("board", {
      [record.pageId]: textDoc('<img src=x onerror="alert(1)">'),
    });
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).not.toContain("<img src=x");
  });

  it("preserves existing markup when no bodies are supplied", () => {
    const html = renderCard("board");
    expect(html).toContain('data-record-id="rec-alpha"');
    expect(html).not.toContain("r3-card-excerpt");
  });

  it("omits an empty card body without leaving an empty element", () => {
    const html = renderCard("gallery", {
      [record.pageId]: { type: "doc", content: [{ type: "paragraph" }] },
    });
    expect(html).not.toContain("r3-card-excerpt");
  });
});
