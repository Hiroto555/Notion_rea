import type { FilterValue, Property } from "../shared/types";
import { cellPatchValue } from "./database-ui";
import { parsePropertyNumberInput } from "./property-number-input";
import "./database.css";

/**
 * One typed property control used by the database cells, the record page and
 * the fixture harness. The caller owns the value and the save semantics; this
 * component only converts native input to a typed FilterValue | null.
 */
export function PropertyField({
  property,
  value,
  ariaLabel,
  id,
  disabled = false,
  inputText,
  onInputTextChange,
  onChange,
}: {
  property: Property;
  value: FilterValue | null | undefined;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  /** Optional App-owned numeric text, including incomplete '-' / '1e'. */
  inputText?: string;
  onInputTextChange?: (text: string) => void;
  onChange: (value: FilterValue | null) => void;
}) {
  const text = value === undefined || value === null ? "" : String(value);
  const commit = (raw: string | boolean) =>
    onChange(cellPatchValue(property, raw));

  if (property.type === "number" && onInputTextChange) {
    const raw = inputText ?? text;
    const incomplete = parsePropertyNumberInput(raw).kind === "incomplete";
    return (
      <input
        className="r3-property-control"
        id={id}
        aria-label={ariaLabel}
        aria-invalid={incomplete || undefined}
        title={incomplete ? "数値の入力を完了してください" : undefined}
        type="text"
        inputMode="decimal"
        value={raw}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onInputTextChange(next);
          const parsed = parsePropertyNumberInput(next);
          if (parsed.kind === "valid") onChange(parsed.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !incomplete) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    );
  }

  if (property.type === "select") {
    const options = property.options ?? [];
    const unknown = text !== "" && !options.includes(text) ? text : null;
    return (
      <select
        className="r3-property-control"
        id={id}
        aria-label={ariaLabel}
        value={text}
        disabled={disabled}
        onChange={(event) => commit(event.target.value)}
      >
        <option value="">—</option>
        {unknown && <option value={unknown}>{unknown}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (property.type === "checkbox")
    return (
      <input
        className="r3-property-control r3-property-checkbox"
        id={id}
        aria-label={ariaLabel}
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  return (
    <input
      className="r3-property-control"
      id={id}
      aria-label={ariaLabel}
      type={
        property.type === "date"
          ? "date"
          : property.type === "number"
            ? "number"
            : "text"
      }
      step={property.type === "number" ? "any" : undefined}
      value={text}
      disabled={disabled}
      maxLength={property.type === "text" ? 10_000 : undefined}
      onChange={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
