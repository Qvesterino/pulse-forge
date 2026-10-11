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
        : `${(hit as HTMLElement | null)?.tagName ?? "null"}.${((hit as HTMLElement | null)?.className || "")
            .toString()
            .split(" ")[0]}`;
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
  test("the workspace keeps three grid tracks and gives the sequencer column to workspace-main", async ({
    page,
  }) => {
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
});