import { documentSchema } from "../shared/editor-schema";
import { validDocument } from "../shared/validation";
import { BLOCK_TYPES } from "../editor/block-identity";
import { versionDocument } from "../shared/rich-document";
import type { Doc } from "../shared/types";
import { parseSharedInput } from "./raw-json";

export function inspectSharedDocument(
  raw: string,
): { ok: true; document: Doc } | { ok: false; code: string; raw: string } {
  const parsed = parseSharedInput(raw);
  if (!parsed.ok) return parsed;
  const refuse = (code: string) => ({ ok: false as const, code, raw });
  if (!validDocument(parsed.value)) return refuse("UNSUPPORTED_DOCUMENT");
  const doc = parsed.value as Doc;
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop()!;
    if (
      BLOCK_TYPES.includes(node.type) &&
      (typeof node.attrs?.id !== "string" || !node.attrs.id)
    )
      return refuse("MISSING_ID");
    stack.push(...(node.content ?? []));
  }
  const normalized = versionDocument(
    documentSchema.nodeFromJSON(doc).toJSON() as Doc,
  );
  if (doc.schemaVersion !== undefined)
    normalized.schemaVersion = doc.schemaVersion;
  // PM may fill defaults, but may not discard/rewrite any authored field.
  function retained(input: unknown, output: unknown): boolean {
    if (input === null || typeof input !== "object") return input === output;
    if (!output || typeof output !== "object") return false;
    if (Array.isArray(input))
      return (
        Array.isArray(output) &&
        input.length === output.length &&
        input.every((v, i) => retained(v, output[i]))
      );
    return Object.entries(input).every(([key, v]) => {
      if (!Object.hasOwn(output, key)) {
        return (
          ["attrs", "marks", "content"].includes(key) &&
          v !== null &&
          typeof v === "object" &&
          Object.keys(v).length === 0
        );
      }
      return retained(v, (output as Record<string, unknown>)[key]);
    });
  }
  if (!retained(doc, normalized)) return refuse("LOSSY_PROJECTION");
  return { ok: true, document: normalized };
}
