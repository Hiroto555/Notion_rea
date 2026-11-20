import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("P7/P8 App wiring", () => {
  const app = read("src/renderer/App.tsx");

  it("routes document link clicks through one shared handler", () => {
    expect(app).toContain("onClick={handleDocumentLinkClick}");
    expect(app).toContain("onBodyClick={handleDocumentLinkClick}");
    expect(app.match(/closest\("a"\)/g)).toHaveLength(1);
  });

  it("only ever applies links with setLink({ href }) and unlinks via extendMarkRange", () => {
    expect(app).toContain('extendMarkRange("link").unsetLink()');
    const calls = app.match(/(?<![A-Za-z])setLink\(/g) ?? [];
    const literal = app.match(/(?<![A-Za-z])setLink\(\{ href \}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(literal.length).toBe(calls.length);
  });

  it("wires the record find bar and the writing affordances", () => {
    expect(app).toContain("findBar={");
    expect(app).toContain("titleKeyMovesToBody(");
    expect(app).toContain("pendingTitleFocus");
    expect(app).toContain("customPageIcon(");
    expect(app).toContain("normalizeWebLink(");
  });
});
