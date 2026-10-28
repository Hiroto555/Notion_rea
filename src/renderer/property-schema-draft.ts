import type { Property } from "../shared/types";
import { propertyChangeSchema, type PropertyChange } from "../shared/property-operation";

export type PropertySchemaDraft = {kind: PropertyChange["kind"]; propertyId: string;
  name: string; type: Property["type"]; optionsText: string};
export function newPropertyDraft(): PropertySchemaDraft {
  return {kind: "add", propertyId: crypto.randomUUID(), name: "", type: "text", optionsText: ""};
}
export function editPropertyDraft(property: Property, kind: "rename" | "changeType"): PropertySchemaDraft {
  return {kind, propertyId: property.id, name: property.name, type: property.type,
    optionsText: (property.options ?? []).join("\n")};
}
/** Preserve user's spelling. Empty or duplicate options are rejected, not trimmed away. */
export function propertyChangeFromDraft(draft: PropertySchemaDraft): PropertyChange {
  const shape = {type: draft.type, ...(draft.type === "select" ? {options: draft.optionsText.split("\n")} : {})};
  return propertyChangeSchema.parse(draft.kind === "add"
    ? {kind: "add", property: {id: draft.propertyId, name: draft.name, ...shape}}
    : draft.kind === "rename" ? {kind: "rename", propertyId: draft.propertyId, name: draft.name}
    : {kind: "changeType", propertyId: draft.propertyId, ...shape});
}
