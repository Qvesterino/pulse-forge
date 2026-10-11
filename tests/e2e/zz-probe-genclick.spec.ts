import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * TEMPORARY probe — why does `click()` on GEN never complete?
 *
 * Against the PRODUCTION build the core suite reports 8 passed / 5 failed, and
 * three of the five fail on the same line:
 *
 *   await page.locator('.pattern-actions button:has-text("GEN")').click();
 *   Error: waiting for element to be visible, enabled and stable
 *
 * The button IS in the accessibility tree at failure time (proved in the
 * error-context snapshot), so "missing" and "hidden" are both falsified. What
 * is left is the third clause: STABLE — Playwright requires the bounding box
 * to be identical across two consecutive animation frames, and a control that
 * never settles can never be clicked by a user either.
 *
 * Two candidate causes, and they are not the same defect:
 *   a) layout feedback — the panel's height depends on its content and the
 *      content's height depends on the panel's height, so the box oscillates;
 *   b) a constant animation/transient on the panel subtree.
 *
 * Sample the rect across frames and print the whole ancestor chain's geometry
 * so the loop, if it is one, is visible rather than inferred.
 */
test("GEN button geometry over consecutive animation frames", async ({ page }) => {
  test.setTimeout(120_000);
  await openHouseTemplate(page);

  const btn = page.locator('.pattern-actions button:has-text("GEN")');
  await btn.waitFor({ state: "attached", timeout: 30_000 });

  const report = await page.evaluate(async () => {
    const el = Array.from(document.querySelectorAll<HTMLButtonElement>(".pattern-actions button")).find((b) =>
      (b.textContent ?? "").includes("GEN"),
    );
    if (!el) return { error: "GEN button not found" };

    const chain = (node: Element | null) => {
      const out: string[] = [];
      let n: Element | null = node;
      while (n && out.length < 10) {
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        out.push(
          `${n.tagName.toLowerCase()}.${(n.className || "").toString().split(" ").slice(0, 3).join(".")} ` +
            `box=${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)}x${r.height.toFixed(1)} ` +
            `scrollH=${n.scrollHeight} clientH=${n.clientHeight} ` +
            `overflow=${cs.overflow}/${cs.overflowY} minH=${cs.minHeight} flex=${cs.flex}`,
        );
        n = n.parentElement;
      }
      return out;
    };

    const frames: Array<{ y: number; h: number }> = [];
    await new Promise<void>((resolve) => {
      let n = 0;
      const tick = () => {
        const r = el.getBoundingClientRect();
        frames.push({ y: Math.round(r.y * 10) / 10, h: Math.round(r.height * 10) / 10 });
        if (++n >= 30) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const anim = el.getAnimations({ subtree: true }).length;

    return {
      frames,
      distinct: new Set(frames.map((f) => `${f.y}:${f.h}`)).size,
      hitTest: hit ? `${hit.tagName.toLowerCase()}.${(hit.className || "").toString().split(" ").slice(0, 3).join(".")}` : "null",
      isSelf: hit === el || el.contains(hit),
      runningAnimations: anim,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      chain: chain(el),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });

  console.info(`GENPROBE ${JSON.stringify(report, null, 1)}`);
  expect(report).not.toHaveProperty("error");
});