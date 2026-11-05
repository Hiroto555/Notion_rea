/**
 * Child-process fixture for the L3-C fault tests.
 *
 * The parent starts this bundle with an IPC channel and kills exactly this
 * process (SIGKILL) after an explicit barrier message. The barriers are placed
 * on production code paths:
 *
 * - page-before-commit: inside Store.transaction, immediately before COMMIT
 * - page-after-commit: immediately after COMMIT returned
 * - page-between-writes: after the first pages INSERT and before its receipt
 * - backup-before-manifest: after the database and assets were copied and
 *   flushed, but before manifest.json is published
 *
 * This file is not a Vitest test. It is bundled with the repository's existing
 * esbuild dependency and executed by tests/l3-crash-boundaries.test.ts.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Store } from "../../src/persistence/store";
import { commitPageOperation } from "../../src/persistence/page-operations";
import { createFullBackup } from "../../src/persistence/full-backup-create";
import { durableFs } from "../../src/persistence/durable-file";
import type { PageOperation } from "../../src/shared/page-operation";

type PagePayload = {
  kind: "page";
  database: string;
  operation: PageOperation;
};

type BackupPayload = {
  kind: "backup";
  database: string;
  source: string;
  destination: string;
};

type Payload = PagePayload | BackupPayload;

type Mode =
  | "page-before-commit"
  | "page-after-commit"
  | "page-between-writes"
  | "backup-before-manifest"
  | "backup-before-marker-removal"
  | "backup-complete";

const MODES = new Set<string>([
  "page-before-commit",
  "page-after-commit",
  "page-between-writes",
  "backup-before-manifest",
  "backup-before-marker-removal",
  "backup-complete",
]);

function send(message: unknown): void {
  if (process.send) process.send(message);
}

function sendAndExit(message: unknown, code: number): void {
  if (process.send) process.send(message, () => process.exit(code));
  else process.exit(code);
}

/**
 * Announce the exact interruption point and stop. The parent owns the only
 * legitimate continuation: SIGKILL of this process. There is deliberately no
 * timeout or polling here; a test that fails to kill must time out loudly.
 */
function blockAt(point: string): never {
  send({ type: "barrier", point });
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0);
  throw new Error("barrier was released without a parent kill: " + point);
}

function readPayload(path: string): Payload {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object")
    throw new Error("worker payload must be an object");
  return parsed as Payload;
}

function runPage(mode: Mode, payload: PagePayload): unknown {
  const store = new Store(payload.database);
  try {
    // This is a test-only seam on the child's own connection. It does not
    // change product source and never exists in the parent process.
    const db: any = store.db;
    let fired = false;

    if (mode === "page-between-writes") {
      const originalPrepare = db.prepare.bind(db);
      db.prepare = (sql: string) => {
        const statement = originalPrepare(sql);
        if (!/^\s*INSERT\s+INTO\s+pages\b/i.test(sql)) return statement;
        return {
          run: (...args: unknown[]) => {
            const result = statement.run(...args);
            if (!fired) {
              fired = true;
              blockAt("between-page-and-receipt");
            }
            return result;
          },
        };
      };
    } else {
      const originalExec = db.exec.bind(db);
      db.exec = (sql: string, ...args: unknown[]) => {
        if (sql === "COMMIT" && !fired) {
          if (mode === "page-before-commit") {
            fired = true;
            blockAt("before-commit");
          }
          const result = originalExec(sql, ...args);
          if (mode === "page-after-commit") {
            fired = true;
            blockAt("after-commit");
          }
          return result;
        }
        return originalExec(sql, ...args);
      };
    }

    return commitPageOperation(store, payload.operation);
  } finally {
    try {
      store.close();
    } catch {
      // The parent only needs the exit status; the DB is reopened separately.
    }
  }
}

function runBackup(mode: Mode, payload: BackupPayload): unknown {
  const store = new Store(payload.database);
  const originalSyncPath = durableFs.syncPath;
  // The backup creator canonicalizes its destination. Mirror that here so the
  // barrier compares one canonical path.
  const canonicalDestination = join(
    realpathSync(dirname(payload.destination)),
    basename(payload.destination),
  );
  const nodeFs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const originalUnlinkSync = nodeFs.unlinkSync;
  let patchedUnlink = false;
  try {
    if (mode === "backup-before-manifest") {
      const assetsPath = join(canonicalDestination, "assets");
      let fired = false;
      durableFs.syncPath = (path: string) => {
        if (
          !fired &&
          resolve(path) === resolve(assetsPath) &&
          existsSync(join(canonicalDestination, "workspace.sqlite")) &&
          !existsSync(join(canonicalDestination, "manifest.json"))
        ) {
          fired = true;
          originalSyncPath(path);
          blockAt("backup-before-manifest");
        }
        return originalSyncPath(path);
      };
    }

    if (mode === "backup-before-marker-removal") {
      // The marker is removed only after manifest publication and the shared
      // verifier pass. Stopping before that unlink leaves a fully written
      // manifest plus the guard, which must still be rejected as incomplete.
      const markerPath = join(canonicalDestination, "FOLIO-RECOVERY-INCOMPLETE");
      let fired = false;
      (nodeFs as any).unlinkSync = (path: string) => {
        if (!fired && resolve(path) === resolve(markerPath)) {
          fired = true;
          blockAt("backup-before-marker-removal");
        }
        return originalUnlinkSync(path);
      };
      patchedUnlink = true;
    }

    const result = createFullBackup(
      store.db,
      payload.source,
      payload.destination,
    );
    return {
      directory: result.directory,
      fingerprint: result.fingerprint,
      manifest: result.manifest,
    };
  } finally {
    durableFs.syncPath = originalSyncPath;
    if (patchedUnlink) (nodeFs as any).unlinkSync = originalUnlinkSync;
    try {
      store.close();
    } catch {
      // The parent reopens the source separately.
    }
  }
}

function main(): void {
  const [modeArg, payloadArg] = process.argv.slice(2);
  if (!modeArg || !MODES.has(modeArg))
    throw new Error("unknown worker mode: " + String(modeArg));
  if (!payloadArg) throw new Error("missing worker payload path");
  const mode = modeArg as Mode;
  const payload = readPayload(payloadArg);

  let outcome: unknown;
  if (mode.startsWith("page-")) {
    if (payload.kind !== "page")
      throw new Error("page worker mode requires a page payload");
    outcome = runPage(mode, payload);
  } else {
    if (payload.kind !== "backup")
      throw new Error("backup worker mode requires a backup payload");
    outcome = runBackup(mode, payload);
  }
  sendAndExit({ type: "done", result: outcome }, 0);
}

try {
  main();
} catch (error) {
  sendAndExit(
    {
      type: "error",
      message:
        error instanceof Error
          ? error.stack ?? error.message
          : String(error),
    },
    1,
  );
}
