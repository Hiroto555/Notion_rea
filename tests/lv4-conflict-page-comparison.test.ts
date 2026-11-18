import { describe, expect, it } from "vitest";
import { compareConflictPages } from "../src/renderer/conflict-page-comparison";

const page = (id: string, title: string, body: string, extra = {}) => [id, JSON.stringify({
  id, title, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] }, ...extra,
})];
const checkpoint = (rows: string[][]) => JSON.stringify({payload: {tables: {pages: rows}}});

describe("conflict page comparison", () => {
  it("shows changed, added, deleted and metadata-only pages without mixing identities", () => {
    const left = checkpoint([page("a", "Old", "left"), page("b", "Only left", "text"), page("d", "Same", "same"), page("e", "Meta", "x", {favorite: true})]);
    const right = checkpoint([page("a", "New", "right"), page("c", "Only right", "text"), page("d", "Same", "same"), page("e", "Meta", "x", {favorite: false})]);
    const result = compareConflictPages(left, right);
    expect(result.totalChanged).toBe(4);
    expect(result.differences.map(({id}) => id)).toEqual(["a", "b", "c", "e"]);
    expect(result.differences[0]).toMatchObject({local: {title: "Old", body: "left"}, remote: {title: "New", body: "right"}});
    expect(result.differences[1].remote).toBeNull();
    expect(result.differences[2].local).toBeNull();
  });
  it("bounds excerpts and row count while reporting the total", () => {
    const rows = Array.from({length: 51}, (_, index) => page(String(index).padStart(2, "0"), "Title", "x".repeat(501)));
    const result = compareConflictPages(checkpoint(rows), checkpoint([]));
    expect(result.totalChanged).toBe(51);
    expect(result.differences).toHaveLength(50);
    expect(result.differences[0].local).toMatchObject({body: "x".repeat(500), bodyTruncated: true});
  });
  it("refuses malformed and duplicate page identities", () => {
    expect(() => compareConflictPages("{}", checkpoint([]))).toThrow();
    expect(() => compareConflictPages(checkpoint([page("a", "A", "x"), page("a", "A", "y")]), checkpoint([]))).toThrow();
    const bad = [["a", JSON.stringify({id: "b", title: "Mismatch", doc: {type: "doc"}})]];
    expect(() => compareConflictPages(checkpoint(bad), checkpoint([]))).toThrow();
  });
});
