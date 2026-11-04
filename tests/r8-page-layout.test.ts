import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PageLayoutControl,
  shouldPreservePointerFocus,
} from "../src/renderer/page-layout/PageLayoutControl";

function render(value: "standard" | "wide", disabled = false) {
  return renderToStaticMarkup(
    createElement(PageLayoutControl, {
      value,
      disabled,
      onChange: () => undefined,
    }),
  );
}

describe("PageLayoutControl accessibility", () => {
  it("renders a Japanese fieldset with both width choices and one pressed state", () => {
    const html = render("standard");

    expect(html).toMatch(/<fieldset[^>]*class="page-layout-control"[^>]*>/);
    expect(html).toContain("<legend");
    expect(html).toContain("ページの幅");
    expect(html).toContain('aria-label="標準"');
    expect(html).toContain('aria-label="ワイド"');
    expect(html).toContain("読みやすい幅で本文を表示します。");
    expect(html).toContain("画面の幅いっぱいに本文を表示します。");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
  });

  it("moves the pressed state without changing the control structure", () => {
    const standard = render("standard");
    const wide = render("wide");

    expect(wide.match(/<button/g)).toHaveLength(2);
    expect(wide).toContain('data-page-width="wide"');
    expect(wide).toContain('aria-label="ワイド" aria-pressed="true"');
    expect(wide).toContain('aria-label="標準" aria-pressed="false"');
    const structure = (html: string) =>
      html
        .replace(/aria-pressed="(true|false)"/g, "")
        .replace(/data-page-width="(standard|wide)"/, "");
    expect(structure(standard)).toBe(structure(wide));
  });

  it("describes each choice with a unique explanation id", () => {
    const html = render("wide");
    const describedBy = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(describedBy).toHaveLength(2);
    expect(new Set(describedBy).size).toBe(2);
    for (const id of describedBy) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("disables the fieldset and both choices when requested", () => {
    const html = render("standard", true);
    const fieldset = /<fieldset[^>]*>/.exec(html)?.[0] ?? "";

    expect(fieldset).toContain("disabled");
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(2);
  });
});

describe("PageLayoutControl pointer focus preservation", () => {
  function active(
    tag: "input" | "textarea" | "div" | "button",
    contenteditable?: string,
  ) {
    return {
      matches(selector: string) {
        if (tag === "input" || tag === "textarea") {
          return selector.includes(tag);
        }
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

  it("keeps focus for primary clicks in inputs and the Editor", () => {
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
});
