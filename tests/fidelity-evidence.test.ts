import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The GUI run could only be performed once in this session (see
// docs/parallel/r3/fidelity/RESULTS.md). These checks pin the recorded raw
// measurements so the report cannot drift to a layout the run did not observe.
const read = (name: string) =>
  JSON.parse(
    readFileSync(`docs/parallel/r3/fidelity/evidence/${name}`, "utf8"),
  ) as any;

const responsive = read("r3-responsive.json");
const database = read("r3-db-record-display.json");
const focus = read("r3-focus-contract.json");
const longTitle = read("r3-long-title-keyboard-motion.json");

describe("recorded 1440/1024/960 measurements", () => {
  test("all three widths fit without horizontal overflow", () => {
    expect(responsive.readings).toHaveLength(3);
    for (const { size, reading } of responsive.readings) {
      expect(["1440x907", "1024x720", "960x700"]).toContain(size);
      expect(reading.horizontalOverflow).toBeLessThanOrEqual(0);
      expect(reading.documentOverflow).toBeLessThanOrEqual(1);
      const contentRight =
        reading.boxes.content.x + reading.boxes.content.width;
      const titleRight = reading.boxes.title.x + reading.boxes.title.width;
      expect(contentRight).toBeLessThanOrEqual(reading.boxes.inspector.x + 1);
      expect(titleRight).toBeLessThanOrEqual(reading.boxes.inspector.x + 1);
    }
  });

  test("960 uses the floating panel with a reserved editing gutter", () => {
    const narrow = responsive.readings.find(
      (entry: any) => entry.size === "960x700",
    ).reading;
    expect(narrow.styles.inspectorPosition).toBe("absolute");
    expect(parseFloat(narrow.styles.documentScrollPaddingRight)).toBe(292);
    expect(narrow.boxes.inspector.x).toBe(680);
    expect(narrow.boxes.content.x + narrow.boxes.content.width).toBeLessThan(
      narrow.boxes.inspector.x,
    );
    expect(narrow.styles.titleSize).toBe("29px");
  });

  test("1024 and 1440 keep the panel in flow", () => {
    for (const width of ["1024x720", "1440x907"]) {
      const reading = responsive.readings.find(
        (entry: any) => entry.size === width,
      ).reading;
      expect(reading.styles.inspectorPosition).toBe("static");
      expect(reading.styles.documentScrollPaddingRight).toBe("0px");
    }
  });

  test("popovers and contrast stay inside the measured bounds", () => {
    expect(responsive.slashMenu.insideViewport).toBe(true);
    expect(
      responsive.slashMenu.box.x + responsive.slashMenu.box.width,
    ).toBeLessThanOrEqual(responsive.slashMenu.viewport.width);
    for (const theme of ["light", "dark"]) {
      for (const ratio of ["title", "editor", "muted", "inspector"]) {
        expect(responsive.contrast[theme][ratio]).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(responsive.contrast.dark.title).not.toBe(
      responsive.contrast.light.title,
    );
  });
});

describe("recorded DB fixture display", () => {
  test("board, calendar and gallery share a bounded modal at every width", () => {
    expect(database.readings).toHaveLength(9);
    for (const reading of database.readings) {
      expect(["1440x907", "1024x720", "960x700"]).toContain(reading.size);
      expect(["ギャラリー", "ボード", "カレンダー"]).toContain(reading.view);
      expect(reading.insideViewport).toBe(true);
      expect(reading.panel.width).toBe(620);
      expect(reading.fieldCount).toBeGreaterThan(0);
      expect(reading.tabbable).toBeGreaterThan(0);
      expect(reading.escapeRestoredCardFocus).toBe(true);
    }
  });

  test("table view still exposes inline editing and no full-page record", () => {
    expect(database.tableViewObservation.inlineTitleInputs).toBe(3);
    expect(database.tableViewObservation.recordDialog).toBe(false);
    expect(database.tableViewObservation.fullPageRecordFromTable).toBe(
      "NOT_IMPLEMENTED_OBSERVED",
    );
    expect(database.storage).toContain("DatabaseProjection/RecordRequest");
  });

  test("the fixture title survives a restart", () => {
    expect(database.restart.longJapaneseTitlePreserved).toBe(true);
  });
});

describe("recorded focus, long title and motion results", () => {
  test("all dialog families enter, loop, dismiss and return focus", () => {
    expect(focus.search.focusReturn).toBe("page-title");
    expect(focus.link.focusReturn).toBe("editor");
    expect(focus.link.selectionAfterCancel).toBe("リンク対象");
    expect(focus.templates.initialFocus.firstCard).toBe(true);
    expect(focus.templates.enterActivation).toContain("created 無題 page");
    expect(focus.move.initialFocus.firstRow).toBe(true);
    expect(focus.move.focusReturnAfterEscape).toBe("ページメニュー button");
    expect(focus.history.focusReturnAfterEscape).toBe("変更履歴を見る button");
    expect(focus.trash.focusReturnAfterEscape).toBe("sidebar ゴミ箱 button");
    expect(focus.background).toContain("backdrop click dismissed");
    expect(focus.input).toContain("physical Japanese IME NOT_RUN");
  });

  test("long title is preserved and clipped or wrapped per surface", () => {
    expect(longTitle.title.valuePreserved).toBe(true);
    expect(longTitle.title.length).toBe(119);
    expect(longTitle.truncation.sidebar).toContain("ellipsis");
    expect(longTitle.truncation.breadcrumb).toContain("ellipsis");
    expect(longTitle.truncation.inspectorPage).toContain("wraps");
    expect(longTitle.truncation.pageTitle).toContain("NOT_RUN");
    expect(longTitle.focusRing.focusVisible).toBe(true);
    expect(longTitle.focusRing.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(longTitle.sidebarCollapsed.contentRight).toBeLessThanOrEqual(
      longTitle.sidebarCollapsed.inspectorLeft + 1,
    );
    expect(longTitle.reducedMotion.scrollBehavior).toBe("auto");
    expect(longTitle.reducedMotion.dropdownAnimation).toBe("none");
    expect(
      longTitle.reducedMotion.pageToolsTransitions.every(
        (value: number) => value === 0,
      ),
    ).toBe(true);
  });

  test("evidence files contain no absolute personal paths", () => {
    for (const name of [
      "r3-responsive.json",
      "r3-db-record-display.json",
      "r3-focus-contract.json",
      "r3-long-title-keyboard-motion.json",
    ]) {
      const raw = readFileSync(
        `docs/parallel/r3/fidelity/evidence/${name}`,
        "utf8",
      );
      expect(raw).not.toMatch(/\/Users\/|\/home\/[^" ]+\/|[A-Z]:\\Users\\/);
    }
  });
});
