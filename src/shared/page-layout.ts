export type PageWidth = "standard" | "wide";
export function effectivePageWidth(page: {kind: "page" | "database"; width?: PageWidth}): PageWidth {
  return page.width ?? (page.kind === "database" ? "wide" : "standard");
}
