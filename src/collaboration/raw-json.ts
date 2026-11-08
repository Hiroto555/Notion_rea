/** Parse a bounded, lossless subset before JS numeric coercion. Decimal/exponent
 * forms are deliberately unsupported in this preparation port; keep their raw
 * input for a later explicit migration instead of rounding it silently. */
export function parseSharedInput(
  raw: string,
): { ok: true; value: unknown } | { ok: false; code: string; raw: string } {
  const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  let p = 0,
    nodes = 0;
  const fail = (code: string): never => {
    throw new Error(code);
  };
  const ws = () => {
    while (/[\t\r\n ]/.test(raw[p] ?? "!") && p < raw.length) p++;
  };
  function str(): string {
    const start = p++;
    while (p < raw.length) {
      if (raw[p] === "\\") {
        p += 2;
        continue;
      }
      if (raw[p++] === '"') {
        const value: string = JSON.parse(raw.slice(start, p));
        for (let i = 0; i < value.length; i++) {
          const u = value.charCodeAt(i);
          if (u >= 0xd800 && u <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail("UNICODE");
          } else if (u >= 0xdc00 && u <= 0xdfff) fail("UNICODE");
        }
        return value;
      }
    }
    return fail("JSON");
  }
  function value(depth: number): void {
    if (++nodes > 100_000 || depth > 100) fail("LIMIT");
    ws();
    const ch = raw[p];
    if (ch === '"') {
      str();
      return;
    }
    if (ch === "{" || ch === "[") {
      p++;
      ws();
      const close = ch === "{" ? "}" : "]";
      const keys = new Set<string>();
      if (raw[p] === close) {
        p++;
        return;
      }
      while (p < raw.length) {
        ws();
        if (ch === "{") {
          if (raw[p] !== '"') fail("JSON");
          const key = str();
          if (keys.has(key)) fail("DUPLICATE_KEY");
          keys.add(key);
          ws();
          if (raw[p++] !== ":") fail("JSON");
        }
        value(depth + 1);
        ws();
        if (raw[p] === close) {
          p++;
          return;
        }
        if (raw[p++] !== ",") fail("JSON");
      }
      fail("JSON");
    }
    for (const literal of ["true", "false", "null"])
      if (raw.slice(p, p + literal.length) === literal) {
        p += literal.length;
        return;
      }
    numberToken.lastIndex = p;
    const token = numberToken.exec(raw)?.[0];
    if (!token) fail("JSON");
    if (
      !/^-?(?:0|[1-9][0-9]*)$/.test(token!) ||
      !Number.isSafeInteger(Number(token)) ||
      token === "-0"
    )
      fail("UNSAFE_NUMBER");
    p += token!.length;
  }
  try {
    if (raw.length > 2_000_000) fail("LIMIT");
    if (new TextEncoder().encode(raw).byteLength > 2_000_000) fail("LIMIT");
    value(0);
    ws();
    if (p !== raw.length) fail("JSON");
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (e) {
    const known = [
      "JSON",
      "LIMIT",
      "UNICODE",
      "DUPLICATE_KEY",
      "UNSAFE_NUMBER",
    ];
    const code =
      e instanceof Error && known.includes(e.message) ? e.message : "JSON";
    return { ok: false, code, raw };
  }
}
