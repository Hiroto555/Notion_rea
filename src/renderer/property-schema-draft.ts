import type { Property } from "../shared/types";
import { propertyChangeSchema, type PropertyChange } from "../shared/property-operation";

export type PropertySchemaDraft = {kind: PropertyChange["kind"]; propertyId: string;
  name: string; type: Property["type"]; optionsText: string; order?: string[]};
export function newPropertyDraft(): PropertySchemaDraft {
  return {kind: "add", propertyId: crypto.randomUUID(), name: "", type: "text", optionsText: ""};
}
export function editPropertyDraft(property: Property, kind: "rename" | "changeType"): PropertySchemaDraft {
  return {kind, propertyId: property.id, name: property.name, type: property.type,
    optionsText: (property.options ?? []).join("\n")};
}
export function removePropertyDraft(property: Property): PropertySchemaDraft {
  return {kind: "remove", propertyId: property.id, name: property.name, type: property.type, optionsText: ""};
}
/** Repeated moves accumulate into a single reorder draft so preview→apply sees
 * the final order, not one swap per click. */
export function movePropertyDraft(properties: readonly Property[],
  draft: PropertySchemaDraft | null, propertyId: string, delta: -1 | 1): PropertySchemaDraft | null {
  const property = properties.find((p) => p.id === propertyId);
  if (!property) return null;
  const order = draft?.kind === "reorder" && draft.order ? [...draft.order] : properties.map((p) => p.id);
  const index = order.indexOf(propertyId), next = index + delta;
  if (index < 0 || next < 0 || next >= order.length) return null;
  [order[index], order[next]] = [order[next], order[index]];
  return {kind: "reorder", propertyId, name: property.name, type: property.type, optionsText: "", order};
}
/** Preserve user's spelling. Empty or duplicate options are rejected, not trimmed away. */
export function propertyChangeFromDraft(draft: PropertySchemaDraft): PropertyChange {
  const shape = {type: draft.type, ...(draft.type === "select" ? {options: draft.optionsText.split("\n")} : {})};
  return propertyChangeSchema.parse(draft.kind === "add"
    ? {kind: "add", property: {id: draft.propertyId, name: draft.name, ...shape}}
    : draft.kind === "rename" ? {kind: "rename", propertyId: draft.propertyId, name: draft.name}
    : draft.kind === "remove" ? {kind: "remove", propertyId: draft.propertyId}
    : draft.kind === "reorder" ? {kind: "reorder", propertyIds: draft.order ?? []}
    : {kind: "changeType", propertyId: draft.propertyId, ...shape});
}
