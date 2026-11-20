import { composing } from "../shared/keyboard";

export function customPageIcon(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const first = [
    ...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(trimmed),
  ][0]?.segment;
  if (!first || !first.trim() || first.length > 16) return null;
  return first;
}

export function titleKeyMovesToBody(
  event: {
    key: string;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
  composingActive = false,
): boolean {
  if (composing(event, composingActive)) return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey)
    return false;
  return event.key === "Enter" || event.key === "ArrowDown";
}

export type FocusTarget = { tagName: string; isContentEditable?: boolean };

export function newPageTitleFocusAllowed(
  active: FocusTarget | null | undefined,
  title: FocusTarget,
  body?: FocusTarget | null,
): boolean {
  if (!active || active === body || active === title) return true;
  const tag = active.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (active.isContentEditable === true) return false;
  return true;
}
