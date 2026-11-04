import { expect, it } from "vitest";
import { prepareCrashRecovery } from "../src/renderer/prepare-crash-recovery";
import {
  emptyCrashRecoverySnapshot,
  crashRecoverySnapshotSchema,
} from "../src/shared/crash-recovery";
import { saveFixture } from "./fixtures/r4-save-fixture";
import { PendingEdits } from "../src/renderer/pending-edits";
import {
  capturePendingJournal,
  serializePendingJournal,
  parsePendingJournal,
} from "../src/shared/pending-journal";
import { recoveryContent, parseRecovery } from "../src/shared/recovery";
import type { Doc, Request } from "../src/shared/types";
import { versionDocument } from "../src/shared/rich-document";

const doc: Doc = versionDocument({
  type: "doc",
  content: [
    {
      type: "callout",
      attrs: { id: "r9-callout", tone: "warning" },
      content: [
        {
          type: "paragraph",
          attrs: { id: "r9-text" },
          content: [
            { type: "text", text: "保存結果が不明でもこの入力を保持する" },
          ],
        },
      ],
    },
    {
      type: "table",
      attrs: { id: "r9-table" },
      content: [
        {
          type: "tableRow",
          attrs: { id: "r9-row" },
          content: [
            {
              type: "tableCell",
              attrs: { id: "r9-cell", colspan: 1, rowspan: 1, colwidth: null },
              content: [
                {
                  type: "paragraph",
                  attrs: { id: "r9-cell-text" },
                  content: [{ type: "text", text: "本文の表" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

it.each([false, true])(
  "rich lost ACK resolves once and retains later draft (record=%s)",
  async (record) => {
    const f = saveFixture();
    try {
      const operation = { ...f.operation(record), patch: { doc } };
      const base = record ? f.store.get(f.record.pageId) : f.page;
      const later = structuredClone(doc);
      later.content![0].attrs!.tone = "tip";
      const entry = {
        sessionId: operation.sessionId,
        base,
        seq: 2,
        intents: [
          { seq: 1, patch: { doc } },
          { seq: 2, patch: { doc: later } },
        ],
        operation,
        ...(record ? { record: f.record } : {}),
      };
      const snapshot = {
        ...emptyCrashRecoverySnapshot(),
        ...(record ? { records: [entry] } : { pages: [entry] }),
      };
      expect(crashRecoverySnapshotSchema.safeParse(snapshot).success).toBe(
        true,
      );
      expect(f.store.commitSave(operation).status).toBe("applied");
      const requests: Request[] = [];
      const result = await prepareCrashRecovery(
        snapshot,
        async <T>(request: Request) => {
          requests.push(request);
          return f.store.handle(request) as T;
        },
      );
      const prepared = (record ? result.records : result.pages)[0];
      expect(prepared.operation).toBeUndefined();
      expect(prepared.base.doc).toEqual(doc);
      expect(prepared.intents).toEqual([{ seq: 2, patch: { doc: later } }]);
      expect(requests.filter((r) => r.type === "save:resolve")).toHaveLength(1);
      expect(requests.some((r) => r.type === "save:commit")).toBe(false);
      expect(f.store.get(base.id).doc).toEqual(doc);
    } finally {
      f.dispose();
    }
  },
);

it("rich pending journal and page recovery preserve explicit root version, cells and IDs", () => {
  const f = saveFixture();
  try {
    const pending = new PendingEdits();
    pending.add(f.page.id, { doc });
    const journal = parsePendingJournal(
      serializePendingJournal(capturePendingJournal(pending)),
    );
    expect(journal.entries[0]).toMatchObject({ kind: "page", patch: { doc } });
    expect(pending.snapshotPages()[0].patch.doc).toEqual(doc);
    const pages = parseRecovery(
      recoveryContent([f.page], [{ id: f.page.id, patch: { doc } }]),
    );
    expect(pages[0].doc).toEqual(doc);
    const recovered = f.store.recover(
      JSON.parse(
        recoveryContent([f.page], [{ id: f.page.id, patch: { doc } }]),
      ),
    ) as unknown;
    expect(recovered).toBeTruthy();
    expect(
      f.store
        .load()
        .pages.some(
          (p) =>
            p.id !== f.page.id && JSON.stringify(p.doc) === JSON.stringify(doc),
        ),
    ).toBe(true);
    expect(f.store.get(f.page.id).doc).toEqual(f.page.doc);
  } finally {
    f.dispose();
  }
});
