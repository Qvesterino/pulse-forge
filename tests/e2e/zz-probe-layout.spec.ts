import { test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * TEMPORARY probe — dump the studio layout at the Playwright default viewport.
 *
 * Measured facts so far (production build, Chromium, 1280x720):
 *   GEN button  box=1186,395 52x24, geometry stable across 30 frames
 *   elementFromPoint(GEN centre) = button.dock-resize-handle, not GEN
 *   div.workspace-main box=1000,48 280x172.5  clientH=173  scrollH=511
 *
 * So workspace-main is 172.5 px tall, its content needs 511 px, and the
 * overflow paints over the bottom dock, which wins the hit test. This probe
 * dumps every column plus a screenshot so the fix targets the real geometry
 * instead of a guessed one.
 */
test("dump studio layout geometry at 1280x720", async ({ page }) => {
  test.setTimeout(120_000);
  await openHouseTemplate(page);

  const sel = [
    ".app",
    ".topbar",
    "main.workspace",
    ".workspace-main",
    ".pattern-bar",
    ".sequencer",
    ".bottom-panels",
    ".dock-resize-handle",
    ".dock-tabs",
  ];
  const dump = await page.evaluate((selectors) => {
    const out: Record<string, unknown> = {};
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (!el) {
        out[s] = "MISSING";
        continue;
      }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out[s] = {
        box: `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`,
        client: `${el.clientWidth}x${el.clientHeight}`,
        scroll: `${el.scrollWidth}x${el.scrollHeight}`,
        position: cs.position,
        display: cs.display,
        flex: cs.flex,
        overflow: `${cs.overflowX}/${cs.overflowY}`,
        zIndex: cs.zIndex,
        minH: cs.minHeight,
        transform: cs.transform === "none" ? "none" : cs.transform,
        contains: cs.contain,
        children: el.children.length,
      };
    }
    out.__viewport = `${window.innerWidth}x${window.innerHeight}`;
    out.__dockVar = getComputedStyle(document.querySelector(".app") as Element).getPropertyValue("--dock-height");
    return out;
  }, sel);

  console.info(`LAYOUT ${JSON.stringify(dump, null, 1)}`);
  await page.screenshot({ path: "test-results/zz-studio-1280x720.png", fullPage: false });
});