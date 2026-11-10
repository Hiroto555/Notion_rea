import {
  Mark,
  Node as PMNode,
} from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { BLOCK_TYPES } from "./block-identity";
import { moveStep } from "../collaboration/runtime/pm-move";
import { FolioFrameStep, type FrameStepOptions } from "./shared-frame-step";

export function projectSharedDocument(doc: PMNode, target: PMNode): Transform {
  if (!doc || !target) throw new TypeError("PROJECTION_MISSING_DOCUMENT");
  if (doc.type.name !== "doc" || target.type.name !== "doc")
    throw new Error("PROJECTION_NOT_DOCUMENT");
  if (doc.type.schema !== target.type.schema)
    throw new Error("PROJECTION_SCHEMA_MISMATCH");

  target.check();
  assertUniqueIds(doc, "source");
  assertUniqueIds(target, "target");
  assertRequiredIds(doc, "source");
  assertRequiredIds(target, "target");

  const framePlan = planFrameSteps(doc, target);

  const tr = new Transform(doc);
  for (const step of framePlan.steps) tr.step(step);
  const targetIds = collectIds(target);

  const orderMoves = (targetContainer: PMNode, containerId: string | null): void => {
    if (containerId !== null) {
      if (!locateById(tr.doc, containerId)) return;
    }
    orderChildren(tr, containerId, targetContainer);
    for (const child of nodeChildren(targetContainer)) {
      if (child.isLeaf || child.isTextblock) continue;
      const childId = idOf(child);
      if (childId === null) continue;
      orderMoves(child, childId);
    }
  };

  const syncContainer = (path: string[], targetContainer: PMNode): void => {
    if (targetContainer.isTextblock) {
      reconcileInline(tr, path, targetContainer);
      return;
    }
    if (targetContainer.isLeaf) return;

    const targetChildren = nodeChildren(targetContainer);
    const targetKeys = keysOf(targetChildren);
    const targetKeySet = new Set(targetKeys);

    for (;;) {
      const located = locateByPath(tr.doc, path);
      if (!located) throw new Error("PROJECTION_CONTAINER_MISSING");
      const currentChildren = nodeChildren(located.node);
      const currentKeys = keysOf(currentChildren);
      let removeIndex = -1;
      for (let index = 0; index < currentKeys.length; index += 1) {
        if (!targetKeySet.has(currentKeys[index])) {
          removeIndex = index;
          break;
        }
      }
      if (removeIndex < 0) break;
      const removed = currentChildren[removeIndex];
      if (containsAnyId(removed, targetIds))
        throw new Error("PROJECTION_UNRESOLVED_MOVE");
      const from = contentStart(located) + offsetBefore(currentChildren, removeIndex);
      tr.delete(from, from + removed.nodeSize);
    }

    for (let index = targetChildren.length - 1; index >= 0; index -= 1) {
      const targetKey = targetKeys[index];
      const located = locateByPath(tr.doc, path);
      if (!located) throw new Error("PROJECTION_CONTAINER_MISSING");
      const currentChildren = nodeChildren(located.node);
      const currentKeys = keysOf(currentChildren);
      if (currentKeys.includes(targetKey)) continue;

      const inserted = targetChildren[index];
      for (const id of collectIds(inserted)) {
        if (locateById(tr.doc, id))
          throw new Error("PROJECTION_UNRESOLVED_MOVE");
      }

      let insertPos = contentStart(located) + located.node.content.size;
      for (let next = index + 1; next < targetChildren.length; next += 1) {
        const nextIndex = currentKeys.indexOf(targetKeys[next]);
        if (nextIndex >= 0) {
          insertPos = contentStart(located) + offsetBefore(currentChildren, nextIndex);
          break;
        }
      }
      tr.insert(insertPos, inserted);
    }

    const finalChildren = nodeChildren(targetContainer);
    const finalKeys = keysOf(finalChildren);
    for (let index = 0; index < finalChildren.length; index += 1) {
      const targetChild = finalChildren[index];
      const childPath = path.concat([finalKeys[index]]);
      const childLocation = locateByPath(tr.doc, childPath);
      if (!childLocation) throw new Error("PROJECTION_CHILD_MISSING");
      const currentChild = childLocation.node;

      if (
        currentChild.type !== targetChild.type ||
        !sameAttrs(currentChild.attrs, targetChild.attrs) ||
        !sameMarks(currentChild.marks, targetChild.marks)
      ) {
        tr.setNodeMarkup(
          childLocation.pos,
          targetChild.type,
          targetChild.attrs,
          targetChild.marks,
        );
      }

      if (targetChild.isTextblock) {
        reconcileInline(tr, childPath, targetChild);
      } else if (!targetChild.isLeaf && targetChild.content.size > 0) {
        syncContainer(childPath, targetChild);
      }
    }
  };

  try {
    orderMoves(target, null);
    syncContainer([], target);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PROJECTION_"))
      throw error;
    throw new Error(
      `PROJECTION_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!tr.doc.eq(target)) throw new Error("PROJECTION_TARGET_MISMATCH");
  return tr;
}

type FramePlan = {
  steps: FolioFrameStep[];
  retained: Map<string, PMNode>;
};

/**
 * Detects the two structural frame shapes the incremental orderer cannot
 * express: a brand-new wrapper around existing ids, and a removed wrapper whose
 * identified descendants are promoted. Each detection produces a real step so
 * the retained subtrees are embedded from the live document.
 */
function planFrameSteps(doc: PMNode, target: PMNode): FramePlan {
  const steps: FolioFrameStep[] = [];
  const retained = new Map<string, PMNode>();
  let working = doc;
  for (let guard = 0; guard < 64; guard += 1) {
    const step = detectWrap(working, target) ?? detectUnwrap(working, target);
    if (!step) break;
    const result = step.apply(working);
    if (result.failed || !result.doc)
      throw new Error(`PROJECTION_FRAME_FAILED:${result.failed ?? "UNKNOWN"}`);
    for (const id of step.retainedIds) {
      const located = locateById(working, id);
      if (located) retained.set(id, located.node);
    }
    steps.push(step);
    working = result.doc;
  }
  return { steps, retained };
}

function directChildAt(root: PMNode, id: string, parentId: string | null): Located | null {
  let entry = locateById(root, id);
  while (entry && entry.parentId !== parentId) {
    if (entry.parentId === null) return null;
    entry = locateById(root, entry.parentId);
  }
  return entry;
}

function frameTopology(node: PMNode): string {
  return JSON.stringify({id: idOf(node), type: node.type.name,
    children: node.isTextblock ? [] : nodeChildren(node).map(frameTopology)});
}

function candidateFrame(current: PMNode, target: PMNode, parentId: string | null,
  sourceIndices: number[], targetIndices: number[]): FolioFrameStep | null {
  const oldParent = parentId === null ? current : locateById(current, parentId)?.node;
  const newParent = parentId === null ? target : locateById(target, parentId)?.node;
  if (!oldParent || !newParent || !sourceIndices.length || !targetIndices.length) return null;
  const before = nodeChildren(oldParent), after = nodeChildren(newParent);
  let low = Math.min(...sourceIndices), high = Math.max(...sourceIndices);
  let targetLow = Math.min(...targetIndices), targetHigh = Math.max(...targetIndices);
  for (let pass = 0; pass < before.length + after.length + 1; pass++) {
    const previous = [low, high, targetLow, targetHigh].join(":");
    for (const child of before.slice(low, high + 1)) for (const id of collectIds(child)) {
      const entry = directChildAt(target, id, parentId);
      if (entry) { targetLow = Math.min(targetLow, entry.index); targetHigh = Math.max(targetHigh, entry.index); }
    }
    for (const child of after.slice(targetLow, targetHigh + 1)) for (const id of collectIds(child)) {
      const entry = directChildAt(current, id, parentId);
      if (entry) { low = Math.min(low, entry.index); high = Math.max(high, entry.index); }
    }
    if (previous === [low, high, targetLow, targetHigh].join(":")) break;
  }
  const source = before.slice(low, high + 1), template = after.slice(targetLow, targetHigh + 1);
  const rangeIds = new Set(source.flatMap(node => [...collectIds(node)]));
  const retainedIds: string[] = [];
  const walk = (node: PMNode): void => {
    const id = idOf(node), live = id !== null && rangeIds.has(id) ? locateById(current, id)?.node : null;
    if (id !== null && live && (node.isTextblock || node.isLeaf || frameTopology(live) === frameTopology(node))) {
      retainedIds.push(id); return;
    }
    node.forEach(walk);
  };
  template.forEach(walk);
  if (!retainedIds.length || source.some(node => idOf(node) === null)) return null;
  return FolioFrameStep.create(current, {parentId, spanIds: source.map(node => idOf(node)!),
    retainedIds, template: template.map(node => node.toJSON())} satisfies FrameStepOptions);
}

function detectWrap(current: PMNode, target: PMNode): FolioFrameStep | null {
  const oldIds = collectIds(current);
  let found: FolioFrameStep | null = null;
  target.descendants((node, _pos, parent) => {
    if (found || !parent) return false;
    const id = idOf(node);
    if (id === null || oldIds.has(id) || node.isTextblock || node.isLeaf) return true;
    const parentId = parent.type.name === "doc" ? null : idOf(parent);
    if (parentId !== null && !oldIds.has(parentId)) return true;
    const sourceIndices = [...collectIds(node)].map(childId => directChildAt(current, childId, parentId)?.index)
      .filter((at): at is number => at !== undefined);
    const targetAt = nodeChildren(parent).findIndex(child => idOf(child) === id);
    found = candidateFrame(current, target, parentId, sourceIndices, [targetAt]);
    return !found;
  });
  return found;
}

function detectUnwrap(current: PMNode, target: PMNode): FolioFrameStep | null {
  const targetIds = collectIds(target);
  let found: FolioFrameStep | null = null;
  current.descendants((node, _pos, parent) => {
    if (found || !parent) return false;
    const id = idOf(node);
    if (id === null || targetIds.has(id) || node.isTextblock || node.isLeaf) return true;
    const parentId = parent.type.name === "doc" ? null : idOf(parent);
    if (parentId !== null && !targetIds.has(parentId)) return true;
    const targetIndices = [...collectIds(node)].map(childId => directChildAt(target, childId, parentId)?.index)
      .filter((at): at is number => at !== undefined);
    const sourceAt = nodeChildren(parent).findIndex(child => idOf(child) === id);
    found = candidateFrame(current, target, parentId, [sourceAt], targetIndices);
    return !found;
  });
  return found;
}

type Located = {
  node: PMNode;
  pos: number;
  parent: PMNode;
  parentId: string | null;
  index: number;
  nextId: string | null;
};

function nodeChildren(node: PMNode): PMNode[] {
  const children: PMNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

function idOf(node: PMNode): string | null {
  const id = node.attrs?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function contentStart(located: { node: PMNode; pos: number }): number {
  return located.node.type.name === "doc" ? located.pos : located.pos + 1;
}

function offsetBefore(children: PMNode[], index: number): number {
  let offset = 0;
  for (let current = 0; current < index; current += 1)
    offset += children[current].nodeSize;
  return offset;
}

function keysOf(children: PMNode[]): string[] {
  const occurrences = new Map<string, number>();
  return children.map((child) => {
    const id = idOf(child);
    if (id !== null) return `#${id}`;
    const occurrence = occurrences.get(child.type.name) ?? 0;
    occurrences.set(child.type.name, occurrence + 1);
    return `~${child.type.name}:${occurrence}`;
  });
}

function locateByPath(root: PMNode, path: string[]): { node: PMNode; pos: number } | null {
  let node = root;
  let pos = 0;
  for (const key of path) {
    const children = nodeChildren(node);
    const keys = keysOf(children);
    const index = keys.indexOf(key);
    if (index < 0) return null;
    const start = node.type.name === "doc" ? pos : pos + 1;
    pos = start + offsetBefore(children, index);
    node = children[index];
  }
  return { node, pos };
}

function locateById(root: PMNode, id: string): Located | null {
  let found: Located | null = null;
  const walk = (node: PMNode, pos: number): void => {
    if (found) return;
    const start = node.type.name === "doc" ? pos : pos + 1;
    const children = nodeChildren(node);
    let offset = 0;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const childPos = start + offset;
      if (idOf(child) === id) {
        const next = children[index + 1];
        found = {
          node: child,
          pos: childPos,
          parent: node,
          parentId: node.type.name === "doc" ? null : idOf(node),
          index,
          nextId: next ? idOf(next) : null,
        };
        return;
      }
      walk(child, childPos);
      if (found) return;
      offset += child.nodeSize;
    }
  };
  walk(root, 0);
  return found;
}

function orderChildren(
  tr: Transform,
  containerId: string | null,
  targetContainer: PMNode,
): void {
  const targetChildren = nodeChildren(targetContainer);
  const targetIds = targetChildren.map(idOf);
  for (let index = targetChildren.length - 1; index >= 0; index -= 1) {
    const id = targetIds[index];
    if (id === null) continue;
    const current = locateById(tr.doc, id);
    if (!current) continue;

    let nextId: string | null = null;
    for (let next = index + 1; next < targetIds.length; next += 1) {
      const candidate = targetIds[next];
      if (candidate !== null && locateById(tr.doc, candidate)) {
        nextId = candidate;
        break;
      }
    }

    if (current.parent.type.name !== "doc" && current.parentId === null)
      throw new Error("PROJECTION_UNIDENTIFIED_PARENT");

    if (current.parentId === containerId && current.nextId === nextId) continue;

    tr.step(moveStep(tr.doc, id, containerId, nextId));
  }
}

function reconcileInline(
  tr: Transform,
  path: string[],
  target: PMNode,
): void {
  const located = locateByPath(tr.doc, path);
  if (!located) throw new Error("PROJECTION_CONTAINER_MISSING");
  const current = located.node;
  const contentFrom = located.pos + 1;

  const start = current.content.findDiffStart(target.content, contentFrom);
  if (start === null) return;
  const end = current.content.findDiffEnd(
    target.content,
    contentFrom + current.content.size,
    contentFrom + target.content.size,
  );
  if (end === null) throw new Error("PROJECTION_DIFF_FAILED");

  const targetFrom = start - contentFrom;
  const targetTo = end.b - contentFrom;
  if (start === end.a && targetFrom === targetTo) return;

  const fragment = target.content.cut(targetFrom, targetTo);
  tr.replaceWith(start, end.a, fragment);
}

function sameAttrs(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right ?? {});
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right ?? {}, key)) return false;
    const a = left[key];
    const b = right[key];
    if (a === b) continue;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
      return false;
    try {
      if (JSON.stringify(a) !== JSON.stringify(b)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function sameMarks(left: readonly Mark[], right: readonly Mark[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (!left[index].eq(right[index])) return false;
  return true;
}

function collectIds(node: PMNode): Set<string> {
  const ids = new Set<string>();
  const walk = (current: PMNode): void => {
    const id = idOf(current);
    if (id !== null) ids.add(id);
    current.forEach((child) => walk(child));
  };
  walk(node);
  return ids;
}

function containsAnyId(node: PMNode, ids: Set<string>): boolean {
  for (const id of collectIds(node)) if (ids.has(id)) return true;
  return false;
}

function assertUniqueIds(node: PMNode, label: string): void {
  const seen = new Set<string>();
  const walk = (current: PMNode): void => {
    const id = idOf(current);
    if (id !== null) {
      if (seen.has(id))
        throw new Error(`PROJECTION_DUPLICATE_ID:${label}:${id}`);
      seen.add(id);
    }
    current.forEach((child) => walk(child));
  };
  walk(node);
}

function assertRequiredIds(node: PMNode, label: string): void {
  const walk = (current: PMNode): void => {
    if (BLOCK_TYPES.includes(current.type.name) && idOf(current) === null)
      throw new Error(
        `PROJECTION_MISSING_ID:${label}:${current.type.name}`,
      );
    current.forEach((child) => walk(child));
  };
  walk(node);
}
