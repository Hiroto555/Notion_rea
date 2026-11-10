import {expandInlinePatch} from "./compact-inline";
import { applyBlockFrame } from "./block-frame";
import { canonical } from "./canonical";
import { applyBlock } from "./block-commands";
import { applyTable } from "./table-commands";
import { mapInlinePosition } from "./rich-inline";
import { applyInline } from "./rich-inline";
import { applyBlockFormat } from "./block-format";
import { locate } from "./document";
import { clone, demand, type DocumentState, type EditorAtomic, type BlockCommand, type TableCommand } from "./contract";

function apply(state: DocumentState, atom: EditorAtomic, incarnation: string, basis = state): DocumentState {
  if (atom.kind === "block.frame") return applyBlockFrame(state, atom, basis, incarnation).state;
  if (atom.kind === "inline") return applyInline(state, atom).state;
  if (atom.kind === "block.format") return applyBlockFormat(state, atom, incarnation).state;
  return atom.kind.startsWith("table.") ? applyTable(state, atom as TableCommand, incarnation).state : applyBlock(state, atom as BlockCommand, incarnation).state;
}

/** Validate each immutable before fragment at the trusted intent base, then
 * apply the same logical operations to the current state in one outer savepoint. */
export function applyEditorBatch(
  basis: DocumentState, current: DocumentState, atoms: EditorAtomic[], incarnation: string,
  authorizeAtom: (atom: EditorAtomic, state: DocumentState) => void = () => {},
): DocumentState {
  demand(atoms.length > 0 && atoms.length <= 64, "EDITOR_BATCH_LIMIT");
  let base = clone(basis), next = clone(current);
  for (const wireAtom of atoms) {
    const atom = wireAtom.kind === "inline.patch" || wireAtom.kind === "inline.mark" ? expandInlinePatch(base, wireAtom) : wireAtom;
    let currentAtom = atom;
    demand(atom.kind !== "table.row.restore" && atom.kind !== "table.column.restore", "EDITOR_RESTORE_REQUIRES_PROOF");
    if (atom.kind === "inline") {
      demand(canonical(locate(base.document, atom.blockId).node.content ?? []) === canonical(atom.before), "EDITOR_SOURCE_MISMATCH");
    } else if (atom.kind === "block.format") {
      const source = locate(base.document, atom.blockId).node;
      demand(source.type === atom.beforeType && canonical(source.attrs ?? {}) === canonical(atom.beforeAttrs), "EDITOR_SOURCE_MISMATCH");
    } else if (atom.kind === "block.split") {
      currentAtom = {...atom, offset: mapInlinePosition(locate(base.document, atom.blockId).node.content ?? [], locate(next.document, atom.blockId).node.content ?? [], atom.offset)};
    }
    authorizeAtom(atom, next);
    const basis = base;
    base = apply(base, atom, incarnation, basis);
    next = apply(next, currentAtom, incarnation, basis);
  }
  return next;
}
