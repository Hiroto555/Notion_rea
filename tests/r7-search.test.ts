import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { searchPages } from "../src/persistence/search-query";
import { SearchResults } from "../src/renderer/SearchPanel";
import { buildSnippet, searchRanges } from "../src/shared/search-snippet";
import { emptyDatabase, type Doc, type Page } from "../src/shared/types";

function textDoc(text: string): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text }] : [],
      },
    ],
  };
}

function page(overrides: Partial<Page> & Pick<Page, "id">): Page {
  return {
    parentId: null,
    title: "",
    icon: "📄",
    cover: "",
    position: 0,
    doc: textDoc(""),
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

describe("R7 ranked contextual search", () => {
  it("ranks exact title, title prefix, other title, then newer body matches", () => {
    const body = page({
      id: "body",
      title: "Body result",
      doc: textDoc("a needle in the body"),
      updatedAt: 999,
    });
    const prefix = page({
      id: "prefix",
      title: "needle notes",
      updatedAt: 500,
    });
    const exact = page({ id: "exact", title: "needle", updatedAt: 1 });
    const other = page({
      id: "other",
      title: "The needle thing",
      updatedAt: 700,
    });

    const results = searchPages([body, prefix, exact, other], "needle");

    expect(results.map((result) => result.id)).toEqual([
      "exact",
      "prefix",
      "other",
      "body",
    ]);
    expect(results.map((result) => result.searchMatch?.kind)).toEqual([
      "title",
      "title",
      "title",
      "body",
    ]);
  });

  it("keeps equal ranks in the caller's original order", () => {
    const first = page({
      id: "first",
      title: "Same",
      doc: textDoc("needle"),
    });
    const second = page({
      id: "second",
      title: "Same",
      doc: textDoc("needle"),
    });

    expect(
      searchPages([first, second], "needle").map((result) => result.id),
    ).toEqual(["first", "second"]);
  });

  it("finds a one-character Japanese title substring", () => {
    const result = searchPages(
      [page({ id: "jp", title: "会議メモ", doc: textDoc("本日の議題") })],
      "議",
    )[0];

    expect(result.searchMatch?.kind).toBe("title");
    expect(result.searchMatch?.snippet).toBe("会議メモ");
    expect(result.searchMatch?.ranges).toEqual([{ start: 1, end: 2 }]);
  });

  it("builds a snippet around a match that appears late in the body", () => {
    const body =
      "前置き".repeat(120) + "秘密のキーワード" + "後書き".repeat(40);
    const result = searchPages(
      [page({ id: "late", title: "Late", doc: textDoc(body) })],
      "秘密のキーワード",
    )[0];
    const match = result.searchMatch;

    expect(match?.kind).toBe("body");
    expect(match?.snippet.startsWith("…")).toBe(true);
    expect(match?.snippet).toContain("秘密のキーワード");
    expect(
      match?.ranges.map((range) =>
        match.snippet.slice(range.start, range.end),
      ),
    ).toContain("秘密のキーワード");
  });

  it.each([70, 500])(
    "keeps a %i-character query fully visible and highlighted",
    (queryLength) => {
      const query = "長".repeat(queryLength);
      const text = "前置き".repeat(40) + query + "後書き".repeat(40);
      const built = buildSnippet(text, query);

      expect(built).not.toBeNull();
      const at = built!.snippet.indexOf(query);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(built!.ranges).toContainEqual({
        start: at,
        end: at + query.length,
      });
    },
  );

  it("searches normalized record values and marks them as property matches", () => {
    const record = page({ id: "record", title: "Record" });
    const values = new Map([["record", "未着手 重要な値"]]);
    const result = searchPages([record], "重要な値", values)[0];

    expect(result.searchMatch?.kind).toBe("property");
    expect(result.searchMatch?.label).toBe("プロパティ");
    expect(result.searchMatch?.snippet).toContain("重要な値");
  });

  it("searches legacy database row titles and values", () => {
    const database = {
      ...emptyDatabase(),
      rows: [
        {
          id: "legacy-row",
          title: "Legacy row",
          values: { status: "完了" },
        },
      ],
    };
    const legacy = page({
      id: "legacy",
      title: "Database",
      kind: "database",
      database,
    });

    const valueResult = searchPages([legacy], "完了")[0];
    expect(valueResult.searchMatch?.kind).toBe("property");
    expect(valueResult.searchMatch?.label).toBe("ステータス");
    expect(valueResult.searchMatch?.snippet).toContain("完了");

    const titleResult = searchPages([legacy], "Legacy row")[0];
    expect(titleResult.searchMatch?.kind).toBe("property");
    expect(titleResult.searchMatch?.label).toBe("レコード");
  });

  it("excludes deleted pages even when their titles match exactly", () => {
    const deleted = page({
      id: "deleted",
      title: "needle",
      deletedAt: 42,
    });
    const alive = page({
      id: "alive",
      title: "Other",
      doc: textDoc("needle"),
    });

    expect(
      searchPages([deleted, alive], "needle").map((result) => result.id),
    ).toEqual(["alive"]);
    expect(searchPages([deleted], "needle")).toEqual([]);
  });

  it("treats empty and whitespace-only queries as an unfiltered page list", () => {
    const first = page({ id: "first", title: "First" });
    const deleted = page({ id: "deleted", title: "Deleted", deletedAt: 1 });
    const second = page({ id: "second", title: "Second" });

    for (const query of ["", "   "]) {
      const results = searchPages([first, deleted, second], query);
      expect(results.map((result) => result.id)).toEqual(["first", "second"]);
      expect(results.every((result) => result.searchMatch === undefined)).toBe(
        true,
      );
    }
  });

  it("highlights every case-insensitive occurrence in the matched text", () => {
    const result = searchPages(
      [
        page({
          id: "case",
          title: "Case",
          doc: textDoc("First alpha then ALPHA and Alpha."),
        }),
      ],
      "alpha",
    )[0];
    const match = result.searchMatch;

    expect(match?.kind).toBe("body");
    expect(
      match?.ranges.map((range) =>
        match.snippet.slice(range.start, range.end),
      ),
    ).toEqual(["alpha", "ALPHA", "Alpha"]);
  });

  it("keeps highlight offsets stable for Japanese, ASCII and surrogate text", () => {
    expect(searchRanges("会議 ABC 議事録", "abc")).toEqual([
      { start: 3, end: 6 },
    ]);
    expect(searchRanges("😀ABC", "abc")).toEqual([{ start: 2, end: 5 }]);
  });

  it("always shows the unsupported-document notice alongside a match", () => {
    const result = searchPages(
      [
        page({
          id: "broken",
          title: "needle",
          documentError: "対応していない文書形式です",
        }),
      ],
      "needle",
    )[0];
    const markup = renderToStaticMarkup(
      createElement(SearchResults, {
        results: [result],
        query: "needle",
        searchIndex: 0,
        onSelect: () => undefined,
      }),
    );

    expect(result.searchMatch?.kind).toBe("title");
    expect(markup).toContain("未対応の文書（原本を保全）");
    expect(markup).toContain("タイトルに一致");
    expect(markup).toContain("<mark>needle</mark>");
  });

  it("renders highlights as escaped React text rather than HTML", () => {
    const result = searchPages(
      [page({ id: "safe", title: "<img src=x onerror=alert(1)> alpha" })],
      "alpha",
    )[0];
    const markup = renderToStaticMarkup(
      createElement(SearchResults, {
        results: [result],
        query: "alpha",
        searchIndex: 0,
        onSelect: () => undefined,
      }),
    );

    expect(markup).toContain("<mark>alpha</mark>");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
  });
});
