import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SyncError } from "../src/sync/protocol";
import {
  readIssuedSyncCredential,
  readServerOpsConfig,
  writeIssuedSyncCredential,
  writeServerOpsConfig,
  type IssuedSyncCredential,
  type ServerOpsConfig,
} from "../src/sync/server-ops-config";

const INVALID = "server-config-invalid";
const UNSAFE = "server-config-unsafe";
const CONFIG_FILE = "server-config.json";
const created: string[] = [];

const CONFIG: ServerOpsConfig = {
  format: "folio-server-config/v1",
  workspaceId: "workspace_1",
  ownerId: "owner_1",
  port: 8787,
};

const TOKEN = "a".repeat(32);

function makeDir(mode = 0o700): string {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-ops-")),
  );
  chmodSync(directory, mode);
  created.push(directory);
  return directory;
}

function makeSubdir(parent: string, name: string, mode = 0o700): string {
  const directory = join(parent, name);
  mkdirSync(directory, { mode });
  chmodSync(directory, mode);
  return directory;
}

function credential(
  changes: Partial<IssuedSyncCredential> = {},
): IssuedSyncCredential {
  return {
    format: "folio-sync-credential/v1",
    baseUrl: "http://127.0.0.1:8787",
    workspaceId: "workspace_1",
    clientId: "client_1",
    token: TOKEN,
    ...changes,
  };
}

function expectError(
  action: () => unknown,
  code: typeof INVALID | typeof UNSAFE,
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SyncError);
  const error = caught as SyncError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(409);
  expect(error.message).toBe(code);
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("server ops config", () => {
  it("round-trips a private config file", () => {
    const directory = makeDir();
    const path = join(directory, CONFIG_FILE);
    writeServerOpsConfig(directory, CONFIG);
    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    expect(stat.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(stat.uid).toBe(process.getuid?.());
    }
    expect(readServerOpsConfig(directory)).toEqual(CONFIG);
  });

  it("accepts both usable port boundaries", () => {
    for (const port of [1, 65_535]) {
      const directory = makeDir();
      writeServerOpsConfig(directory, { ...CONFIG, port });
      expect(readServerOpsConfig(directory).port).toBe(port);
    }
  });

  it("rejects out-of-range and non-integer ports", () => {
    const directory = makeDir();
    for (const port of [0, 65_536, -1, 1.5, Number.NaN]) {
      expectError(
        () => writeServerOpsConfig(directory, { ...CONFIG, port }),
        INVALID,
      );
    }
    expect(existsSync(join(directory, CONFIG_FILE))).toBe(false);
  });

  it("rejects malformed identifiers and formats", () => {
    const directory = makeDir();
    for (const workspaceId of ["", "-ws", "ws/1", "ws 1", "a".repeat(129)]) {
      expectError(
        () => writeServerOpsConfig(directory, { ...CONFIG, workspaceId }),
        INVALID,
      );
    }
    for (const ownerId of ["", "_owner", "owner/1", "owner 1"]) {
      expectError(
        () => writeServerOpsConfig(directory, { ...CONFIG, ownerId }),
        INVALID,
      );
    }
    expectError(
      () =>
        writeServerOpsConfig(directory, {
          ...CONFIG,
          format: "folio-server-config/v2",
        } as unknown as ServerOpsConfig),
      INVALID,
    );
  });

  it("rejects extra keys and never writes a token into the config", () => {
    const directory = makeDir();
    expectError(
      () =>
        writeServerOpsConfig(directory, {
          ...CONFIG,
          token: TOKEN,
        } as unknown as ServerOpsConfig),
      INVALID,
    );
    expect(existsSync(join(directory, CONFIG_FILE))).toBe(false);

    writeServerOpsConfig(directory, CONFIG);
    const text = readFileSync(join(directory, CONFIG_FILE), "utf8");
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual(CONFIG);
  });

  it("rejects extra, missing, or malformed config contents", () => {
    const directory = makeDir();
    const path = join(directory, CONFIG_FILE);
    for (const value of [
      { ...CONFIG, token: TOKEN },
      { format: CONFIG.format, workspaceId: CONFIG.workspaceId },
      { ...CONFIG, format: "folio-server-config/v2" },
      { ...CONFIG, port: "8787" },
      { ...CONFIG, port: 0 },
    ]) {
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      chmodSync(path, 0o600);
      expectError(() => readServerOpsConfig(directory), INVALID);
    }
    writeFileSync(path, "{", { mode: 0o600 });
    chmodSync(path, 0o600);
    expectError(() => readServerOpsConfig(directory), INVALID);
  });

  it("rejects oversized config files", () => {
    const directory = makeDir();
    const path = join(directory, CONFIG_FILE);
    writeFileSync(path, "x".repeat(4_097), { mode: 0o600 });
    chmodSync(path, 0o600);
    expectError(() => readServerOpsConfig(directory), INVALID);
  });

  it("does not create directories or overwrite an existing destination", () => {
    const parent = makeDir();
    const missing = join(parent, "nested");
    expectError(() => writeServerOpsConfig(missing, CONFIG), UNSAFE);
    expect(existsSync(missing)).toBe(false);

    const directory = makeDir();
    writeServerOpsConfig(directory, CONFIG);
    const path = join(directory, CONFIG_FILE);
    const before = readFileSync(path);
    const modeBefore = statSync(path).mode & 0o777;
    expectError(
      () => writeServerOpsConfig(directory, { ...CONFIG, port: 9090 }),
      UNSAFE,
    );
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(modeBefore);
    expect(readServerOpsConfig(directory)).toEqual(CONFIG);
  });

  it("rejects a non-private root and a symlinked root", () => {
    const open = makeDir(0o755);
    expectError(() => writeServerOpsConfig(open, CONFIG), UNSAFE);

    const privateRoot = makeDir();
    const link = join(makeDir(), "root-link");
    symlinkSync(privateRoot, link);
    expectError(() => readServerOpsConfig(link), UNSAFE);
  });

  it("rejects symbolic and hard links for the config file", () => {
    const directory = makeDir();
    const path = join(directory, CONFIG_FILE);
    const target = join(makeDir(), "target.json");
    writeFileSync(target, JSON.stringify(CONFIG), { mode: 0o600 });
    chmodSync(target, 0o600);
    symlinkSync(target, path);
    expectError(() => readServerOpsConfig(directory), UNSAFE);

    const linked = makeDir();
    writeServerOpsConfig(linked, CONFIG);
    linkSync(join(linked, CONFIG_FILE), join(linked, "alias.json"));
    expectError(() => readServerOpsConfig(linked), UNSAFE);
  });
});

describe("issued sync credential handoff", () => {
  it("round-trips a private handoff file outside forbidden roots", () => {
    const directory = makeDir();
    const forbidden = makeDir();
    const path = join(directory, "handoff.json");
    writeIssuedSyncCredential(path, credential(), [forbidden]);
    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    if (process.platform !== "win32") {
      expect(stat.uid).toBe(process.getuid?.());
    }
    expect(readIssuedSyncCredential(path)).toEqual(credential());
  });

  it("normalizes a strict loopback http origin", () => {
    const directory = makeDir();
    const path = join(directory, "handoff.json");
    const forbidden = makeDir();
    writeIssuedSyncCredential(
      path,
      credential({ baseUrl: "http://127.0.0.1:8787/" }),
      [forbidden],
    );
    expect(readIssuedSyncCredential(path).baseUrl).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("rejects non-loopback, non-http, and non-origin base URLs", () => {
    const directory = makeDir();
    const forbidden = makeDir();
    const invalid = [
      "https://127.0.0.1:8787",
      "http://localhost:8787",
      "http://192.168.1.1:8787",
      "http://user@127.0.0.1:8787",
      "http://127.0.0.1:8787/path",
      "http://127.0.0.1:8787/?query",
      "http://127.0.0.1:8787/#hash",
      "ftp://127.0.0.1:8787",
    ];
    for (const [index, baseUrl] of invalid.entries()) {
      const path = join(directory, `bad-${index}.json`);
      expectError(
        () =>
          writeIssuedSyncCredential(path, credential({ baseUrl }), [forbidden]),
        INVALID,
      );
      expect(existsSync(path)).toBe(false);
    }
  });

  it("rejects bad token shapes and extra credential keys", () => {
    const directory = makeDir();
    const forbidden = makeDir();
    for (const token of ["a".repeat(31), "a".repeat(513), "a".repeat(31) + " "]) {
      expectError(
        () =>
          writeIssuedSyncCredential(
            join(directory, "handoff.json"),
            credential({ token }),
            [forbidden],
          ),
        INVALID,
      );
    }
    expectError(
      () =>
        writeIssuedSyncCredential(
          join(directory, "handoff.json"),
          {
            ...credential(),
            extra: "value",
          } as unknown as IssuedSyncCredential,
          [forbidden],
        ),
      INVALID,
    );
    expectError(
      () =>
        writeIssuedSyncCredential(
          join(directory, "handoff.json"),
          {
            ...credential(),
            format: "folio-sync-credential/v2",
          } as unknown as IssuedSyncCredential,
          [forbidden],
        ),
      INVALID,
    );
    expect(existsSync(join(directory, "handoff.json"))).toBe(false);
  });

  it("rejects extra keys on credential read", () => {
    const directory = makeDir();
    const path = join(directory, "handoff.json");
    writeFileSync(
      path,
      JSON.stringify({ ...credential(), extra: "value" }),
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    expectError(() => readIssuedSyncCredential(path), INVALID);
  });

  it("requires forbidden roots and rejects overlap in both directions", () => {
    const parent = makeDir();
    const path = join(parent, "handoff.json");
    expectError(
      () => writeIssuedSyncCredential(path, credential(), []),
      INVALID,
    );

    const rootChild = makeSubdir(parent, "workspace");
    expectError(
      () => writeIssuedSyncCredential(path, credential(), [rootChild]),
      UNSAFE,
    );

    const outer = makeDir();
    const inner = makeSubdir(outer, "server");
    expectError(
      () =>
        writeIssuedSyncCredential(join(inner, "handoff.json"), credential(), [
          outer,
        ]),
      UNSAFE,
    );

    expectError(
      () => writeIssuedSyncCredential(path, credential(), [parent]),
      UNSAFE,
    );
    expectError(
      () => writeIssuedSyncCredential(path, credential(), [join(parent, "missing")]),
      UNSAFE,
    );
    expect(existsSync(path)).toBe(false);
  });

  it("requires a private existing parent and never creates it", () => {
    const open = makeDir(0o755);
    expectError(
      () => writeIssuedSyncCredential(join(open, "handoff.json"), credential(), [makeDir()]),
      UNSAFE,
    );
    expect(existsSync(join(open, "handoff.json"))).toBe(false);

    const parent = makeDir();
    const missing = join(parent, "nested");
    expectError(
      () => writeIssuedSyncCredential(join(missing, "handoff.json"), credential(), [makeDir()]),
      UNSAFE,
    );
    expect(existsSync(missing)).toBe(false);
  });

  it("does not overwrite an existing handoff destination", () => {
    const directory = makeDir();
    const forbidden = makeDir();
    const path = join(directory, "handoff.json");
    writeIssuedSyncCredential(path, credential(), [forbidden]);
    const before = readFileSync(path);
    const modeBefore = statSync(path).mode & 0o777;
    const other = credential({ token: "b".repeat(32), clientId: "client_2" });
    expectError(
      () => writeIssuedSyncCredential(path, other, [forbidden]),
      UNSAFE,
    );
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(modeBefore);
    expect(readIssuedSyncCredential(path)).toEqual(credential());
  });

  it("rejects wrong file modes, symbolic links, and hard links", () => {
    const directory = makeDir();
    const forbidden = makeDir();
    const path = join(directory, "handoff.json");
    writeIssuedSyncCredential(path, credential(), [forbidden]);
    chmodSync(path, 0o644);
    expectError(() => readIssuedSyncCredential(path), UNSAFE);

    const targetDirectory = makeDir();
    const target = join(targetDirectory, "target.json");
    writeIssuedSyncCredential(target, credential(), [forbidden]);
    const linkDirectory = makeDir();
    const link = join(linkDirectory, "handoff.json");
    symlinkSync(target, link);
    expectError(() => readIssuedSyncCredential(link), UNSAFE);

    const hardDirectory = makeDir();
    const hard = join(hardDirectory, "handoff.json");
    writeIssuedSyncCredential(hard, credential(), [forbidden]);
    linkSync(hard, join(hardDirectory, "alias.json"));
    expectError(() => readIssuedSyncCredential(hard), UNSAFE);
    expect(lstatSync(join(hardDirectory, "alias.json")).nlink).toBe(2);
  });

  it("rejects oversized handoff files", () => {
    const directory = makeDir();
    const path = join(directory, "handoff.json");
    writeFileSync(path, "x".repeat(4_097), { mode: 0o600 });
    chmodSync(path, 0o600);
    expectError(() => readIssuedSyncCredential(path), INVALID);
  });
});
