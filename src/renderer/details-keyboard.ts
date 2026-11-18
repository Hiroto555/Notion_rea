import { composing } from "../shared/keyboard";

/** Structural view of a keyboard event fired on a `<details>` element. Kept
 * framework-neutral so the shared rule is testable without React or a DOM.
 * React's synthetic `onKeyDown` event carries `isComposing`/`keyCode` only on
 * `nativeEvent`, so the flags are read from both levels. */
export type DetailsKeyEvent = {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
    defaultPrevented?: boolean;
  };
  currentTarget: {
    open: boolean;
    querySelector(selector: string): { focus(): void } | null;
  };
  preventDefault(): void;
  stopPropagation(): void;
};

/** Close a single open `<details>` on Escape.
 *
 * The handler claims the key only when this disclosure actually consumes it:
 * an in-progress IME composition (`isComposing` / keyCode 229), an already
 * `defaultPrevented` event and a closed disclosure all refuse and keep
 * propagation intact. An inner `<details>` or menu that already handled the
 * same event has either stopped propagation or marked `defaultPrevented`, so
 * an outer disclosure never also closes itself or steals the focus back.
 * Only the consuming disclosure calls preventDefault/stopPropagation and
 * returns focus to its summary. Returns true when it consumed the event. */
export function closeDetailsOnEscape(event: DetailsKeyEvent): boolean {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented === true ||
    event.nativeEvent?.defaultPrevented === true ||
    composing(event) ||
    (event.nativeEvent ? composing(event.nativeEvent) : false)
  )
    return false;
  const details = event.currentTarget;
  if (!details.open) return false;
  event.preventDefault();
  event.stopPropagation();
  details.open = false;
  details.querySelector("summary")?.focus();
  return true;
}
