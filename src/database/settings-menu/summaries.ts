import type {
  DatabaseView,
  FilterCondition,
  FilterGroup,
  Property,
} from "../../shared/types";
import { OPERATOR_LABELS, operatorNeedsValue } from "../model";

const TITLE_NAME = "名前";

export type ViewSummaryChip = {
  id: string;
  kind: "filter" | "sort" | "group";
  /** A short, human-readable condition. */
  text: string;
  /** Present for conditions nested inside a filter group. */
  scope?: string;
};

export type ViewSummary = {
  filters: ViewSummaryChip[];
  sorts: ViewSummaryChip[];
  group: ViewSummaryChip | null;
  /** A boolean expression suitable for a trigger's accessible description. */
  filterExpression: string;
  activeCount: number;
};

function propertyName(
  properties: readonly Property[],
  propertyId: string,
): string {
  if (propertyId === "title") return TITLE_NAME;
  return (
    properties.find((property) => property.id === propertyId)?.name ??
    propertyId
  );
}

function conditionText(
  condition: FilterCondition,
  properties: readonly Property[],
): string {
  const property = propertyName(properties, condition.propertyId);
  const operator = OPERATOR_LABELS[condition.operator] ?? condition.operator;
  const value = condition.value;
  if (
    !operatorNeedsValue(condition.operator) ||
    value === undefined ||
    value === ""
  )
    return `${property} ${operator}`;
  return `${property} ${operator}「${String(value)}」`;
}

function groupExpression(
  group: FilterGroup,
  properties: readonly Property[],
): string {
  const parts = group.conditions.map((node) =>
    node.kind === "condition"
      ? conditionText(node, properties)
      : `(${groupExpression(node, properties)})`,
  );
  return parts.join(group.conjunction === "and" ? " かつ " : " または ");
}

function collectConditions(
  group: FilterGroup,
  properties: readonly Property[],
  scope: string | undefined,
  chips: ViewSummaryChip[],
): void {
  for (const node of group.conditions) {
    if (node.kind === "condition") {
      chips.push({
        id: node.id,
        kind: "filter",
        text: conditionText(node, properties),
        scope,
      });
      continue;
    }
    collectConditions(
      node,
      properties,
      node.conjunction === "and"
        ? "グループ内すべて (AND)"
        : "グループ内いずれか (OR)",
      chips,
    );
  }
}

function sortDirection(direction: DatabaseView["sorts"][number]["direction"]) {
  return direction === "asc" ? "昇順" : "降順";
}

/** Renders the saved view state as compact, read-only summaries. The helper is
 * pure so nested conjunction and multi-sort coverage can be tested without a
 * DOM. */
export function summarizeView(
  view: DatabaseView,
  properties: readonly Property[],
): ViewSummary {
  const filters: ViewSummaryChip[] = [];
  collectConditions(view.filter, properties, undefined, filters);
  const sorts = view.sorts.map<ViewSummaryChip>((sort) => ({
    id: sort.id,
    kind: "sort",
    text: `${propertyName(properties, sort.propertyId)} ${sortDirection(sort.direction)}`,
  }));
  const group = view.groupBy
    ? {
        id: `group:${view.groupBy.propertyId}`,
        kind: "group" as const,
        text: `${propertyName(properties, view.groupBy.propertyId)} ${sortDirection(view.groupBy.direction)}`,
      }
    : null;
  return {
    filters,
    sorts,
    group,
    filterExpression: groupExpression(view.filter, properties),
    activeCount: filters.length + sorts.length + (group ? 1 : 0),
  };
}

/** Useful for tests and future callers that need only the boolean shape. */
export function filterExpression(
  filter: FilterGroup,
  properties: readonly Property[],
): string {
  return groupExpression(filter, properties);
}
