import { test, expect } from "./next-round-fixture";

test("Electron SQLite exposes the transaction and connection state used by workspace snapshots", async ({
  folio: s,
}) => {
  const state = await s.app.evaluate(async () => {
    const { DatabaseSync } = process.getBuiltinModule(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      const initial = {
        node: process.versions.node,
        open: db.isOpen,
        transaction: db.isTransaction,
      };
      db.exec("BEGIN");
      const inside = db.isTransaction;
      db.exec("ROLLBACK");
      db.close();
      return { ...initial, inside, afterClose: db.isOpen };
    } finally {
      if (db.isOpen) db.close();
    }
  });
  expect(state.node).toBeTruthy();
  expect(state).toMatchObject({
    open: true,
    transaction: false,
    inside: true,
    afterClose: false,
  });
});
