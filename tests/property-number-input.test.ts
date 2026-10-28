import { describe, expect, it } from "vitest";
import { parsePropertyNumberInput } from "../src/database/property-number-input";

describe("property number input", () => {
  it("retains incomplete numeric input instead of converting it to deletion", () => {
    for (const text of ["-", "+", ".", "-.", "1e", "1e-", "1e999", "NaN", "0x10"])
      expect(parsePropertyNumberInput(text)).toEqual({ kind: "incomplete" });
  });

  it("distinguishes clearing the value from incomplete input", () => {
    expect(parsePropertyNumberInput("")).toEqual({ kind: "valid", value: null });
    expect(parsePropertyNumberInput("  ")).toEqual({ kind: "valid", value: null });
  });

  it("accepts signed, decimal and exponent values without losing zero", () => {
    for (const [text, value] of [
      ["0", 0], ["-12.5", -12.5], [".5", 0.5], ["12.", 12],
      ["+1e-2", 0.01], [" 42 ", 42],
    ] as const)
      expect(parsePropertyNumberInput(text)).toEqual({ kind: "valid", value });
  });
});
