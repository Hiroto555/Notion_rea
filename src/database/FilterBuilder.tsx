import type {
  DatabaseData,
  DatabaseView,
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
  FilterValue,
  Property,
} from "../shared/types";
import {
  OPERATOR_LABELS,
  addFilterCondition,
  addFilterGroup,
  defaultFilterOperator,
  filterOperatorsFor,
  newFilterCondition,
  operatorNeedsValue,
  propertyById,
  propertyType,
  removeFilterNode,
  setFilterConjunction,
  updateFilterCondition,
} from "./model";

const TITLE = { id: "title", name: "名前", type: "text" as const };

function propertyOptions(data: DatabaseData) {
  return [TITLE, ...data.properties];
}

function comparisonValue(
  property: { type: Property["type"] } | undefined,
  value: FilterValue | undefined,
): string {
  if (value === undefined) return "";
  return String(value);
}

function valueControl(
  data: DatabaseData,
  node: FilterCondition,
  path: string,
  onChange: (value: FilterValue) => void,
) {
  if (!operatorNeedsValue(node.operator)) return null;
  const property =
    node.propertyId === TITLE.id
      ? TITLE
      : propertyById(data, node.propertyId);
  const type = property?.type ?? "text";
  if (type === "checkbox") return null;
  if (property && property.type === "select" && property.options?.length) {
    return (
      <select
        aria-label={`フィルター値 ${path}`}
        value={comparisonValue(property, node.value)}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">—</option>
        {property.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (type === "number")
    return (
      <input
        aria-label={`フィルター値 ${path}`}
        type="number"
        value={comparisonValue(property, node.value)}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? "" : Number(event.target.value),
          )
        }
      />
    );
  if (type === "date")
    return (
      <input
        aria-label={`フィルター値 ${path}`}
        type="date"
        value={comparisonValue(property, node.value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  return (
    <input
      aria-label={`フィルター値 ${path}`}
      value={comparisonValue(property, node.value)}
      onChange={(event) => onChange(event.target.value)}
      placeholder="値"
    />
  );
}

function newConditionFor(data: DatabaseData) {
  const first = data.properties[0];
  return first
    ? newFilterCondition(first.id, first.type)
    : newFilterCondition("title", "text");
}

function ConditionRow({
  data,
  node,
  path,
  onChange,
  onRemove,
}: {
  data: DatabaseData;
  node: FilterCondition;
  path: string;
  onChange: (patch: Partial<Omit<FilterCondition, "id" | "kind">>) => void;
  onRemove: () => void;
}) {
  const options = propertyOptions(data);
  const type = propertyType(data, node.propertyId);
  const operators = filterOperatorsFor(type);
  return (
    <div className="db-filter-condition" style={{ display: "flex", gap: 6 }}>
      <select
        aria-label={`フィルター対象 ${path}`}
        value={node.propertyId}
        onChange={(event) => {
          const next = event.target.value;
          const nextType =
            next === TITLE.id ? "text" : propertyType(data, next);
          const operator = defaultFilterOperator(nextType);
          onChange({
            propertyId: next,
            operator,
            value:
              nextType === "checkbox" || !operatorNeedsValue(operator)
                ? undefined
                : "",
          });
        }}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <select
        aria-label={`フィルター演算子 ${path}`}
        value={node.operator}
        onChange={(event) =>
          onChange({ operator: event.target.value as FilterOperator })
        }
      >
        {operators.map((operator) => (
          <option key={operator} value={operator}>
            {OPERATOR_LABELS[operator]}
          </option>
        ))}
      </select>
      {valueControl(data, node, path, (value) => onChange({ value }))}
      <button
        type="button"
        aria-label={`フィルター条件を削除 ${path}`}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

function GroupRows({
  data,
  group,
  path,
  onChange,
}: {
  data: DatabaseData;
  group: FilterGroup;
  path: string;
  onChange: (next: FilterGroup) => void;
}) {
  const renderNode = (node: FilterNode, index: number) => {
    const childPath = `${path}.${index + 1}`;
    if (node.kind === "condition")
      return (
        <ConditionRow
          key={node.id}
          data={data}
          node={node}
          path={childPath}
          onChange={(patch) =>
            onChange(updateFilterCondition(group, node.id, patch))
          }
          onRemove={() => onChange(removeFilterNode(group, node.id))}
        />
      );
    return (
      <div
        key={node.id}
        className="db-filter-group"
        style={{
          borderLeft: "2px solid rgba(128,128,128,.35)",
          paddingLeft: 8,
          margin: "4px 0",
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            aria-label={`フィルターの結合 ${childPath}`}
            value={node.conjunction}
            onChange={(event) =>
              onChange(
                setFilterConjunction(
                  group,
                  node.id,
                  event.target.value as "and" | "or",
                ),
              )
            }
          >
            <option value="and">すべて満たす (AND)</option>
            <option value="or">いずれか (OR)</option>
          </select>
          <button
            type="button"
            aria-label={`条件を追加 ${childPath}`}
            onClick={() =>
              onChange(addFilterCondition(group, node.id, newConditionFor(data)))
            }
          >
            ＋ 条件
          </button>
          <button
            type="button"
            aria-label={`グループを追加 ${childPath}`}
            onClick={() => onChange(addFilterGroup(group, node.id))}
          >
            ＋ グループ
          </button>
          <button
            type="button"
            aria-label={`フィルターグループを削除 ${childPath}`}
            onClick={() => onChange(removeFilterNode(group, node.id))}
          >
            ×
          </button>
        </div>
        {node.conditions.map(renderNode)}
      </div>
    );
  };
  return (
    <div className="db-filter-group">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span>{path === "1" ? "一致条件" : "グループ"}</span>
        <select
          aria-label={`フィルターの結合 ${path}`}
          value={group.conjunction}
          onChange={(event) =>
            onChange(
              setFilterConjunction(
                group,
                group.id,
                event.target.value as "and" | "or",
              ),
            )
          }
        >
          <option value="and">すべて満たす (AND)</option>
          <option value="or">いずれか (OR)</option>
        </select>
        <button
          type="button"
          aria-label={`条件を追加 ${path}`}
          onClick={() =>
            onChange(addFilterCondition(group, group.id, newConditionFor(data)))
          }
        >
          ＋ 条件
        </button>
        <button
          type="button"
          aria-label={`グループを追加 ${path}`}
          onClick={() => onChange(addFilterGroup(group, group.id))}
        >
          ＋ グループ
        </button>
      </div>
      {group.conditions.map(renderNode)}
    </div>
  );
}

export function FilterBuilder({
  data,
  view,
  onChange,
}: {
  data: DatabaseData;
  view: DatabaseView;
  onChange: (filter: FilterGroup) => void;
}) {
  return (
    <div className="db-filter-builder">
      <GroupRows
        data={data}
        group={view.filter}
        path="1"
        onChange={onChange}
      />
    </div>
  );
}
