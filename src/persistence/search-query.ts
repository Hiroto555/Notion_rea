import { textOf, type Page } from "../shared/types";
import {
  buildSnippet,
  buildTitleMatch,
  type SearchMatch,
  type SearchResultPage,
} from "../shared/search-snippet";

type RankedResult = {
  page: Page;
  inputIndex: number;
  rank: number;
  match: SearchMatch;
};

type PropertySource = { text: string; label?: string };

function propertySources(
  page: Page,
  values: ReadonlyMap<string, string>,
): PropertySource[] {
  const sources: PropertySource[] = [];
  const recordValues = values.get(page.id);
  if (recordValues) sources.push({ text: recordValues, label: "プロパティ" });

  if (page.database) {
    const propertyNames = new Map(
      page.database.properties.map((property) => [property.id, property.name]),
    );
    for (const row of page.database.rows) {
      if (row.title) sources.push({ text: row.title, label: "レコード" });
      for (const [propertyId, value] of Object.entries(row.values)) {
        const text = String(value);
        if (text)
          sources.push({
            text,
            label: propertyNames.get(propertyId) ?? propertyId,
          });
      }
    }
  }
  return sources;
}

function titleRank(title: string, needle: string): number | null {
  const foldedTitle = title.toLocaleLowerCase();
  if (foldedTitle === needle) return 0;
  if (foldedTitle.startsWith(needle)) return 1;
  if (foldedTitle.includes(needle)) return 2;
  return null;
}

/**
 * Read-only ranked search. Title matches win over body/property matches, and
 * equal ranks keep the caller's original page order so results are stable.
 */
export function searchPages(
  pages: readonly Page[],
  query: string,
  values: ReadonlyMap<string, string> = new Map(),
): SearchResultPage[] {
  const term = query.trim();
  if (!term) return pages.filter((page) => page.deletedAt == null);

  const needle = term.toLocaleLowerCase();
  const ranked: RankedResult[] = [];

  pages.forEach((page, inputIndex) => {
    if (page.deletedAt != null) return;

    const title = page.title ?? "";
    const rank = titleRank(title, needle);
    if (rank !== null) {
      ranked.push({
        page,
        inputIndex,
        rank,
        match: buildTitleMatch(title, term) ?? {
          kind: "title",
          snippet: title,
          ranges: [],
        },
      });
      return;
    }

    const body = page.documentError ? "" : textOf(page.doc);
    const bodyMatch = body ? buildSnippet(body, term) : null;
    if (bodyMatch) {
      ranked.push({
        page,
        inputIndex,
        rank: 3,
        match: { kind: "body", ...bodyMatch },
      });
      return;
    }

    for (const source of propertySources(page, values)) {
      const propertyMatch = buildSnippet(source.text, term);
      if (propertyMatch) {
        ranked.push({
          page,
          inputIndex,
          rank: 3,
          match: {
            kind: "property",
            label: source.label,
            ...propertyMatch,
          },
        });
        return;
      }
    }
  });

  ranked.sort(
    (left, right) =>
      left.rank - right.rank || left.inputIndex - right.inputIndex,
  );
  return ranked.map(({ page, match }) => ({ ...page, searchMatch: match }));
}
