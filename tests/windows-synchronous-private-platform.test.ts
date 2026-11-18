import { describe, expect, it } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  PosixPrivatePlatform,
  synchronousPrivatePlatform,
  WindowsPrivatePlatform,
  type PrivatePlatform,
  type WindowsPrivateNativeRuntime,
} from "../src/sync/private-platform";
import { SyncError } from "../src/sync/protocol";

const DIRECTORY = "C:\\FolioPrivate";
const LEDGER = `${DIRECTORY}\\connections.sqlite`;

function expectCode(
  work: () => unknown,
  code: string,
  status?: number,
): SyncError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe(code);
    if (status !== undefined)
      expect((error as SyncError).status).toBe(status);
    return error as SyncError;
  }
  throw new Error(`expected ${code}`);
}

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** In-memory injected native runtime; every call is recorded, nothing touches the OS. */
function fakeNativeRuntime(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const runtime = {
    bind(directory: string): string {
      calls.push("bind");
      return directory;
    },
    assertRoot(): void {
      calls.push("assertRoot");
    },
    assertFile(path: string): void {
      calls.push(`assertFile:${path === LEDGER}`);
    },
    assertSidecars(path: string): void {
      calls.push(`assertSidecars:${path === LEDGER}`);
    },
    createExclusiveDurably(path: string): void {
      calls.push(`createExclusiveDurably:${path === LEDGER}`);
    },
    assertEmptyFile(path: string): void {
      calls.push(`assertEmptyFile:${path === LEDGER}`);
    },
    close(): void {
      calls.push("close");
    },
    ...overrides,
  };
  return {
    runtime: runtime as unknown as WindowsPrivateNativeRuntime,
    mutate: runtime as unknown as Record<string, unknown>,
    calls,
  };
}

/** In-memory injected PrivatePlatform for the exported wrapper. */
function fakePlatform(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const platform = {
    kind: "windows" as const,
    bind(directory: string): string {
      calls.push("bind");
      return directory;
    },
    assertRoot(): void {
      calls.push("assertRoot");
    },
    assertFile(path: string): void {
      calls.push(`assertFile:${path === LEDGER}`);
    },
    assertSidecars(path: string): void {
      calls.push(`assertSidecars:${path === LEDGER}`);
    },
    createExclusive(path: string): void {
      calls.push(`createExclusive:${path === LEDGER}`);
    },
    assertEmptyFile(path: string): void {
      calls.push(`assertEmptyFile:${path === LEDGER}`);
    },
    close(): void {
      calls.push("close");
    },
    ...overrides,
  };
  return {
    platform: platform as unknown as PrivatePlatform,
    mutate: platform as unknown as Record<string, unknown>,
    calls,
  };
}

/** Thenable whose .then records invocations; the guard must never run it. */
function inertThenable() {
  const calls: unknown[] = [];
  const value = {
    then: (...args: unknown[]): void => {
      calls.push(args);
    },
  };
  return { value, calls };
}

const THROWING_THEN: Record<string, unknown> = {};
Object.defineProperty(THROWING_THEN, "then", {
  get() {
    throw new Error("then getter must not be accessed");
  },
});

const ASYNC_KINDS: ReadonlyArray<readonly [string, unknown]> = [
  ["async function", async () => undefined],
  [
    "generator function",
    function* () {
      yield undefined;
    },
  ],
  [
    "async generator function",
    async function* () {
      yield undefined;
    },
  ],
];

/** Class provider with real private state to prove the receiver is preserved. */
class InMemoryPrivatePort {
  readonly kind = "windows" as const;
  readonly calls: string[] = [];
  #root: string | undefined;
  #files = new Set<string>();
  #closed = false;

  #assertOpen(): void {
    if (this.#closed) throw new SyncError("fixture-closed", 409);
  }

  #assertBound(): void {
    if (this.#root === undefined) throw new SyncError("fixture-unbound", 409);
  }

  bind(directory: string): string {
    this.#assertOpen();
    this.calls.push("bind");
    this.#root = directory;
    return directory;
  }

  assertRoot(): void {
    this.#assertOpen();
    this.#assertBound();
    this.calls.push("assertRoot");
  }

  assertFile(path: string): void {
    this.#assertOpen();
    this.#assertBound();
    if (!this.#files.has(path))
      throw new SyncError("fixture-missing-file", 409);
    this.calls.push("assertFile");
  }

  assertSidecars(path: string): void {
    this.#assertOpen();
    this.#assertBound();
    this.calls.push("assertSidecars");
  }

  createExclusive(path: string): void {
    this.#assertOpen();
    this.#assertBound();
    this.#files.add(path);
    this.calls.push("createExclusive");
  }

  createExclusiveDurably(path: string): void {
    this.createExclusive(path);
  }

  assertEmptyFile(path: string): void {
    this.#assertOpen();
    this.#assertBound();
    if (!this.#files.has(path))
      throw new SyncError("fixture-missing-file", 409);
    this.calls.push("assertEmptyFile");
  }

  close(): void {
    this.calls.push("close");
    this.#closed = true;
    this.#files.clear();
    this.#root = undefined;
  }
}

const NATIVE_CAPABILITIES = [
  "bind",
  "assertRoot",
  "assertFile",
  "assertSidecars",
  "createExclusiveDurably",
  "assertEmptyFile",
  "close",
] as const;

const PLATFORM_CAPABILITIES = [
  "bind",
  "assertRoot",
  "assertFile",
  "assertSidecars",
  "createExclusive",
  "assertEmptyFile",
  "close",
] as const;

describe("synchronous capability admission", () => {
  for (const [label, fn] of ASYNC_KINDS)
    for (const name of NATIVE_CAPABILITIES)
      it(`rejects a ${label} native ${name} before any provider call`, () => {
        const fake = fakeNativeRuntime({ [name]: fn });
        expectCode(
          () => new WindowsPrivatePlatform(fake.runtime),
          "private-ledger-platform-unsupported",
          503,
        );
        expect(fake.calls).toEqual([]);
      });

  for (const [label, fn] of ASYNC_KINDS)
    for (const name of PLATFORM_CAPABILITIES)
      it(`rejects a ${label} platform ${name} before any provider call`, () => {
        const fake = fakePlatform({ [name]: fn });
        expectCode(
          () => synchronousPrivatePlatform(fake.platform),
          "private-ledger-platform-unsupported",
          503,
        );
        expect(fake.calls).toEqual([]);
      });

  it("rejects a runtime with a missing capability before any call", () => {
    const fake = fakeNativeRuntime();
    delete fake.mutate.assertFile;
    expectCode(
      () => new WindowsPrivatePlatform(fake.runtime),
      "private-ledger-platform-invalid",
      503,
    );
    expect(fake.calls).toEqual([]);
  });

  it.each([null, undefined, [], "native", 7])(
    "rejects a non-object runtime %s",
    (value) => {
      expectCode(
        () =>
          new WindowsPrivatePlatform(
            value as unknown as WindowsPrivateNativeRuntime,
          ),
        "private-ledger-platform-invalid",
        503,
      );
    },
  );

  it.each([null, undefined, [], "platform", 7, { kind: "windows" }, { kind: "darwin" }])(
    "rejects a malformed platform %s",
    (value) => {
      expectCode(
        () => synchronousPrivatePlatform(value as unknown as PrivatePlatform),
        "private-ledger-platform-invalid",
        503,
      );
    },
  );

  it("rejects a method replaced with async after bind before it runs", () => {
    const fake = fakeNativeRuntime();
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    let asyncBody = false;
    fake.mutate.assertFile = async () => {
      asyncBody = true;
    };
    expectCode(
      () => platform.assertFile(LEDGER),
      "private-ledger-platform-unsupported",
      503,
    );
    expect(asyncBody).toBe(false);
  });

  it("rejects an unrelated async method before dependent proof runs", () => {
    const fake = fakeNativeRuntime();
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    let asyncClose = false;
    fake.mutate.close = async () => {
      asyncClose = true;
    };
    expectCode(
      () => platform.createExclusive(LEDGER),
      "private-ledger-platform-unsupported",
      503,
    );
    expect(asyncClose).toBe(false);
    expect(fake.calls).not.toContain("createExclusiveDurably:true");
    // Restoring synchronous capabilities (no partial work ran) lets proof run.
    fake.mutate.close = () => {
      fake.calls.push("close");
    };
    platform.createExclusive(LEDGER);
    expect(fake.calls).toContain("createExclusiveDurably:true");
  });

  it("revalidates the wrapped provider on every exported call", () => {
    const fake = fakePlatform();
    const platform = synchronousPrivatePlatform(fake.platform);
    platform.bind(DIRECTORY);
    let asyncBody = false;
    fake.mutate.createExclusive = async () => {
      asyncBody = true;
    };
    expectCode(
      () => platform.createExclusive(LEDGER),
      "private-ledger-platform-unsupported",
      503,
    );
    expect(asyncBody).toBe(false);
  });

  it("runs a legitimate sequence through WindowsPrivatePlatform with a class provider", () => {
    const port = new InMemoryPrivatePort();
    const platform = new WindowsPrivatePlatform(
      port as unknown as WindowsPrivateNativeRuntime,
    );
    expect(platform.bind(DIRECTORY)).toBe(DIRECTORY);
    platform.createExclusive(LEDGER);
    platform.assertRoot();
    platform.assertFile(LEDGER);
    platform.assertSidecars(LEDGER);
    platform.assertEmptyFile(LEDGER);
    platform.close();
    platform.close();
    expect(port.calls.filter((call) => call === "close")).toHaveLength(1);
    expectCode(() => platform.assertRoot(), "private-ledger-closed", 409);
  });

  it("returns one frozen facade per provider and wraps idempotently", () => {
    const port = new InMemoryPrivatePort();
    const wrapped = synchronousPrivatePlatform(port);
    expect(synchronousPrivatePlatform(port)).toBe(wrapped);
    expect(synchronousPrivatePlatform(wrapped)).toBe(wrapped);
    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(wrapped.kind).toBe("windows");
    expect(wrapped.bind(DIRECTORY)).toBe(DIRECTORY);
    wrapped.assertRoot();
    wrapped.createExclusive(LEDGER);
    wrapped.assertFile(LEDGER);
    wrapped.assertSidecars(LEDGER);
    wrapped.assertEmptyFile(LEDGER);
    wrapped.close();
    wrapped.close();
    expect(port.calls.filter((call) => call === "close")).toHaveLength(1);
    expectCode(() => wrapped.assertRoot(), "private-ledger-closed", 409);
  });

  it("wraps the real POSIX class without touching the filesystem", () => {
    const wrapped = synchronousPrivatePlatform(new PosixPrivatePlatform());
    expect(wrapped.kind).toBe("posix");
    wrapped.close();
    wrapped.close();
    expectCode(() => wrapped.bind(DIRECTORY), "private-ledger-closed", 409);
  });
});

describe("malformed synchronous results poison proof calls", () => {
  const VOID_CALLS: ReadonlyArray<
    readonly [string, (platform: WindowsPrivatePlatform) => void]
  > = [
    ["assertRoot", (platform) => platform.assertRoot()],
    ["assertFile", (platform) => platform.assertFile(LEDGER)],
    ["assertSidecars", (platform) => platform.assertSidecars(LEDGER)],
    [
      "createExclusiveDurably",
      (platform) => platform.createExclusive(LEDGER),
    ],
    ["assertEmptyFile", (platform) => platform.assertEmptyFile(LEDGER)],
  ];

  for (const [name, call] of VOID_CALLS)
    it(`rejects a thenable returned by ${name} without executing .then`, () => {
      const thenable = inertThenable();
      const dependent: string[] = [];
      const fake = fakeNativeRuntime({
        [name]: () => {
          dependent.push(name);
          return thenable.value;
        },
      });
      const platform = new WindowsPrivatePlatform(fake.runtime);
      platform.bind(DIRECTORY);
      const first = expectCode(
        () => call(platform),
        "private-ledger-platform-unknown",
        503,
      );
      expect(thenable.calls).toEqual([]);
      expect(dependent).toEqual([name]);
      // Repairing the provider cannot re-authorize proof or create retries.
      fake.mutate[name] = () => {
        dependent.push(`${name}:repaired`);
      };
      const second = expectCode(
        () => call(platform),
        "private-ledger-platform-unknown",
        503,
      );
      expect(second).toBe(first);
      expectCode(
        () => platform.createExclusive(LEDGER),
        "private-ledger-platform-unknown",
        503,
      );
      expect(dependent).toEqual([name]);
    });

  it("rejects a thenable function without executing it", () => {
    const thenCalls: unknown[] = [];
    const thenFn = Object.assign(() => undefined, {
      then: (...args: unknown[]): void => {
        thenCalls.push(args);
      },
    });
    const fake = fakeNativeRuntime({ assertRoot: () => thenFn });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
      503,
    );
    expect(thenCalls).toEqual([]);
  });

  it("rejects a result whose .then getter throws, without accessing it", () => {
    const fake = fakeNativeRuntime({ assertRoot: () => THROWING_THEN });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    const error = expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
      503,
    );
    expect(error.message).not.toContain("then getter");
  });

  it.each<[string, () => unknown]>([
    ["thenable", () => inertThenable().value],
    ["empty string", () => ""],
    ["number", () => 7],
    ["object", () => ({ path: DIRECTORY })],
  ])("rejects a malformed bind result (%s) and poisons binding", (_label, result) => {
    let binds = 0;
    const fake = fakeNativeRuntime({
      bind: () => {
        binds++;
        return result();
      },
    });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    expectCode(
      () => platform.bind(DIRECTORY),
      "private-ledger-platform-unknown",
      503,
    );
    expect(binds).toBe(1);
    expectCode(
      () => platform.bind(DIRECTORY),
      "private-ledger-platform-unknown",
      503,
    );
    expect(binds).toBe(1);
    expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
      503,
    );
  });

  it.each<[string, unknown]>([
    ["number", 42],
    ["string", "done"],
    ["plain object", { ok: true }],
    ["false", false],
  ])("rejects a nonthenable %s returned by a void method", (_label, result) => {
    const fake = fakeNativeRuntime({ assertEmptyFile: () => result });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.assertEmptyFile(LEDGER),
      "private-ledger-platform-unknown",
      503,
    );
  });

  it("poisons the exported wrapper on a malformed void result", () => {
    const fake = fakePlatform({
      createExclusive: () => ({ leaked: true }),
    });
    const platform = synchronousPrivatePlatform(fake.platform);
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.createExclusive(LEDGER),
      "private-ledger-platform-unknown",
      503,
    );
    fake.mutate.createExclusive = () => {};
    expectCode(
      () => platform.createExclusive(LEDGER),
      "private-ledger-platform-unknown",
      503,
    );
    platform.close();
    expect(fake.calls).toContain("close");
    expectCode(() => platform.assertRoot(), "private-ledger-closed", 409);
  });
});

describe("native Promise results", () => {
  it("consumes a rejected Promise via the intrinsic without unhandled rejection", async () => {
    const observed: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      observed.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const sentinel = new Error("late native rejection");
      const shadowCalls: unknown[] = [];
      const rejected = Promise.reject(sentinel);
      // An own .then shadow proves the captured intrinsic is used instead.
      Object.defineProperty(rejected, "then", {
        configurable: true,
        value: (...args: unknown[]): void => {
          shadowCalls.push(args);
        },
      });
      const fake = fakeNativeRuntime({ assertRoot: () => rejected });
      const platform = new WindowsPrivatePlatform(fake.runtime);
      platform.bind(DIRECTORY);
      expectCode(
        () => platform.assertRoot(),
        "private-ledger-platform-unknown",
        503,
      );
      expect(shadowCalls).toEqual([]);
      await flushMicrotasks();
      await flushMicrotasks();
      expect(observed).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("handles deferred and fulfilled Promise results safely", async () => {
    const observed: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      observed.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectDeferred!: (reason?: unknown) => void;
      const deferred = new Promise<unknown>((_resolve, reject) => {
        rejectDeferred = reject;
      });
      const fake = fakeNativeRuntime({ assertRoot: () => deferred });
      const platform = new WindowsPrivatePlatform(fake.runtime);
      platform.bind(DIRECTORY);
      expectCode(
        () => platform.assertRoot(),
        "private-ledger-platform-unknown",
        503,
      );
      rejectDeferred(new Error("deferred rejection"));

      const resolved = fakeNativeRuntime({
        assertRoot: () => Promise.resolve("done"),
      });
      const resolvedPlatform = new WindowsPrivatePlatform(resolved.runtime);
      resolvedPlatform.bind(DIRECTORY);
      expectCode(
        () => resolvedPlatform.assertRoot(),
        "private-ledger-platform-unknown",
        503,
      );
      await flushMicrotasks();
      await flushMicrotasks();
      expect(observed).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("never assimilates an arbitrary thenable", async () => {
    const thenable = inertThenable();
    const fake = fakeNativeRuntime({ assertRoot: () => thenable.value });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
      503,
    );
    await flushMicrotasks();
    expect(thenable.calls).toEqual([]);
  });
});

describe("cleanup and poisoning interplay", () => {
  it("permits close before bind", () => {
    const fake = fakeNativeRuntime();
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.close();
    platform.close();
    expect(fake.calls).toEqual(["close"]);
  });

  it("runs a synchronous close once after an unknown proof", () => {
    const fake = fakeNativeRuntime({ assertRoot: () => ({ leaked: true }) });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
      503,
    );
    platform.close();
    platform.close();
    expect(fake.calls).toEqual(["bind", "close"]);
    expectCode(() => platform.assertRoot(), "private-ledger-closed", 409);
  });

  it("lets cleanup run even while an unrelated proof method is invalid", () => {
    const fake = fakeNativeRuntime({ assertRoot: () => 1 });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
      503,
    );
    fake.mutate.assertFile = async () => {};
    fake.mutate.createExclusiveDurably = "not a function";
    platform.close();
    expect(fake.calls).toContain("close");
    expectCode(() => platform.assertRoot(), "private-ledger-closed", 409);
  });

  it("rejects a known async close before it executes", () => {
    const fake = fakeNativeRuntime();
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    let asyncClose = false;
    fake.mutate.close = async () => {
      asyncClose = true;
    };
    expectCode(
      () => platform.close(),
      "private-ledger-platform-unsupported",
      503,
    );
    expect(asyncClose).toBe(false);
  });

  it.each(["native", "wrapped"] as const)(
    "keeps an unknown %s close failed without ever reinvoking it",
    (boundary) => {
      let closes = 0;
      const overrides = {
        close: () => {
          closes++;
          return { unexpected: true };
        },
      };
      const platform =
        boundary === "native"
          ? new WindowsPrivatePlatform(fakeNativeRuntime(overrides).runtime)
          : synchronousPrivatePlatform(fakePlatform(overrides).platform);
      platform.bind(DIRECTORY);
      const first = expectCode(
        () => platform.close(),
        "private-ledger-platform-unknown",
        503,
      );
      expect(closes).toBe(1);
      // Neither another cleanup call nor another proof can turn UNKNOWN into success.
      expectCode(
        () => platform.assertRoot(),
        "private-ledger-platform-unknown",
        503,
      );
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          expectCode(
            () => platform.close(),
            "private-ledger-platform-unknown",
            503,
          ),
        ).toBe(first);
      expect(closes).toBe(1);
      expectCode(
        () => platform.assertRoot(),
        "private-ledger-platform-unknown",
        503,
      );
    },
  );

  it("keeps a synchronous cleanup throw retriable with identity preserved", () => {
    const sentinel = new SyncError("native-close-failed", 503);
    let closes = 0;
    const fake = fakeNativeRuntime({
      close: () => {
        closes++;
        if (closes === 1) throw sentinel;
      },
    });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    try {
      platform.close();
      throw new Error("close did not throw");
    } catch (error) {
      expect(error).toBe(sentinel);
    }
    expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
      503,
    );
    platform.close();
    platform.close();
    expect(closes).toBe(2);
  });
});

describe("native error mapping and uncertainty", () => {
  it.each([
    "WINDOWS_PRIVATE_CREATE_UNKNOWN",
    "WINDOWS_PRIVATE_OPEN_UNKNOWN",
    "WINDOWS_PRIVATE_DIRECTORY_UNKNOWN",
  ])("keeps %s at status 503 and poisons retries", (code) => {
    let creates = 0;
    const fake = fakeNativeRuntime({
      createExclusiveDurably: () => {
        creates++;
        throw new CollaborationError(code);
      },
    });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    const error = expectCode(
      () => platform.createExclusive(LEDGER),
      code,
      503,
    );
    expect(error).toBeInstanceOf(SyncError);
    // Uncertain creation is never retried against the provider.
    expectCode(
      () => platform.createExclusive(LEDGER),
      "private-ledger-platform-unknown",
      503,
    );
    expectCode(
      () => platform.assertRoot(),
      "private-ledger-platform-unknown",
      503,
    );
    expect(creates).toBe(1);
  });

  it("preserves a 503 SyncError thrown natively with identity", () => {
    const sentinel = new SyncError("windows-private-create-uncertain", 503);
    let creates = 0;
    const fake = fakeNativeRuntime({
      createExclusiveDurably: () => {
        creates++;
        throw sentinel;
      },
    });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    try {
      platform.createExclusive(LEDGER);
      throw new Error("createExclusive did not throw");
    } catch (error) {
      expect(error).toBe(sentinel);
    }
    expectCode(
      () => platform.createExclusive(LEDGER),
      "private-ledger-platform-unknown",
      503,
    );
    expect(creates).toBe(1);
  });

  it("keeps a 409 native validation error retriable and unpoisoned", () => {
    const sentinel = new SyncError("windows-private-file-changed", 409);
    let asserts = 0;
    const fake = fakeNativeRuntime({
      assertFile: () => {
        asserts++;
        if (asserts === 1) throw sentinel;
      },
    });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    platform.bind(DIRECTORY);
    try {
      platform.assertFile(LEDGER);
      throw new Error("assertFile did not throw");
    } catch (error) {
      expect(error).toBe(sentinel);
    }
    platform.assertFile(LEDGER);
    platform.createExclusive(LEDGER);
    expect(asserts).toBe(2);
    expect(fake.calls).toContain("createExclusiveDurably:true");
  });

  it("maps a non-uncertain native CollaborationError to 409 without poison", () => {
    let binds = 0;
    const fake = fakeNativeRuntime({
      bind: (directory: string) => {
        binds++;
        if (binds === 1) throw new CollaborationError("WINDOWS_DATABASE_PATH");
        return directory;
      },
    });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    expectCode(() => platform.bind(DIRECTORY), "WINDOWS_DATABASE_PATH", 409);
    expect(platform.bind(DIRECTORY)).toBe(DIRECTORY);
    expect(binds).toBe(2);
  });

  it("preserves a synchronous sentinel thrown through the exported wrapper", () => {
    const sentinel = new Error("provider failure");
    const fake = fakePlatform({
      assertRoot: () => {
        throw sentinel;
      },
    });
    const platform = synchronousPrivatePlatform(fake.platform);
    platform.bind(DIRECTORY);
    try {
      platform.assertRoot();
      throw new Error("assertRoot did not throw");
    } catch (error) {
      expect(error).toBe(sentinel);
    }
    expectCode(
      () => platform.assertFile(LEDGER),
      "private-ledger-platform-unknown",
      503,
    );
  });

  it("preserves a 409 SyncError through the wrapper without poisoning", () => {
    const sentinel = new SyncError("private-ledger-unsafe", 409);
    let asserts = 0;
    const fake = fakePlatform({
      assertFile: () => {
        asserts++;
        if (asserts === 1) throw sentinel;
      },
    });
    const platform = synchronousPrivatePlatform(fake.platform);
    platform.bind(DIRECTORY);
    try {
      platform.assertFile(LEDGER);
      throw new Error("assertFile did not throw");
    } catch (error) {
      expect(error).toBe(sentinel);
    }
    platform.assertFile(LEDGER);
    expect(asserts).toBe(2);
  });
});
