import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedDemo } from "../scripts/r7-demo-seed";
import { Store } from "../src/persistence/store";
import { WorkspaceBackupService } from "../src/main/workspace-backup-service";
import { launchRestoredWorkspace, type RestoredWorkspaceSpawn } from "../src/main/private-workspace-launch";
import { createPrivatePersistenceLifecycle } from "../src/main/private-persistence-lifecycle";
import { retainStartupProtector, startupHasRetainedNativeLease } from "../src/persistence/startup-connection-owner";
import type { NativePrivateSqliteLease } from "../src/platform/private-persistence";
import type { NativeMaintenance, PreparedRestoreHandoff } from "../src/main/windows-maintenance-selection";

// Contract-only: a fake EventEmitter child is injected — no real spawn ever runs.
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {for (const s of stores.splice(0)) s.close(); for (const p of roots.splice(0)) rmSync(p, {recursive: true, force: true});});

type FakeChild = EventEmitter & {unref: () => void; unrefCalls: number};
const fakeSpawn = (behavior: {syncThrow?: unknown; emit?: "spawn" | "error" | "none"; errorValue?: unknown; unref?: () => void} = {}) => {
  const child = new EventEmitter() as FakeChild;
  child.unrefCalls = 0;
  child.unref = () => {child.unrefCalls++; behavior.unref?.();};
  const calls: {executable: string; args: readonly string[]; env: NodeJS.ProcessEnv; detached: boolean; stdio: string}[] = [];
  const spawn: RestoredWorkspaceSpawn = (executable, args, options) => {
    calls.push({executable, args, env: options.env, detached: options.detached, stdio: options.stdio});
    if ("syncThrow" in behavior) throw behavior.syncThrow;
    queueMicrotask(() => {
      if (behavior.emit === "error") child.emit("error", behavior.errorValue);
      else if (behavior.emit !== "none") child.emit("spawn");
    });
    return child;
  };
  return {spawn, calls, child};
};

const PARENT_ENV: NodeJS.ProcessEnv = {
  PARENT: "1", FOLIO_SYNC_TOKEN: "secret", FOLIO_DEV_URL: "http://x",
  FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES: "1", FOLIO_WINDOWS_OUTPUT_PARENT: "C:\\out",
};

const launchWith = (fake: ReturnType<typeof fakeSpawn>) =>
  (directory: string, handoff: PreparedRestoreHandoff | undefined, markStarted?: () => void) =>
    launchRestoredWorkspace({directory, handoff, markStarted,
      parentEnv: {...PARENT_ENV}, executable: "exe", args: ["--mode", "restored"], spawn: fake.spawn});

function fixture(native?: NativeMaintenance) {
  const root = mkdtempSync(join(tmpdir(), "folio-c04-launch-")); roots.push(root);
  const source = join(root, "source"); mkdirSync(source);
  seedDemo(join(source, "workspace.sqlite"), undefined, resolve("tests/fixtures/image.png"));
  const store = new Store(join(source, "workspace.sqlite")); stores.push(store);
  const service = new WorkspaceBackupService(store.db, source, {}, undefined, undefined, native);
  const chosen = service.choose(service.create().directory);
  const restored = service.restore(chosen.ticket, root);
  return {root, service, ticket: restored.ticket, directory: restored.directory};
}

const handoff = (overrides: Partial<PreparedRestoreHandoff> = {}): PreparedRestoreHandoff => ({
  childEnvironment: env => ({...env, FOLIO_DATA_DIR: "restored", FOLIO_SYNC_SESSION: "leak"}),
  assertCurrent: () => {},
  close: () => {},
  ...overrides,
});
const maintenance = (h: PreparedRestoreHandoff, faults: {prepare?: () => never} = {}): NativeMaintenance => ({
  withScope: (_request, _current, work) => work(),
  admitOrphan: () => {throw new Error("unused");},
  withOrphan: work => work(),
  prepareRestored: (_verified, _current, _ticket) => faults.prepare ? faults.prepare() : h,
  checkRestored: (_h, _current) => {},
});

describe("restored workspace launch observation (contract-only, no OS spawn)", () => {
  it("returns RETURNED with the started fact, unref exactly once, filtered env, once-only ticket", async () => {
    const fake = fakeSpawn();
    const f = fixture();
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal).toEqual({terminal: "RETURNED", value: undefined, launchStarted: true});
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].detached).toBe(true);
    expect(fake.calls[0].stdio).toBe("ignore");
    expect(fake.child.unrefCalls).toBe(1);
    const env = fake.calls[0].env;
    expect(env.FOLIO_DATA_DIR).toBe(f.directory);
    expect(env.PARENT).toBe("1");
    expect(Object.keys(env).some(key => key.toUpperCase().startsWith("FOLIO_SYNC_"))).toBe(false);
    expect("FOLIO_DEV_URL" in env || "FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES" in env || "FOLIO_WINDOWS_OUTPUT_PARENT" in env).toBe(false);
    const retry = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(retry.terminal).toBe("THREW");
    expect(retry.launchStarted).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("blocks a failed POSIX launch without a second spawn", async () => {
    const primary = new Error("spawn-refused");
    const fake = fakeSpawn({syncThrow: primary});
    const f = fixture();
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal.terminal).toBe("THREW");
    if (terminal.terminal !== "THREW") return;
    expect(terminal.value).toBe(primary);
    expect(terminal.launchStarted).toBe(true);
    const retry = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(retry.terminal).toBe("THREW");
    expect(retry.launchStarted).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("preserves the exact primitive thrown value", async () => {
    const fake = fakeSpawn({syncThrow: "primitive-launch-failure"});
    const f = fixture();
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal.terminal).toBe("THREW");
    expect(terminal.launchStarted).toBe(true);
    if (terminal.terminal === "THREW") expect(terminal.value).toBe("primitive-launch-failure");
  });

  it("reports started when the child emits error after dispatch", async () => {
    const failure = new Error("exec-failed");
    const fake = fakeSpawn({emit: "error", errorValue: failure});
    const f = fixture();
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal.terminal).toBe("THREW");
    expect(terminal.launchStarted).toBe(true);
    if (terminal.terminal === "THREW") expect(terminal.value).toBe(failure);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects a throwing unref instead of leaking it (ACK failure)", async () => {
    const ack = new Error("unref-ack-failed");
    const fake = fakeSpawn({unref: () => {throw ack;}});
    const f = fixture();
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal.terminal).toBe("THREW");
    expect(terminal.launchStarted).toBe(true);
    if (terminal.terminal === "THREW") expect(terminal.value).toBe(ack);
    expect(fake.child.unrefCalls).toBe(1);
  });

  it("reports not-started for native prepare, child environment and currency failures", async () => {
    const prepareFault = new Error("prepare-refused");
    const envFault = new Error("child-env-refused");
    const currencyFault = new Error("stale-handoff");
    for (const [build, expected] of [
      [() => maintenance(handoff(), {prepare: () => {throw prepareFault;}}), prepareFault],
      [() => maintenance(handoff({childEnvironment: () => {throw envFault;}})), envFault],
      [() => maintenance(handoff({assertCurrent: () => {throw currencyFault;}})), currencyFault],
    ] as const) {
      const fake = fakeSpawn();
      const f = fixture(build());
      const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
      expect(terminal.terminal).toBe("THREW");
      expect(terminal.launchStarted).toBe(false);
      if (terminal.terminal === "THREW") expect(terminal.value).toBe(expected);
      const retry = await f.service.openObserved(f.ticket, launchWith(fake));
      expect(retry.terminal).toBe("THREW");
      expect(retry.launchStarted).toBe(false);
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("launches through the handoff environment with sync state filtered", async () => {
    const fake = fakeSpawn();
    const f = fixture(maintenance(handoff()));
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal).toEqual({terminal: "RETURNED", value: undefined, launchStarted: true});
    expect(fake.calls).toHaveLength(1);
    expect(fake.child.unrefCalls).toBe(1);
    const env = fake.calls[0].env;
    expect(env.FOLIO_DATA_DIR).toBe("restored");
    expect(Object.keys(env).some(key => key.toUpperCase().startsWith("FOLIO_SYNC_"))).toBe(false);
  });

  it("throws the exact cleanup error when handoff close fails after a started launch", async () => {
    const cleanup = new Error("handoff-close-failed");
    const f = fixture(maintenance(handoff({close: () => {throw cleanup;}})));
    const fake = fakeSpawn();
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal.terminal).toBe("THREW");
    expect(terminal.launchStarted).toBe(true);
    if (terminal.terminal === "THREW") expect(terminal.value).toBe(cleanup);
    expect(fake.child.unrefCalls).toBe(1);
  });

  it("aggregates the exact launch failure and retained close error; lifecycle holds it", async () => {
    const primary = new Error("child-refused");
    let retained: unknown;
    try {retainStartupProtector({} as NativePrivateSqliteLease, [new Error("lease-close")]);}
    catch (error) {retained = error;}
    const f = fixture(maintenance(handoff({close: () => {throw retained;}})));
    const fake = fakeSpawn({emit: "error", errorValue: primary});
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal.terminal).toBe("THREW");
    expect(terminal.launchStarted).toBe(true);
    if (terminal.terminal !== "THREW") return;
    const value = terminal.value;
    expect(value).toBeInstanceOf(AggregateError);
    expect((value as AggregateError).errors).toEqual([primary, retained]);
    expect(startupHasRetainedNativeLease(value)).toBe(true);
    const life = createPrivatePersistenceLifecycle();
    life.observe(value);
    expect(life.isUsable()).toBe(false);
    expect(life.retainedFailure()).toBe(value);
    expect(() => life.run(() => 1)).toThrow("resources remain held");
  });

  it("keeps capacity-code-only aggregates without positive owner proof", async () => {
    const primary = new Error("launch-refused");
    const unknown = new AggregateError([new Error("WINDOWS_RECOVERY_ARCHIVE_CAPACITY")], "UNKNOWN cleanup outcome");
    const f = fixture(maintenance(handoff({close: () => {throw unknown;}})));
    const fake = fakeSpawn({emit: "error", errorValue: primary});
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal.terminal).toBe("THREW");
    if (terminal.terminal !== "THREW") return;
    expect((terminal.value as AggregateError).errors).toEqual([primary, unknown]);
    expect(startupHasRetainedNativeLease(terminal.value)).toBe(false);
  });

  it("ignores marks arriving after terminal finalization", async () => {
    let leaked: (() => void) | undefined;
    const f = fixture();
    const terminal = await f.service.openObserved(f.ticket,
      async (_directory, _handoff, markStarted) => {leaked = markStarted; throw new Error("pre-spawn");});
    expect(terminal.terminal).toBe("THREW");
    expect(terminal.launchStarted).toBe(false);
    leaked?.();
    expect(terminal.launchStarted).toBe(false);
  });

  it("legacy open rethrows the exact thrown value", async () => {
    const primary = new Error("exact");
    const fake = fakeSpawn({syncThrow: primary});
    const f = fixture();
    let caught: unknown;
    try {await f.service.open(f.ticket, launchWith(fake));} catch (error) {caught = error;}
    expect(caught).toBe(primary);
  });

  it.each([undefined, null, false, 0, ""])("preserves falsy primitive thrown value %s", async (primitive) => {
    const fake = fakeSpawn({syncThrow: primitive});
    const f = fixture();
    const terminal = await f.service.openObserved(f.ticket, launchWith(fake));
    expect(terminal.terminal).toBe("THREW");
    expect(terminal.launchStarted).toBe(true);
    if (terminal.terminal === "THREW") expect(terminal.value).toBe(primitive);
    expect(fake.calls).toHaveLength(1);
    const second = fakeSpawn({syncThrow: primitive});
    const f2 = fixture();
    let caught: unknown;
    try { await f2.service.open(f2.ticket, launchWith(second)); } catch (error) { caught = error; }
    expect(caught).toBe(primitive);
  });
});
