import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EditorView } from "@tiptap/pm/view";
import { setFindHighlight } from "../src/editor/find-highlight";
import { pageFindLabel, revealPageFindIndex, stepPageFind } from "../src/renderer/page-find";
import { PageFindBar } from "../src/renderer/PageFindBar";
import { RecordPage } from "../src/database/RecordPage";
import type { RecordProjection } from "../src/shared/types";

describe("pageFindLabel", () => {
  it.each([
    [0, -1, "0 件"],
    [0, 0, "0 件"],
    [1, 0, "1 / 1 件"],
    [1, -1, "1 件"],
    [5, 1, "2 / 5 件"],
    [5, -1, "5 件"],
    [5, 5, "5 件"],
  ] as const)("total=%d index=%d → %s", (total, index, expected) => {
    expect(pageFindLabel(total, index)).toBe(expected);
    if (total > 0) expect(pageFindLabel(total, index).endsWith(`${total} 件`)).toBe(true);
  });
});

describe("stepPageFind / revealPageFindIndex", () => {
  it("wraps around in both directions", () => {
    expect(stepPageFind(0, 3, 1)).toBe(1);
    expect(stepPageFind(2, 3, 1)).toBe(0);
    expect(stepPageFind(0, 3, -1)).toBe(2);
    expect(stepPageFind(-1, 3, 1)).toBe(0);
    expect(stepPageFind(-1, 3, -1)).toBe(2);
    expect(stepPageFind(9, 3, 1)).toBe(0);
    expect(stepPageFind(0, 0, 1)).toBe(-1);
  });
  it("reveals the stored index or the first match", () => {
    expect(revealPageFindIndex(-1, 4)).toBe(0);
    expect(revealPageFindIndex(2, 4)).toBe(2);
    expect(revealPageFindIndex(4, 4)).toBe(0);
    expect(revealPageFindIndex(0, 0)).toBe(-1);
  });
});

describe("setFindHighlight", () => {
  const view = {
    domAtPos: (pos: number) => ({ node: { pos }, offset: 0 }),
  } as unknown as Pick<EditorView, "domAtPos">;
  function fakeEnv() {
    const registry = new Map<string, unknown>();
    const ranges: unknown[] = [];
    const env = {
      CSS: {
        highlights: {
          delete: (name: string) => void registry.delete(name),
          set: (name: string, highlight: unknown) => void registry.set(name, highlight),
        },
      },
      Highlight: class {
        constructor(...args: unknown[]) {
          ranges.push(args);
        }
      },
      document: {
        createRange: () => ({
          setStart: () => undefined,
          setEnd: () => undefined,
        }),
      },
    };
    return { registry, ranges, env };
  }
  it("registers then clears the folio-find highlight", () => {
    const { registry, ranges, env } = fakeEnv();
    setFindHighlight(view, { from: 2, to: 5 }, env);
    expect(registry.has("folio-find")).toBe(true);
    expect(ranges).toHaveLength(1);
    setFindHighlight(null, null, env);
    expect(registry.has("folio-find")).toBe(false);
  });
  it("is a silent no-op without the Custom Highlight API", () => {
    expect(() => setFindHighlight(view, { from: 0, to: 1 }, {})).not.toThrow();
    expect(() => setFindHighlight(view, { from: 0, to: 1 })).not.toThrow();
    const { registry, env } = fakeEnv();
    setFindHighlight(view, null, env);
    expect(registry.has("folio-find")).toBe(false);
  });
  it("still clears when the range cannot be built", () => {
    const { registry, env } = fakeEnv();
    const broken = {
      domAtPos: () => { throw new Error("out of range"); },
    } as unknown as Pick<EditorView, "domAtPos">;
    expect(() => setFindHighlight(broken, { from: 0, to: 9 }, env)).not.toThrow();
    expect(registry.has("folio-find")).toBe(false);
  });
});

describe("PageFindBar markup", () => {
  it("renders the search input, label and navigation buttons", () => {
    const html = renderToStaticMarkup(
      createElement(PageFindBar, {
        query: "あ",
        label: "2 / 5 件",
        onQueryChange: () => undefined,
        onStep: () => undefined,
        onShow: () => undefined,
        onClose: () => undefined,
        isComposing: () => false,
      }),
    );
    expect(html).toContain('class="page-find"');
    expect(html).toContain('aria-label="ページ内検索"');
    expect(html).toContain(">表示</button>");
    expect(html).toContain('aria-label="前の一致"');
    expect(html).toContain('aria-label="次の一致"');
    expect(html).toContain("2 / 5 件");
    expect(html).toContain('aria-label="ページ内検索を閉じる"');
  });
});

describe("RecordPage find bar slot", () => {
  const recordValue: RecordProjection = {
    pageId: "page-a",
    databasePageId: "db-projects",
    revision: 1,
    title: "Alpha",
    icon: "📄",
    values: {},
    deletedAt: null,
  };
  it("mounts the find bar before the record icon and title", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPage, {
        pageId: recordValue.pageId,
        record: recordValue,
        draft: { title: recordValue.title, values: {} },
        properties: [],
        onBack: () => undefined,
        onClose: () => undefined,
        onTitleChange: () => undefined,
        onValueChange: () => undefined,
        body: createElement("div", { "data-editor-body": "same-instance" }, "本文"),
        findBar: createElement("div", { "data-find-bar": "probe" }, "検索"),
      }),
    );
    const barAt = html.indexOf('data-find-bar="probe"');
    expect(barAt).toBeGreaterThan(-1);
    expect(barAt).toBeLessThan(html.indexOf("r3-record-icon"));
    expect(barAt).toBeLessThan(html.indexOf("r3-record-title"));
  });
});
