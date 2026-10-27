import { documentSchema } from "./editor-schema";
export const DOCUMENT_SCHEMA_VERSION = 1;
// Bounds precede recursive ProseMirror validation. The very same extensions build
// the editor schema; attribute types add checks Tiptap's defaults do not supply.
export function validDocument(value: unknown): boolean {
  if (!value || typeof value !== "object" || (value as any).type !== "doc")
    return false;
  const stack = [{ node: value as any, depth: 0 }];
  let count = 0;
  const ids = new Set<string>();
  try {
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (
        ++count > 100000 ||
        depth > 100 ||
        !node ||
        typeof node !== "object" ||
        Array.isArray(node)
      )
        return false;
      if (
        node.schemaVersion !== undefined &&
        (depth !== 0 || node.schemaVersion !== DOCUMENT_SCHEMA_VERSION)
      )
        return false;
      if (
        Object.keys(node).some(
          (k) =>
            ![
              "type",
              "attrs",
              "marks",
              "text",
              "content",
              "schemaVersion",
            ].includes(k),
        )
      )
        return false;
      const spec = documentSchema.nodes[node.type];
      if (!spec || (depth > 0 && node.type === "doc")) return false;
      if (
        node.text !== undefined &&
        (node.type !== "text" || typeof node.text !== "string")
      )
        return false;
      if (
        node.attrs !== undefined &&
        !attributes(node.attrs, spec.spec.attrs ?? {})
      )
        return false;
      if (node.attrs?.id !== undefined && node.attrs.id !== null) {
        if (
          typeof node.attrs.id !== "string" ||
          !node.attrs.id ||
          node.attrs.id.length > 128 ||
          ids.has(node.attrs.id)
        )
          return false;
        ids.add(node.attrs.id);
      }
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks)) return false;
        for (const mark of node.marks) {
          const type = documentSchema.marks[mark?.type];
          if (
            !type ||
            Object.keys(mark).some((k) => !["type", "attrs"].includes(k)) ||
            (mark.attrs !== undefined &&
              !attributes(mark.attrs, type.spec.attrs ?? {}))
          )
            return false;
        }
      }
      if (node.content !== undefined) {
        if (!Array.isArray(node.content)) return false;
        for (const child of node.content)
          stack.push({ node: child, depth: depth + 1 });
      }
    }
    if (JSON.stringify(value).length > 30_000_000) return false;
    documentSchema.nodeFromJSON(value).check();
    return true;
  } catch {
    return false;
  }
}
function attributes(value: any, declared: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (!(key in declared)) return false;
    if (key === "level") {
      if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > 6) return false;
    } else if (key === "start") {
      if (!Number.isInteger(v) || Number(v) < 1) return false;
    } else if (key === "checked" || key === "open") {
      if (typeof v !== "boolean") return false;
    } else if (key === "width" || key === "height") {
      if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v > 0))
        return false;
    } else if (v !== null && typeof v !== "string") return false;
    if (
      (key === "href" || key === "src") &&
      typeof v === "string" &&
      /^\s*(javascript|vbscript):/i.test(v)
    )
      return false;
  }
  return true;
}
