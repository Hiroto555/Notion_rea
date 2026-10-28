/** Raw input is owned by the App, so an incomplete numeric edit survives a
 * closed peek or a different record. Only complete finite values are saved. */
export function parsePropertyNumberInput(
  text: string,
): { kind: "valid"; value: number | null } | { kind: "incomplete" } {
  const value = text.trim();
  if (value === "") return { kind: "valid", value: null };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
    return { kind: "incomplete" };
  const number = Number(value);
  return Number.isFinite(number)
    ? { kind: "valid", value: number }
    : { kind: "incomplete" };
}
