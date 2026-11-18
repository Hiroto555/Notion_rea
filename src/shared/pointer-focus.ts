export type FocusMatchLike = {
  matches(selector: string): boolean;
};

/**
 * Pointer-only width changes must behave like the record page layout toggle:
 * keep focus in a raw property input or the Editor. Keyboard activation keeps
 * normal button focus because it never dispatches a primary mousedown.
 */
export function shouldPreservePointerFocus(
  button: number,
  active: FocusMatchLike | null,
): boolean {
  if (button !== 0 || active === null) return false;
  return active.matches(
    "input, textarea, [contenteditable='true'], [contenteditable='']",
  );
}
