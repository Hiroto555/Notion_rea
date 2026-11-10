import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blankDoc } from "../src/shared/types";
import {
  CollaborationError,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { digest } from "../src/collaboration/runtime/digest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { executeSharedAdmin } from "../src/collaboration/runtime/admin";

const ORG = "org1";
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-admin-test-")),
  );
  chmodSync(directory, 0o700);
  const authority = new SharedAuthority(directory);
  cleanups.push(() => {
    try {
      authority.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const boot = authority.bootstrap({
    orgId: ORG,
    userId: "owner1",
    deviceId: "device-owner1",
    workspaceId: "ws1",
    documentId: "doc1",
    document: {
      type: "doc",
      content: [{ type: "paragraph", attrs: { id: "p1" } }],
    },
  });
  return { authority, token: boot.token, scope: boot.scope };
}

function failure(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    throw error;
  }
  throw new Error("EXPECTED_FAILURE");
}

function inviteAndAccept(
  authority: SharedAuthority,
  token: string,
  userId: string,
  deviceId: string,
): string {
  const result = executeSharedAdmin(authority, token, {
    action: "invite",
    orgId: ORG,
    userId,
  }) as { inviteToken: string };
  return authority.acceptInvite(result.inviteToken, deviceId).token;
}

describe("shared admin dispatcher", () => {
  it("executes legal organization, audit, workspace, read, invite, and backup actions", () => {
    const { authority, token, scope } = fixture();

    const organization = executeSharedAdmin(authority, token, {
      action: "organization",
      orgId: ORG,
    }) as {
      orgId: string;
      isAdministrator: boolean;
      members: string[];
      workspaces: { workspaceId: string }[];
    };
    expect(organization.orgId).toBe(ORG);
    expect(organization.isAdministrator).toBe(true);
    expect(organization.members).toEqual(["owner1"]);
    expect(organization.workspaces.map((item) => item.workspaceId)).toEqual([
      "ws1",
    ]);

    const overview = executeSharedAdmin(authority, token, {
      action: "overview",
      orgId: ORG,
    }) as { cut: { seq: number }; documents: number };
    expect(overview.cut.seq).toBeGreaterThan(0);
    expect(overview.documents).toBe(1);

    const audit = executeSharedAdmin(authority, token, {
      action: "audit",
      orgId: ORG,
      limit: 10,
    }) as { events: { seq: number }[] };
    expect(audit.events.length).toBeGreaterThan(0);
    expect(audit.events.every((event) => event.seq > 0)).toBe(true);

    expect(
      executeSharedAdmin(authority, token, {
        action: "workspaceCreate",
        orgId: ORG,
        workspaceId: "ws2",
        name: "Second workspace",
      }),
    ).toEqual({ ok: true });
    const afterCreate = executeSharedAdmin(authority, token, {
      action: "organization",
      orgId: ORG,
    }) as { workspaces: { workspaceId: string; name: string }[] };
    expect(afterCreate.workspaces).toContainEqual({
      workspaceId: "ws2",
      name: "Second workspace",
      role: "owner",
    });

    const records = executeSharedAdmin(authority, token, {
      action: "records",
      scope,
    }) as { document: { type: string } };
    expect(
      (records.document as unknown as { document: { type: string } }).document
        .type,
    ).toBe("doc");

    const history = executeSharedAdmin(authority, token, {
      action: "history",
      scope,
    }) as unknown[];
    expect(history.length).toBeGreaterThan(0);

    const search = executeSharedAdmin(authority, token, {
      action: "search",
      scope,
      query: "",
    }) as { scope: Scope }[];
    expect(search.map((item) => item.scope.documentId)).toEqual(["doc1"]);

    expect(
      executeSharedAdmin(authority, token, {
        action: "backlinks",
        scope,
      }),
    ).toEqual([]);

    const backup = executeSharedAdmin(authority, token, {
      action: "backup",
      orgId: ORG,
    }) as { format: string; records: unknown[] };
    expect(backup.format).toBe("folio-shared-runtime-backup/1");
    expect(backup.records.length).toBeGreaterThan(0);
    expect(JSON.stringify(backup)).not.toContain(token);
    expect(JSON.stringify(organization)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain(token);

    const invite = executeSharedAdmin(authority, token, {
      action: "invite",
      orgId: ORG,
      userId: "member1",
    }) as { inviteToken: string };
    expect(invite.inviteToken.length).toBeGreaterThan(0);
    expect(invite.inviteToken).not.toBe(token);
    expect(
      executeSharedAdmin(authority, token, {
        action: "cancelInvite",
        orgId: ORG,
        inviteHash: digest(invite.inviteToken),
      }),
    ).toEqual({ ok: true });
    expect(
      failure(() => authority.acceptInvite(invite.inviteToken, "device-x")),
    ).toBe("INVITE_EXPIRED");
  });

  it("keeps unshared workspaces isolated for a granted member", () => {
    const { authority, token, scope } = fixture();
    const scope2: Scope = {
      orgId: ORG,
      workspaceId: "ws2",
      documentId: "doc2",
      incarnationId: "inc2",
    };
    executeSharedAdmin(authority, token, {
      action: "workspaceCreate",
      orgId: ORG,
      workspaceId: "ws2",
      name: "Private",
    });
    expect(
      authority.createDocument(
        token,
        scope2,
        {
          type: "doc" as const,
          content: [{ type: "paragraph", attrs: { id: "p1" } }],
        },
        "Private page",
      ).status,
    ).toBe("SERVER_ACCEPTED");

    const memberToken = inviteAndAccept(
      authority,
      token,
      "member2",
      "device-member2",
    );
    expect(
      executeSharedAdmin(authority, token, {
        action: "grant",
        scope: scope2,
        userId: "member2",
        role: "viewer",
      }),
    ).toEqual({ ok: true });

    const memberRecords = executeSharedAdmin(authority, memberToken, {
      action: "records",
      scope: scope2,
    }) as { document: { type: string } };
    expect(
      (memberRecords.document as unknown as { document: { type: string } })
        .document.type,
    ).toBe("doc");
    expect(
      executeSharedAdmin(authority, memberToken, {
        action: "search",
        scope: scope2,
        query: "",
      }),
    ).toEqual([
      expect.objectContaining({
        scope: expect.objectContaining({ documentId: "doc2" }),
      }),
    ]);
    expect(
      executeSharedAdmin(authority, memberToken, {
        action: "backlinks",
        scope: scope2,
      }),
    ).toEqual([]);

    expect(
      failure(() =>
        executeSharedAdmin(authority, memberToken, {
          action: "records",
          scope,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      failure(() =>
        executeSharedAdmin(authority, memberToken, {
          action: "search",
          scope,
          query: "",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      failure(() =>
        executeSharedAdmin(authority, memberToken, {
          action: "history",
          scope,
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("revokes organization access and requires fresh authority on retry", () => {
    const { authority, token, scope } = fixture();
    const memberToken = inviteAndAccept(
      authority,
      token,
      "member3",
      "device-member3",
    );
    expect(
      executeSharedAdmin(authority, token, {
        action: "grant",
        scope,
        userId: "member3",
        role: "editor",
      }),
    ).toEqual({ ok: true });
    expect(
      executeSharedAdmin(authority, memberToken, {
        action: "records",
        scope,
      }),
    ).toBeTruthy();

    expect(
      executeSharedAdmin(authority, token, {
        action: "revokeMember",
        orgId: ORG,
        userId: "member3",
      }),
    ).toEqual({ ok: true });

    expect(
      failure(() =>
        executeSharedAdmin(authority, memberToken, {
          action: "organization",
          orgId: ORG,
        }),
      ),
    ).toBe("TOKEN_INVALID");
    expect(
      failure(() =>
        executeSharedAdmin(authority, memberToken, {
          action: "records",
          scope,
        }),
      ),
    ).toBe("TOKEN_INVALID");
    expect(
      failure(() =>
        executeSharedAdmin(authority, token, {
          action: "revokeMember",
          orgId: ORG,
          userId: "member3",
        }),
      ),
    ).toBe("TARGET_MISSING");

    const overview = executeSharedAdmin(authority, token, {
      action: "organization",
      orgId: ORG,
    }) as { members: string[] };
    expect(overview.members).toEqual(["owner1"]);
  });

  it("refuses to revoke the last owner of a workspace", () => {
    const { authority, token, scope } = fixture();
    const secondToken = inviteAndAccept(
      authority,
      token,
      "owner2",
      "device-owner2",
    );
    executeSharedAdmin(authority, token, {
      action: "grant",
      scope,
      userId: "owner2",
      role: "owner",
    });
    executeSharedAdmin(authority, token, {
      action: "handoff",
      orgId: ORG,
      userId: "owner2",
      workspaces: ["ws1"],
    });
    executeSharedAdmin(authority, secondToken, {
      action: "workspaceCreate",
      orgId: ORG,
      workspaceId: "ws2",
      name: "Owner2 workspace",
    });
    executeSharedAdmin(authority, secondToken, {
      action: "handoff",
      orgId: ORG,
      userId: "owner1",
      workspaces: ["ws1"],
    });

    expect(
      failure(() =>
        executeSharedAdmin(authority, token, {
          action: "revokeMember",
          orgId: ORG,
          userId: "owner2",
        }),
      ),
    ).toBe("LAST_OWNER");

    const overview = executeSharedAdmin(authority, token, {
      action: "organization",
      orgId: ORG,
    }) as { members: string[]; isAdministrator: boolean };
    expect(overview.isAdministrator).toBe(true);
    expect(overview.members).toContain("owner2");
  });

  it("rejects unknown fields and invalid values before any change", () => {
    const { authority, token } = fixture();
    const before = executeSharedAdmin(authority, token, {
      action: "overview",
      orgId: ORG,
    }) as { cut: { seq: number; hash: string }; documents: number };
    const beforeOrg = executeSharedAdmin(authority, token, {
      action: "organization",
      orgId: ORG,
    }) as { workspaces: unknown[] };

    const hostile = {
      action: "workspaceCreate",
      orgId: ORG,
      workspaceId: "ws3",
      name: "Should not exist",
      token,
    };
    const original = JSON.stringify(hostile);
    expect(failure(() => executeSharedAdmin(authority, token, hostile))).toBe(
      "INVALID_ADMIN_COMMAND",
    );
    expect(JSON.stringify(hostile)).toBe(original);

    expect(
      failure(() =>
        executeSharedAdmin(authority, token, {
          action: "grant",
          scope: {
            orgId: ORG,
            workspaceId: "ws1",
            documentId: "doc1",
            incarnationId: "inc1",
            extra: true,
          },
          userId: "owner1",
          role: "superuser",
        }),
      ),
    ).toBe("INVALID_ADMIN_COMMAND");
    expect(
      failure(() =>
        executeSharedAdmin(authority, token, {
          action: "audit",
          orgId: ORG,
          limit: 1001,
        }),
      ),
    ).toBe("INVALID_ADMIN_COMMAND");

    const after = executeSharedAdmin(authority, token, {
      action: "overview",
      orgId: ORG,
    }) as typeof before;
    const afterOrg = executeSharedAdmin(authority, token, {
      action: "organization",
      orgId: ORG,
    }) as typeof beforeOrg;
    expect(after.cut).toEqual(before.cut);
    expect(after.documents).toBe(before.documents);
    expect(afterOrg.workspaces.length).toBe(beforeOrg.workspaces.length);
  });
});
