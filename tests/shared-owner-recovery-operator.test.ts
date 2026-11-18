import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { runRecoveryOperator } from "../src/collaboration/runtime/recovery-operator";
import { runSharedServer } from "../src/collaboration/runtime/server-entry";
import { durableFs } from "../src/persistence/durable-file";
import { SHARED_RUNTIME_FILE } from "../src/collaboration/runtime/store";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-owner-recover-")),
  );
  chmodSync(base, 0o700);
  roots.push(base);
  const root = join(base, "server"),
    secrets = join(base, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  const authority = new SharedAuthority(root);
  const boot = authority.bootstrap({
    orgId: "org",
    userId: "owner",
    deviceId: "original",
    workspaceId: "ws",
    documentId: "page",
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p" },
          content: [{ type: "text", text: "KEEP" }],
        },
      ],
    },
  });
  const cut = authority.head();
  authority.close();
  const key = join(secrets, "original.json"),
    output = join(secrets, "recovered.json");
  writeFileSync(
    key,
    JSON.stringify({ token: boot.token, recoveryKey: boot.recoveryKey }),
    { mode: 0o600 },
  );
  const args = [
    "--root",
    root,
    "--org",
    "org",
    "--recovery-key-file",
    key,
    "--device",
    "replacement",
    "--credentials-output",
    output,
  ];
  return { base, root, secrets, key, output, args, boot, cut };
}
function readCredentials(output: string): {
  token: string;
  recoveryKey: string;
} {
  return JSON.parse(readFileSync(output, "utf8"));
}
function withAuthority<T>(root: string, work: (a: SharedAuthority) => T): T {
  const a = new SharedAuthority(root);
  try {
    return work(a);
  } finally {
    a.close();
  }
}

describe("headless owner lost-device recovery operator", () => {
  it("publishes private rotated secrets, revokes old session, and keeps the current owner and document", async () => {
    const f = fixture();
    const handle = await runRecoveryOperator(f.args);
    try {
      expect(handle.state).toBe("recovered");
      expect(Object.keys(handle)).toEqual(["state", "close"]);
      const issued = readCredentials(f.output);
      expect(Object.keys(issued).sort()).toEqual(["recoveryKey", "token"]);
      expect(issued.recoveryKey).not.toBe(f.boot.recoveryKey);
      expect(issued.token).not.toBe(f.boot.token);
      expect(lstatSync(f.output).mode & 0o777).toBe(0o600);
      withAuthority(f.root, (a) => {
        expect(a.session(issued.token, "org")).toMatchObject({
          userId: "owner",
          deviceId: "replacement",
        });
        expect(a.recoveryStatus(issued.token, "org")).toEqual({
          configured: true,
        });
        expect(() => a.session(f.boot.token, "org")).toThrow();
        expect(
          a.snapshot(issued.token, f.boot.scope).state.document.content?.[0]
            .content?.[0].text,
        ).toBe("KEEP");
        expect(() =>
          a.recover("org", f.boot.recoveryKey, "cannot-use-old-key"),
        ).toThrow("RECOVERY_INVALID");
        a.verify();
      });
    } finally {
      await handle.close();
      await handle.close();
    }
  });
  it("connects the recover route through the actual shared server entry", async () => {
    const f = fixture();
    const handle = await runSharedServer(["recover", ...f.args]);
    try {
      expect(handle.state).toBe("recovered");
      expect(handle.result).toBeUndefined();
      expect(handle.url).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
  it("accepts a raw private key file without exposing a token in its result", async () => {
    const f = fixture();
    writeFileSync(f.key, f.boot.recoveryKey, { mode: 0o600 });
    const h = await runRecoveryOperator(f.args);
    try {
      expect(h.state).toBe("recovered");
    } finally {
      await h.close();
    }
  });
  it("does not create an output or mutate authority for a wrong recovery key", async () => {
    const f = fixture();
    writeFileSync(f.key, "wrong-key");
    await expect(runRecoveryOperator(f.args)).rejects.toThrow(
      "RECOVERY_INVALID",
    );
    expect(existsSync(f.output)).toBe(false);
    withAuthority(f.root, (a) => {
      expect(a.head()).toEqual(f.cut);
      expect(a.session(f.boot.token, "org").userId).toBe("owner");
    });
  });
  it("rejects a preexisting output before changing identities or its contents", async () => {
    const f = fixture();
    writeFileSync(f.output, "DO NOT TOUCH", { mode: 0o600 });
    await expect(runRecoveryOperator(f.args)).rejects.toThrow(
      "CREDENTIALS_EXIST",
    );
    expect(readFileSync(f.output, "utf8")).toBe("DO NOT TOUCH");
    withAuthority(f.root, (a) => {
      expect(a.head()).toEqual(f.cut);
      expect(a.session(f.boot.token, "org").userId).toBe("owner");
    });
  });
  it("rejects missing and foreign-format sources without creating/migrating SQLite files", async () => {
    const f = fixture(),
      missing = join(f.base, "missing");
    const args = [...f.args];
    args[1] = missing;
    await expect(runRecoveryOperator(args)).rejects.toThrow("UNSAFE_ROOT");
    expect(existsSync(missing)).toBe(false);
    const foreign = join(f.base, "foreign");
    mkdirSync(foreign, { mode: 0o700 });
    const file = join(foreign, SHARED_RUNTIME_FILE),
      db = new DatabaseSync(file);
    db.exec("CREATE TABLE private_notes(body TEXT)");
    db.close();
    chmodSync(file, 0o600);
    const before = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
    args[1] = foreign;
    await expect(runRecoveryOperator(args)).rejects.toThrow(
      "NOT_SHARED_RUNTIME_FORMAT",
    );
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(
      before,
    );
    expect(existsSync(file + "-wal")).toBe(false);
    expect(existsSync(f.output)).toBe(false);
  });
  it("retains private output and rolls back identity changes when publication fsync fails", async () => {
    const f = fixture();
    vi.spyOn(durableFs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("disk failure with no secrets");
    });
    await expect(runRecoveryOperator(f.args)).rejects.toThrow(
      "RECOVERY_UNKNOWN",
    );
    expect(existsSync(f.output)).toBe(true);
    expect(lstatSync(f.output).mode & 0o777).toBe(0o600);
    withAuthority(f.root, (a) => {
      expect(a.head()).toEqual(f.cut);
      expect(a.session(f.boot.token, "org").userId).toBe("owner");
      expect(() => a.session(readCredentials(f.output).token, "org")).toThrow();
    });
  });
  it("retains published credentials on before-COMMIT failure without committing the recovery", async () => {
    const f = fixture();
    await expect(
      runRecoveryOperator(
        f.args,
        {},
        {
          beforeCommit() {
            throw new Error("stop before commit");
          },
        },
      ),
    ).rejects.toThrow("RECOVERY_UNKNOWN");
    expect(existsSync(f.output)).toBe(true);
    withAuthority(f.root, (a) => {
      expect(a.head()).toEqual(f.cut);
      expect(a.session(f.boot.token, "org").userId).toBe("owner");
    });
  });
  it("keeps newly valid secrets when the post-COMMIT acknowledgement is lost; never retries", async () => {
    const f = fixture();
    await expect(
      runRecoveryOperator(
        f.args,
        {},
        {
          afterCommit() {
            throw new Error("lost acknowledgement");
          },
        },
      ),
    ).rejects.toThrow("RECOVERY_UNKNOWN");
    const issued = readCredentials(f.output);
    withAuthority(f.root, (a) => {
      expect(a.head().seq).toBe(f.cut.seq + 1);
      expect(a.session(issued.token, "org").userId).toBe("owner");
      expect(() => a.session(f.boot.token, "org")).toThrow();
      a.verify();
    });
    await expect(runRecoveryOperator(f.args)).rejects.toThrow(
      "CREDENTIALS_EXIST",
    );
  });
  it("refuses a loose key file and credentials inside the authority root", async () => {
    const f = fixture();
    chmodSync(f.key, 0o644);
    await expect(runRecoveryOperator(f.args)).rejects.toThrow(
      "UNSAFE_PRIVATE_FILE",
    );
    chmodSync(f.key, 0o600);
    const args = [...f.args];
    args[args.length - 1] = join(f.root, "secrets.json");
    await expect(runRecoveryOperator(args)).rejects.toThrow(
      "CREDENTIALS_INSIDE_ROOT",
    );
    expect(existsSync(args[args.length - 1])).toBe(false);
  });
});
