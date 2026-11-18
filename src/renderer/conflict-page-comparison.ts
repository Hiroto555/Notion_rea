import { textOf, type Doc } from "../shared/types";

type PageExcerpt = { title: string; body: string; bodyTruncated: boolean };
export type ConflictPageDifference = {
  id: string;
  local: PageExcerpt | null;
  remote: PageExcerpt | null;
};
export type ConflictPageComparison = {
  totalChanged: number;
  differences: ConflictPageDifference[];
};

const MAX_PAGES = 50;
const MAX_BODY = 500;

function pages(checkpointJson: string): Map<string, string> {
  const parsed: unknown = JSON.parse(checkpointJson);
  const rows = (parsed as { payload?: { tables?: { pages?: unknown } } })?.payload?.tables?.pages;
  if (!Array.isArray(rows)) throw new Error("invalid-candidate-pages");
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" ||
        typeof row[1] !== "string" || result.has(row[0])) throw new Error("invalid-candidate-page");
    result.set(row[0], row[1]);
  }
  return result;
}

function excerpt(raw: string | undefined, id: string): PageExcerpt | null {
  if (raw === undefined) return null;
  const page = JSON.parse(raw) as { id?: unknown; title?: unknown; doc?: unknown };
  if (!page || page.id !== id || typeof page.title !== "string" || !page.doc || typeof page.doc !== "object")
    throw new Error("invalid-candidate-page");
  const body = textOf(page.doc as Doc);
  return { title: page.title, body: body.slice(0, MAX_BODY), bodyTruncated: body.length > MAX_BODY };
}

/** The caller supplies the two identity-checked, hash-verified snapshots.
 * Page JSON is compared in full; text is only an excerpt, not a full diff. */
export function compareConflictPages(localJson: string, remoteJson: string): ConflictPageComparison {
  const local = pages(localJson), remote = pages(remoteJson);
  const ids = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const changed = ids.filter((id) => local.get(id) !== remote.get(id));
  return {
    totalChanged: changed.length,
    differences: changed.slice(0, MAX_PAGES).map((id) => ({
      id, local: excerpt(local.get(id), id), remote: excerpt(remote.get(id), id),
    })),
  };
}
