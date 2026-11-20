import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ErrorBoundary,
  RenderingRecovery,
} from "../src/renderer/ErrorBoundary";
import { showSharedUi } from "../src/shared/startup-status";

describe("local workspace presentation", () => {
  it("shows shared controls only for explicit flags or an enabled/held connection", () => {
    expect(showSharedUi({}, {})).toBe(false);
    expect(
      showSharedUi(
        { FOLIO_SYNC_ENABLED: "0", FOLIO_EXPERIMENTAL_SHARED_UI: "true" },
        {},
      ),
    ).toBe(false);
    expect(showSharedUi({ FOLIO_EXPERIMENTAL_SHARED_UI: "1" }, {})).toBe(true);
    expect(showSharedUi({ FOLIO_SYNC_ENABLED: "1" }, {})).toBe(true);
    expect(showSharedUi({}, { saved: { revision: 1 } })).toBe(true);
    expect(showSharedUi({}, { held: true })).toBe(true);
  });

  it("preserves the normal child and exposes offline recovery actions after an error without writing during render", () => {
    const backup = vi.fn(async () => "output"),
      salvage = vi.fn(async () => null);
    const props = {
      backup,
      salvage,
      onClose: vi.fn(),
      children: createElement("p", null, "本文"),
    };
    const boundary = new ErrorBoundary(props);
    expect(boundary.render()).toBe(props.children);
    boundary.state = ErrorBoundary.getDerivedStateFromError();
    const markup = renderToStaticMarkup(
      createElement("div", null, boundary.render()),
    );
    expect(markup).toContain("診断用の原本コピーを保存");
    expect(markup).toContain("DB・添付・復旧記録を救出");
    expect(markup).toContain("レコードを閉じる");
    expect(markup).not.toContain("本文");
    expect(backup).not.toHaveBeenCalled();
    expect(salvage).not.toHaveBeenCalled();
    expect(
      renderToStaticMarkup(createElement(RenderingRecovery, { backup })),
    ).not.toContain("レコードを閉じる");
    expect(new ErrorBoundary(props).render()).toBe(props.children);
  });
});
