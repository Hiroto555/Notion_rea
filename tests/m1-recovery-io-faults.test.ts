import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runStartupWorkspaceSyncDetailed } from "../src/main/workspace-sync-startup";
import {
  withRecoveryRead,
  writeRecoveryFile,
} from "../src/persistence/recovery-io";
import { writeRecoveryOrigin } from "../src/persistence/recovery-origin";
import { Store } from "../src/persistence/store";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { hashCheckpoint } from "../src/sync/protocol";
import { RECOVERY_ORIGIN_KEY } from "../src/shared/conflict-recovery";

const roots: string[] = [];
function temporaryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-m1-io-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("refuses a FIFO before calling the content reader, without blocking", () => {
  const root = temporaryRoot();
  execFileSync("mkfifo", [join(root, "input")]);
  let reads = 0;
  expect(() =>
    withRecoveryRead(root, "input", 1024, () => {
      reads++;
    }),
  ).toThrow("invalid-recovery-file");
  expect(reads).toBe(0);
  expect(existsSync(join(root, "input"))).toBe(true);
});

it("rejects replacement of the pathname while its original FD is in use", () => {
  const root = temporaryRoot();
  writeFileSync(join(root, "input"), "original bytes");
  expect(() =>
    withRecoveryRead(root, "input", 1024, (fd) => {
      expect(readFileSync(fd, "utf8")).toBe("original bytes");
      renameSync(join(root, "input"), join(root, "preserved"));
      writeFileSync(join(root, "input"), "original bytes");
    }),
  ).toThrow("recovery-file-changed");
  expect(readFileSync(join(root, "preserved"), "utf8")).toBe("original bytes");
  expect(readFileSync(join(root, "input"), "utf8")).toBe("original bytes");
});

it("preserves the new file on an injected ENOSPC and never overwrites it on retry", () => {
  const root = temporaryRoot();
  const failure = Object.assign(new Error("injected ENOSPC"), {
    code: "ENOSPC",
  });
  expect(() =>
    writeRecoveryFile(root, "output", "preserve these bytes", (stage) => {
      if (stage === "before-file-sync") throw failure;
    }),
  ).toThrow(failure);
  expect(readFileSync(join(root, "output"), "utf8")).toBe(
    "preserve these bytes",
  );
  expect(() => writeRecoveryFile(root, "output", "replacement")).toThrow();
  expect(readFileSync(join(root, "output"), "utf8")).toBe(
    "preserve these bytes",
  );
});

it("holds ambient startup sync before enrollment and offers no reconnect for recovery origins", async () => {
  const root = temporaryRoot();
  const store = new Store(join(root, "workspace.sqlite"));
  try {
    store.transaction(() =>
      writeRecoveryOrigin(
        store.db,
        randomUUID(),
        hashCheckpoint(buildWorkspaceCheckpoint(store.db)),
      ),
    );
    for (const corrupt of [false, true]) {
      if (corrupt)
        store.db
          .prepare("UPDATE settings SET value=? WHERE key=?")
          .run("{", RECOVERY_ORIGIN_KEY);
      for (const mode of ["publish", "join", "recover"]) {
        let opened = 0;
        const result = await runStartupWorkspaceSyncDetailed(
          store,
          () => ({ status: "empty", generation: 0 }),
          {
            FOLIO_DATA_DIR: root,
            FOLIO_SYNC_ENABLED: "1",
            FOLIO_SYNC_MODE: mode,
            FOLIO_SYNC_URL: "http://127.0.0.1:1",
            FOLIO_SYNC_TOKEN: "invalid-fixture-token",
            FOLIO_SYNC_WORKSPACE: "fixture",
            FOLIO_SYNC_CLIENT: "fixture",
            FOLIO_SYNC_BINDING: "fixture",
          },
          undefined,
          () => {
            opened++;
          },
        );
        expect(result.message).toContain("recovered-workspace-sync-held");
        expect(result.opened).toBeUndefined();
        expect(result.reconnect).toBeUndefined();
        expect(opened).toBe(0);
        expect(
          store.db.prepare("PRAGMA user_version").get()?.user_version,
        ).toBe(3);
        expect(
          store.db
            .prepare(
              "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'workspace_sync_%'",
            )
            .get()?.n,
        ).toBe(0);
        expect(existsSync(join(root, ".folio-sync-binding"))).toBe(false);
      }
    }
  } finally {
    store.close();
  }
});
