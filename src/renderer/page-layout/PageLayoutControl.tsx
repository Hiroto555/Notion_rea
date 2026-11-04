import { useId, type MouseEvent as ReactMouseEvent } from "react";
import type { PageWidth } from "../../shared/page-layout";
import "./page-layout.css";

export type PageLayoutControlProps = {
  /** Persisted (or effective default) width owned by the parent. */
  value: PageWidth;
  disabled?: boolean;
  onChange: (width: PageWidth) => void;
};

type WidthChoice = {
  value: PageWidth;
  label: string;
  description: string;
};

/** Keep the choices stable so a width change never rebuilds the control tree. */
const WIDTH_CHOICES: readonly WidthChoice[] = [
  {
    value: "standard",
    label: "標準",
    description: "読みやすい幅で本文を表示します。",
  },
  {
    value: "wide",
    label: "ワイド",
    description: "画面の幅いっぱいに本文を表示します。",
  },
];

type FocusMatchLike = {
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

/**
 * Accessible page-width choice. The parent owns persistence, the effective
 * default and applying the width class/attribute; this component only renders
 * a controlled, non-remounting choice.
 */
export function PageLayoutControl({
  value,
  disabled = false,
  onChange,
}: PageLayoutControlProps) {
  const baseId = useId();

  const keepTextEntryFocus = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (
      typeof document !== "undefined" &&
      shouldPreservePointerFocus(event.button, document.activeElement)
    ) {
      event.preventDefault();
    }
  };

  return (
    <fieldset
      className="page-layout-control"
      disabled={disabled}
      data-page-width={value}
    >
      <legend className="page-layout-legend">ページの幅</legend>
      <div className="page-layout-options">
        {WIDTH_CHOICES.map((choice) => {
          const descriptionId = `${baseId}-${choice.value}`;
          return (
            <button
              key={choice.value}
              type="button"
              className="page-layout-option"
              aria-label={choice.label}
              aria-pressed={value === choice.value}
              aria-describedby={descriptionId}
              disabled={disabled}
              onClick={() => onChange(choice.value)}
              onMouseDown={keepTextEntryFocus}
            >
              <span className="page-layout-option-label">{choice.label}</span>
              <span
                id={descriptionId}
                className="page-layout-option-description"
              >
                {choice.description}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
