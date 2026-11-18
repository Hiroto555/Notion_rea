import { describe, expect, it, vi } from "vitest";
import {
  closeDetailsOnEscape,
  type DetailsKeyEvent,
} from "../src/renderer/details-keyboard";

/** Minimal structural event: a <details> currentTarget whose summary is the
 * only queryable element. Tracks every consumption signal the handler may
 * emit. */
function makeEvent(open = true, overrides: Partial<DetailsKeyEvent> = {}) {
  const summary = { focus: vi.fn() };
  const details = {
    open,
    querySelector: vi.fn((selector: string) =>
      selector === "summary" ? summary : null,
    ),
  };
  const event: DetailsKeyEvent = {
    key: "Escape",
    currentTarget: details,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
  return { event, details, summary };
}

describe("closeDetailsOnEscape — the shared nested details rule", () => {
  it("an open disclosure consumes Escape: closes, refocuses, stops propagation", () => {
    const { event, details, summary } = makeEvent(true);
    expect(closeDetailsOnEscape(event)).toBe(true);
    expect(details.open).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(details.querySelector).toHaveBeenCalledWith("summary");
    expect(summary.focus).toHaveBeenCalledTimes(1);
  });

  it("a closed disclosure refuses and consumes nothing", () => {
    const { event, details, summary } = makeEvent(false);
    expect(closeDetailsOnEscape(event)).toBe(false);
    expect(details.open).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("an active IME composition (isComposing) is ignored entirely", () => {
    const { event, details, summary } = makeEvent(true, {
      isComposing: true,
    });
    expect(closeDetailsOnEscape(event)).toBe(false);
    expect(details.open).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("an IME composition key event (keyCode 229) is ignored entirely", () => {
    const { event, details, summary } = makeEvent(true, { keyCode: 229 });
    expect(closeDetailsOnEscape(event)).toBe(false);
    expect(details.open).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("a React-shaped event reads isComposing from nativeEvent", () => {
    // React's synthetic onKeyDown puts isComposing/keyCode on nativeEvent;
    // reading only the top level would close and steal focus mid-composition.
    const { event, details, summary } = makeEvent(true, {
      key: "Escape",
      keyCode: 27,
      nativeEvent: { isComposing: true, keyCode: 27 },
    });
    expect(closeDetailsOnEscape(event)).toBe(false);
    expect(details.open).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("a React-shaped event reads the 229 composition key from nativeEvent", () => {
    const { event, details, summary } = makeEvent(true, {
      key: "Escape",
      keyCode: 27,
      nativeEvent: { keyCode: 229 },
    });
    expect(closeDetailsOnEscape(event)).toBe(false);
    expect(details.open).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("a nativeEvent-level defaultPrevented (inner consumer) refuses", () => {
    const { event, details, summary } = makeEvent(true, {
      key: "Escape",
      nativeEvent: { defaultPrevented: true },
    });
    expect(closeDetailsOnEscape(event)).toBe(false);
    expect(details.open).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("a normal React-shaped Escape still consumes and refocuses", () => {
    const { event, details, summary } = makeEvent(true, {
      key: "Escape",
      keyCode: 27,
      nativeEvent: { isComposing: false, keyCode: 27 },
    });
    expect(closeDetailsOnEscape(event)).toBe(true);
    expect(details.open).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(summary.focus).toHaveBeenCalledTimes(1);
  });

  it("an already defaultPrevented event is not consumed twice", () => {
    const { event, details, summary } = makeEvent(true, {
      defaultPrevented: true,
    });
    expect(closeDetailsOnEscape(event)).toBe(false);
    expect(details.open).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("a non-Escape key never touches the disclosure", () => {
    const { event, details, summary } = makeEvent(true, { key: "Enter" });
    expect(closeDetailsOnEscape(event)).toBe(false);
    expect(details.open).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("an inner consumer wins: the outer disclosure refuses a consumed event", () => {
    // The inner details sees Escape first, consumes it and stops propagation.
    const inner = makeEvent(true);
    expect(closeDetailsOnEscape(inner.event)).toBe(true);
    expect(inner.event.stopPropagation).toHaveBeenCalledTimes(1);
    // If an inner consumer only prevented the default instead of stopping
    // propagation, the outer disclosure still must not also close or steal
    // the focus back.
    const outer = makeEvent(true, { defaultPrevented: true });
    expect(closeDetailsOnEscape(outer.event)).toBe(false);
    expect(outer.details.open).toBe(true);
    expect(outer.summary.focus).not.toHaveBeenCalled();
  });

  it("an inner refusal keeps propagation intact so the outer still closes", () => {
    // The inner (closed) disclosure refuses: nothing is prevented or stopped,
    // so the same event reaches the outer open disclosure, which consumes it.
    const innerClosed = makeEvent(false);
    expect(closeDetailsOnEscape(innerClosed.event)).toBe(false);
    expect(innerClosed.event.stopPropagation).not.toHaveBeenCalled();
    expect(innerClosed.event.preventDefault).not.toHaveBeenCalled();
    const outer = makeEvent(true);
    expect(closeDetailsOnEscape(outer.event)).toBe(true);
    expect(outer.details.open).toBe(false);
    expect(outer.summary.focus).toHaveBeenCalledTimes(1);
  });

  it("focus returns to the summary only when this disclosure consumed", () => {
    const refused = makeEvent(true, { defaultPrevented: true });
    closeDetailsOnEscape(refused.event);
    expect(refused.summary.focus).not.toHaveBeenCalled();
    const consumed = makeEvent(true);
    closeDetailsOnEscape(consumed.event);
    expect(consumed.summary.focus).toHaveBeenCalledTimes(1);
  });
});
