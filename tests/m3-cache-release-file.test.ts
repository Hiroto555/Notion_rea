import { createHash, randomUUID } from "node:crypto";
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
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReleaseFilePin } from "../src/sync/cache-release-types";
import {
  pinReleaseFile,
  trashReleaseFile,
  unlinkReleaseTrash,
} from "../src/sync/cache-release-file";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-m3-release-file-")),
  );
  roots.push(root);
  return root;
}

function partialName(): string {
  return createHash("sha256").update(randomUUID()).digest("hex") + ".part";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writePartial(root: string, name: string, value: string): string {
  const path = join(root, name);
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

function trashPath(root: string, operationId: string): string {
  return join(root, `.release-${operationId}.part`);
}

function errorCode(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  throw new Error("expected rejection");
}

function expectStale(callback: () => unknown): void {
  expect(errorCode(callback)).toBe("cache-release-stale");
}

describe("cache release file primitive", () => {
  it("pins, trashes and unlinks only the owned partial", () => {
    const root = makeRoot();
    const name = partialName();
    expect(pinReleaseFile(root, name)).toBeNull();

    const original = writePartial(root, name, "payload");
    const pin = pinReleaseFile(root, name);
    expect(pin).not.toBeNull();
    expect(pin).toMatchObject({ size: 7, sha256: sha256("payload") });

    const operationId = randomUUID();
    expect(unlinkReleaseTrash(root, operationId, pin!)).toBe("absent");
    expect(trashReleaseFile(root, name, operationId, pin!)).toBe("trashed");
    expect(existsSync(original)).toBe(false);
    expect(readFileSync(trashPath(root, operationId), "utf8")).toBe("payload");
    expect(unlinkReleaseTrash(root, operationId, pin!)).toBe("removed");
    expect(unlinkReleaseTrash(root, operationId, pin!)).toBe("absent");
  });

  it("rejects a ticket whose hash or size no longer matches", () => {
    const root = makeRoot();
    const name = partialName();
    const original = writePartial(root, name, "payload");
    const pin = pinReleaseFile(root, name)!;
    const operationId = randomUUID();

    expectStale(() =>
      trashReleaseFile(root, name, operationId, {
        ...pin,
        sha256: sha256("other"),
      }),
    );
    expectStale(() =>
      trashReleaseFile(root, name, operationId, { ...pin, size: pin.size + 1 }),
    );
    expect(readFileSync(original, "utf8")).toBe("payload");
    expect(existsSync(trashPath(root, operationId))).toBe(false);
  });

  it("rejects an in-place prefix change and a replaced file", () => {
    const root = makeRoot();
    const name = partialName();
    const original = writePartial(root, name, "payload");
    const pin = pinReleaseFile(root, name)!;
    const operationId = randomUUID();

    writeFileSync(original, "Xayload", { mode: 0o600 });
    expectStale(() => trashReleaseFile(root, name, operationId, pin));
    expect(readFileSync(original, "utf8")).toBe("Xayload");
    expect(existsSync(trashPath(root, operationId))).toBe(false);

    unlinkSync(original);
    writePartial(root, name, "payload");
    expectStale(() => trashReleaseFile(root, name, operationId, pin));
    expect(readFileSync(original, "utf8")).toBe("payload");
    expect(existsSync(trashPath(root, operationId))).toBe(false);
  });

  it("keeps a foreign trash file and the original untouched", () => {
    const root = makeRoot();
    const name = partialName();
    const original = writePartial(root, name, "payload");
    const pin = pinReleaseFile(root, name)!;
    const operationId = randomUUID();
    const foreign = trashPath(root, operationId);
    writeFileSync(foreign, "foreign", { mode: 0o600 });

    expectStale(() => trashReleaseFile(root, name, operationId, pin));
    expect(readFileSync(original, "utf8")).toBe("payload");
    expect(readFileSync(foreign, "utf8")).toBe("foreign");
  });

  it("completes a hardlink publication window and its resume", () => {
    const root = makeRoot();
    const name = partialName();
    const original = writePartial(root, name, "payload");
    const pin = pinReleaseFile(root, name)!;
    const operationId = randomUUID();
    const trash = trashPath(root, operationId);
    linkSync(original, trash);
    expect(lstatSync(original).nlink).toBe(2);

    expect(trashReleaseFile(root, name, operationId, pin)).toBe("trashed");
    expect(existsSync(original)).toBe(false);
    expect(lstatSync(trash).nlink).toBe(1);
    expect(readFileSync(trash, "utf8")).toBe("payload");
    expect(trashReleaseFile(root, name, operationId, pin)).toBe("trashed");
  });

  it("rejects unknown extra links instead of guessing ownership", () => {
    const root = makeRoot();
    const name = partialName();
    const original = writePartial(root, name, "payload");
    const pin = pinReleaseFile(root, name)!;
    const operationId = randomUUID();
    const trash = trashPath(root, operationId);
    const extra = join(root, "extra-link");
    linkSync(original, trash);
    linkSync(original, extra);

    expectStale(() => trashReleaseFile(root, name, operationId, pin));
    expect(lstatSync(original).nlink).toBe(3);
    expect(readFileSync(trash, "utf8")).toBe("payload");
    expect(readFileSync(extra, "utf8")).toBe("payload");
  });

  it("rejects symlinked, non-private and wrong-identity roots", () => {
    const parent = makeRoot();
    const target = join(parent, "target");
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
    const name = partialName();
    writePartial(target, name, "payload");
    const linked = join(parent, "linked");
    symlinkSync(target, linked);
    expectStale(() => pinReleaseFile(linked, name));

    const open = join(parent, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    writePartial(open, name, "payload");
    expectStale(() => pinReleaseFile(open, name));

    const moved = join(parent, "moved");
    const replacement = join(parent, "replacement");
    mkdirSync(moved, { mode: 0o700 });
    mkdirSync(replacement, { mode: 0o700 });
    writePartial(moved, name, "payload");
    const pin = pinReleaseFile(moved, name)!;
    rmSync(moved, { recursive: true, force: true });
    symlinkSync(replacement, moved);
    expectStale(() => trashReleaseFile(moved, name, randomUUID(), pin));
  });

  it("is deterministic across kill windows and unlink is idempotent", () => {
    const root = makeRoot();
    const name = partialName();
    const original = writePartial(root, name, "payload");
    const pin = pinReleaseFile(root, name)!;
    const operationId = randomUUID();
    const trash = trashPath(root, operationId);

    linkSync(original, trash);
    expect(trashReleaseFile(root, name, operationId, pin)).toBe("trashed");
    unlinkSync(trash);
    expect(trashReleaseFile(root, name, operationId, pin)).toBe("absent");
    expect(unlinkReleaseTrash(root, operationId, pin)).toBe("absent");

    const secondName = partialName();
    const secondOriginal = writePartial(root, secondName, "second");
    const secondPin = pinReleaseFile(root, secondName)!;
    const secondOperation = randomUUID();
    expect(
      trashReleaseFile(root, secondName, secondOperation, secondPin),
    ).toBe("trashed");
    const secondTrash = trashPath(root, secondOperation);
    expect(unlinkReleaseTrash(root, secondOperation, secondPin)).toBe("removed");
    expect(existsSync(secondTrash)).toBe(false);
    expect(unlinkReleaseTrash(root, secondOperation, secondPin)).toBe("absent");
  });

  it("validates the trash itself before unlinking it", () => {
    const root = makeRoot();
    const name = partialName();
    writePartial(root, name, "payload");
    const pin = pinReleaseFile(root, name)!;
    const operationId = randomUUID();
    expect(trashReleaseFile(root, name, operationId, pin)).toBe("trashed");
    const trash = trashPath(root, operationId);
    writeFileSync(trash, "XLyload", { mode: 0o600 });

    expectStale(() => unlinkReleaseTrash(root, operationId, pin));
    expect(existsSync(trash)).toBe(true);
    expect(unlinkReleaseTrash(root, randomUUID(), pin)).toBe("absent");
    expect(existsSync(trash)).toBe(true);
  });
});
