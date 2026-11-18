import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { preflightExistingJournal } from "../src/sync/journal-preflight";
import { PrivateLedger } from "../src/sync/private-ledger";
import { SyncTransportJournal } from "../src/sync/transport-journal";
import {
  synchronousPrivatePlatform,
  WindowsPrivatePlatform,
  type PrivatePlatform,
  type WindowsPrivateNativeRuntime,
} from "../src/sync/private-platform";
import { SyncError } from "../src/sync/protocol";

// Contract-only coverage: the injected snapshot capability copies through
// ordinary Node I/O on disposable temp roots. It exercises the preflight,
// guard and call-site semantics; it is NOT Windows OS/filesystem acceptance.
const SUFFIXES = ["", "-journal", "-wal", "-shm"] as const;
const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-native-preflight-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

function expectCode(work: () => unknown, code: string): SyncError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe(code);
    return error as SyncError;
  }
  throw new Error(`expected ${code}`);
}

/** A real hot rollback journal: main + -journal copied mid-transaction. */
function makeHotJournalCopy(
  sourceMain: string,
  targetMain: string,
  mutateSql: string,
): { journalPath: string } {
  const staging = join(tempRoot(), "staging.sqlite");
  copyFileSync(sourceMain, staging);
  const writer = new DatabaseSync(staging);
  try {
    writer.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; PRAGMA cache_spill=ON; PRAGMA synchronous=FULL;",
    );
    writer.exec("BEGIN IMMEDIATE");
    writer.exec(mutateSql);
    // A one-row change can leave an uninitialized rollback header entirely
    // cached. Force actual page spill, then prove error 776 on the copy.
    writer.exec("CREATE TABLE _hot_spill(payload BLOB); INSERT INTO _hot_spill VALUES(zeroblob(131072))");
    expect(lstatSync(staging + "-journal").size).toBeGreaterThan(0);
    copyFileSync(staging, targetMain);
    copyFileSync(staging + "-journal", targetMain + "-journal");
    chmodSync(targetMain, 0o600);
    chmodSync(targetMain + "-journal", 0o600);
    writer.exec("ROLLBACK");
  } finally {
    writer.close();
  }
  return { journalPath: targetMain + "-journal" };
}

/** Prove the copy actually needs hot-journal recovery (errcode 776). */
function expectReadonlyRollback(path: string): void {
  let errcode: number | undefined;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.prepare("SELECT name FROM sqlite_master").all();
    } finally {
      try {
        db.close();
      } catch {}
    }
  } catch (error) {
    errcode = (error as { errcode?: number }).errcode;
  }
  expect(errcode).toBe(776);
}

type SourceVersion = Map<string, { present: boolean; bytes?: Buffer }>;

function readSources(path: string): SourceVersion {
  const version: SourceVersion = new Map();
  for (const suffix of SUFFIXES) {
    try {
      version.set(suffix, {
        present: true,
        bytes: Buffer.from(readFileSync(path + suffix)),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        version.set(suffix, { present: false });
        continue;
      }
      throw error;
    }
  }
  return version;
}

function expectSameSources(before: SourceVersion, after: SourceVersion): void {
  for (const suffix of SUFFIXES) {
    const left = before.get(suffix)!;
    const right = after.get(suffix)!;
    expect(right.present).toBe(left.present);
    if (left.present) expect(right.bytes!.equals(left.bytes!)).toBe(true);
  }
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Contract-faithful injected capability: captures source identity + bytes,
 * copies every present source into a disposable private directory, runs the
 * callback on the working copy only, then rechecks identity and hashes.
 */
function snapshotBehavior(calls: string[]) {
  return (path: string, callback: (snapshotPath: string) => void): void => {
    calls.push("withHotJournalSnapshot");
    const directory = tempRoot();
    const before = readSources(path);
    const hashes = new Map<string, string>();
    for (const [suffix, entry] of before)
      if (entry.present) hashes.set(suffix, sha(entry.bytes!));
    for (const suffix of SUFFIXES) {
      if (!before.get(suffix)!.present) continue;
      copyFileSync(path + suffix, join(directory, "snapshot.sqlite" + suffix));
      chmodSync(join(directory, "snapshot.sqlite" + suffix), 0o600);
    }
    callback(join(directory, "snapshot.sqlite"));
    const after = readSources(path);
    expectSameSources(before, after);
    for (const [suffix, entry] of after)
      if (entry.present) expect(sha(entry.bytes!)).toBe(hashes.get(suffix));
  };
}

function fakePlatform(
  calls: string[],
  overrides: Record<string, unknown> = {},
): PrivatePlatform {
  const pinned = new Map<string, { dev: number; ino: number }>();
  const base = {
    kind: "windows" as const,
    bind(directory: string): string {
      calls.push("bind");
      return directory;
    },
    assertRoot(): void {
      calls.push("assertRoot");
    },
    assertFile(path: string): void {
      calls.push("assertFile");
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new SyncError("windows-fake-file-unsafe", 409);
      const pin = pinned.get(path);
      if (pin === undefined) pinned.set(path, { dev: stat.dev, ino: stat.ino });
      else if (stat.dev !== pin.dev || stat.ino !== pin.ino)
        throw new SyncError("windows-fake-file-changed", 409);
    },
    assertSidecars(path: string): void {
      calls.push("assertSidecars");
      for (const suffix of SUFFIXES) {
        if (suffix === "") continue;
        let stat;
        try {
          stat = lstatSync(path + suffix);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600
        )
          throw new SyncError("windows-fake-sidecar-unsafe", 409);
      }
    },
    createExclusive(path: string): void {
      calls.push("createExclusive");
      try {
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      chmodSync(path, 0o600);
    },
    assertEmptyFile(path: string): void {
      calls.push("assertEmptyFile");
      if (lstatSync(path).size !== 0)
        throw new SyncError("windows-fake-not-empty", 409);
    },
    close(): void {
      calls.push("close");
    },
  };
  return { ...base, ...overrides } as unknown as PrivatePlatform;
}

function fakeRuntime(
  calls: string[],
  overrides: Record<string, unknown> = {},
): WindowsPrivateNativeRuntime {
  const platform = fakePlatform(calls, overrides) as unknown as Record<
    string,
    unknown
  >;
  return {
    bind: platform.bind as (directory: string) => string,
    assertRoot: platform.assertRoot as () => void,
    assertFile: platform.assertFile as (path: string) => void,
    assertSidecars: platform.assertSidecars as (path: string) => void,
    createExclusiveDurably: platform.createExclusive as (path: string) => void,
    assertEmptyFile: platform.assertEmptyFile as (path: string) => void,
    ...(platform.withHotJournalSnapshot !== undefined
      ? {
          withHotJournalSnapshot: platform.withHotJournalSnapshot as (
            path: string,
            callback: (snapshotPath: string) => void,
          ) => void,
        }
      : {}),
    close: platform.close as () => void,
  } as WindowsPrivateNativeRuntime;
}

function seedLedger(
  directory: string,
  name: string,
  role: string,
  key: string,
  value: string,
): string {
  const ledger = new PrivateLedger(directory, name, role);
  ledger.transaction(() => ledger.write(key, value));
  ledger.close();
  return join(directory, name);
}

describe("journal preflight native hot snapshot (contract only, not Windows OS acceptance)", () => {
  it("recovers a hot rollback journal through an injected windows snapshot capability", () => {
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    const targetMain = join(target, "state.sqlite");
    makeHotJournalCopy(
      sourceMain,
      targetMain,
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    expectReadonlyRollback(targetMain);
    const before = readSources(targetMain);
    const calls: string[] = [];
    const platform = fakePlatform(calls, {
      withHotJournalSnapshot: snapshotBehavior(calls),
    });
    const validated: string[] = [];
    preflightExistingJournal(
      targetMain,
      () => {
        calls.push("assertPath");
      },
      (db) => {
        const identity = db
          .prepare("SELECT role FROM m3_private_identity")
          .all();
        expect(identity.length).toBe(1);
        expect(identity[0].role).toBe("connections");
        validated.push("ok");
      },
      platform,
    );
    expect(validated).toEqual(["ok"]);
    expect(calls).toContain("withHotJournalSnapshot");
    // The original stays byte-for-byte: preflight never opened it writable.
    expectSameSources(before, readSources(targetMain));
  });

  it("PrivateLedger recovers the correct role via the snapshot and keeps retained state", () => {
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    makeHotJournalCopy(
      sourceMain,
      join(target, "state.sqlite"),
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    const calls: string[] = [];
    const platform = fakePlatform(calls, {
      withHotJournalSnapshot: snapshotBehavior(calls),
    });
    const ledger = new PrivateLedger(
      target,
      "state.sqlite",
      "connections",
      [],
      platform,
    );
    expect(ledger.read("raw:one")).toBe("original");
    ledger.close();
    expect(calls).toContain("withHotJournalSnapshot");
    expect(calls).toContain("close");
  });

  it("PrivateLedger wrong role preserves source main AND journal byte-for-byte", () => {
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    const { journalPath } = makeHotJournalCopy(
      sourceMain,
      join(target, "state.sqlite"),
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    const before = readSources(join(target, "state.sqlite"));
    const calls: string[] = [];
    const platform = fakePlatform(calls, {
      withHotJournalSnapshot: snapshotBehavior(calls),
    });
    expectCode(
      () => new PrivateLedger(target, "state.sqlite", "other-role", [], platform),
      "private-ledger-invalid",
    );
    expect(existsSync(journalPath)).toBe(true);
    expectSameSources(before, readSources(join(target, "state.sqlite")));
    expect(calls).toContain("close");
  });

  it("rejects a snapshot working copy that does not contain the real source", () => {
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    const { journalPath } = makeHotJournalCopy(
      sourceMain,
      join(target, "state.sqlite"),
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    const before = readSources(join(target, "state.sqlite"));
    // A foreign database posed as the working copy must fail semantic proof;
    // the source and its hot journal are never recovered or replaced.
    const foreign = seedLedger(tempRoot(), "state.sqlite", "other-role", "k", "v");
    const calls: string[] = [];
    const platform = fakePlatform(calls, {
      withHotJournalSnapshot: (path: string, callback: (p: string) => void) => {
        calls.push("withHotJournalSnapshot");
        const directory = tempRoot();
        copyFileSync(foreign, join(directory, "snapshot.sqlite"));
        callback(join(directory, "snapshot.sqlite"));
      },
    });
    expectCode(
      () => new PrivateLedger(target, "state.sqlite", "connections", [], platform),
      "private-ledger-invalid",
    );
    expect(existsSync(journalPath)).toBe(true);
    expectSameSources(before, readSources(join(target, "state.sqlite")));
  });

  it("SyncTransportJournal recovers the correct binding via the snapshot", () => {
    const source = tempRoot();
    const sourcePath = join(source, "transport.sqlite");
    const seed = new SyncTransportJournal({
      path: sourcePath,
      workspaceId: "ws-hot",
      clientId: "device-1",
      bindingId: "binding-1",
    });
    seed.close();
    const target = tempRoot();
    const targetPath = join(target, "transport.sqlite");
    makeHotJournalCopy(
      sourcePath,
      targetPath,
      "UPDATE transport_identity SET received_cursor=received_cursor+1",
    );
    expectReadonlyRollback(targetPath);
    const calls: string[] = [];
    const platform = fakePlatform(calls, {
      withHotJournalSnapshot: snapshotBehavior(calls),
    });
    const journal = new SyncTransportJournal({
      path: targetPath,
      workspaceId: "ws-hot",
      clientId: "device-1",
      bindingId: "binding-1",
      platformAdapter: platform,
    });
    journal.close();
    expect(calls).toContain("withHotJournalSnapshot");
    expect(calls).toContain("close");
  });

  it("SyncTransportJournal wrong binding preserves source main AND journal byte-for-byte", () => {
    const source = tempRoot();
    const sourcePath = join(source, "transport.sqlite");
    const seed = new SyncTransportJournal({
      path: sourcePath,
      workspaceId: "ws-hot",
      clientId: "device-1",
      bindingId: "binding-1",
    });
    seed.close();
    const target = tempRoot();
    const targetPath = join(target, "transport.sqlite");
    const { journalPath } = makeHotJournalCopy(
      sourcePath,
      targetPath,
      "UPDATE transport_identity SET received_cursor=received_cursor+1",
    );
    const before = readSources(targetPath);
    const calls: string[] = [];
    const platform = fakePlatform(calls, {
      withHotJournalSnapshot: snapshotBehavior(calls),
    });
    expectCode(
      () =>
        new SyncTransportJournal({
          path: targetPath,
          workspaceId: "ws-hot",
          clientId: "device-1",
          bindingId: "other-binding",
          platformAdapter: platform,
        }),
      "journal-binding-mismatch",
    );
    expect(existsSync(journalPath)).toBe(true);
    expectSameSources(before, readSources(targetPath));
    expect(calls).toContain("close");
  });

  it("windows platform without the capability fails closed, never a POSIX fallback", () => {
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    makeHotJournalCopy(
      sourceMain,
      join(target, "state.sqlite"),
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    const before = readSources(join(target, "state.sqlite"));
    const calls: string[] = [];
    const platform = fakePlatform(calls); // no withHotJournalSnapshot
    expect(() =>
      new PrivateLedger(target, "state.sqlite", "connections", [], platform),
    ).toThrow("Windows hot-journal private copy is unavailable");
    expectSameSources(before, readSources(join(target, "state.sqlite")));
    expect(calls).not.toContain("withHotJournalSnapshot");
  });

  it("non-776 failures never reach the snapshot capability", () => {
    const target = tempRoot();
    const targetMain = seedLedger(
      target,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const calls: string[] = [];
    const platform = fakePlatform(calls, {
      withHotJournalSnapshot: snapshotBehavior(calls),
    });
    // Readonly open succeeds (no hot journal); the role failure is not 776.
    expectCode(
      () => new PrivateLedger(target, "state.sqlite", "wrong-role", [], platform),
      "private-ledger-invalid",
    );
    expect(calls).not.toContain("withHotJournalSnapshot");
    expect(existsSync(targetMain + "-journal")).toBe(false);
  });

  it("routes the capability through WindowsPrivatePlatform + facade (double guard)", () => {
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    makeHotJournalCopy(
      sourceMain,
      join(target, "state.sqlite"),
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    const calls: string[] = [];
    const runtime = fakeRuntime(calls, {
      withHotJournalSnapshot: snapshotBehavior(calls),
    });
    const wrapped = new WindowsPrivatePlatform(runtime);
    expect(typeof wrapped.withHotJournalSnapshot).toBe("function");
    const ledger = new PrivateLedger(
      target,
      "state.sqlite",
      "connections",
      [],
      synchronousPrivatePlatform(wrapped),
    );
    expect(ledger.read("raw:one")).toBe("original");
    ledger.close();
    expect(calls).toContain("withHotJournalSnapshot");
  });

  it("WindowsPrivatePlatform without the capability never exposes it", () => {
    const calls: string[] = [];
    const wrapped = new WindowsPrivatePlatform(fakeRuntime(calls));
    expect(wrapped.withHotJournalSnapshot).toBeUndefined();
    const facade = synchronousPrivatePlatform(wrapped);
    expect(facade.withHotJournalSnapshot).toBeUndefined();
  });
});

describe("snapshot capability protocol enforcement (contract only)", () => {
  const snapshotPlatform = (
    calls: string[],
    behavior: unknown,
  ): PrivatePlatform =>
    fakePlatform(calls, { withHotJournalSnapshot: behavior });

  function openWithHotCopy(
    platform: PrivatePlatform,
    role = "connections",
  ): () => PrivateLedger {
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    makeHotJournalCopy(
      sourceMain,
      join(target, "state.sqlite"),
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    return () => new PrivateLedger(target, "state.sqlite", role, [], platform);
  }

  it("rejects an async or generator capability at wrapping, before bind", () => {
    const calls: string[] = [];
    for (const fn of [
      async () => undefined,
      function* () {
        yield undefined;
      },
    ]) {
      expectCode(
        () =>
          new WindowsPrivatePlatform(
            fakeRuntime(calls, { withHotJournalSnapshot: fn }),
          ),
        "private-ledger-platform-unsupported",
      );
    }
  });

  it("poisons permanently when the capability is mutated async after wrapping", () => {
    const calls: string[] = [];
    const provider = snapshotPlatform(calls, () => undefined) as unknown as Record<
      string,
      unknown
    >;
    const platform = synchronousPrivatePlatform(
      provider as unknown as PrivatePlatform,
    );
    provider.withHotJournalSnapshot = async () => undefined;
    const first = expectCode(
      () => platform.withHotJournalSnapshot!("x", () => {}),
      "private-ledger-platform-unsupported",
    );
    void first;
    // The stable poison persists: same SyncError identity on every later call.
    const second = expectCode(
      () => platform.withHotJournalSnapshot!("x", () => {}),
      "private-ledger-platform-unknown",
    );
    const third = expectCode(
      () => platform.withHotJournalSnapshot!("x", () => {}),
      "private-ledger-platform-unknown",
    );
    expect(third).toBe(second);
    // The same stable poison refuses the whole ledger-construction path.
    expectCode(openWithHotCopy(platform), "private-ledger-platform-unknown");
    platform.close();
  });

  it("poisons when the provider never invokes the callback", () => {
    const calls: string[] = [];
    const platform = synchronousPrivatePlatform(
      snapshotPlatform(calls, () => undefined),
    );
    const first = expectCode(
      () => platform.withHotJournalSnapshot!("x", () => {}),
      "private-ledger-platform-unknown",
    );
    const second = expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
    );
    // One stable poison object answers every later proof.
    expect(second).toBe(first);
    expectCode(openWithHotCopy(platform), "private-ledger-platform-unknown");
    platform.close();
  });

  it("poisons when the provider invokes the callback twice", () => {
    const calls: string[] = [];
    const platform = synchronousPrivatePlatform(
      snapshotPlatform(
        calls,
        (path: string, callback: (p: string) => void) => {
          const directory = tempRoot();
          const before = readSources(path);
          for (const suffix of SUFFIXES)
            if (before.get(suffix)!.present) {
              copyFileSync(path + suffix, join(directory, "snapshot.sqlite" + suffix));
              chmodSync(join(directory, "snapshot.sqlite" + suffix), 0o600);
            }
          callback(join(directory, "snapshot.sqlite")); // first: valid
          callback(join(directory, "snapshot.sqlite")); // second: poison
        },
      ),
    );
    const open = openWithHotCopy(platform);
    expectCode(open, "private-ledger-platform-unknown");
    platform.close();
  });

  it("a stored callback fired after return never runs semantic work and poisons", () => {
    const calls: string[] = [];
    let stored: ((p: string) => void) | undefined;
    const platform = synchronousPrivatePlatform(
      snapshotPlatform(calls, (path: string, callback: (p: string) => void) => {
        stored = callback;
        const directory = tempRoot();
        const before = readSources(path);
        for (const suffix of SUFFIXES)
          if (before.get(suffix)!.present) {
            copyFileSync(path + suffix, join(directory, "snapshot.sqlite" + suffix));
            chmodSync(join(directory, "snapshot.sqlite" + suffix), 0o600);
          }
        callback(join(directory, "snapshot.sqlite"));
      }),
    );
    const open = openWithHotCopy(platform);
    const ledger = open();
    // The late call must be rejected by the guard before any semantic work.
    expect(() => stored!("/forged")).toThrow(SyncError);
    expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
    );
    ledger.close();
  });

  it("poisons when the provider returns a Promise or a non-undefined ack", () => {
    const calls: string[] = [];
    for (const result of [
      Promise.resolve(undefined),
      1,
      (function* () {
        yield 1;
      })(),
    ]) {
      const platform = synchronousPrivatePlatform(
        snapshotPlatform(calls, () => result),
      );
      const open = openWithHotCopy(platform);
      expectCode(open, "private-ledger-platform-unknown");
      platform.close();
    }
  });

  it("never runs an arbitrary thenable's .then while poisoning the provider", () => {
    const calls: string[] = [];
    let thenCalls = 0;
    const thenable = {
      then: () => {
        thenCalls++;
      },
    };
    const platform = synchronousPrivatePlatform(
      snapshotPlatform(calls, () => thenable),
    );
    const open = openWithHotCopy(platform);
    expectCode(open, "private-ledger-platform-unknown");
    expect(thenCalls).toBe(0);
    platform.close();
  });

  it("poisons on a malformed snapshot path or non-undefined callback ack", () => {
    const calls: string[] = [];
    // snapshotPath equal to the source is malformed.
    const samePath = synchronousPrivatePlatform(
      snapshotPlatform(calls, (path: string, callback: (p: string) => void) => {
        callback(path);
      }),
    );
    expectCode(openWithHotCopy(samePath), "private-ledger-platform-unknown");
    // An empty snapshot path is malformed.
    const emptyPath = synchronousPrivatePlatform(
      snapshotPlatform(calls, (path: string, callback: (p: string) => void) => {
        callback("");
      }),
    );
    expectCode(openWithHotCopy(emptyPath), "private-ledger-platform-unknown");
    // A callback that acknowledges with a non-undefined result poisons.
    const ack = synchronousPrivatePlatform(
      snapshotPlatform(calls, (path: string, callback: (p: string) => void) => {
        callback(join(tempRoot(), "snapshot.sqlite"));
      }),
    );
    expectCode(
      () =>
        ack.withHotJournalSnapshot!("C:\\Folio\\state.sqlite", () => 1),
      "private-ledger-platform-unknown",
    );
  });

  it("preserves a semantic callback failure even when the provider swallows it", () => {
    const calls: string[] = [];
    const semantic = new SyncError("semantic-callback-failure", 409);
    const platform = synchronousPrivatePlatform(
      snapshotPlatform(
        calls,
        (path: string, callback: (p: string) => void) => {
          const directory = tempRoot();
          const before = readSources(path);
          for (const suffix of SUFFIXES)
            if (before.get(suffix)!.present) {
              copyFileSync(path + suffix, join(directory, "snapshot.sqlite" + suffix));
              chmodSync(join(directory, "snapshot.sqlite" + suffix), 0o600);
            }
          try {
            callback(join(directory, "snapshot.sqlite"));
          } catch {
            // Provider swallows: the semantic failure must still surface.
          }
          return undefined;
        },
      ),
    );
    let observed: unknown;
    try {
      const source = tempRoot();
      const sourceMain = seedLedger(
        source,
        "state.sqlite",
        "connections",
        "raw:one",
        "original",
      );
      const target = tempRoot();
      makeHotJournalCopy(
        sourceMain,
        join(target, "state.sqlite"),
        "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
      );
      preflightExistingJournal(
        join(target, "state.sqlite"),
        () => {},
        () => {
          throw semantic;
        },
        platform,
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(semantic);
    // A semantic callback failure is not provider fault: no poison.
    expect(() => platform.assertRoot()).not.toThrow();
    platform.close();
  });

  it("keeps the semantic error and poisons when identity mutates after the callback", () => {
    const calls: string[] = [];
    const semantic = new SyncError("semantic-callback-failure", 409);
    let nativeVisits = 0;
    const platform = synchronousPrivatePlatform(
      snapshotPlatform(
        calls,
        (path: string, callback: (p: string) => void) => {
          nativeVisits++;
          const directory = tempRoot();
          const before = readSources(path);
          for (const suffix of SUFFIXES)
            if (before.get(suffix)!.present) {
              copyFileSync(path + suffix, join(directory, "snapshot.sqlite" + suffix));
              chmodSync(join(directory, "snapshot.sqlite" + suffix), 0o600);
            }
          try {
            callback(join(directory, "snapshot.sqlite"));
          } catch {
            // swallowed below
          }
          const after = readSources(path);
          expectSameSources(before, after); // throws: evidence of mutation
        },
      ),
    );
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    const targetMain = join(target, "state.sqlite");
    makeHotJournalCopy(
      sourceMain,
      targetMain,
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    const mainBefore = Buffer.from(readFileSync(targetMain));
    const journalBefore = Buffer.from(readFileSync(targetMain + "-journal"));
    let observed: unknown;
    try {
      preflightExistingJournal(
        targetMain,
        () => {},
        () => {
          // Mutating the source inside the semantic callback must surface as
          // evidence, not be reinterpreted as a clean retry signal.
          writeFileSync(targetMain, Buffer.from("mutated"), { mode: 0o600 });
          chmodSync(targetMain, 0o600);
          throw semantic;
        },
        platform,
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(semantic);
    expect(nativeVisits).toBe(1); // The assertion must exercise the native guard.
    // Restore the bytes so the temp root cleanup stays valid.
    writeFileSync(targetMain, mainBefore, { mode: 0o600 });
    writeFileSync(targetMain + "-journal", journalBefore, { mode: 0o600 });
    expect(() => platform.assertRoot()).toThrow(SyncError);
    platform.close();
  });

  it("closes the callback window even when the provider throws before calling it", () => {
    let saved: ((path: string) => void) | undefined;
    let semanticCalls = 0;
    const cause = new SyncError("source-identity-changed", 409);
    const platform = synchronousPrivatePlatform(snapshotPlatform([], (_path: string, callback: (path: string) => void) => {
      saved = callback;
      throw cause;
    }));
    expect(() => platform.withHotJournalSnapshot!("C:\\Private\\state.sqlite", () => { semanticCalls++; })).toThrow(cause);
    expectCode(() => saved!("C:\\Private\\copy.sqlite"), "private-ledger-platform-unknown");
    expect(semanticCalls).toBe(0);
    expectCode(() => platform.assertRoot(), "private-ledger-platform-unknown");
    platform.close();
  });

  it("does not let WindowsPrivatePlatform hide an async callback or malformed return", () => {
    for (const knownAsync of [true, false]) {
      let entered = 0, nativeCalls = 0;
      const platform = new WindowsPrivatePlatform(fakeRuntime([], {
        withHotJournalSnapshot(_path: string, callback: (path: string) => void) {
          nativeCalls++;
          callback("C:\\Private\\copy.sqlite");
        },
      }));
      platform.bind(tempRoot());
      const callback = knownAsync
        ? async () => { entered++; }
        : () => { entered++; return 1; };
      expectCode(() => platform.withHotJournalSnapshot!("C:\\Private\\state.sqlite", callback),
        knownAsync ? "private-ledger-platform-invalid" : "private-ledger-platform-unknown");
      expect(nativeCalls).toBe(knownAsync ? 0 : 1);
      expect(entered).toBe(knownAsync ? 0 : 1);
      expectCode(() => platform.assertRoot(), "private-ledger-platform-unknown");
      platform.close();
    }
  });

  it("preserves undefined semantic throws even when the provider swallows them", () => {
    const platform = synchronousPrivatePlatform(snapshotPlatform([], (_path: string, callback: (path: string) => void) => {
      try { callback("C:\\Private\\copy.sqlite"); } catch {}
    }));
    let caught = false;
    try { platform.withHotJournalSnapshot!("C:\\Private\\state.sqlite", () => { throw undefined; }); }
    catch (error) { caught = true; expect(error).toBeUndefined(); }
    expect(caught).toBe(true);
    platform.close();
  });

  it("retains a provider cleanup aggregate after a semantic failure through both guards", () => {
    const semantic = new SyncError("wrong-role", 409), cleanup = new Error("snapshot close failed");
    const aggregate = new AggregateError([semantic, cleanup], "semantic and cleanup");
    const native = new WindowsPrivatePlatform(fakeRuntime([], {
      withHotJournalSnapshot(_path: string, callback: (path: string) => void) {
        try { callback("C:\\Private\\copy.sqlite"); } catch { throw aggregate; }
      },
    }));
    const platform = synchronousPrivatePlatform(native);
    platform.bind(tempRoot());
    let actual: unknown;
    try { platform.withHotJournalSnapshot!("C:\\Private\\state.sqlite", () => { throw semantic; }); }
    catch (error) { actual = error; }
    expect(actual).toBe(aggregate);
    expect((actual as AggregateError).errors).toEqual([semantic, cleanup]);
    expectCode(() => platform.assertRoot(), "private-ledger-platform-unknown");
    platform.close();
  });

  it("cannot return success after a caught snapshot reentry", () => {
    const platform = synchronousPrivatePlatform(snapshotPlatform([], (_path: string, callback: (path: string) => void) => {
      callback("C:\\Private\\copy.sqlite");
    }));
    expectCode(() => platform.withHotJournalSnapshot!("C:\\Private\\state.sqlite", () => {
      try { platform.withHotJournalSnapshot!("C:\\Private\\state.sqlite", () => {}); } catch {}
    }), "private-ledger-platform-unknown");
    platform.close();
  });

  it("poisons a post-snapshot source-proof failure even when classified as 409", () => {
    let changed = false;
    const cause = new SyncError("source-identity-changed", 409);
    const platform = synchronousPrivatePlatform(fakePlatform([], {
      withHotJournalSnapshot(_path: string, callback: (path: string) => void) { callback("C:\\Private\\copy.sqlite"); },
      assertRoot() { if (changed) throw cause; },
    }));
    platform.withHotJournalSnapshot!("C:\\Private\\state.sqlite", () => {});
    changed = true;
    expect(() => platform.assertRoot()).toThrow(cause);
    changed = false;
    expectCode(() => platform.assertRoot(), "private-ledger-platform-unknown");
    platform.close();
  });

  it("aggregates the semantic failure and the snapshot close failure", () => {
    const calls: string[] = [];
    const semantic = new SyncError("semantic-callback-failure", 409);
    const platform = synchronousPrivatePlatform(
      snapshotPlatform(
        calls,
        (path: string, callback: (p: string) => void) => {
          const directory = tempRoot();
          const before = readSources(path);
          for (const suffix of SUFFIXES)
            if (before.get(suffix)!.present) {
              copyFileSync(path + suffix, join(directory, "snapshot.sqlite" + suffix));
              chmodSync(join(directory, "snapshot.sqlite" + suffix), 0o600);
            }
          callback(join(directory, "snapshot.sqlite"));
        },
      ),
    );
    const source = tempRoot();
    const sourceMain = seedLedger(
      source,
      "state.sqlite",
      "connections",
      "raw:one",
      "original",
    );
    const target = tempRoot();
    const targetMain = join(target, "state.sqlite");
    makeHotJournalCopy(
      sourceMain,
      targetMain,
      "UPDATE m3_private_records SET value='uncommitted' WHERE key='raw:one'",
    );
    let observed: unknown;
    try {
      preflightExistingJournal(
        targetMain,
        () => {},
        (db) => {
          db.close(); // force the finally close to fail as the second cause
          throw semantic;
        },
        platform,
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    const aggregate = observed as AggregateError;
    expect(aggregate.errors[0]).toBe(semantic);
    expect(aggregate.errors.length).toBe(2);
  });
});
