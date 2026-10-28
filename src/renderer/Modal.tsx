import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { composing } from "../shared/keyboard";

type Props = {
  name: string;
  className?: string;
  children: ReactNode;
  onClose: () => void;
  restoreFocus?: () => boolean;
};

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function shown(element: HTMLElement) {
  return (
    !element.hasAttribute("disabled") &&
    element.getAttribute("aria-hidden") !== "true" &&
    !element.closest("[inert]") &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

function focusable(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && shown(element),
  );
}

// The dialog itself is the last resort: focusing it announces the accessible
// name and keeps Tab inside even when a dialog has no controls.
function initialTarget(dialog: HTMLElement) {
  const marked = dialog.querySelector<HTMLElement>(
    "[data-initial-focus],[autofocus]",
  );
  if (marked && shown(marked)) return marked;
  // Search/link/record dialogs mark their own input. The older list dialogs do
  // not, so the first action in their content list is the predictable entry
  // point (the header close button stays one Tab away in either direction).
  const content = dialog.querySelector<HTMLElement>(
    ".dialog-list, .templates, [role='listbox']",
  );
  const first = content
    ? [
        ...content.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href]",
        ),
      ].find(shown)
    : undefined;
  return first ?? focusable(dialog)[0] ?? dialog;
}

function menuItems(group: HTMLElement) {
  return [
    ...group.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], [role='option']",
    ),
  ].filter(shown);
}

// Native showModal supplies top-layer ordering and an inert background. The
// explicit Tab loop also keeps focus inside rather than in browser chrome.
export function Modal({
  name,
  className = "",
  children,
  onClose,
  restoreFocus,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null),
    composition = useRef(false);
  // Chromium can close a native select popup before dispatching the same
  // Escape to its containing dialog. Remember that inner surface until cancel.
  const selectMenu = useRef<HTMLSelectElement | null>(null);
  const [origin] = useState(() => {
    const active = document.activeElement as HTMLElement | null;
    // A dropdown item that opened the dialog is unmounted in the same commit;
    // remember its visible trigger so focus can return to the menu button.
    const anchor = active?.closest?.(".menu-anchor");
    return {
      active:
        active &&
        active !== document.body &&
        active !== document.documentElement
          ? active
          : null,
      fallback: anchor?.querySelector<HTMLElement>(":scope > button") ?? null,
    };
  });
  const restore = useRef(restoreFocus);
  restore.current = restoreFocus;
  useLayoutEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    initialTarget(dialog).focus({ preventScroll: true });
    return () => {
      dialog.close();
      queueMicrotask(() => {
        // Development StrictMode reopens the same element immediately after
        // its effect cleanup; that is not a user dismissal.
        if (dialog.isConnected && dialog.open) return;
        if (restore.current?.()) return;
        if (origin.active?.isConnected) {
          origin.active.focus({ preventScroll: true });
          return;
        }
        if (origin.fallback?.isConnected) {
          origin.fallback.focus({ preventScroll: true });
          return;
        }
        const title = document.querySelector<HTMLInputElement>(".page-title");
        if (title && !title.disabled) title.focus({ preventScroll: true });
      });
    };
  }, [origin]);
  return createPortal(
    <dialog
      ref={ref}
      className={"common-dialog " + className}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      onPointerDownCapture={(e) => {
        if (e.target instanceof HTMLSelectElement)
          selectMenu.current = e.target;
      }}
      onChangeCapture={(e) => {
        if ((e.target as EventTarget) === selectMenu.current)
          selectMenu.current = null;
      }}
      onBlurCapture={(e) => {
        if ((e.target as EventTarget) === selectMenu.current)
          selectMenu.current = null;
      }}
      onKeyUp={(e) => {
        if (
          (e.key === "Enter" || e.key === "Escape") &&
          selectMenu.current &&
          !selectMenu.current.matches(":open")
        )
          selectMenu.current = null;
      }}
      onCompositionStart={() => {
        composition.current = true;
      }}
      onCompositionEnd={() => {
        composition.current = false;
      }}
      onCancel={(e) => {
        if (e.defaultPrevented || e.target !== e.currentTarget) return;
        e.preventDefault();
        if (selectMenu.current) {
          selectMenu.current = null;
          return;
        }
        if (!composition.current) onClose();
      }}
      onKeyDown={(e) => {
        if (
          e.defaultPrevented ||
          (e.target as HTMLElement).closest("dialog") !== ref.current
        )
          return;
        if (composing(e.nativeEvent, composition.current)) {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
        if (
          e.target instanceof HTMLSelectElement &&
          (e.key === " " ||
            e.key === "Enter" ||
            (e.key === "ArrowDown" && e.altKey))
        )
          selectMenu.current = e.target;
        // Arrow keys move through menu-like lists. Search owns its own arrow
        // handling on the input and prevents the default before this point.
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const group = (e.target as HTMLElement).closest<HTMLElement>(
            ".dialog-list, .templates, [role='listbox']",
          );
          if (group) {
            const items = menuItems(group);
            if (items.length > 1) {
              e.preventDefault();
              const current = items.indexOf(e.target as HTMLElement);
              const step = e.key === "ArrowDown" ? 1 : -1;
              const index =
                current < 0
                  ? step > 0
                    ? 0
                    : items.length - 1
                  : (current + step + items.length) % items.length;
              items[index].focus();
              return;
            }
          }
        }
        // Escape's native cancel event closes only the uppermost dialog. Inner
        // menus can consume keydown with preventDefault before it reaches here.
        if (e.key !== "Tab") return;
        const nodes = focusable(ref.current!);
        if (!nodes.length) {
          e.preventDefault();
          ref.current!.focus();
          return;
        }
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            !nodes.includes(document.activeElement as HTMLElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !nodes.includes(document.activeElement as HTMLElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }}
      onClick={(e) => {
        if (e.target instanceof HTMLSelectElement && !e.target.matches(":open"))
          selectMenu.current = null;
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          onClose();
      }}
    >
      {children}
    </dialog>,
    document.body,
  );
}

// Every dialog gets the same native top layer and focus contract. The `modal`
// flag only selects whether App's link-specific focus callback applies: for
// the older dialogs that callback would treat a stale link origin as the
// restore target, so those fall back to their own trigger instead.
export function DialogFrame({
  modal,
  restoreFocus,
  ...props
}: Props & { modal: boolean }) {
  return <Modal {...props} restoreFocus={modal ? restoreFocus : undefined} />;
}
