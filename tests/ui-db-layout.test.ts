import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  emptyDatabase,
  type DatabaseCallbacks,
  type DatabaseProjection,
  type DatabaseSettings,
  type DatabaseView,
  type DatabaseViewType,
  type Doc,
  type Property,
  type RecordProjection,
} from "../src/shared/types";
import {
  DatabaseSettingsPanel,
  searchDisclosureAction,
  type DatabaseSettingsPanelProps,
} from "../src/database/DatabaseSettingsPanel";
import { DatabasePresentation } from "../src/database/DatabasePresentation";
import { RecordPage } from "../src/database/RecordPage";

const properties: Property[] = [
  {
    id: "status",
    name: "ステータス",
    type: "select",
    options: ["未着手", "進行中", "完了"],
  },
  { id: "due", name: "期日", type: "date" },
  { id: "cost", name: "費用", type: "number" },
  { id: "note", name: "メモ", type: "text" },
];

const unused = async (): Promise<never> => {
  throw new Error("read-only display must not call a database writer");
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

function baseSettings(): DatabaseSettings {
  const { rows: _rows, ...settings } = emptyDatabase();
  void _rows;
  return settings;
}

function makeView(type: DatabaseViewType = "table"): DatabaseView {
  return {
    ...baseSettings().views[0],
    id: "view-" + type,
    name: type,
    type,
  };
}

function conditionsView(): DatabaseView {
  const view = makeView();
  view.filterText = "later search";
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

function panelSettings(view: DatabaseView): DatabaseSettings {
  return {
    ...baseSettings(),
    properties,
    views: [view],
    activeViewId: view.id,
    view: view.type,
    filter: view.filterText,
    sort: "",
  };
}

function record(
  pageId: string,
  patch: Partial<RecordProjection> = {},
): RecordProjection {
  return {
    pageId,
    databasePageId: "db-projects",
    revision: 1,
    title: "Alpha",
    icon: "📄",
    values: { status: "進行中", note: "メモ値" },
    deletedAt: null,
    ...patch,
  };
}

function projection(
  view: DatabaseView,
  records: readonly RecordProjection[],
): DatabaseProjection {
  return {
    settings: panelSettings(view),
    records,
    revision: 1,
  };
}

function renderPanel(
  settings: DatabaseSettings,
  extra: Omit<Partial<DatabaseSettingsPanelProps>, "settings" | "onIntent"> = {},
): string {
  return renderToStaticMarkup(
    createElement(DatabaseSettingsPanel, {
      settings,
      onIntent: () => undefined,
      ...extra,
    }),
  );
}

function textDoc(text: string): Doc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function renderReadOnly(
  view: DatabaseView,
  records: readonly RecordProjection[],
  recordBodies?: Readonly<Record<string, Doc | undefined>>,
): string {
  return renderToStaticMarkup(
    createElement(DatabasePresentation, {
      value: projection(view, records),
      callbacks,
      databasePageId: "db-projects",
      readOnly: true,
      recordBodies,
    }),
  );
}

function tagFor(html: string, pattern: RegExp): string {
  return pattern.exec(html)?.[0] ?? "";
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(new URL("../src/database/" + path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function querySelectorLiterals(file: ts.SourceFile): string[] {
  const selectors: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "querySelector"
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument))
        selectors.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return selectors;
}

function jsxElements(file: ts.SourceFile): ts.JsxElement[] {
  const elements: ts.JsxElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) elements.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return elements;
}

function jsxClassName(element: ts.JsxElement): string {
  for (const property of element.openingElement.attributes.properties) {
    if (
      ts.isJsxAttribute(property) &&
      property.name.getText() === "className" &&
      property.initializer &&
      ts.isStringLiteral(property.initializer)
    )
      return property.initializer.text;
  }
  return "";
}

function jsxOpeningHasAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  file: ts.SourceFile,
): boolean {
  return opening.attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText(file) === name,
  );
}

function hasAncestorAttribute(
  node: ts.Node,
  name: string,
  file: ts.SourceFile,
): boolean {
  let current = node.parent;
  while (current) {
    if (
      (ts.isJsxElement(current) &&
        jsxOpeningHasAttribute(current.openingElement, name, file)) ||
      ((ts.isJsxOpeningElement(current) ||
        ts.isJsxSelfClosingElement(current)) &&
        jsxOpeningHasAttribute(current, name, file))
    )
      return true;
    current = current.parent;
  }
  return false;
}

function enclosingJsxExpression(
  node: ts.Node,
  file: ts.SourceFile,
): string {
  let current = node.parent;
  while (current) {
    if (ts.isJsxExpression(current) && current.expression)
      return current.expression.getText(file);
    current = current.parent;
  }
  return "";
}

function hasSearchFocusEffect(file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useEffect"
    ) {
      const effect = node.arguments[0];
      const deps = node.arguments[1];
      if (!effect || !deps || !ts.isArrayLiteralExpression(deps)) {
        ts.forEachChild(node, visit);
        return;
      }
      const dependencies = deps.elements.map((item) => item.getText(file));
      if (
        dependencies.length === 1 &&
        dependencies[0] === "searchOpen" &&
        effect.getText(file).includes("searchInput.current?.focus()")
      )
        found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("registered database operation row", () => {
  it("keeps a non-empty saved search visible while an empty one is a disclosure", () => {
    const emptyView = makeView();
    emptyView.filterText = "";
    const emptyHtml = renderPanel(panelSettings(emptyView));
    const emptyLabel = tagFor(
      emptyHtml,
      /<label[^>]*class="[^"]*r7-view-search[^"]*"[^>]*>/,
    );
    const emptyToggle = tagFor(
      emptyHtml,
      /<button[^>]*data-search-toggle="search"[^>]*>/,
    );
    expect(emptyToggle).not.toContain("hidden");
    expect(emptyToggle).toContain('aria-expanded="false"');
    expect(emptyHtml).toContain('data-search-open="false"');
    expect(emptyLabel).toContain("hidden");

    const filledView = makeView();
    filledView.filterText = "needle";
    const filledHtml = renderPanel(panelSettings(filledView));
    const filledLabel = tagFor(
      filledHtml,
      /<label[^>]*class="[^"]*r7-view-search[^"]*"[^>]*>/,
    );
    const filledToggle = tagFor(
      filledHtml,
      /<button[^>]*data-search-toggle="search"[^>]*>/,
    );
    expect(filledLabel).not.toContain("hidden");
    expect(filledToggle).not.toContain("hidden");
    expect(filledToggle).toContain('aria-expanded="true"');
    expect(filledHtml).toContain('data-search-open="true"');
    expect(filledHtml).toContain('aria-label="ビュー内検索"');
    expect(filledHtml).toContain('value="needle"');
    expect(filledHtml).not.toContain('aria-label="検索を閉じる"');
  });

  it("wires explicit search focus and trigger restoration without touching the value", () => {
    for (const name of ["DatabaseSettingsPanel.tsx", "Database.tsx"]) {
      const file = sourceFile(name);
      const source = file.getFullText();
      expect(hasSearchFocusEffect(file)).toBe(true);
      expect(source).toContain("ref={searchInput}");
      expect(source).toContain("ref={searchToggle}");
      expect(source).toContain(
        "onClick={() => (searchOpen ? closeSearch() : openSearch())}",
      );
      expect(source).toMatch(
        /const closeSearch = \(\) => \{\s*setSearchOpen\(false\);\s*searchToggle\.current\?\.focus\(\);\s*\};/,
      );
    }
    expect(sourceFile("DatabaseSettingsPanel.tsx").getFullText()).toContain(
      'if (searchDisclosureAction(event) === "ignore") return;',
    );
    expect(sourceFile("Database.tsx").getFullText()).toContain(
      'if (searchDisclosureAction(e) === "ignore") return;',
    );
  });

  it("ignores composition Escape and closes only on a non-composing Escape", () => {
    expect(
      searchDisclosureAction({
        key: "Escape",
        nativeEvent: { isComposing: true },
      }),
    ).toBe("ignore");
    expect(
      searchDisclosureAction({
        key: "Escape",
        nativeEvent: { keyCode: 229 },
      }),
    ).toBe("ignore");
    expect(
      searchDisclosureAction({
        key: "Escape",
        nativeEvent: { isComposing: false, keyCode: 27 },
      }),
    ).toBe("close");
    expect(
      searchDisclosureAction({
        key: "Enter",
        nativeEvent: { isComposing: false, keyCode: 13 },
      }),
    ).toBe("ignore");
  });

  it("shows a short count summary with a full nested-condition disclosure", () => {
    const html = renderPanel(panelSettings(conditionsView()));
    expect(html).toContain("data-condition-count=\"filters\"");
    expect(html).toContain("フィルター 3件");
    expect(html).toContain("並べ替え 2件");
    expect(html).toContain("グループ 1件");
    expect(html).toContain("<summary>条件を確認</summary>");
    expect(html).toContain(
      "名前 含む「Task」 かつ (名前 で始まる「A」 または ステータス 等しい「進行中」)",
    );
    expect(html).toContain("名前 含む「Task」");
    expect(html).toContain("名前 で始まる「A」");
    expect(html).toContain("ステータス 等しい「進行中」");
    expect(html).toContain("期日 降順");
    expect(html).toContain("費用 昇順");
    expect(html).toContain(">1.</span>");
    expect(html).toContain(">2.</span>");
    expect(html).toContain("グループ内いずれか (OR)");
  });

  it("mounts toolbar and schema slots in the same operation surface", () => {
    const html = renderPanel(panelSettings(makeView()), {
      status: "pending",
      toolbarActions: createElement(
        "button",
        { type: "button", "data-parent-toolbar": "new-row" },
        "新規行",
      ),
      schemaActions: createElement(
        "button",
        { type: "button", "data-parent-schema": "properties" },
        "プロパティを編集",
      ),
    });
    const toolbarAt = html.indexOf('data-parent-toolbar="new-row"');
    const optionsAt = html.indexOf('data-settings-menu-panel="view-options"');
    const schemaAt = html.indexOf('data-parent-schema="properties"');
    const filterAt = html.indexOf('data-settings-menu-panel="filter"');
    expect(toolbarAt).toBeGreaterThan(-1);
    expect(optionsAt).toBeGreaterThan(toolbarAt);
    expect(schemaAt).toBeGreaterThan(optionsAt);
    expect(schemaAt).toBeGreaterThan(filterAt);
    expect(html).toContain('aria-label="プロパティを編集"');
    expect(html).toContain("設定の保存待ち");
  });

  it("does not advertise a schema action when the parent has not supplied one", () => {
    const html = renderPanel(panelSettings(makeView()));
    expect(html).toContain('data-search-toggle="search"');
    expect(html).not.toContain("プロパティを編集");
    expect(html).not.toContain("data-schema-actions");
  });
});

describe("record page display slot", () => {
  const recordValue = record("page-a");

  function renderRecord(
    displayOptions?: ReturnType<typeof createElement>,
    overrides: { editingBlocked?: boolean; readOnly?: "document-error" } = {},
  ) {
    return renderToStaticMarkup(
      createElement(RecordPage, {
        pageId: recordValue.pageId,
        record: recordValue,
        draft: { title: recordValue.title, values: {} },
        properties: [],
        onBack: () => undefined,
        onClose: () => undefined,
        onTitleChange: () => undefined,
        onValueChange: () => undefined,
        body: createElement(
          "div",
          { "data-editor-body": "same-instance" },
          "本文",
        ),
        displayOptions,
        ...overrides,
      }),
    );
  }

  it("mounts parent display controls in the header menu while closed", () => {
    const html = renderRecord(
      createElement(
        "button",
        { type: "button", "data-display-probe": "width" },
        "ワイド",
      ),
    );
    const panel = tagFor(
      html,
      /<div[^>]*data-settings-menu-panel="record-display"[^>]*>/,
    );
    const panelAt = html.indexOf('data-settings-menu-panel="record-display"');
    const probeAt = html.indexOf('data-display-probe="width"');
    expect(panel).toContain("hidden");
    expect(panelAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(panelAt);
    expect(html).toContain('data-settings-menu-trigger="record-display"');
    expect(html).toContain(">表示</span>");
    expect(html).toContain('data-editor-body="same-instance"');
    expect(html).toContain('aria-label="レコードページ"');
  });

  it("keeps the legacy header when no display options are provided", () => {
    const html = renderRecord();
    expect(html).not.toContain('data-settings-menu-trigger="record-display"');
    expect(html).not.toContain('data-settings-menu-panel="record-display"');
    expect(html).toContain('data-editor-body="same-instance"');
  });

  it("moves the kind into the hidden page-info section instead of the body", () => {
    const html = renderRecord(
      createElement(
        "button",
        { type: "button", "data-display-probe": "width" },
        "ワイド",
      ),
    );
    const panel = tagFor(
      html,
      /<div[^>]*data-settings-menu-panel="record-display"[^>]*>/,
    );
    const panelAt = html.indexOf('data-settings-menu-panel="record-display"');
    const infoAt = html.indexOf("data-record-page-info");
    const kindAt = html.indexOf("データベースのレコード");
    const headerEnd = html.indexOf("</header>");
    const bodyAt = html.indexOf("data-record-body");
    expect(panel).toContain("hidden");
    expect(panelAt).toBeGreaterThan(-1);
    expect(infoAt).toBeGreaterThan(panelAt);
    expect(kindAt).toBeGreaterThan(infoAt);
    expect(kindAt).toBeLessThan(headerEnd);
    expect(kindAt).toBeLessThan(bodyAt);
    expect(html.match(/データベースのレコード/g)).toHaveLength(1);
    expect(html.slice(0, panelAt)).not.toContain("データベースのレコード");
    expect(html).not.toContain('class="r3-record-meta"');
    expect(html).toContain('data-editor-body="same-instance"');
    expect(html).toContain('data-record-id="page-a"');
  });

  it("keeps the locked badge outside the closed menu for both lock sources", () => {
    for (const overrides of [
      { editingBlocked: true },
      { readOnly: "document-error" as const },
    ]) {
      const html = renderRecord(
        createElement("span", { "data-display-probe": "width" }, "表示"),
        overrides,
      );
      const panel = tagFor(
        html,
        /<div[^>]*data-settings-menu-panel="record-display"[^>]*>/,
      );
      const panelAt = html.indexOf('data-settings-menu-panel="record-display"');
      const headerEnd = html.indexOf("</header>");
      const metaAt = html.indexOf('class="r3-record-meta"');
      const badgeAt = html.indexOf('<span class="r3-record-readonly">');
      const bodyAt = html.indexOf("data-record-body");
      expect(panel).toContain("hidden");
      expect(metaAt).toBeGreaterThan(headerEnd);
      expect(badgeAt).toBeGreaterThan(metaAt);
      expect(badgeAt).toBeLessThan(bodyAt);
      expect(html.slice(panelAt, headerEnd)).not.toContain(
        "r3-record-readonly",
      );
      expect(html.slice(panelAt, headerEnd)).toContain(
        "データベースのレコード",
      );
      expect(html).toContain('data-editor-body="same-instance"');
      expect(html).toContain('data-record-id="page-a"');
    }
  });

  it("keeps the legacy kind line when the display slot is omitted", () => {
    const html = renderRecord();
    const metaAt = html.indexOf('class="r3-record-meta"');
    const kindAt = html.indexOf('class="r3-record-kind"');
    const bodyAt = html.indexOf("data-record-body");
    expect(html).not.toContain('data-settings-menu-panel="record-display"');
    expect(html).not.toContain("data-record-page-info");
    expect(metaAt).toBeGreaterThan(-1);
    expect(kindAt).toBeGreaterThan(metaAt);
    expect(kindAt).toBeLessThan(bodyAt);
    expect(html.match(/データベースのレコード/g)).toHaveLength(1);
    expect(html).toContain('data-editor-body="same-instance"');
    expect(html).toContain('data-record-id="page-a"');
  });

  it("guards the legacy kind and nests the menu kind in page info (AST)", () => {
    const file = sourceFile("RecordPage.tsx");
    const elements = jsxElements(file);
    const kinds = elements.filter(
      (element) => jsxClassName(element) === "r3-record-kind",
    );
    expect(kinds).toHaveLength(2);

    const menu = elements.find(
      (element) => element.openingElement.tagName.getText(file) === "SettingsMenu",
    );
    expect(menu).toBeDefined();
    if (!menu) throw new Error("SettingsMenu not found");
    const menuStart = menu.getStart(file);
    const menuEnd = menu.getEnd();
    const menuKind = kinds.find(
      (element) =>
        element.getStart(file) > menuStart && element.getEnd() < menuEnd,
    );
    const legacyKind = kinds.find((element) => element !== menuKind);
    expect(menuKind).toBeDefined();
    expect(legacyKind).toBeDefined();
    if (!menuKind || !legacyKind) throw new Error("kind spans not found");

    expect(hasAncestorAttribute(menuKind, "data-record-page-info", file)).toBe(
      true,
    );
    expect(
      hasAncestorAttribute(legacyKind, "data-record-page-info", file),
    ).toBe(false);
    expect(enclosingJsxExpression(legacyKind, file)).toContain(
      "displayOptions === undefined",
    );
    expect(enclosingJsxExpression(menuKind, file)).toContain(
      "displayOptions !== undefined",
    );

    const badges = elements.filter(
      (element) => jsxClassName(element) === "r3-record-readonly",
    );
    expect(badges).toHaveLength(1);
    const badge = badges[0];
    expect(badge.getStart(file) < menuStart || badge.getEnd() > menuEnd).toBe(
      true,
    );
    expect(hasAncestorAttribute(badge, "data-record-page-info", file)).toBe(
      false,
    );
    expect(enclosingJsxExpression(badge, file)).toContain("locked");
  });

  it("guards capture and bubble Escape while a helper menu is open", () => {
    const file = sourceFile("RecordPage.tsx");
    const source = file.getFullText();
    const openMenuSelectors = querySelectorLiterals(file).filter(
      (selector) =>
        selector.includes("data-settings-menu-panel") &&
        selector.includes(":not([hidden])"),
    );
    expect(openMenuSelectors.length).toBeGreaterThanOrEqual(2);
    for (const selector of openMenuSelectors) {
      expect(selector).toContain("[role='menu']");
      expect(selector).toContain("data-settings-menu-panel");
      expect(selector).toContain(":not([hidden])");
    }

    const captureStart = source.indexOf("onKeyDownCapture={");
    const captureEnd = source.indexOf("onChangeCapture={", captureStart);
    const capture = source.slice(captureStart, captureEnd);
    expect(capture).toContain("composing(event.nativeEvent)");
    expect(capture).toContain("data-settings-menu-panel]:not([hidden])");
    expect(capture.indexOf("event.stopPropagation()")).toBeGreaterThan(-1);
    expect(capture.indexOf("event.stopPropagation()")).toBeLessThan(
      capture.indexOf("close();"),
    );

    const handlerStart = source.indexOf("const keyDown =");
    const handlerEnd = source.indexOf("const notice =", handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    expect(handler).toContain("composing(event.nativeEvent)");
    expect(handler).toContain("data-settings-menu-panel]:not([hidden])");
    expect(handler.indexOf("data-settings-menu-panel]:not([hidden])")).toBeLessThan(
      handler.indexOf("close();"),
    );
  });
});

describe("board, gallery and calendar decoration", () => {
  it.each(["board", "gallery"] as const)(
    "keeps title, every chip and the plain-text excerpt in order on %s",
    (type) => {
      const view = makeView(type);
      view.groupBy = { propertyId: "status", direction: "asc" };
      const html = renderReadOnly(view, [record("page-a")], {
        "page-a": textDoc("本文の抜粋です。"),
      });
      const titleAt = html.indexOf("Alpha");
      const chipAt = html.indexOf("メモ値");
      const excerptAt = html.indexOf("本文の抜粋です。");
      expect(titleAt).toBeGreaterThan(-1);
      expect(chipAt).toBeGreaterThan(titleAt);
      expect(excerptAt).toBeGreaterThan(chipAt);
      expect(html).toContain('<p class="r3-card-excerpt">');
      expect(html).not.toContain("<img");
      expect(html).not.toContain("cover");
    },
  );

  it("keeps the owner guard on cards and adds no new gallery preview", () => {
    const view = makeView("gallery");
    view.groupBy = { propertyId: "status", direction: "asc" };
    const html = renderReadOnly(view, [
      record("page-a", { databasePageId: "db-other" }),
    ]);
    const button = tagFor(
      html,
      /<button[^>]*class="r3-card-open"[^>]*>/,
    );
    expect(button).toContain("disabled");
    expect(html).not.toContain("画像プレビュー");
    expect(html).not.toContain("表示プロパティ");
  });

  it("shows the existing date property and undated count next to month navigation", () => {
    const view = makeView("calendar");
    const html = renderReadOnly(view, [
      record("page-a", { values: { due: "2026-11-02" } }),
      record("page-b", {
        title: "Beta",
        values: { status: "未着手" },
      }),
    ]);
    expect(html).toContain('data-calendar-property="due"');
    expect(html).toContain("対象日付: 期日");
    expect(html).toContain("日付未設定: 1件");
    expect(html.indexOf("r3-month-context")).toBeLessThan(
      html.indexOf("r3-calendar"),
    );
    expect(html).not.toContain("日付を変更");
  });
});

describe("legacy database layout contract", () => {
  const source = readFileSync(
    new URL("../src/database/Database.tsx", import.meta.url),
    "utf8",
  );

  it("uses the same operation names and keeps the legacy writer", () => {
    expect(source).toContain('name="view-options"');
    expect(source).toContain('name="filter"');
    expect(source).toContain('name="sort"');
    expect(source).toContain("条件を確認");
    expect(source).toContain("新規行");
    expect(source).toContain("プロパティを編集");
    expect(source).toContain("DB変更を元に戻す");
    expect(source).toContain("value.views.length >= 100");
    expect(source).toContain("hidden={!propertyForm}");
  });

  it("keeps the search collapse display-only", () => {
    expect(source).toContain("setSearchOpen(false)");
    expect(source).toContain("changeView({ filterText: e.target.value })");
    expect(source).not.toContain("changeView({ filterText: \"\" })");
  });
});
