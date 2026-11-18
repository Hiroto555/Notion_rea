import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import type { Attempt, Command } from "../src/collaboration/runtime/contract";
const document = {
  schemaVersion: 1,
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [{ type: "text", text: "abc" }],
    },
    {
      type: "paragraph",
      attrs: { id: "p2" },
      content: [{ type: "text", text: "xyz" }],
    },
  ],
};
describe("real shared authority integration", () => {
  it("commits latest block move and concurrent KEEP in its original block; deduplicates and reopens", () => {
    const root = mkdtempSync(join(tmpdir(), "folio-runtime-"));
    let server: SharedAuthority | undefined;
    try {
      server = new SharedAuthority(root);
      const first = server.bootstrap({
        orgId: "org",
        userId: "alice",
        deviceId: "device-a",
        workspaceId: "space",
        documentId: "page",
        document,
      });
      const invite = server.invite(first.token, "org", "bob");
      const second = server.acceptInvite(invite, "device-b");
      server.grant(first.token, first.scope, "bob", "editor");
      const base = server.head();
      const attempt = (writerId: string, command: Command): Attempt => ({
        v: 1,
        attemptId: randomUUID(),
        base,
        intent: {
          v: 1,
          intentId: randomUUID(),
          writerId,
          scope: first.scope,
          base,
          command,
        },
      });
      const move = attempt(first.auth.writerId, {
        kind: "block.move",
        blockId: "p1",
        parentId: null,
        beforeId: null,
      });
      expect(server.submit(first.token, move).status).toBe("SERVER_ACCEPTED");
      const text = attempt(second.auth.writerId, {
        kind: "text",
        blockId: "p1",
        from: 1,
        to: 1,
        text: "KEEP",
        before: "abc",
      });
      const receipt = server.submit(second.token, text);
      expect(receipt.status).toBe("SERVER_ACCEPTED");
      expect(server.submit(second.token, text)).toEqual(receipt);
      const snap = server.snapshot(second.token, first.scope);
      expect(snap.state.document.content?.map((n) => n.attrs?.id)).toEqual([
        "p2",
        "p1",
      ]);
      expect(snap.state.document.content?.[1].content?.[0].text).toBe(
        "aKEEPbc",
      );
      server.verify();
      server.close();
      server = new SharedAuthority(root);
      expect(server.receipt(second.token, text)).toEqual(receipt);
      expect(server.snapshot(second.token, first.scope).cut).toEqual(snap.cut);
    } finally {
      server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
