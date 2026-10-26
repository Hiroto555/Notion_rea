import { requestSchema, type Page, type PagePatch } from "./types";
import { fileFits } from "./limits";
export const RECOVERY_VERSION = 2;
export type RecoveryPage = Pick<
  Page,
  | "id"
  | "title"
  | "kind"
  | "doc"
  | "database"
  | "icon"
  | "cover"
  | "favorite"
  | "schemaVersion"
>;
const invalid = () =>
  new Error(
    "対応するFolio退避ファイルではありません。原本と未保存変更を保持しています。",
  );
export function recoveryPages(input: unknown): RecoveryPage[] {
  const value = input as any;
  if (
    !value ||
    value.format !== "folio-recovery" ||
    ![1, RECOVERY_VERSION].includes(value.schemaVersion) ||
    !Array.isArray(value.pages) ||
    value.pages.length > 10000
  )
    throw invalid();
  if (!fileFits(JSON.stringify(value)))
    throw new Error("退避ファイルの上限はUTF-8で30,000,000 bytesです");
  let pages: any[] = value.pages;
  if (value.schemaVersion === 1) {
    if (!Array.isArray(value.pendingPatches)) throw invalid();
    const patches = new Map<string, PagePatch>();
    for (const entry of value.pendingPatches) {
      const parsed = requestSchema.parse({
        type: "update",
        id: entry?.id,
        revision: 0,
        patch: entry?.patch,
      });
      if (parsed.type !== "update") throw invalid();
      patches.set(parsed.id, { ...patches.get(parsed.id), ...parsed.patch });
    }
    pages = [...patches].map(([id, patch]) => {
      const sources = value.pages.filter((p: any) => p?.id === id);
      if (sources.length !== 1) throw invalid();
      return { ...sources[0], ...patch };
    });
  }
  if (!pages.length) throw invalid();
  const ids = new Set<string>();
  return pages.map((local) => {
    if (
      !local ||
      typeof local.id !== "string" ||
      !local.id ||
      ids.has(local.id) ||
      !["page", "database"].includes(local.kind) ||
      (local.schemaVersion !== undefined && local.schemaVersion !== 1) ||
      !local.doc ||
      local.database === undefined ||
      (local.kind === "database" && local.database === null)
    )
      throw invalid();
    ids.add(local.id);
    const patch = {
      title: local.title,
      doc: local.doc,
      database: local.database,
      icon: local.icon,
      cover: local.cover,
      favorite: local.favorite,
    };
    if (
      typeof local.title !== "string" ||
      typeof local.icon !== "string" ||
      typeof local.cover !== "string" ||
      typeof local.favorite !== "boolean"
    )
      throw invalid();
    requestSchema.parse({ type: "update", id: local.id, revision: 0, patch });
    return { id: local.id, kind: local.kind, schemaVersion: 1, ...patch };
  });
}
export function parseRecovery(content: string): RecoveryPage[] {
  if (!fileFits(content))
    throw new Error("退避ファイルの上限はUTF-8で30,000,000 bytesです");
  return recoveryPages(JSON.parse(content));
}
export function recoveryContent(
  pages: Page[],
  entries: { id: string; patch: PagePatch }[],
): string {
  const patches = new Map<string, PagePatch>();
  for (const e of entries)
    patches.set(e.id, { ...patches.get(e.id), ...e.patch });
  const locals = [...patches].map(([id, patch]) => {
    const source = pages.find((p) => p.id === id);
    if (!source) throw invalid();
    const p = { ...source, ...patch };
    return {
      id: p.id,
      schemaVersion: p.schemaVersion,
      title: p.title,
      kind: p.kind,
      doc: p.doc,
      database: p.database,
      icon: p.icon,
      cover: p.cover,
      favorite: p.favorite,
    };
  });
  const content = JSON.stringify({
    format: "folio-recovery",
    schemaVersion: RECOVERY_VERSION,
    pages: locals,
  });
  parseRecovery(content);
  return content;
}
