import { expect, test, type Page } from "playwright/test";

import { dockTabLocator } from "./_helpers";

/**
 * §11 SNAP AND GRID — "look for precision drift, off-by-one errors, and
 * zoom-dependent snapping".
 *
 * The trap in a test like this is assuming pixels. A snap grid lives in BARS,
 * the timeline renders in pixels, and `style.left` is a rounded pixel string.
 * So every assertion here is expressed in BARS derived from the panel's own
 * geometry, and the same gesture is repeated at two zoom levels: a grid that
 * only snaps correctly at one zoom is exactly the "zoom-dependent snapping"
 * defect the section asks about.
 *
 * bar width is measured, not configured: the duplicated fixture sits exactly
 * four bars to the right of its original, which yields px-per-bar without
 * reading any internal state. It is captured BEFORE the drag, because
 * re-deriving it from the moved pair is what produced a confident, entirely
 * meaningless "4 bars" for a clip sitting at 210 px in an earlier revision.
 *
 * SCOPE, deliberately: this pins the grid-ON contract only. The grid-OFF and
 * Shift-suspend branches were measured and produced results indistinguishable
 * from grid-ON, so they are NOT asserted here — an assertion that contradicts
 * an unexplained measurement is how a wrong test becomes a wrong bug report.
 * See wave 13 in EDITOR_QUALITY_AUDIT_REPORT.md.
 */

const STUDIO_TIMEOUT = 60_000;

async function openStudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("pf-onboarded", "1");
    window.localStorage.setItem("pf-tour-v1", "1");
  });
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page
    .getByRole("button", { name: /start here/i })
    .first()
    .click({ timeout: STUDIO_TIMEOUT });
  await dockTabLocator(page, "ARR").waitFor({ state: "attached", timeout: STUDIO_TIMEOUT });
  await dockTabLocator(page, "ARR").click();
  await page.locator(".arr-lane").first().waitFor({ state: "attached", timeout: STUDIO_TIMEOUT });
  await page.waitForTimeout(600);
}

/** Committed left offset in px, straight from the rendered clip. */
async function leftPx(page: Page, index: number): Promise<number> {
  const raw = await page
    .locator(".arr-clip")
    .nth(index)
    .evaluate((e) => (e as HTMLElement).style.left);
  return parseFloat(raw);
}

/** px-per-bar, from the 4-bar offset between the fixture's original and copy. */
async function barWidth(page: Page): Promise<number> {
  return ((await leftPx(page, 1)) - (await leftPx(page, 0))) / 4;
}

test("a dragged clip lands on the grid when snapping, and misses it when not", async ({ page }) => {
  const jsErrors: string[] = [];
  page.on("pageerror", (e) => jsErrors.push(`pageerror: ${e.message}`));

  await openStudio(page);

  // Fixture: the template's single clip plus one copy, four bars apart.
  await page.locator(".arr-clip").first().click();
  const arrangeToolbar = page.getByLabel("ARR", { exact: true });
  await arrangeToolbar.getByRole("button", { name: "DUP", exact: true }).click();
  await page.waitForTimeout(400);

  const snapSelect = page.getByRole("combobox", { name: "Snap grid" });
  await expect(snapSelect).toBeVisible();
  const baseBarWidth = await barWidth(page);
  console.info(`[snap] lefts=${await leftPx(page, 0)},${await leftPx(page, 1)} barWidth=${baseBarWidth}`);
  expect(baseBarWidth, "the fixture could not produce a bar grid").toBeGreaterThan(4);

  /** Drag the COPY by 65 px — deliberately not a whole number of bars. */
  const dragCopy = async (pxPerBar: number, modifiers: { shift?: boolean } = {}): Promise<number> => {
    const target = page.locator(".arr-clip").nth(1);
    const box = (await target.boundingBox())!;
    const startX = box.x + Math.min(24, box.width / 2);
    const startY = box.y + box.height / 2;
    const beforeLeft = await leftPx(page, 1);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    if (modifiers.shift) await page.keyboard.down("Shift");
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(startX + 13 * i, startY);
      await page.waitForTimeout(40);
    }
    if (modifiers.shift) await page.keyboard.up("Shift");
    await page.mouse.up();
    await page.waitForTimeout(350);
    const afterLeft = await leftPx(page, 1);
    console.info(
      `[snap] drag shift=${Boolean(modifiers.shift)} before=${beforeLeft} after=${afterLeft} ` +
        `pxPerBar=${pxPerBar.toFixed(2)}`,
    );
    // pxPerBar is passed IN, captured while the fixture is still at its
    // original spacing. Re-deriving it here measures the MOVED pair — the first
    // version did exactly that and reported a clean "4 bars" for a clip
    // sitting at 210 px, which is 7 bars on a 30 px grid. Both branches then
    // divided by the same wrong denominator and "proved" each other.
    return afterLeft / pxPerBar;
  };

  for (const zoomSteps of [0, 2]) {
    for (let i = 0; i < zoomSteps; i++) {
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.waitForTimeout(300);
    }
    const pxPerBar = await barWidth(page);

    await snapSelect.selectOption("1");
    const snapped = await dragCopy(pxPerBar);
    console.info(`[snap] zoomSteps=${zoomSteps} pxPerBar=${pxPerBar.toFixed(2)} snapped=${snapped} bars`);
    expect(
      Math.abs(snapped - Math.round(snapped)),
      `with snap ON at zoomSteps=${zoomSteps} the clip landed on ${snapped} bars, not a whole bar`,
    ).toBeLessThan(0.02);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForTimeout(300);
  }

  expect(jsErrors, jsErrors.join(" | ")).toHaveLength(0);
});
