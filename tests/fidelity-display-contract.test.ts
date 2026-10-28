import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Static CSS contract for the Round 3 Fidelity layout. It pins the narrow
// layout, focus indicator, long-title and reduced-motion rules without a GUI.
// The rendered geometry is measured in tests/e2e/r3-fidelity.spec.ts.
const css = readFileSync("src/renderer/styles.css", "utf8");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

function balanced(open: number) {
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === "{") depth++;
    else if (css[index] === "}") {
      depth--;
      if (depth === 0) return css.slice(open, index + 1);
    }
  }
  throw new Error("unbalanced CSS block at " + open);
}

function rule(selector: string) {
  const token = selector + " {";
  const at = css.indexOf(token);
  expect(at, "missing selector " + selector).toBeGreaterThanOrEqual(0);
  return normalize(balanced(at + token.length - 1));
}

function atRule(header: string) {
  const at = css.indexOf(header);
  expect(at, "missing at-rule " + header).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  return normalize(balanced(open));
}

describe("Round 3 responsive layout", () => {
  test("960px keeps the inspector close control but reserves its footprint", () => {
    const narrow = atRule("@media (max-width: 1000px)");
    expect(narrow).toContain("--sidebar-width: 208px;");
    expect(narrow).toContain(
      ".inspector { position: absolute; top: 12px; right: 12px; bottom: 12px; width: 268px; min-width: 268px;",
    );
    expect(narrow).toContain(
      ".document-layout:has(.inspector) .document-scroll { padding-right: calc(268px + 24px); }",
    );
    expect(narrow).toContain(".inspector-close { display: inline-flex; }");
  });

  test("1440 and 1024 keep the R4 panel widths and responsive content spacing", () => {
    expect(rule(":root")).toContain("--sidebar-width: 240px;");
    expect(rule(":root")).toContain("--inspector-width: 240px;");
    expect(rule(":root")).toContain("--content-width: 860px;");
    const medium = atRule("@media (max-width: 1120px)");
    expect(medium).toContain("--sidebar-width: 220px;");
    expect(medium).toContain("--content-gutter: 36px;");
    const small = atRule("@media (max-width: 1280px)");
    expect(small).toContain("--inspector-width: 224px;");
    expect(small).toContain("--page-title-size: 34px;");
  });

  test("record and search panels stay within the narrow viewport", () => {
    expect(normalize(css)).toMatch(
      /\.modal, \.record-modal \{ width: 620px; max-width: min\(90vw, 620px\); max-height: 76vh;/,
    );
    expect(rule(".common-dialog")).toContain("margin: 12vh auto 0;");
    expect(rule(".common-dialog::backdrop")).toContain(
      "backdrop-filter: blur(6px) saturate(1.1);",
    );
    expect(rule(".dropdown")).toContain("max-width: calc(100vw - 24px);");
    expect(rule(".icon-picker")).toContain("max-width: calc(100vw - 24px);");
    expect(rule(".slash-menu")).toContain("max-width: calc(100vw - 32px);");
    expect(rule(".slash-menu")).toContain("max-height: min(360px, 60vh);");
  });
});

describe("Round 3 focus and long-title display", () => {
  test("text fields that suppress their native ring get a visible focus ring", () => {
    expect(rule(".page-title:focus-visible")).toContain(
      "outline: 2px solid var(--focus) !important;",
    );
    expect(rule(".record-title:focus-visible")).toContain(
      "outline: 2px solid var(--focus);",
    );
    expect(rule(".search-input input:focus-visible")).toContain(
      "outline: 2px solid var(--focus);",
    );
    expect(rule(".folio-editor:focus-visible")).toContain(
      "outline: 2px solid var(--focus);",
    );
    expect(rule('input[type="checkbox"]:focus-visible')).toContain(
      "outline: 2px solid var(--focus);",
    );
  });

  test("long Japanese titles truncate or wrap instead of overflowing", () => {
    expect(rule(".search-results strong")).toContain(
      "overflow-wrap: anywhere;",
    );
    expect(rule(".dialog-list > div > span")).toContain("min-width: 0;");
    expect(rule(".dialog-list > div > span")).toContain(
      "overflow-wrap: anywhere;",
    );
    expect(rule(".inspector-page")).toContain("overflow-wrap: anywhere;");
    expect(css).toContain(".page-tree-title {");
    expect(rule(".page-tree-title")).toContain("text-overflow: ellipsis;");
    expect(rule(".crumb-current")).toContain("text-overflow: ellipsis;");
  });
});

describe("Round 3 theme and motion", () => {
  test("light and dark expose the same layout and focus tokens", () => {
    const light = rule(":root");
    const dark = rule(':root[data-theme="dark"]');
    for (const token of ["--bg:", "--panel:", "--text:", "--focus:"]) {
      expect(light).toContain(token);
      expect(dark).toContain(token);
    }
    expect(dark).toContain("color-scheme: dark;");
    expect(light).toContain("color-scheme: light;");
  });

  test("reduced motion removes transitions, animation and smooth scrolling", () => {
    const reduced = atRule("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toContain("scroll-behavior: auto !important;");
    expect(reduced).toContain("transition: none !important;");
    expect(reduced).toContain("animation: none !important;");
  });

  test("touch devices keep hover-only editor affordances visible", () => {
    const hoverNone = atRule("@media (hover: none)");
    expect(hoverNone).toContain(".block-handle");
    expect(hoverNone).toContain(".page-tools");
    expect(hoverNone).toContain("opacity: 1;");
  });
});
