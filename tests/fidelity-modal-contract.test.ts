import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Static contract guard for the shared Modal/DialogFrame source. The rendered
// behaviour (focus entry, Tab loop, Escape, backdrop dismissal) is covered by
// the real-Electron suite tests/e2e/r3-fidelity.spec.ts; this test keeps the
// source contract from being removed or narrowed silently when no GUI run is
// available.
const source = readFileSync("src/renderer/Modal.tsx", "utf8");
const compact = source.replace(/\s+/g, " ");

describe("Modal focus contract", () => {
  test("uses the native top layer with an accessible modal name", () => {
    expect(compact).toContain("createPortal(");
    expect(compact).toContain("if (!dialog.open) dialog.showModal();");
    expect(compact).toContain('role="dialog"');
    expect(compact).toContain('aria-modal="true"');
    expect(compact).toContain("aria-label={name}");
    expect(compact).toContain("tabIndex={-1}");
  });

  test("focuses a marked control, then a list action, then the dialog", () => {
    expect(compact).toContain('"[data-initial-focus],[autofocus]"');
    expect(compact).toContain("\".dialog-list, .templates, [role='listbox']\"");
    expect(compact).toContain(
      "initialTarget(dialog).focus({ preventScroll: true });",
    );
    expect(compact).toContain(
      "return first ?? focusable(dialog)[0] ?? dialog;",
    );
  });

  test("keeps Tab and Shift+Tab inside the modal", () => {
    expect(compact).toContain(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
    );
    expect(compact).toContain('if (e.key !== "Tab") return;');
    expect(compact).toContain(
      "const first = nodes[0], last = nodes[nodes.length - 1];",
    );
    expect(compact).toContain("last.focus();");
    expect(compact).toContain("first.focus();");
    expect(compact).toContain("ref.current!.focus();");
  });

  test("gives menu-like lists ArrowUp/ArrowDown with wrap-around", () => {
    expect(compact).toContain('e.key === "ArrowDown" || e.key === "ArrowUp"');
    expect(compact).toContain("\".dialog-list, .templates, [role='listbox']\"");
    expect(compact).toContain("(current + step + items.length) % items.length");
  });

  test("guards Escape during composition and while a native select menu is open", () => {
    expect(compact).toContain("composing(e.nativeEvent, composition.current)");
    expect(compact).toContain("if (!composition.current) onClose();");
    expect(compact).toContain("selectMenu.current = e.target;");
    expect(compact).toContain("if (selectMenu.current) {");
  });

  test("restores focus to the origin, the menu trigger, then the page title", () => {
    expect(compact).toContain('closest?.(".menu-anchor")');
    expect(compact).toContain('querySelector<HTMLElement>(":scope > button")');
    expect(compact).toContain("if (origin.active?.isConnected) {");
    expect(compact).toContain("if (origin.fallback?.isConnected) {");
    expect(compact).toContain(
      'document.querySelector<HTMLInputElement>(".page-title")',
    );
    expect(compact).toContain("if (title && !title.disabled) title.focus");
    expect(compact).toContain("if (dialog.isConnected && dialog.open) return;");
  });

  test("dismisses only on a real backdrop click", () => {
    expect(compact).toContain("if (e.target !== e.currentTarget) return;");
    expect(compact).toContain(
      "const r = e.currentTarget.getBoundingClientRect();",
    );
    expect(compact).toContain("e.clientX < r.left");
    expect(compact).toContain("e.clientY < r.top");
  });

  test("routes every DialogFrame through the same native modal contract", () => {
    expect(compact).toContain("export function DialogFrame(");
    expect(compact).toContain("<Modal {...props}");
    expect(compact).toContain(
      "restoreFocus={modal ? restoreFocus : undefined}",
    );
    // The old non-native branch is gone; no dialog keeps a separate contract.
    expect(compact).not.toContain("modal-backdrop");
  });
});
