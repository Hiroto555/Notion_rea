import type { Page, PagePatch } from "../shared/types";
export class PendingEdits {
  private serial = 0;
  private entries: { seq: number; id: string; patch: PagePatch }[] = [];
  failed = new Set<string>();
  get sequence() {
    return this.serial;
  }
  add(id: string, patch: PagePatch) {
    const seq = ++this.serial;
    this.entries.push({ seq, id, patch: structuredClone(patch) });
    return seq;
  }
  patch(id: string, through = Infinity): PagePatch {
    return Object.assign(
      {},
      ...this.entries
        .filter((e) => e.id === id && e.seq <= through)
        .map((e) => e.patch),
    );
  }
  has(id: string, through = Infinity) {
    return this.entries.some((e) => e.id === id && e.seq <= through);
  }
  ack(id: string, through: number) {
    this.entries = this.entries.filter((e) => e.id !== id || e.seq > through);
    this.failed.delete(id);
  }
  discardThrough(through: number) {
    this.entries = this.entries.filter((e) => e.seq > through);
    for (const id of this.failed) if (!this.has(id)) this.failed.delete(id);
  }
  get size() {
    return this.entries.length;
  }
  patches() {
    return new Map(
      [...new Set(this.entries.map((e) => e.id))].map((id) => [
        id,
        this.patch(id),
      ]),
    );
  }
  merge(pages: Page[]) {
    return pages.map((p) => ({ ...p, ...this.patch(p.id) }));
  }
  snapshot() {
    return structuredClone(this.entries);
  }
}
