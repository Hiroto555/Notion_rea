import { describe, expect, it } from "vitest";
import type { PrivatePlatform } from "../src/sync/private-platform";
import {
  createNativeAuthorityLeaseAcquirer, isAuthorityLeasePlatform,
  withPrivateAuthorityLease, withPrivateAuthorityLeaseForTesting,
  type AcquirePrivateAuthorityLease, type PrivateAuthorityLease,
} from "../src/platform/windows/authority-lease";

// These exercise synchronous ownership contracts only. No process is spawned,
// and fake HELD is never accepted by the production wrapper.
function fixture() {
  const events: string[] = [];
  const state = {lost: false, closeFailures: 0, closed: false};
  const platform: PrivatePlatform = {kind: "windows",
    bind(d) {events.push("bind"); return d;},
    createExclusive() {events.push("create");},
    assertRoot() {events.push("root");},
    assertFile() {events.push("file");},
    assertSidecars() {events.push("sidecars");},
    assertEmptyFile() {events.push("empty");},
    close() {events.push("platform-close");},
  };
  const lease: PrivateAuthorityLease = {trust: "untrusted-test",
    assertHeld() {events.push("held"); if (state.lost || state.closed) throw new Error("lease lost");},
    close() {
      events.push("lease-close");
      if (state.closeFailures-- > 0) throw new Error("CLOSED acknowledgement unknown");
      state.closed = true;
    },
  };
  const acquire = () => {events.push("acquire"); return lease;};
  return {events, state, platform, acquire, lease,
    wrapped: withPrivateAuthorityLeaseForTesting(platform, acquire)};
}

describe("owned authority lease contract (not native OS acceptance)", () => {
  it("requires acquisition and HELD before proofs can authorize a writable open", () => {
    const f = fixture();
    f.wrapped.bind("C:\\State");
    expect(() => f.wrapped.assertFile("C:\\State\\archive.sqlite")).toThrow();
    f.wrapped.createExclusive("C:\\State\\archive.sqlite");
    f.wrapped.assertRoot(); f.wrapped.assertFile("C:\\State\\archive.sqlite");
    f.wrapped.assertSidecars("C:\\State\\archive.sqlite");
    expect(f.events.slice(0, 4)).toEqual(["bind", "create", "acquire", "held"]);
    expect(f.events.indexOf("file")).toBeGreaterThan(f.events.indexOf("held"));
    f.wrapped.close();
    expect(f.events.slice(-2)).toEqual(["lease-close", "platform-close"]);
  });

  it("poisons use after a lost hold, even if a later fake liveness flag recovers", () => {
    const f = fixture();
    f.wrapped.bind("C:\\State"); f.wrapped.createExclusive("C:\\State\\archive.sqlite");
    f.state.lost = true;
    expect(() => f.wrapped.assertRoot()).toThrow(/lost/);
    f.state.lost = false;
    expect(() => f.wrapped.assertFile("C:\\State\\archive.sqlite")).toThrow(/lost/);
    f.wrapped.close();
  });

  it("retains the owned scope on uncertain close and retries only that scope", () => {
    const f = fixture();
    f.wrapped.bind("C:\\State"); f.wrapped.createExclusive("C:\\State\\archive.sqlite");
    f.state.closeFailures = 1;
    expect(() => f.wrapped.close()).toThrow(/unknown/);
    expect(f.events).not.toContain("platform-close");
    expect(() => f.wrapped.assertRoot()).toThrow();
    f.wrapped.close();
    expect(f.events.filter(x => x === "lease-close")).toHaveLength(2);
    expect(f.events.filter(x => x === "platform-close")).toHaveLength(1);
    f.wrapped.close();
    expect(f.events.filter(x => x === "lease-close")).toHaveLength(2);
  });

  it("retains a failed acquisition proof's scope for constructor cleanup", () => {
    const f = fixture();
    f.state.lost = true;
    f.wrapped.bind("C:\\State");
    expect(() => f.wrapped.createExclusive("C:\\State\\archive.sqlite")).toThrow();
    f.wrapped.close();
    expect(f.events.slice(-2)).toEqual(["lease-close", "platform-close"]);
  });

  it("rejects asynchronous acquisition and fake production branding", () => {
    const f = fixture();
    expect(() => withPrivateAuthorityLeaseForTesting(f.platform,
      (async () => f.lease) as unknown as AcquirePrivateAuthorityLease)).toThrow();
    expect(() => withPrivateAuthorityLease(f.platform,
      () => ({...f.lease, trust: "native-owned-helper"}))).toThrow(/UNTRUSTED/);
    expect(isAuthorityLeasePlatform(f.wrapped)).toBe(false);
    if (process.platform !== "win32") {
      expect(() => createNativeAuthorityLeaseAcquirer({} as never)).toThrow(/PLATFORM/);
    }
  });
});
