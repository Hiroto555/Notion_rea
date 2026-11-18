import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedAuthority } from "../src/collaboration/runtime/authority";

const fixtures: { root: string; authority: SharedAuthority }[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.authority.close(); rmSync(f.root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-retention-authority-"));
  const authority = new SharedAuthority(root); fixtures.push({ root, authority });
  const issued = authority.bootstrap({ orgId: "org", userId: "owner", deviceId: "device", workspaceId: "workspace", documentId: "document", document: { type: "doc", content: [{ type: "paragraph", attrs: { id: "paragraph" } }] } });
  return { authority, ...issued };
}

it("connects the read-only dependency plan to the real current authority without changing its root", () => {
  const f = fixture(), cut = f.authority.head();
  const plan = f.authority.retentionDependencies(f.token, "org", cut);
  expect(plan).toMatchObject({ mode: "PLAN_ONLY", execution: "UNSUPPORTED", cut, deletions: [] });
  expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(plan.protected.length).toBeGreaterThan(0);
  expect(f.authority.head()).toEqual(cut); f.authority.verify();
});

it("rejects stale exact-cut plans", () => {
  const f = fixture(), cut = f.authority.head(); f.authority.createWorkspace(f.token, "org", "second", "Second");
  expect(() => f.authority.retentionDependencies(f.token, "org", cut)).toThrow("RETENTION_PLAN_STALE");
});

it("denies organization owners who have no body access, even for reference metadata", () => {
  const f = fixture();
  const invite = f.authority.invite(f.token, "org", "delegate");
  const delegate = f.authority.join(invite, "org", "delegate-device");
  f.authority.handoff(f.token, "org", "delegate", []);
  expect(() => f.authority.recoveryStatus(delegate.token, "org")).not.toThrow();
  expect(() => f.authority.retentionDependencies(delegate.token, "org", f.authority.head())).toThrow("FORBIDDEN");
});

it("rechecks the current device session for every inspection", () => {
  const f = fixture(), old = f.token;
  f.authority.recover("org", f.recoveryKey, "replacement-device");
  expect(() => f.authority.retentionDependencies(old, "org", f.authority.head())).toThrow();
});

it("does not bypass inventory limits to make capacity inspection succeed", () => {
  const f = fixture();
  expect(() => f.authority.retentionDependencies(f.token, "org", f.authority.head(), { maxRows: 1 })).toThrow("RETENTION_INVENTORY_LIMIT");
  f.authority.verify();
});
