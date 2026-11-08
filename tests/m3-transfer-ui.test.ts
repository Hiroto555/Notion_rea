import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TRANSFER_GENERIC_ERROR,
  TransferMaintenancePanel,
  formatTransferBytes,
  transferErrorMessage,
  transferReleaseConfirmation,
} from "../src/renderer/sync/TransferMaintenancePanel";
import type {
  TransferMaintenanceEntry,
  TransferMaintenanceView,
} from "../src/shared/sync-management";

const entries: TransferMaintenanceEntry[] = [
  {
    entryId: "entry-active",
    scopeHash: "scope-current",
    assetId: "asset-1",
    bytes: 2048,
    offset: 0,
    state: "active",
    currentScope: true,
    canRelease: true,
    reason: null,
  },
  {
    entryId: "entry-blocked",
    scopeHash: "scope-old",
    assetId: null,
    bytes: 0,
    offset: 0,
    state: "blocked",
    currentScope: false,
    canRelease: false,
    reason: "blocked by sync",
  },
  {
    entryId: "entry-completed",
    scopeHash: "scope-old-2",
    assetId: "asset-2",
    bytes: 4096,
    offset: 1024,
    state: "completed",
    currentScope: false,
    canRelease: true,
    reason: "stale cache",
  },
  {
    entryId: "entry-unknown",
    scopeHash: "scope-unknown",
    assetId: null,
    bytes: 512,
    offset: 0,
    state: "unknown",
    currentScope: false,
    canRelease: false,
    reason: "unreleasable",
  },
];

const view: TransferMaintenanceView = {
  entries,
  nextCursor: "cursor-2",
  usedBytes: 6656,
  overLimit: true,
  held: "maintenance held by another process",
};

function handlers() {
  return {
    onRefresh: vi.fn(async (_cursor?: string) => {}),
    onPlan: vi.fn(async () => {
      throw new Error("not called during SSR");
    }),
    onRelease: vi.fn(async () => {
      throw new Error("not called during SSR");
    }),
    onResolve: vi.fn(async () => {
      throw new Error("not called during SSR");
    }),
  };
}

function render(nextView: TransferMaintenanceView = view, busy = false) {
  return renderToStaticMarkup(
    React.createElement(TransferMaintenancePanel, { view: nextView, busy, ...handlers() }),
  );
}

describe("TransferMaintenancePanel SSR", () => {
  it("shows retained bytes, over-limit state, held reason and refresh", () => {
    const html = render();

    expect(html).toContain("Retained bytes");
    expect(html).toContain("6656 bytes (6.5 KiB)");
    expect(html).toContain("Over limit");
    expect(html).toContain(">Yes<");
    expect(html).toContain("maintenance held by another process");
    expect(html).toContain("Refresh is available while maintenance is held");
    expect(html).toContain('data-cursor="cursor-2"');
    expect(html).toContain(">Refresh</button>");
  });

  it("shows every given entry with scope, state and reason", () => {
    const html = render();

    expect(html).toContain("entry-active");
    expect(html).toContain("asset-1");
    expect(html).toContain("Current scope");
    expect(html).toContain("Old scope");
    expect(html).toContain(">active<");
    expect(html).toContain(">blocked<");
    expect(html).toContain(">completed<");
    expect(html).toContain(">unknown<");
    expect(html).toContain("blocked by sync");
    expect(html).toContain("unreleasable");
    expect(html).toContain("scope-current");
    expect(html).toContain("scope-old-2");
    expect(html).toContain("No reason supplied");
  });

  it("offers a dry-run preview only for releasable entries", () => {
    const html = render();

    expect((html.match(/>Preview release</g) ?? []).length).toBe(2);
    expect(html).toContain("Preview release for entry-active");
    expect(html).toContain("Preview release for entry-completed");
    expect(html).not.toContain("Preview release for entry-blocked");
    expect(html).not.toContain("Preview release for entry-unknown");
    expect(html).toContain("Keep this entry. Release is unavailable.");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Confirm release");
  });

  it("does not call any action while server rendering", () => {
    const props = { view, busy: false, ...handlers() };

    renderToStaticMarkup(React.createElement(TransferMaintenancePanel, props));

    expect(props.onRefresh).not.toHaveBeenCalled();
    expect(props.onPlan).not.toHaveBeenCalled();
    expect(props.onRelease).not.toHaveBeenCalled();
    expect(props.onResolve).not.toHaveBeenCalled();
  });

  it("handles an empty page and no next cursor", () => {
    const html = render(
      { entries: [], nextCursor: null, usedBytes: 0, overLimit: false, held: null },
      false,
    );

    expect(html).toContain("No transfer entries.");
    expect(html).toContain(">No<");
    expect(html).not.toContain("Load more");
    expect(html).not.toContain("Refresh is available while maintenance is held");
  });

  it("marks the panel busy and disables actions", () => {
    const html = render(view, true);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Working...");
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThan(0);
  });
});

describe("transfer release model", () => {
  it("uses the exact entry identity for confirmation", () => {
    const confirm = transferReleaseConfirmation(entries[0]);

    expect(confirm.entryId).toBe("entry-active");
    expect(confirm.assetId).toBe("asset-1");
    expect(confirm.scopeHash).toBe("scope-current");
    expect(confirm.currentScope).toBe(true);
    expect(confirm.scopeLabel).toBe("Current scope");
    expect(confirm.bytes).toBe(2048);
    expect(confirm.bytesLabel).toBe("2048 bytes (2.0 KiB)");
    expect(confirm.cacheNotice).toContain("Incomplete cache will be re-downloaded");
  });

  it("shows an explicit missing asset and old scope", () => {
    const confirm = transferReleaseConfirmation(entries[1]);

    expect(confirm.assetId).toBe("None");
    expect(confirm.scopeLabel).toBe("Old scope");
    expect(confirm.bytesLabel).toBe("0 bytes (0 B)");
  });

  it("formats bytes deterministically", () => {
    expect(formatTransferBytes(0)).toBe("0 B");
    expect(formatTransferBytes(512)).toBe("512 B");
    expect(formatTransferBytes(2048)).toBe("2.0 KiB");
    expect(formatTransferBytes(6656)).toBe("6.5 KiB");
  });

  it("never exposes a raw exception message", () => {
    const message = transferErrorMessage(new Error("boom /tmp/secret raw"));

    expect(message).toBe(TRANSFER_GENERIC_ERROR);
    expect(message).not.toContain("boom");
    expect(message).not.toContain("/tmp");
    expect(message).not.toContain("secret");
  });
});
