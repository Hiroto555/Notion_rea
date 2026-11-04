import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  DatabaseSettings,
  DatabaseView,
  Property,
} from "../src/shared/types";
import { emptyDatabase } from "../src/shared/types";
import { DatabaseSettingsPanel } from "../src/database/DatabaseSettingsPanel";
import {
  summarizeView,
  type ViewSummaryChip,
} from "../src/database/settings-menu/summaries";

const properties: Property[] = [
  {
    id: "status",
    name: "ステータス",
    type: "select",
    options: ["未着手", "進行中", "完了"],
  },
  { id: "due", name: "期日", type: "date" },
  { id: "cost", name: "費用", type: "number" },
];

function baseSettings(): DatabaseSettings {
  const { rows: _rows, ...settings } = emptyDatabase();
  void _rows;
  return settings;
}

function viewWithConditions(): DatabaseView {
  const view = baseSettings().views[0];
  view.filter = {
    kind: "group",
    id: "outer",
    conjunction: "and",
    conditions: [
      {
        kind: "condition",
        id: "condition-a",
        propertyId: "title",
        operator: "contains",
        value: "Task",
      },
      {
        kind: "group",
        id: "inner",
        conjunction: "or",
        conditions: [
          {
            kind: "condition",
            id: "condition-b",
            propertyId: "title",
            operator: "starts_with",
            value: "A",
          },
          {
            kind: "condition",
            id: "condition-c",
            propertyId: "status",
            operator: "equals",
            value: "進行中",
          },
        ],
      },
    ],
  };
  view.sorts = [
    { id: "sort-a", propertyId: "due", direction: "desc" },
    { id: "sort-b", propertyId: "cost", direction: "asc" },
  ];
  view.groupBy = { propertyId: "status", direction: "asc" };
  return view;
}

function chipTexts(chips: ViewSummaryChip[]) {
  return chips.map((chip) => chip.text);
}

describe("compact settings menu summaries", () => {
  it("summarises nested filters, multiple sorts and a group", () => {
    const summary = summarizeView(viewWithConditions(), properties);
    expect(chipTexts(summary.filters)).toEqual([
      "名前 含む「Task」",
      "名前 で始まる「A」",
      "ステータス 等しい「進行中」",
    ]);
    expect(summary.filters.map((chip) => chip.scope)).toEqual([
      undefined,
      "グループ内いずれか (OR)",
      "グループ内いずれか (OR)",
    ]);
    expect(chipTexts(summary.sorts)).toEqual(["期日 降順", "費用 昇順"]);
    expect(summary.group?.text).toBe("ステータス 昇順");
    expect(summary.activeCount).toBe(6);
    expect(summary.filterExpression).toBe(
      "名前 含む「Task」 かつ (名前 で始まる「A」 または ステータス 等しい「進行中」)",
    );
  });

  it("omits absent values for no-value operators and falls back to a property id", () => {
    const view = baseSettings().views[0];
    view.filter = {
      kind: "group",
      id: "outer",
      conjunction: "or",
      conditions: [
        {
          kind: "condition",
          id: "empty",
          propertyId: "status",
          operator: "is_empty",
        },
        {
          kind: "condition",
          id: "missing",
          propertyId: "missing-property",
          operator: "contains",
          value: "x",
        },
      ],
    };
    const summary = summarizeView(view, properties);
    expect(chipTexts(summary.filters)).toEqual([
      "ステータス 空である",
      "missing-property 含む「x」",
    ]);
    expect(summary.sorts).toEqual([]);
    expect(summary.group).toBeNull();
    expect(summary.activeCount).toBe(2);
  });

  it("renders compact main controls, mounted closed panels and parent toolbar actions", () => {
    const settings = baseSettings();
    settings.properties = properties;
    settings.views[0] = viewWithConditions();
    const html = renderToStaticMarkup(
      createElement(DatabaseSettingsPanel, {
        settings,
        onIntent: () => undefined,
        status: "pending",
        toolbarActions: createElement(
          "button",
          { type: "button", "data-parent-toolbar": "new-row" },
          "新規行",
        ),
      }),
    );

    expect(html).toContain('data-settings-state="pending"');
    expect(html).toContain("設定の保存待ち");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-parent-toolbar="new-row"');
    expect(html).toContain("適用中の表示条件");
    expect(html).toContain("名前 含む「Task」");
    expect(html).toContain("期日 降順");
    expect(html).toContain("ステータス 昇順");
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
    for (const name of ["view-options", "filter", "sort"]) {
      const panel = new RegExp(
        `<div[^>]*data-settings-menu-panel="${name}"[^>]*>`,
      ).exec(html)?.[0];
      expect(panel).toContain("hidden");
    }
    expect(html).toContain('aria-label="ビュー名"');
    expect(html).toContain('aria-label="ビュー内検索"');
    expect(html).toContain('aria-label="ビューを追加"');
  });

  it("keeps conflict and unknown status plus recovery outside collapsed menus", () => {
    const settings = baseSettings();
    const conflict = renderToStaticMarkup(
      createElement(DatabaseSettingsPanel, {
        settings,
        onIntent: () => undefined,
        status: "conflict",
        onResolve: () => undefined,
      }),
    );
    expect(conflict).toContain('data-settings-state="conflict"');
    expect(conflict).toContain("設定が競合しています。入力を保持しています。");
    expect(conflict).toContain('role="alert"');

    const unknown = renderToStaticMarkup(
      createElement(DatabaseSettingsPanel, {
        settings,
        onIntent: () => undefined,
        status: "unknown",
        onResolve: () => undefined,
      }),
    );
    expect(unknown).toContain('data-settings-state="unknown"');
    expect(unknown).toContain("設定の保存結果が不明です。入力を保持しています。");
    expect(unknown).toContain("保存結果を確認");
    expect(unknown).toContain('aria-label="設定の保存結果を確認"');
  });
});
