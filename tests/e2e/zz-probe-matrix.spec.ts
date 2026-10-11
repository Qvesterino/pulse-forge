import { test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * SCOPE probe — how wide is the sequencer-collapse defect?
 *
 * The grid falsifier proved two separate things:
 *   1. the two-column `.workspace` override is what made GEN unclickable
 *      (elementFromPoint: .dock-resize-handle -> GEN-OK after injection);
 *   2. but the sequencer stayed 20 px tall even with the correct three-column
 *      template, so a SECOND defect owns the collapse.
 *
 * The second defect is vertical: `.workspace-main` is a flex column and
 * `.sequencer { flex: 1; min-height: 0 }`, so the sequencer absorbs whatever
 * is left after the track tabs and the pattern bar — which at a 720 px
 * viewport is 20 px.
 *
 * A viewport matrix is the only honest way to scope it: if 1080 is fine and
 * 720 is not, this is short-viewport degradation (P2); if every size is
 * broken, it is P0.
 */
const VIEWPORTS = [
  { w: 1280, h: 720 },
  { w: 1366, h: 768 },
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
];

test("sequencer height across the viewport matrix", async ({ page }) => {
  test.setTimeout(300_000);
  await openHouseTemplate(page);
  console.info(`BODY ${(await page.evaluate(() => document.body.innerText.slice(0, 120)).catch(() => "n/a"))}`);

  const rows: Array<Record<string, unknown>> = [];
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(400);
    const row = await page.evaluate(() => {
      const q = (s: string) => document.querySelector(s) as HTMLElement | null;
      const ws = q("main.workspace");
      if (!ws) return { error: "main.workspace missing", present: document.querySelectorAll(".workspace-main").length };
      const box = (s: string) => {
        const el = q(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
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
      const seq = box(".sequencer");
      const dock = box(".bottom-panels");
      const wm = box(".workspace-main");
      return {
        cols: getComputedStyle(ws).gridTemplateColumns,
        workspaceMain: wm,
        sequencer: seq,
        sequencerScrollH: q(".sequencer")?.scrollHeight ?? null,
        dock: dock?.h ?? null,
        genHit,
        seqCoveredByDock: seq && dock ? seq.y + seq.h > dock.y : null,
      };
    });
    rows.push({ vp: `${vp.w}x${vp.h}`, ...row });
  }
  console.info(`BODY ${(await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => "n/a"))}`); console.info(`MATRIX ${JSON.stringify(rows, null, 1)}`);
});