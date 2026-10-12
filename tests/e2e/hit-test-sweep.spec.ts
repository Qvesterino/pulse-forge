import { expect, test } from "playwright/test";

import { hitAll, openArrangement } from "./_studio";

/**
 * THE HIT-TEST SWEEP — the class of defect this suite could not previously see.
 *
 * Two of this audit's confirmed defects were the SAME bug: something
 * invisible sat on top of an editing surface and answered for it. Wave 9:
 * the scene-intensity strip was the last in-flow child of a fixed-height lane
 * and, being a later sibling of the absolutely positioned clips with equal
 * `z-index: auto`, took the top hit for the whole clip row. Wave 10: the
 * fixed onboarding bar landed on the lane at 900 px and did the same.
 *
 * Neither was caught by a unit test, because jsdom has no layout and therefore
 * no hit-testing. They were caught by asking one question of a real page —
 * "what is actually under the pointer here?" — which is why this file exists
 * as a standing check rather than a one-off probe.
 *
 * The sweep runs at three viewport sizes, because a fixed overlay only has to
 * collide at ONE of them to be a defect (D15 only appeared below 1280).
 *
 * Built-in falsification: the last test injects an overlay that covers the
 * lane and asserts the sweep reports it. A check that cannot go red is a
 * decoration, so this one is required to demonstrate that it can.
 */

/** Surfaces the user must be able to press. Order is only for stable logs. */
const SURFACES: { selector: string; why: string }[] = [
  { selector: ".arr-clip", why: "select and drag a scene clip" },
  { selector: ".arr-clip .arr-clip-resize", why: "trim from the right edge" },
  { selector: ".arr-ruler", why: "seek and drag-select a time range" },
  { selector: ".arr-lane", why: "marquee-select on empty lane space" },
  { selector: ".arr-intensity-point", why: "edit a scene-intensity point" },
  { selector: ".arr-audio-clip", why: "select and drag a recorded audio clip" },
];

/**
 * Surfaces that MUST be click-through. These are decorative layers: if the
 * grid line answers for the lane beneath it, every empty-lane gesture in the
 * app silently stops working — a failure that looks like "drag is broken".
 */
const CLICK_THROUGH: { selector: string; why: string }[] = [
  { selector: ".arr-bar-grid", why: "bar gridlines are decorative; the lane below must receive the press" },
];

const VIEWPORTS: { width: number; height: number; label: string }[] = [
  { width: 1280, height: 720, label: "1280x720" },
  { width: 1100, height: 800, label: "1100x800" },
  { width: 900, height: 700, label: "900x700" },
];

test.describe("arrangement hit-testing", () => {
  for (const viewport of VIEWPORTS) {
    test(`no editing surface is covered at ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openArrangement(page);

      const blocked: string[] = [];
      const absent: string[] = [];

      for (const surface of SURFACES) {
        const results = await hitAll(page, surface.selector);
        if (results.length === 0) {
          absent.push(`${surface.selector} (${surface.why})`);
          continue;
        }
        for (const r of results) {
          if (!r.inside) {
            blocked.push(`${surface.selector}[${r.index}] -> ${r.hit}  (must press itself to ${surface.why})`);
          }
        }
      }

      for (const layer of CLICK_THROUGH) {
        const results = await hitAll(page, layer.selector);
        for (const r of results) {
          if (r.inside) {
            blocked.push(`${layer.selector}[${r.index}] answered for itself (${r.hit}); ${layer.why}`);
          }
        }
      }

      console.info(`[sweep ${viewport.label}] blocked=${blocked.length} absent=${absent.length}`);
      for (const line of absent) console.info(`[sweep ${viewport.label}]   not rendered: ${line}`);
      for (const line of blocked) console.info(`[sweep ${viewport.label}]   BLOCKED: ${line}`);
      expect(blocked, blocked.join("\n")).toHaveLength(0);
    });
  }

  test("the sweep reports an overlay that covers the lane — its own falsification", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openArrangement(page);

    // Control: the clean page blocks nothing, or every result below is noise.
    const clean = await hitAll(page, ".arr-clip");
    expect(clean.length, "the fixture must render clips to be worth sweeping").toBeGreaterThan(0);
    expect(
      clean.filter((r) => !r.inside),
      "the clean page is already blocked — fix that first",
    ).toHaveLength(0);

    // Inject the exact shape of D14: a later sibling covering the whole lane.
    // NO class from the stylesheet — the first version of this control reused
    // `.arr-bar-grid`, which carries `pointer-events: none`, so the "overlay"
    // was click-through and the sweep correctly reported nothing blocked. The
    // control has to be a real blocker or it proves nothing.
    await page.evaluate(() => {
      const lane = document.querySelector(".arr-lane") as HTMLElement | null;
      if (!lane) throw new Error("no lane");
      const cover = document.createElement("div");
      cover.id = "sweep-control-cover";
      Object.assign(cover.style, {
        position: "absolute",
        inset: "0",
        zIndex: "5",
        background: "rgba(255,0,0,0.25)",
        pointerEvents: "auto",
      });
      lane.appendChild(cover);
    });

    const covered = await hitAll(page, ".arr-clip");
    const blockedNow = covered.filter((r) => !r.inside);
    console.info(
      `[sweep control] after injecting a cover: ${blockedNow.length}/${covered.length} clips blocked` +
        (blockedNow[0] ? `, hit=${blockedNow[0].hit}` : ""),
    );
    expect(blockedNow.length, "an overlay covering the lane must be detected").toBeGreaterThan(0);
  });
});
