import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * D14 — the workspace grid regression (2026-10-11).
 *
 * `.workspace` has three children: BrowserStrip, `.workspace-main`
 * (TrackTabs + PatternBar + Sequencer) and the Inspector. `24-layout-tokens.css`
 * is imported LAST in src/styles/index.css and used to re-declare
 * `grid-template-columns` with only TWO tracks, which silently replaced the
 * three-column template from `20-control-kit.css` (same specificity, later
 * wins). Auto-placement dropped `.workspace-main` into the 280px inspector
 * column.
 *
 * Measured before the fix, in Chromium against the production build, at
 * 1280x720 / 1366x768 / 1440x900 / 1920x1080 — every viewport:
 *   columns              = "<wide>px 280px"          (2 tracks)
 *   .workspace-main      = 280px wide
 *   .sequencer           = 256x20 with 618px of content inside
 *   GEN hit test @1280   = BUTTON.dock-resize-handle (not the button)
 *
 * These assertions are the defect, not a description of a design preference:
 * each one fails on the pre-fix cascade and passes on the fixed one.
 */

/** Read the grid geometry and hit-test GEN from inside the page. */
function probeLayout() {
  const q = <T extends Element>(sel: string) => document.querySelector(sel) as T | null;
  const box = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  };
  const workspace = q("main.workspace");
  const main = q(".workspace-main");
  const seq = q(".sequencer");
  const gen = Array.from(document.querySelectorAll<HTMLButtonElement>(".pattern-actions button")).find((b) =>
    (b.textContent ?? "").includes("GEN"),
  );
  let genHit = "no-gen-button";
  let genBox: { x: number; y: number; w: number; h: number } | null = null;
  if (gen) {
    const r = gen.getBoundingClientRect();
    genBox = { x: r.x, y: r.y, w: r.width, h: r.height };
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    genHit =
      hit === gen || gen.contains(hit)
        ? "GEN"
        : `${(hit as HTMLElement | null)?.tagName ?? "null"}.${
            ((hit as HTMLElement | null)?.className || "").toString().split(" ")[0]
          }`;
  }
  return {
    columnTracks: workspace ? getComputedStyle(workspace).gridTemplateColumns.split(" ").length : 0,
    columnTemplate: workspace ? getComputedStyle(workspace).gridTemplateColumns : "",
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    workspaceMain: box(main),
    sequencer: box(seq),
    sequencerScrollHeight: seq?.scrollHeight ?? 0,
    genHit,
    genBox,
  };
}

type Layout = ReturnType<typeof probeLayout>;

test.describe("19 — workspace layout (D14)", () => {
  test("the 860px ladder step switches the inspector to a row instead of two columns", async ({ page }) => {
    test.setTimeout(120_000);
    // Below 860px the inspector becomes a row UNDER the workspace. That switch
    // was dead for as long as 24-layout-tokens.css existed: a media query adds
    // no specificity, so its plain two-column rule beat the breakpoint.
    //
    // The discriminating measurement is the TRACK COUNT, not the width. With
    // the pre-fix cascade at 800px the layout still resolved to two columns
    // (`520px 280px`) and the inspector stayed a side column — a width-only
    // assertion passes on the broken build, because workspace-main lands in
    // the fluid track either way. Assert the thing that actually changed.
    await page.setViewportSize({ width: 800, height: 900 });
    await openHouseTemplate(page);
    await page.waitForTimeout(300);

    const ladder = await page.evaluate(() => {
      const q = <T extends Element>(s: string) => document.querySelector(s) as T | null;
      const workspace = q("main.workspace");
      const main = q(".workspace-main");
      const inspector = q(".inspector");
      const top = (el: Element | null) => (el ? el.getBoundingClientRect().top : null);
      return {
        columnTemplate: workspace ? getComputedStyle(workspace).gridTemplateColumns : "",
        tracks: workspace ? getComputedStyle(workspace).gridTemplateColumns.split(" ").length : 0,
        mainTop: top(main),
        inspectorTop: top(inspector),
      };
    });

    // One track = the ladder step is alive and the inspector is a row.
    expect(ladder.tracks, `columns were "${ladder.columnTemplate}" at 800x900`).toBe(1);
    // And the inspector really did move below, rather than beside, the sequencer.
    expect(ladder.mainTop, "workspace-main missing").not.toBeNull();
    expect(ladder.inspectorTop, "inspector missing").not.toBeNull();
    expect(ladder.inspectorTop!).toBeGreaterThan(ladder.mainTop!);
  });

  test("the workspace keeps three grid tracks and gives the sequencer column to workspace-main", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await openHouseTemplate(page);
    await page.waitForTimeout(300);

    const layout: Layout = await page.evaluate(probeLayout);

    // Two tracks means auto-placement moved `.workspace-main` into the
    // inspector column — the pre-fix measurement was "1000px 280px".
    expect(layout.columnTracks, `columns were "${layout.columnTemplate}"`).toBe(3);

    // The sequencer's own home must be the fluid middle column, not the
    // clamped inspector. Pre-fix it measured 280px at every viewport.
    expect(layout.workspaceMain, "workspace-main missing").not.toBeNull();
    expect(layout.workspaceMain!.w, `workspace-main width at ${layout.viewport}`).toBeGreaterThan(400);
  });

  test("GEN in the pattern bar is hit-testable and not covered by the dock resizer", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await openHouseTemplate(page);
    await page.waitForTimeout(300);

    const layout: Layout = await page.evaluate(probeLayout);

    expect(layout.genHit, "the GEN button was not in the DOM").not.toBe("no-gen-button");
    // Pre-fix this returned BUTTON.dock-resize-handle: the pattern bar had
    // overflowed out of its column into the dock band, and the dock — a later
    // sibling — won the hit test. A control a user cannot click is the defect.
    expect(layout.genHit, `GEN hit test at ${layout.viewport}`).toBe("GEN");
  });

  test("the sequencer is a usable grid, not a 20px sliver", async ({ page }) => {
    test.setTimeout(120_000);
    // 1440x900 is the smallest viewport in the ladder with room for the whole
    // column stack (topbar + rack strip + pattern bar + sequencer) above the
    // dock. At 720 the leftover for the sequencer is ~20px — a separate,
    // still-open finding recorded in the audit report, not this test.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHouseTemplate(page);
    await page.waitForTimeout(300);

    const layout: Layout = await page.evaluate(probeLayout);

    expect(layout.sequencer, "sequencer missing").not.toBeNull();
    // Pre-fix: 256x20 everywhere, with 618px of grid scrolling inside it.
    expect(layout.sequencer!.h, `sequencer height at ${layout.viewport}`).toBeGreaterThan(120);
    expect(layout.sequencer!.w, `sequencer width at ${layout.viewport}`).toBeGreaterThan(400);
  });

  test("the phone label breakpoint survives a user-chosen label width", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 720, height: 900 });
    await openHouseTemplate(page);

    const read = () =>
      page.evaluate(() => {
        const root = document.documentElement;
        const row = document.querySelector(".sequencer-row");
        return {
          declared: getComputedStyle(root).getPropertyValue("--steps-label").trim(),
          labelColumn: row ? getComputedStyle(row).gridTemplateColumns.split(" ")[0] : "no-row",
        };
      });

    // Baseline: no user preference → the phone breakpoint owns the value.
    const withoutUserWidth = await read();
    expect(withoutUserWidth.declared, "phone breakpoint inactive without a user width").toBe("112px");

    // Exactly what ui/layout.ts:108-113 does for a user who picked a width.
    await page.evaluate(() => {
      document.documentElement.classList.add("user-label-width");
      document.documentElement.style.setProperty("--user-steps-label", "220px");
    });
    const withUserWidth = await read();

    // A 220px label column on a 720px screen eats 30% of the width; the
    // 760px step exists to stop exactly that. Pre-fix this measured 220px.
    expect(withUserWidth.declared, "a user label width overrode the phone breakpoint").toBe("112px");
    expect(withUserWidth.labelColumn).toBe("112px");
  });
});

/**
 * Short-viewport priority (2026-10-12, owner's decision).
 *
 * Measured at 1280x720 before the change: the workspace column was 349px and
 * spent 151px on the pad rack and 149px on the pattern toolbar, leaving the
 * SEQUENCER — the editor the application exists for — 20px. The studio read as
 * "pad grid, four rows of buttons, and a mixer". At 1366x768 it was ~68px.
 *
 * The rules live in src/styles/25-short-viewport.css: the editor has a floor,
 * the toolbar above it yields and scrolls instead of vanishing, and on a short
 * viewport the pad rack drops to one row and the dock stops at 34vh.
 *
 * These assertions are the three ways that can regress silently: the editor
 * losing its floor again, the toolbar being squeezed to zero (which is worse
 * than the original bug and happened once during this work), and content being
 * clipped by `.app { overflow: hidden }` instead of laid out.
 */
test.describe("19b — short viewports give the editor the space", () => {
  const probe = () => {
    const q = <T extends Element>(s: string) => document.querySelector(s) as T | null;
    const h = (el: Element | null) => (el ? el.getBoundingClientRect().height : 0);
    const app = q(".app");
    const bar = q(".pattern-bar");
    return {
      sequencer: h(q(".sequencer")),
      patternBar: h(bar),
      patternBarScrolls: bar ? bar.scrollHeight > bar.clientHeight + 1 : null,
      // Count TRACKS, not distinct child tops: the rack also holds a header
      // row, so a one-row rack measures as 2 distinct tops. A first attempt at
      // this assertion counted tops and failed against a layout that was
      // correct — the metric was wrong, not the CSS. Computed column count is
      // the signal that actually tracks the rule.
      rackCols: (() => {
        const rack = q<HTMLElement>(".rack");
        return rack ? getComputedStyle(rack).gridTemplateColumns.split(" ").length : 0;
      })(),
      dock: h(q(".bottom-panels")),
      // `.app` clips overflow, so anything pushed below the fold is simply gone.
      clippedPx: app ? app.scrollHeight - app.clientHeight : 0,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    };
  };

  test("1280x720 keeps a usable sequencer and clips nothing", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await openHouseTemplate(page);
    await page.waitForTimeout(300);

    const m = await page.evaluate(probe);

    // Pre-fix this measured 20px.
    expect(m.sequencer, `sequencer height at ${m.viewport}`).toBeGreaterThanOrEqual(150);
    // A toolbar squeezed to zero is not compact, it is gone.
    expect(m.patternBar, `pattern toolbar height at ${m.viewport}`).toBeGreaterThanOrEqual(60);
    expect(m.rackCols, `pad rack columns at ${m.viewport} (one row = 16 columns)`).toBe(16);
    expect(m.clippedPx, `content pushed below the fold at ${m.viewport}`).toBe(0);
  });

  test("1366x768 keeps the editor floor too", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1366, height: 768 });
    await openHouseTemplate(page);
    await page.waitForTimeout(300);

    const m = await page.evaluate(probe);
    // Pre-fix this measured ~68px.
    expect(m.sequencer, `sequencer height at ${m.viewport}`).toBeGreaterThanOrEqual(150);
    expect(m.clippedPx).toBe(0);
  });

  test("a tall viewport is untouched — the rack returns to its rows and the toolbar stops scrolling", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openHouseTemplate(page);
    await page.waitForTimeout(300);

    const m = await page.evaluate(probe);

    // The short-viewport rules must not leak into a screen that has room:
    // pre-existing values at 1920x1080 were sequencer 468, rack 2 rows, bar 71.
    expect(m.sequencer, `sequencer height at ${m.viewport}`).toBeGreaterThan(400);
    expect(m.rackCols, `pad rack columns at ${m.viewport}`).toBe(8);
    expect(m.patternBarScrolls, "the toolbar should not scroll when it fits").toBe(false);
  });

  test("a narrow stacked layout keeps both the editor and the toolbar", async ({ page }) => {
    test.setTimeout(120_000);
    // Below 860px the inspector becomes a ROW and shares the vertical budget.
    // The first attempt at the floor left the toolbar 0px tall here, which is
    // worse than the bug it replaced.
    await page.setViewportSize({ width: 800, height: 900 });
    await openHouseTemplate(page);
    await page.waitForTimeout(300);

    const m = await page.evaluate(probe);
    expect(m.sequencer, `sequencer height at ${m.viewport}`).toBeGreaterThan(0);
    expect(m.sequencer, `sequencer height at ${m.viewport}`).toBeGreaterThanOrEqual(90);
    expect(m.patternBar, `pattern toolbar height at ${m.viewport}`).toBeGreaterThanOrEqual(60);
    expect(m.clippedPx).toBe(0);
  });
});
