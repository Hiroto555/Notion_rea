import { Node as PMNode, Schema } from "@tiptap/pm/model";
import {
  Mapping,
  Step,
  StepMap,
  StepResult,
  Transform,
} from "@tiptap/pm/transform";

/**
 * A genuine ProseMirror move step.
 *
 * The serialized step keeps the concrete source range and target slot that
 * existed when it was created. Applying it resolves the *current* identified
 * subtree by `blockId`, so concurrent text edits inside the moved block travel
 * with it instead of being replaced by a stale snapshot. Only the block shape
 * (node types plus stable ids) is validated; text and mark changes are allowed.
 */
export class FolioMoveStep extends Step {
  readonly blockId: string;
  readonly parentId: string | null;
  readonly beforeId: string | null;
  readonly from: number;
  readonly to: number;
  readonly insertPos: number;
  readonly nodeType: string;
  readonly shape: string;

  constructor(
    blockId: string,
    parentId: string | null,
    beforeId: string | null,
    from: number,
    to: number,
    insertPos: number,
    nodeType: string,
    shape: string,
  ) {
    super();
    if (typeof blockId !== "string" || blockId.length === 0)
      throw new TypeError("MOVE_INVALID_BLOCK_ID");
    if (parentId !== null && typeof parentId !== "string")
      throw new TypeError("MOVE_INVALID_PARENT_ID");
    if (beforeId !== null && typeof beforeId !== "string")
      throw new TypeError("MOVE_INVALID_BEFORE_ID");
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(insertPos))
      throw new TypeError("MOVE_INVALID_POSITION");
    if (from < 0 || to <= from || insertPos < 0)
      throw new TypeError("MOVE_INVALID_POSITION");
    if (insertPos > from && insertPos < to)
      throw new TypeError("MOVE_INSERTION_INSIDE_SOURCE");
    if (typeof nodeType !== "string" || nodeType.length === 0)
      throw new TypeError("MOVE_INVALID_NODE_TYPE");
    if (typeof shape !== "string")
      throw new TypeError("MOVE_INVALID_SHAPE");
    this.blockId = blockId;
    this.parentId = parentId;
    this.beforeId = beforeId;
    this.from = from;
    this.to = to;
    this.insertPos = insertPos;
    this.nodeType = nodeType;
    this.shape = shape;
  }

  get size(): number {
    return this.to - this.from;
  }

  apply(doc: PMNode): StepResult {
    const source = locateById(doc, this.blockId);
    if (!source) return StepResult.fail("MOVE_SOURCE_MISSING");
    if (source.node.type.name !== this.nodeType)
      return StepResult.fail("MOVE_NODE_TYPE_MISMATCH");
    if (shapeOf(source.node) !== this.shape)
      return StepResult.fail("MOVE_SHAPE_MISMATCH");

    const target = insertionPoint(doc, this.parentId, this.beforeId);
    if (target instanceof Error) return StepResult.fail(target.message);
    const insertPos = target.position;
    if (insertPos > source.from && insertPos < source.to)
      return StepResult.fail("MOVE_INSERTION_INSIDE_SOURCE");

    if (source.from !== this.from || source.to !== this.to || insertPos !== this.insertPos)
      return StepResult.fail("MOVE_UNMAPPED_POSITION");
    try {
      // Construct the final identified tree without Transform.delete's schema
      // filling. A required parent becoming empty is a rejected move, never an
      // implicit anonymous paragraph which cannot be inverted or mapped.
      const tree = doc.toJSON();
      let moved: Record<string, unknown> | undefined;
      const remove = (parent: any): void => {
        if (!Array.isArray(parent.content)) return;
        const index = parent.content.findIndex((n: any) => n.attrs?.id === this.blockId);
        if (index >= 0) { moved = parent.content.splice(index, 1)[0]; return; }
        for (const child of parent.content) remove(child);
      };
      remove(tree);
      let parent = this.parentId === null ? tree : undefined;
      const find = (node: any): void => {
        if (node.attrs?.id === this.parentId) parent = node;
        for (const child of node.content ?? []) find(child);
      };
      if (parent === undefined) find(tree);
      if (!parent || !moved) return StepResult.fail("MOVE_PARENT_MISSING");
      parent.content ??= [];
      const index = this.beforeId === null ? parent.content.length :
        parent.content.findIndex((n: any) => n.attrs?.id === this.beforeId);
      if (index < 0) return StepResult.fail("MOVE_ANCHOR_MISSING");
      parent.content.splice(index, 0, moved);
      const result = doc.type.schema.nodeFromJSON(tree);
      result.check();
      return StepResult.ok(result);
    } catch (error) {
      return StepResult.fail(
        `MOVE_APPLY_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  map(mapping: Mapping | StepMap): Step | null {
    const from = mapping.map(this.from, 1);
    const to = mapping.map(this.to, -1);
    const insertPos = mapping.map(this.insertPos, 1);
    if (to <= from) return null;
    if (insertPos > from && insertPos < to) return null;
    return new FolioMoveStep(
      this.blockId,
      this.parentId,
      this.beforeId,
      from,
      to,
      insertPos,
      this.nodeType,
      this.shape,
    );
  }

  getMap(): StepMap {
    return new FolioMoveStepMap(this.from, this.to, this.insertPos);
  }

  invert(doc: PMNode): Step {
    const source = locateById(doc, this.blockId);
    if (!source) throw new RangeError("MOVE_SOURCE_MISSING");
    const originalParentId =
      source.parent.type.name === "doc"
        ? null
        : (source.parent.attrs?.id as string | undefined);
    if (originalParentId === undefined)
      throw new RangeError("MOVE_PARENT_UNSUPPORTED");
    const next = source.parent.maybeChild(source.index + 1);
    let originalBeforeId: string | null = null;
    if (next) {
      const nextId = next.attrs?.id;
      if (typeof nextId !== "string") throw new RangeError("MOVE_ANCHOR_UNSUPPORTED");
      originalBeforeId = nextId;
    }
    const applied = this.apply(doc);
    if (applied.failed) throw new RangeError(applied.failed);
    if (!applied.doc) throw new RangeError("MOVE_APPLY_FAILED");
    return moveStep(
      applied.doc,
      this.blockId,
      originalParentId,
      originalBeforeId,
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      stepType: "folioMove",
      blockId: this.blockId,
      parentId: this.parentId,
      beforeId: this.beforeId,
      from: this.from,
      to: this.to,
      insertPos: this.insertPos,
      nodeType: this.nodeType,
      shape: this.shape,
    };
  }

  static fromJSON(_schema: Schema, json: unknown): FolioMoveStep {
    if (!json || typeof json !== "object" || Array.isArray(json))
      throw new RangeError("MOVE_INVALID_JSON");
    const value = json as Record<string, unknown>;
    if (value.stepType !== "folioMove") throw new RangeError("MOVE_INVALID_JSON");
    return new FolioMoveStep(
      value.blockId as string,
      (value.parentId ?? null) as string | null,
      (value.beforeId ?? null) as string | null,
      value.from as number,
      value.to as number,
      value.insertPos as number,
      value.nodeType as string,
      value.shape as string,
    );
  }
}

const MOVE_STEP_ID = "folioMove";
Step.jsonID(MOVE_STEP_ID, FolioMoveStep);

type Located = {
  node: PMNode;
  from: number;
  to: number;
  parent: PMNode;
  index: number;
};

function locateById(doc: PMNode, id: string): Located | null {
  let found: Located | null = null;
  function walk(
    node: PMNode,
    from: number,
    parent: PMNode,
    index: number,
  ): void {
    if (found) return;
    if (node.attrs?.id === id) {
      found = { node, from, to: from + node.nodeSize, parent, index };
      return;
    }
    if (node.isLeaf) return;
    const contentStart = node.type.name === "doc" ? from : from + 1;
    node.forEach((child, offset, childIndex) => {
      walk(child, contentStart + offset, node, childIndex);
    });
  }
  doc.forEach((child, offset, index) => {
    walk(child, offset, doc, index);
  });
  return found;
}

function insertionPoint(
  doc: PMNode,
  parentId: string | null,
  beforeId: string | null,
): { position: number } | Error {
  let parent = doc;
  let contentStart = 0;
  if (parentId !== null) {
    const located = locateById(doc, parentId);
    if (!located) return new Error("MOVE_PARENT_MISSING");
    parent = located.node;
    contentStart = located.from + 1;
  }
  if (parent.isLeaf) return new Error("MOVE_PARENT_LEAF");
  if (beforeId === null) {
    return { position: contentStart + parent.content.size };
  }
  let position: number | null = null;
  parent.forEach((child, offset) => {
    if (position === null && child.attrs?.id === beforeId)
      position = contentStart + offset;
  });
  return position === null ? new Error("MOVE_ANCHOR_MISSING") : { position };
}

function idsInSubtree(node: PMNode): Set<string> {
  const ids = new Set<string>();
  const walk = (current: PMNode): void => {
    const id = current.attrs?.id;
    if (typeof id === "string") ids.add(id);
    current.forEach((child) => walk(child));
  };
  walk(node);
  return ids;
}

function shapeOf(node: PMNode): string {
  const parts: string[] = [];
  const walk = (current: PMNode): void => {
    const id = current.attrs?.id;
    if (typeof id === "string") parts.push(`${current.type.name}:${id}`);
    current.forEach((child) => walk(child));
  };
  walk(node);
  return parts.join("/");
}

export function moveStep(
  doc: PMNode,
  blockId: string,
  parentId: string | null,
  beforeId: string | null,
): FolioMoveStep {
  if (typeof blockId !== "string" || blockId.length === 0)
    throw new TypeError("MOVE_INVALID_BLOCK_ID");
  if (parentId !== null && typeof parentId !== "string")
    throw new TypeError("MOVE_INVALID_PARENT_ID");
  if (beforeId !== null && typeof beforeId !== "string")
    throw new TypeError("MOVE_INVALID_BEFORE_ID");
  const source = locateById(doc, blockId);
  if (!source) throw new RangeError("MOVE_SOURCE_MISSING");
  const subtree = idsInSubtree(source.node);
  if (parentId !== null && subtree.has(parentId))
    throw new RangeError("MOVE_CYCLE");
  if (beforeId !== null && subtree.has(beforeId))
    throw new RangeError("MOVE_INVALID_ANCHOR");
  const target = insertionPoint(doc, parentId, beforeId);
  if (target instanceof Error) throw new RangeError(target.message);
  if (target.position > source.from && target.position < source.to)
    throw new RangeError("MOVE_INSERTION_INSIDE_SOURCE");
  return new FolioMoveStep(
    blockId,
    parentId,
    beforeId,
    source.from,
    source.to,
    target.position,
    source.node.type.name,
    shapeOf(source.node),
  );
}

export function applyMoveTransform(
  doc: PMNode,
  blockId: string,
  parentId: string | null,
  beforeId: string | null,
): Transform {
  const step = moveStep(doc, blockId, parentId, beforeId);
  const tr = new Transform(doc);
  tr.step(step);
  return tr;
}

/**
 * StepMap for a move. A plain deletion+insertion StepMap collapses positions
 * inside the moved subtree onto its old start. This map keeps those offsets and
 * delegates every position outside the moved subtree to the composed
 * deletion/insertion maps.
 */
export class FolioMoveStepMap extends StepMap {
  readonly sourceFrom: number;
  readonly sourceTo: number;
  readonly insertPos: number;
  readonly destination: number;

  constructor(sourceFrom: number, sourceTo: number, insertPos: number) {
    super([0, 0, 0]);
    this.sourceFrom = sourceFrom;
    this.sourceTo = sourceTo;
    this.insertPos = insertPos;
    const size = sourceTo - sourceFrom;
    this.destination =
      insertPos >= sourceTo ? insertPos - size : insertPos;
  }

  private composed(): Mapping {
    const size = this.sourceTo - this.sourceFrom;
    return new Mapping([
      new StepMap([this.sourceFrom, size, 0]),
      new StepMap([this.destination, 0, size]),
    ]);
  }

  private isInside(pos: number, assoc: number): boolean {
    return (pos > this.sourceFrom && pos < this.sourceTo) || (pos === this.sourceFrom && assoc > 0) || (pos === this.sourceTo && assoc < 0);
  }

  map(pos: number, assoc = 1): number {
    if (this.isInside(pos, assoc))
      return this.destination + (pos - this.sourceFrom);
    return this.composed().map(pos, assoc);
  }

  mapResult(pos: number, assoc = 1): ReturnType<StepMap["mapResult"]> {
    if (this.isInside(pos, assoc))
      return StepMap.empty.mapResult(this.destination + (pos - this.sourceFrom), assoc);
    return this.composed().mapResult(pos, assoc);
  }

  forEach(f: (oldStart: number, oldEnd: number, newStart: number, newEnd: number) => void): void {
    const size = this.sourceTo - this.sourceFrom;
    if (this.insertPos <= this.sourceFrom) {
      f(this.insertPos, this.insertPos, this.insertPos, this.insertPos + size);
      f(this.sourceFrom, this.sourceTo, this.sourceFrom + size, this.sourceFrom + size);
    } else {
      f(this.sourceFrom, this.sourceTo, this.sourceFrom, this.sourceFrom);
      f(this.insertPos, this.insertPos, this.destination, this.destination + size);
    }
  }

  invert(): StepMap {
    const size = this.sourceTo - this.sourceFrom;
    const inverseInsert =
      this.destination <= this.sourceFrom
        ? this.sourceFrom + size
        : this.sourceFrom;
    return new FolioMoveStepMap(
      this.destination,
      this.destination + size,
      inverseInsert,
    );
  }
}
