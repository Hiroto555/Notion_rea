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
  const [origin] = useState(() => document.activeElement as HTMLElement | null);
  const restore = useRef(restoreFocus);
  restore.current = restoreFocus;
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      dialog.close();
      queueMicrotask(() => {
        // Development StrictMode reopens the same element immediately after
        // its effect cleanup; that is not a user dismissal.
        if (dialog.isConnected && dialog.open) return;
        if (restore.current?.()) return;
        if (origin?.isConnected) origin.focus({ preventScroll: true });
        else
          document
            .querySelector<HTMLElement>(".page-title")
            ?.focus({ preventScroll: true });
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
        // Escape's native cancel event closes only the uppermost dialog. Inner
        // menus can consume keydown with preventDefault before it reaches here.
        if (e.key !== "Tab") return;
        const nodes = [
          ...ref.current!.querySelectorAll<HTMLElement>(
            "button,input,select,textarea,a[href],[tabindex]",
          ),
        ].filter(
          (el) =>
            !el.hasAttribute("disabled") &&
            el.tabIndex >= 0 &&
            el.getClientRects().length > 0,
        );
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
// Existing non-target dialogs keep their previous behavior this round.
export function DialogFrame({ modal, ...props }: Props & { modal: boolean }) {
  if (modal) return <Modal {...props} />;
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className={props.className}
        role="dialog"
        aria-label={props.name}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  );
}
