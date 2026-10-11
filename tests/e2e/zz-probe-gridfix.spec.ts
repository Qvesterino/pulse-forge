import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * FALSIFICATION probe for the workspace grid regression.
 *
 * Cascade order (src/styles/index.css) puts 24-layout-tokens.css LAST, and it
 * re-declares `.workspace` as a TWO-column grid:
 *
 *   20-control-kit.css:471  .workspace { grid-template-columns: auto minmax(0,1fr) 280px }
 *   24-layout-tokens.css:44 .workspace { grid-template-columns: minmax(0,1fr) clamp(...) }
 *
 * Same specificity, later wins — so the strip / main / inspector three-column
 * layout is silently replaced by two columns, and grid auto-placement drops
 * the Inspector into a second ROW.
 *
 * Hypothesis (H): with three children in a two-column grid, `.workspace-main`
 * lands in the clamped inspector column (measured: box=1000,48 280x173) and
 * its overflowing children paint under the bottom dock, which wins the hit
 * test over GEN (measured: elementFromPoint(GEN centre) = .dock-resize-handle).
 *
 * Falsifier: inject the three-column template at runtime. If the sequencer
 * returns inside the workspace column and GEN becomes hit-testable, H holds.
 * If the layout stays broken, H is wrong and the real cause is elsewhere.
 */
const MEASURE = () => {
  const q = (s: string) => document.querySelector(s) as HTMLElement | null;
  const rect = (s: string) => {
    const el = q(s);
    if (!el) return "MISSING";
    const r = el.getBoundingClientRect();
    return `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`;
  };
  const gen = Array.from(document.querySelectorAll<HTMLButtonElement>(".pattern-actions button")).find((b) =>
    (b.textContent ?? "").includes("GEN"),
  );
  let genHit = "no-gen";
  if (gen) {
    const r = gen.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    genHit = hit === gen || gen.contains(hit) ? "GEN-OK" : `${hit?.tagName}.${(hit?.className || "").toString().split(" ")[0]}`;
  }
  const seq = q(".sequencer");
  return {
    cols: getComputedStyle(q("main.workspace") as Element).gridTemplateColumns,
    workspaceMain: rect(".workspace-main"),
    patternBar: rect(".pattern-bar"),
    sequencer: rect(".sequencer"),
    bottomPanels: rect(".bottom-panels"),
    genHit,
    seqVisibleInWorkspace: (() => {
      const wm = q(".workspace-main")?.getBoundingClientRect();
      const s = seq?.getBoundingClientRect();
      if (!wm || !s) return "n/a";
      return s.height > 40 && s.bottom <= wm.bottom + 1 ? "INSIDE" : "OVERFLOWING";
    })(),
  };
};

test("three-column template repairs the layout (falsifier)", async ({ page }) => {
  test.setTimeout(120_000);
  await openHouseTemplate(page);

  const before = await page.evaluate(MEASURE);

  // The fix under test: restore the three-column template, keep the clamp.
  await page.addStyleTag({
    content:
      "main.workspace{grid-template-columns:auto minmax(0,1fr) clamp(180px, var(--inspector-width,280px), 420px)!important}",
  });
  const after = await page.evaluate(MEASURE);

  console.info(`GRID before=${JSON.stringify(before)}\nGRID after=${JSON.stringify(after)}`);
  expect(before.genHit).not.toBe("GEN-OK");
  expect(after.genHit).toBe("GEN-OK");
  expect(after.seqVisibleInWorkspace).toBe("INSIDE");
});