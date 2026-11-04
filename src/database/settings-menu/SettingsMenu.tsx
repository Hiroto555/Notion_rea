import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { composing } from "../../shared/keyboard";

export type SettingsMenuProps = {
  /** Stable hook used by E2E selectors and tests. */
  name: string;
  /** Accessible name for the trigger. */
  label: string;
  panelLabel: string;
  trigger: ReactNode;
  children:
    | ReactNode
    | ((close: (restoreFocus?: boolean) => void) => ReactNode);
  className?: string;
  panelClassName?: string;
  panelRole?: "group" | "dialog";
};

/** A disclosure popover that stays mounted while closed. Escape closes the
 * panel and returns focus to its trigger; clicking outside closes it without
 * moving focus. */
export function SettingsMenu({
  name,
  label,
  panelLabel,
  trigger,
  children,
  className,
  panelClassName,
  panelRole = "group",
}: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      // Fixed positioning escapes the document scroller's clipping boundary.
      // Keep the panel mounted under its controls for focus and form ownership.
      const sheet = window.innerWidth <= 700 ||
        ((name === "filter" || name === "sort") && window.innerWidth <= 1100);
      if (sheet) { setPosition({}); return; }
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const width = panel.offsetWidth;
      const below = window.innerHeight - trigger.bottom - 18;
      const above = trigger.top - 18;
      const openBelow = below >= Math.min(240, above);
      setPosition({
        left: Math.max(12, Math.min(trigger.left, window.innerWidth - width - 12)),
        right: "auto",
        top: openBelow ? trigger.bottom + 6 : "auto",
        bottom: openBelow ? "auto" : window.innerHeight - trigger.top + 6,
        maxHeight: Math.max(96, Math.min(560, window.innerHeight * 0.7, openBelow ? below : above)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, name]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target))
        setOpen(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target))
        setOpen(false);
    };
    // Removing a focused condition can return focus to document.body. Keep
    // Escape available then as well as inside the panel.
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || composing(event) || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [open, close]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open || composing(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  return (
    <div
      className={["r7-menu", className].filter(Boolean).join(" ")}
      ref={rootRef}
      onKeyDown={handleKeyDown}
      data-settings-menu={name}
    >
      <button
        type="button"
        ref={triggerRef}
        className="r7-menu-trigger"
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        data-settings-menu-trigger={name}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger}
      </button>
      <div
        id={panelId}
        ref={panelRef}
        style={position}
        className={["r7-popover", panelClassName].filter(Boolean).join(" ")}
        role={panelRole}
        aria-label={panelLabel}
        hidden={!open}
        data-settings-menu-panel={name}
      >
        {typeof children === "function" ? children(close) : children}
      </div>
    </div>
  );
}
