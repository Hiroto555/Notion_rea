import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordPage } from "../src/database/RecordPage";
import {
  SettingsMenu,
  shouldPreserveTriggerTextEntryFocus,
} from "../src/database/settings-menu/SettingsMenu";
import { shouldPreservePointerFocus } from "../src/shared/pointer-focus";
import { shouldPreservePointerFocus as pageLayoutShouldPreservePointerFocus } from "../src/renderer/page-layout/PageLayoutControl";

type ActiveTag = "input" | "textarea" | "div" | "button";

function active(tag: ActiveTag, contenteditable?: string) {
  return {
    matches(selector: string) {
      if (tag === "input" || tag === "textarea")
        return selector.includes(tag);
      if (tag === "div" && contenteditable !== undefined) {
        if (contenteditable === "false") return false;
        return (
          selector.includes("[contenteditable='true']") ||
          selector.includes("[contenteditable='']")
        );
      }
      return false;
    },
  };
}

function triggerTag(html: string) {
  return (
    /<button[^>]*data-settings-menu-trigger="record-display"[^>]*>/.exec(
      html,
    )?.[0] ?? ""
  );
}

describe("shared pointer focus policy", () => {
  it("keeps focus for primary clicks in inputs, textareas and the Editor", () => {
    expect(shouldPreservePointerFocus(0, active("input"))).toBe(true);
    expect(shouldPreservePointerFocus(0, active("textarea"))).toBe(true);
    expect(shouldPreservePointerFocus(0, active("div", "true"))).toBe(true);
    expect(shouldPreservePointerFocus(0, active("div", ""))).toBe(true);
  });

  it("does not interfere with other controls, secondary buttons or no focus", () => {
    expect(shouldPreservePointerFocus(0, active("div", "false"))).toBe(false);
    expect(shouldPreservePointerFocus(0, active("button"))).toBe(false);
    expect(shouldPreservePointerFocus(2, active("input"))).toBe(false);
    expect(shouldPreservePointerFocus(0, null)).toBe(false);
  });

  it("keeps the PageLayoutControl export compatible with the moved helper", () => {
    expect(pageLayoutShouldPreservePointerFocus).toBe(
      shouldPreservePointerFocus,
    );
  });
});

describe("SettingsMenu pointer focus opt-in", () => {
  it("defaults off and only preserves focus when explicitly enabled", () => {
    expect(
      shouldPreserveTriggerTextEntryFocus(false, 0, active("input")),
    ).toBe(false);
    expect(
      shouldPreserveTriggerTextEntryFocus(true, 0, active("input")),
    ).toBe(true);
    expect(
      shouldPreserveTriggerTextEntryFocus(true, 0, active("textarea")),
    ).toBe(true);
    expect(
      shouldPreserveTriggerTextEntryFocus(true, 0, active("div", "true")),
    ).toBe(true);
    expect(
      shouldPreserveTriggerTextEntryFocus(true, 0, active("div", "")),
    ).toBe(true);
    expect(
      shouldPreserveTriggerTextEntryFocus(true, 0, active("div", "false")),
    ).toBe(false);
    expect(
      shouldPreserveTriggerTextEntryFocus(true, 0, active("button")),
    ).toBe(false);
    expect(
      shouldPreserveTriggerTextEntryFocus(true, 2, active("input")),
    ).toBe(false);
    expect(shouldPreserveTriggerTextEntryFocus(true, 0, null)).toBe(false);
  });

  it("keeps default markup unchanged and marks only the opt-in trigger", () => {
    const renderMenu = (preserveTextEntryFocus?: boolean) =>
      renderToStaticMarkup(
        createElement(SettingsMenu, {
          name: "record-display",
          label: "表示",
          panelLabel: "レコードの表示",
          trigger: "表示",
          preserveTextEntryFocus,
          children: createElement(
            "span",
            { "data-menu-child": "kept" },
            "child",
          ),
        }),
      );

    const defaultHtml = renderMenu();
    expect(triggerTag(defaultHtml)).not.toContain(
      "data-preserve-text-entry-focus",
    );
    expect(defaultHtml).toContain('data-menu-child="kept"');
    expect(
      /<div[^>]*data-settings-menu-panel="record-display"[^>]*>/.exec(
        defaultHtml,
      )?.[0] ?? "",
    ).toContain("hidden");

    const optedIn = renderMenu(true);
    expect(triggerTag(optedIn)).toContain(
      'data-preserve-text-entry-focus="true"',
    );
    expect(optedIn).toContain('data-menu-child="kept"');
  });

  it("wires only the record display menu to the opt-in policy", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPage, {
        pageId: "record-1",
        record: {
          pageId: "record-1",
          databasePageId: "database-1",
          revision: 0,
          title: "Row",
          icon: "",
          values: {},
          deletedAt: null,
        },
        draft: { title: "Row", values: {} },
        properties: [],
        onBack: () => undefined,
        onTitleChange: () => undefined,
        onValueChange: () => undefined,
        body: null,
        displayOptions: createElement(
          "span",
          { "data-display-child": "kept" },
          "表示",
        ),
      }),
    );

    expect(triggerTag(html)).toContain(
      'data-preserve-text-entry-focus="true"',
    );
    expect(html).toContain('data-display-child="kept"');
  });
});
