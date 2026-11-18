import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  captureDialogOrigin,
  restoreDialogFocus,
} from "../src/renderer/Modal";

// Minimal DOM fake for the Modal restore helpers: connectivity, layout boxes,
// computed visibility, ancestor lookup and focus() only. No real DOM, native
// <dialog> or GUI is involved.
class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  parent: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  isConnected = true;
  rects = 1;
  visibility = "visible";
  movesFocus = true;
  focusCalls = 0;

  constructor(tag: string, attributes: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [name, value] of Object.entries(attributes))
      this.attributes.set(name, value);
  }

  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    return this;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  getClientRects() {
    return { length: this.rects };
  }
  focus() {
    this.focusCalls += 1;
    if (this.movesFocus) activeElement = this;
  }

  private matches(selector: string) {
    if (selector.startsWith("."))
      return (this.attributes.get("class") ?? "")
        .split(/\s+/)
        .includes(selector.slice(1));
    if (selector.startsWith("[") && selector.endsWith("]"))
      return this.attributes.has(selector.slice(1, -1));
    return this.tagName === selector.toUpperCase();
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parent)
      if (node.matches(selector)) return node;
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    const scoped = selector.startsWith(":scope > ");
    const inner = scoped ? selector.slice(":scope > ".length) : selector;
    const pool = scoped ? this.children : this.descendants();
    return pool.find((node) => node.matches(inner)) ?? null;
  }

  private descendants(): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

let activeElement: unknown = null;
const documentElement = new FakeElement("html");
const body = new FakeElement("body");
const pageTitle = new FakeElement("input", { class: "page-title" });
const documentStub = {
  documentElement,
  body,
  get activeElement() {
    return activeElement;
  },
  querySelector: (selector: string) =>
    selector === ".page-title" ? pageTitle : null,
};

const asElement = (node: FakeElement) => node as unknown as HTMLElement;
const globals = globalThis as Record<string, unknown>;
let savedDocument: unknown;
let savedComputedStyle: unknown;

beforeEach(() => {
  activeElement = body;
  for (const shared of [body, documentElement, pageTitle])
    shared.focusCalls = 0;
  savedDocument = globals.document;
  savedComputedStyle = globals.getComputedStyle;
  globals.document = documentStub;
  globals.getComputedStyle = (element: FakeElement) => ({
    visibility: element.visibility,
  });
});
afterEach(() => {
  if (savedDocument === undefined) delete globals.document;
  else globals.document = savedDocument;
  if (savedComputedStyle === undefined) delete globals.getComputedStyle;
  else globals.getComputedStyle = savedComputedStyle;
});

describe("captureDialogOrigin", () => {
  test("drops body-level focus and keeps a real opener", () => {
    expect(captureDialogOrigin(null)).toEqual({
      active: null,
      fallback: null,
    });
    for (const level of [body, documentElement])
      expect(captureDialogOrigin(asElement(level))).toEqual({
        active: null,
        fallback: null,
      });
    const opener = new FakeElement("button");
    expect(captureDialogOrigin(asElement(opener))).toEqual({
      active: opener,
      fallback: null,
    });
  });

  test("captures the settings-menu trigger for an opener inside its panel", () => {
    const trigger = new FakeElement("button", {
      class: "r7-menu-trigger",
      "data-settings-menu-trigger": "view-options",
    });
    const panel = new FakeElement("div", {
      "data-settings-menu-panel": "view-options",
    });
    const opener = new FakeElement("button");
    panel.append(opener);
    const menu = new FakeElement("div", { class: "r7-menu" }).append(
      trigger,
      panel,
    );
    const origin = captureDialogOrigin(asElement(opener));
    expect(origin.active).toBe(opener);
    expect(origin.fallback).toBe(trigger);
    expect(opener.closest(".r7-menu")).toBe(menu);
  });

  test("keeps the menu-anchor trigger compatible and ahead of r7-menu", () => {
    const anchorTrigger = new FakeElement("button");
    const anchor = new FakeElement("div", { class: "menu-anchor" }).append(
      anchorTrigger,
      new FakeElement("div").append(new FakeElement("button")),
    );
    expect(captureDialogOrigin(asElement(anchor.children[1].children[0])).fallback)
      .toBe(anchorTrigger);

    const r7Trigger = new FakeElement("button", {
      "data-settings-menu-trigger": "view-options",
    });
    const panel = new FakeElement("div");
    panel.append(anchor);
    new FakeElement("div", { class: "r7-menu" }).append(r7Trigger, panel);
    const nested = captureDialogOrigin(asElement(anchor.children[1].children[0]));
    expect(nested.fallback).toBe(anchorTrigger);
  });
});

describe("restoreDialogFocus", () => {
  test("prefers a visible origin over every fallback", () => {
    const origin = new FakeElement("button");
    const fallback = new FakeElement("button");
    expect(
      restoreDialogFocus([
        asElement(origin),
        asElement(fallback),
        asElement(pageTitle),
      ]),
    ).toBe(true);
    expect(activeElement).toBe(origin);
    expect(fallback.focusCalls).toBe(0);
    expect(pageTitle.focusCalls).toBe(0);
  });

  test("skips a connected but hidden origin and focuses the menu trigger", () => {
    const origin = new FakeElement("button");
    origin.rects = 0;
    const trigger = new FakeElement("button", {
      "data-settings-menu-trigger": "view-options",
    });
    expect(
      restoreDialogFocus([asElement(origin), asElement(trigger)]),
    ).toBe(true);
    expect(origin.focusCalls).toBe(0);
    expect(activeElement).toBe(trigger);
  });

  test("skips inert, disabled, aria-hidden and disconnected origins", () => {
    const inertParent = new FakeElement("div", { inert: "" });
    const inerted = new FakeElement("button");
    inertParent.append(inerted);
    const disabled = new FakeElement("button", { disabled: "" });
    const ariaHidden = new FakeElement("button", { "aria-hidden": "true" });
    const detached = new FakeElement("button");
    detached.isConnected = false;
    const invisible = new FakeElement("button");
    invisible.visibility = "hidden";
    const trigger = new FakeElement("button");
    expect(
      restoreDialogFocus([
        asElement(inerted),
        asElement(disabled),
        asElement(ariaHidden),
        asElement(detached),
        asElement(invisible),
        asElement(trigger),
      ]),
    ).toBe(true);
    for (const skipped of [
      inerted,
      disabled,
      ariaHidden,
      detached,
      invisible,
    ])
      expect(skipped.focusCalls).toBe(0);
    expect(activeElement).toBe(trigger);
  });

  test("moves to the next candidate when focus() does not take", () => {
    const stubborn = new FakeElement("button");
    stubborn.movesFocus = false;
    const trigger = new FakeElement("button");
    expect(
      restoreDialogFocus([asElement(stubborn), asElement(trigger)]),
    ).toBe(true);
    expect(stubborn.focusCalls).toBe(1);
    expect(activeElement).toBe(trigger);
  });

  test("reaches the page title only after earlier candidates fail", () => {
    const hidden = new FakeElement("button");
    hidden.rects = 0;
    const disconnected = new FakeElement("button");
    disconnected.isConnected = false;
    expect(
      restoreDialogFocus([
        asElement(hidden),
        asElement(disconnected),
        null,
        asElement(pageTitle),
      ]),
    ).toBe(true);
    expect(activeElement).toBe(pageTitle);
  });

  test("returns false without stealing focus when nothing can take it", () => {
    const hidden = new FakeElement("button");
    hidden.rects = 0;
    const detached = new FakeElement("button");
    detached.isConnected = false;
    expect(
      restoreDialogFocus([
        asElement(hidden),
        asElement(detached),
        null,
        undefined,
      ]),
    ).toBe(false);
    expect(hidden.focusCalls).toBe(0);
    expect(detached.focusCalls).toBe(0);
    expect(activeElement).toBe(body);
  });
});

describe("Modal cleanup wiring", () => {
  const source = readFileSync("src/renderer/Modal.tsx", "utf8");
  const compact = source.replace(/\s+/g, " ");

  test("mount captures the origin through captureDialogOrigin", () => {
    expect(compact).toContain(
      "captureDialogOrigin(document.activeElement as HTMLElement | null)",
    );
    expect(compact).toContain("export function captureDialogOrigin(");
    expect(compact).toContain("export function restoreDialogFocus(");
  });

  test("cleanup keeps the StrictMode guard, custom restore and helper chain", () => {
    const microtask = compact.indexOf("queueMicrotask(() => {");
    expect(microtask).toBeGreaterThan(-1);
    expect(compact).toContain("dialog.close();");
    const guard = compact.indexOf(
      "if (dialog.isConnected && dialog.open) return;",
      microtask,
    );
    const custom = compact.indexOf("if (restore.current?.()) return;", guard);
    const chain = compact.indexOf("restoreDialogFocus([", custom);
    expect(guard).toBeGreaterThan(microtask);
    expect(custom).toBeGreaterThan(guard);
    expect(chain).toBeGreaterThan(custom);
    const active = compact.indexOf("origin.active,", chain);
    const fallback = compact.indexOf("origin.fallback,", active);
    const title = compact.indexOf('".page-title"', fallback);
    expect(active).toBeGreaterThan(chain);
    expect(fallback).toBeGreaterThan(active);
    expect(title).toBeGreaterThan(fallback);
  });
});
