import type { Page } from "../src/shared/types";
// Generated at runtime: no giant fixture enters Git.
export function sizedRecovery(page: Page, bytes: number, alphabet: string) {
  const p = {
    ...page,
    doc: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: 'Aあ😀"\\' }] },
      ],
    },
  };
  const value = { format: "folio-recovery", schemaVersion: 2, pages: [p] };
  const remaining = bytes - Buffer.byteLength(JSON.stringify(value));
  const size = Buffer.byteLength(alphabet);
  p.doc.content[0].content[0].text +=
    alphabet.repeat(Math.floor(remaining / size)) +
    "x".repeat(remaining % size);
  return JSON.stringify(value);
}
