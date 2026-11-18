import {
  Fragment,
  Slice,
  Node as PMNode,
  Schema,
} from "@tiptap/pm/model";
import {
  Mapping,
  Step,
  StepMap,
  StepResult,
} from "@tiptap/pm/transform";

/**
 * A real ProseMirror step that replaces one identified sibling span with a new
 * wrapper forest, embedding the *current* retained subtrees by `attrs.id`.
 *
 * The target template only supplies wrapper nodes and brand-new descendants.
 * Every retained id in the template is a placeholder: at apply time it is
 * replaced by the live document subtree, so remote text/marks that arrived
 * after planning are never reverted to a stale JSON snapshot.
 */
export type FrameStepOptions = {
  parentId: string | null;
  spanIds: readonly string[];
  retainedIds: readonly string[];
  template: readonly unknown[];
};

export type FrameSpan = {
  from: number;
  to: number;
  insertPos: number;
};

type RetainedLayout = {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
};

type FrameLayout = {
  spanFrom: number;
  spanTo: number;
  insertPos: number;
  newSize: number;
  retained: RetainedLayout[];
};

export class FolioFrameStep extends Step {
  readonly parentId: string | null;
  readonly spanIds: readonly string[];
  readonly retainedIds: readonly string[];
  readonly template: readonly unknown[];
  readonly from: number;
  readonly to: number;
  readonly insertPos: number;

  private layout: FrameLayout | null = null;

  constructor(
    parentId: string | null,
    spanIds: readonly string[],
    retainedIds: readonly string[],
    template: readonly unknown[],
    from: number,
    to: number,
    insertPos: number,
  ) {
    super();
    if (parentId !== null && typeof parentId !== "string")
      throw new TypeError("FRAME_INVALID_PARENT_ID");
    if (!Array.isArray(spanIds) || spanIds.length === 0)
      throw new TypeError("FRAME_INVALID_SPAN");
    if (!spanIds.every((id) => typeof id === "string" && id.length > 0))
      throw new TypeError("FRAME_INVALID_SPAN_ID");
    if (new Set(spanIds).size !== spanIds.length)
      throw new TypeError("FRAME_DUPLICATE_SPAN_ID");
    if (!Array.isArray(retainedIds) || retainedIds.length === 0)
      throw new TypeError("FRAME_INVALID_RETAINED");
    if (!retainedIds.every((id) => typeof id === "string" && id.length > 0))
      throw new TypeError("FRAME_INVALID_RETAINED_ID");
    if (new Set(retainedIds).size !== retainedIds.length)
      throw new TypeError("FRAME_DUPLICATE_RETAINED_ID");
    if (!Array.isArray(template) || template.length === 0)
      throw new TypeError("FRAME_INVALID_TEMPLATE");
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(insertPos))
      throw new TypeError("FRAME_INVALID_POSITION");
    if (from < 0 || to <= from || insertPos < 0)
      throw new TypeError("FRAME_INVALID_POSITION");
    if (insertPos < from || insertPos > to)
      throw new TypeError("FRAME_INSERTION_OUTSIDE_SPAN");
    this.parentId = parentId;
    this.spanIds = [...spanIds];
    this.retainedIds = [...retainedIds];
    this.template = cloneJson(template);
    this.from = from;
    this.to = to;
    this.insertPos = insertPos;
  }

  static create(doc: PMNode, options: FrameStepOptions): FolioFrameStep {
    const span = resolveSpan(doc, options.parentId, options.spanIds);
    return new FolioFrameStep(
      options.parentId,
      options.spanIds,
      options.retainedIds,
      options.template,
      span.from,
      span.to,
      span.insertPos,
    );
  }

  get size(): number {
    return this.to - this.from;
  }

  apply(doc: PMNode): StepResult {
    try {
      this.layout = null;
      const span = resolveSpan(doc, this.parentId, this.spanIds);
      if (span.from !== this.from || span.to !== this.to)
        return StepResult.fail("FRAME_UNMAPPED_POSITION");

      const retainedNodes = new Map<string, PMNode>();
      const retainedOld = new Map<string, { from: number; to: number }>();
      for (const id of this.retainedIds) {
        const located = locateById(doc, id);
        if (!located) return StepResult.fail(`FRAME_RETAINED_MISSING:${id}`);
        if (located.from < this.from || located.to > this.to)
          return StepResult.fail(`FRAME_RETAINED_OUTSIDE_SPAN:${id}`);
        retainedNodes.set(id, located.node);
        retainedOld.set(id, { from: located.from, to: located.to });
      }
      assertNoLostContent(doc, this.spanIds, new Set(this.retainedIds));

      const schema = doc.type.schema;
      const parsed = parseTemplate(schema, this.template);
      const placeholderCounts = new Map<string, number>();
      const retainedSet = new Set(this.retainedIds);
      const shellNodes = new Map<string, PMNode>();
      const templateIds = new Set<string>();
      const inspect = (node: PMNode): void => {
        const id = idOf(node);
        if (id !== null) {
          if (templateIds.has(id)) throw new Error(`FRAME_ID_COLLISION:${id}`);
          templateIds.add(id);
          if (retainedSet.has(id)) return;
          const located = locateById(doc, id);
          if (located) {
            if (located.from < this.from || located.to > this.to || located.node.isTextblock || located.node.isLeaf ||
                ["table", "tableRow", "tableCell", "tableHeader"].includes(located.node.type.name) || located.node.type !== node.type)
              throw new Error(`FRAME_ID_COLLISION:${id}`);
            // A descendant of a retained subtree is already carried with that
            // subtree and must never also appear as a separate template node.
            for (const retained of retainedOld.values())
              if (located.from >= retained.from && located.to <= retained.to)
                throw new Error(`FRAME_ID_COLLISION:${id}`);
            shellNodes.set(id, located.node);
          }
        }
        node.forEach(inspect);
      };
      parsed.forEach(inspect);

      const embed = (node: PMNode): PMNode => {
        const id = idOf(node);
        if (id !== null && retainedSet.has(id)) {
          placeholderCounts.set(id, (placeholderCounts.get(id) ?? 0) + 1);
          const live = retainedNodes.get(id);
          if (!live) throw new Error(`FRAME_RETAINED_MISSING:${id}`);
          return live;
        }
        const children: PMNode[] = [];
        node.forEach((child) => children.push(embed(child)));
        if (children.length === node.childCount) {
          let same = true;
          for (let index = 0; index < children.length; index++)
            if (children[index] !== node.child(index)) same = false;
          if (same && !(id !== null && shellNodes.has(id))) return node;
        }
        return (id !== null && shellNodes.has(id) ? shellNodes.get(id)! : node).copy(Fragment.fromArray(children));
      };

      for (const id of this.retainedIds)
        if (!templateContainsId(parsed, id))
          return StepResult.fail(`FRAME_TEMPLATE_MISSING_RETAINED:${id}`);

      const newChildren = nodeChildren(parsed).map(embed);
      for (const id of this.retainedIds) {
        if ((placeholderCounts.get(id) ?? 0) !== 1)
          return StepResult.fail(`FRAME_TEMPLATE_RETAINED_COUNT:${id}`);
      }

      const resultIds = new Set<string>();
      const unique = (node: PMNode): void => {
        const id = idOf(node);
        if (id !== null) {
          if (resultIds.has(id)) throw new Error(`FRAME_ID_COLLISION:${id}`);
          resultIds.add(id);
        }
        node.forEach(unique);
      };
      for (const child of newChildren) unique(child);

      const fragment = Fragment.fromArray(newChildren);
      const result = doc.replace(this.from, this.to, new Slice(fragment, 0, 0));
      result.check();
      const newSize = fragment.size;
      if (this.to - this.from < 0 || this.from + newSize < this.from)
        return StepResult.fail("FRAME_INVALID_RESULT_SIZE");

      const appliedSlice = result.slice(this.from, this.from + newSize);
      if (!appliedSlice.content.eq(fragment))
        return StepResult.fail("FRAME_APPLY_INCONSISTENT");

      const retained: RetainedLayout[] = [];
      for (const id of this.retainedIds) {
        const located = locateById(result, id);
        if (!located) return StepResult.fail(`FRAME_RESULT_RETAINED_MISSING:${id}`);
        if (located.from < this.from || located.to > this.from + newSize)
          return StepResult.fail(`FRAME_RESULT_RETAINED_OUTSIDE:${id}`);
        const live = retainedNodes.get(id);
        if (!live || !located.node.eq(live))
          return StepResult.fail(`FRAME_RESULT_RETAINED_CHANGED:${id}`);
        const old = retainedOld.get(id);
        if (!old) return StepResult.fail(`FRAME_RETAINED_MISSING:${id}`);
        retained.push({
          oldFrom: old.from,
          oldTo: old.to,
          newFrom: located.from,
          newTo: located.to,
        });
      }

      this.layout = {
        spanFrom: this.from,
        spanTo: this.to,
        insertPos: this.insertPos,
        newSize,
        retained,
      };
      return StepResult.ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return StepResult.fail(message.startsWith("FRAME_") ? message : `FRAME_APPLY_FAILED:${message}`);
    }
  }

  map(mapping: Mapping | StepMap): Step | null {
    const from = mapping.map(this.from, 1);
    const to = mapping.map(this.to, -1);
    const insertPos = mapping.map(this.insertPos, 1);
    if (to <= from) return null;
    if (insertPos < from || insertPos > to) return null;
    return new FolioFrameStep(
      this.parentId,
      this.spanIds,
      this.retainedIds,
      this.template,
      from,
      to,
      insertPos,
    );
  }

  getMap(): StepMap {
    if (!this.layout) throw new RangeError("FRAME_NOT_APPLIED");
    return new FolioFrameStepMap(
      this.layout.spanFrom,
      this.layout.spanTo,
      this.layout.insertPos,
      this.layout.newSize,
      this.layout.retained,
    );
  }

  invert(doc: PMNode): Step {
    const applied = this.apply(doc);
    if (applied.failed || !applied.doc || !this.layout)
      throw new RangeError(applied.failed ?? "FRAME_APPLY_FAILED");

    const oldSpan = nodeChildrenAt(doc, this.from, this.to).map((node) =>
      node.toJSON(),
    );
    const newTop = nodeChildrenAt(
      applied.doc,
      this.from,
      this.from + this.layout.newSize,
    );
    const spanIds = newTop.map(idOf);
    if (spanIds.some((id) => id === null))
      throw new RangeError("FRAME_UNIDENTIFIED_INVERSE_SPAN");
    return FolioFrameStep.create(applied.doc, {
      parentId: this.parentId,
      spanIds: spanIds as string[],
      retainedIds: this.retainedIds,
      template: oldSpan,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      stepType: "folioFrame",
      parentId: this.parentId,
      spanIds: [...this.spanIds],
      retainedIds: [...this.retainedIds],
      template: cloneJson(this.template),
      from: this.from,
      to: this.to,
      insertPos: this.insertPos,
    };
  }

  static fromJSON(_schema: Schema, json: unknown): FolioFrameStep {
    if (!json || typeof json !== "object" || Array.isArray(json))
      throw new RangeError("FRAME_INVALID_JSON");
    const value = json as Record<string, unknown>;
    if (value.stepType !== "folioFrame") throw new RangeError("FRAME_INVALID_JSON");
    if (!Array.isArray(value.spanIds) || !Array.isArray(value.retainedIds))
      throw new RangeError("FRAME_INVALID_JSON");
    if (!Array.isArray(value.template)) throw new RangeError("FRAME_INVALID_JSON");
    return new FolioFrameStep(
      (value.parentId ?? null) as string | null,
      value.spanIds as string[],
      value.retainedIds as string[],
      value.template,
      value.from as number,
      value.to as number,
      value.insertPos as number,
    );
  }
}

const FRAME_STEP_ID = "folioFrame";
Step.jsonID(FRAME_STEP_ID, FolioFrameStep);

/**
 * Mapping for a frame replacement. Offsets strictly inside a retained subtree
 * keep their relative position (selection/native history inside the block), and
 * all positions outside delegate to a plain replacement StepMap.
 */
export class FolioFrameStepMap extends StepMap {
  readonly spanFrom: number;
  readonly spanTo: number;
  readonly insertPos: number;
  readonly newSize: number;
  readonly retained: readonly RetainedLayout[];

  constructor(
    spanFrom: number,
    spanTo: number,
    insertPos: number,
    newSize: number,
    retained: readonly RetainedLayout[],
  ) {
    super([0, 0, 0]);
    this.spanFrom = spanFrom;
    this.spanTo = spanTo;
    this.insertPos = insertPos;
    this.newSize = newSize;
    this.retained = retained;
  }

  private replacement(): StepMap {
    return new StepMap([
      this.spanFrom,
      this.spanTo - this.spanFrom,
      this.newSize,
    ]);
  }

  private retainedFor(pos: number, assoc: number): RetainedLayout | null {
    for (const entry of this.retained)
      if ((pos > entry.oldFrom && pos < entry.oldTo) || (pos === entry.oldFrom && assoc > 0) || (pos === entry.oldTo && assoc < 0)) return entry;
    return null;
  }

  map(pos: number, assoc = 1): number {
    const entry = this.retainedFor(pos, assoc);
    if (entry) return entry.newFrom + (pos - entry.oldFrom);
    return this.replacement().map(pos, assoc);
  }

  mapResult(pos: number, assoc = 1): ReturnType<StepMap["mapResult"]> {
    const entry = this.retainedFor(pos, assoc);
    if (entry)
      return StepMap.empty.mapResult(
        entry.newFrom + (pos - entry.oldFrom),
        assoc,
      );
    return this.replacement().mapResult(pos, assoc);
  }

  forEach(
    f: (oldStart: number, oldEnd: number, newStart: number, newEnd: number) => void,
  ): void {
    this.replacement().forEach(f);
  }

  invert(): StepMap {
    return new FolioFrameStepMap(
      this.insertPos,
      this.insertPos + this.newSize,
      this.spanFrom,
      this.spanTo - this.spanFrom,
      this.retained.map((entry) => ({
        oldFrom: entry.newFrom,
        oldTo: entry.newTo,
        newFrom: entry.oldFrom,
        newTo: entry.oldTo,
      })),
    );
  }
}

function idOf(node: PMNode): string | null {
  const id = node.attrs?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function nodeChildren(node: PMNode): PMNode[] {
  const children: PMNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

function nodeChildrenAt(root: PMNode, from: number, to: number): PMNode[] {
  const children: PMNode[] = [];
  root.nodesBetween(from, to, (node, pos) => {
    if (pos >= from && pos + node.nodeSize <= to) {
      children.push(node);
      return false;
    }
    return true;
  });
  return children;
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

type Located = {
  node: PMNode;
  from: number;
  to: number;
  parent: PMNode;
  parentId: string | null;
  index: number;
};

function locateById(doc: PMNode, id: string): Located | null {
  let found: Located | null = null;
  function walk(node: PMNode, from: number, parent: PMNode, index: number): void {
    if (found) return;
    if (node.attrs?.id === id) {
      found = {
        node,
        from,
        to: from + node.nodeSize,
        parent,
        parentId: parent.type.name === "doc" ? null : idOf(parent),
        index,
      };
      return;
    }
    if (node.isLeaf) return;
    const contentStart = node.type.name === "doc" ? from : from + 1;
    node.forEach((child, offset, childIndex) =>
      walk(child, contentStart + offset, node, childIndex),
    );
  }
  doc.forEach((child, offset, index) => walk(child, offset, doc, index));
  return found;
}

function resolveSpan(
  doc: PMNode,
  parentId: string | null,
  spanIds: readonly string[],
): FrameSpan {
  let parent = doc;
  let parentContentStart = 0;
  if (parentId !== null) {
    const located = locateById(doc, parentId);
    if (!located) throw new Error("FRAME_PARENT_MISSING");
    parent = located.node;
    parentContentStart = located.from + 1;
  }
  if (parent.isLeaf || parent.isTextblock)
    throw new Error("FRAME_PARENT_NOT_CONTAINER");
  const children = nodeChildren(parent);
  const indices: number[] = [];
  for (const id of spanIds) {
    const index = children.findIndex((child) => idOf(child) === id);
    if (index < 0) throw new Error(`FRAME_SPAN_MISSING:${id}`);
    indices.push(index);
  }
  indices.sort((a, b) => a - b);
  for (let index = 1; index < indices.length; index += 1)
    if (indices[index] !== indices[index - 1] + 1)
      throw new Error("FRAME_SPAN_NOT_CONTIGUOUS");
  const first = indices[0];
  const last = indices[indices.length - 1];
  let from = parentContentStart;
  for (let index = 0; index < first; index += 1)
    from += children[index].nodeSize;
  const to = from + children.slice(first, last + 1).reduce(
    (size, child) => size + child.nodeSize,
    0,
  );
  return { from, to, insertPos: from };
}

function assertNoLostContent(
  doc: PMNode,
  spanIds: readonly string[],
  retained: Set<string>,
): void {
  const spanIdSet = new Set(spanIds);
  const walk = (node: PMNode): void => {
    const id = idOf(node);
    if (id !== null && retained.has(id)) return;
    if (node.isText || node.isLeaf)
      throw new Error("FRAME_REMOVES_CONTENT");
    node.forEach((child) => walk(child));
  };
  doc.descendants((node) => {
    const id = idOf(node);
    if (id !== null && spanIdSet.has(id)) {
      walk(node);
      return false;
    }
    return true;
  });
}

function parseTemplate(schema: Schema, template: readonly unknown[]): PMNode {
  try {
    return schema.nodeFromJSON({
      type: schema.topNodeType.name,
      content: cloneJson(template),
    });
  } catch (error) {
    throw new Error(
      `FRAME_INVALID_TEMPLATE_SCHEMA:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function templateContainsId(root: PMNode, id: string): boolean {
  let found = false;
  root.descendants((node) => {
    if (idOf(node) === id) found = true;
    return !found;
  });
  return found;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
