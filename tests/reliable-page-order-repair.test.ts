import { expect, it, vi } from "vitest";
import { sendPageOrderRepair } from "../src/renderer/reliable-page-order-repair";
import type { PageOrderRepairResult } from "../src/shared/page-order-repair";

const fingerprint = "a".repeat(64);
function result(status: "applied" | "rejected"): PageOrderRepairResult {
  return {
    status,
    sourceFingerprint: fingerprint,
    currentFingerprint: fingerprint,
    appliedGroups: status === "applied" ? 1 : 0,
    appliedPages: status === "applied" ? 1 : 0,
    targets: [],
    issues: [],
  };
}

it("does not send while input or the recovery checkpoint is unsaved", async () => {
  const send = vi.fn();
  const prepare = async () => {
    throw new Error("未保存の入力があります");
  };
  expect(await sendPageOrderRepair(fingerprint, prepare, send)).toEqual({
    status: "not-sent",
    message: "未保存の入力があります",
  });
  expect(send).not.toHaveBeenCalled();
});

it.each(["applied", "rejected"] as const)(
  "preserves a confirmed %s response for the reviewed fingerprint",
  async (status) => {
    const response = result(status);
    const send = vi.fn(async () => response);
    expect(await sendPageOrderRepair(fingerprint, async () => {}, send)).toBe(
      response,
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "pageOrder:apply",
      sourceFingerprint: fingerprint,
    });
  },
);

it("keeps a committed repair with a lost reply unknown and never resends automatically", async () => {
  let writes = 0;
  const send = vi.fn(async () => {
    writes++;
    throw new Error("reply lost after commit");
  });
  expect(
    await sendPageOrderRepair(fingerprint, async () => {}, send),
  ).toMatchObject({ status: "unknown" });
  expect(writes).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not accept an applied reply naming another preview", async () => {
  const send = async () => ({
    ...result("applied"),
    sourceFingerprint: "b".repeat(64),
  });
  expect(
    await sendPageOrderRepair(fingerprint, async () => {}, send),
  ).toMatchObject({ status: "unknown" });
});
