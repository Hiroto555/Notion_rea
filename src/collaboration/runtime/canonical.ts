import { demand, wellFormed } from "./contract";
/** Browser-safe canonical JSON. No getters, unsafe integers, exotic objects or Unicode repair. */
export function canonical(value: unknown, maxBytes = 8_000_000): string {
  let nodes = 0;
  const seen = new Set<object>();
  function encode(v: unknown, depth: number): string {
    demand(++nodes <= 100_000 && depth <= 100, "JSON_LIMIT");
    if (v === null || typeof v === "boolean") return String(v);
    if (typeof v === "number") {
      demand(
        Number.isFinite(v) &&
          (!Number.isInteger(v) || Number.isSafeInteger(v)) &&
          !Object.is(v, -0),
        "UNSAFE_NUMBER",
      );
      return JSON.stringify(v);
    }
    if (typeof v === "string") {
      demand(wellFormed(v), "UNICODE");
      return JSON.stringify(v);
    }
    demand(typeof v === "object" && v !== null && !seen.has(v), "INVALID_JSON");
    demand(Object.getOwnPropertySymbols(v).length === 0, "INVALID_JSON");
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      demand(
        Object.getPrototypeOf(v) === Array.prototype &&
          Object.getOwnPropertyNames(v).length === v.length + 1,
        "INVALID_ARRAY",
      );
      const items: string[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        demand(d && "value" in d && d.enumerable, "INVALID_ARRAY");
        items.push(encode(d.value, depth + 1));
      }
      out = "[" + items.join(",") + "]";
    } else {
      demand(
        Object.getPrototypeOf(v) === Object.prototype ||
          Object.getPrototypeOf(v) === null,
        "INVALID_OBJECT",
      );
      const keys = Object.keys(v).sort();
      demand(
        keys.length === Object.getOwnPropertyNames(v).length,
        "INVALID_OBJECT",
      );
      out =
        "{" +
        keys
          .map((k) => {
            const d = Object.getOwnPropertyDescriptor(v, k)!;
            demand(
              "value" in d && d.enumerable && wellFormed(k),
              "INVALID_ACCESSOR",
            );
            return JSON.stringify(k) + ":" + encode(d.value, depth + 1);
          })
          .join(",") +
        "}";
    }
    seen.delete(v);
    return out;
  }
  const raw = encode(value, 0);
  demand(new TextEncoder().encode(raw).length <= maxBytes, "JSON_LIMIT");
  return raw;
}
