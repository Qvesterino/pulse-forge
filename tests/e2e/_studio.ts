import type { Page } from "playwright/test";

import { dockTabLocator } from "./_helpers";

/**
 * Shared studio harness for the arrangement/timeline E2E specs.
 *
 * This module exists because of a measured cost, not for tidiness. Getting a
 * loaded, hittable editor in front of a Playwright page required defeating,
 * in order, all of these:
 *
 *   1. the landing page          -> localStorage["pf-onboarded"] = "1"
 *   2. the first-run coach tour   -> localStorage["pf-tour-v1"] = "1"
 *      (the tour is modal OVER the arrangement, so a missed skip silently
 *       absorbs every drag instead of moving a clip)
 *   3. the arrangement is a DOCK TAB, not the default panel
 *   4. the one-shot gesture-hint toast sits over the timeline for 4.5 s
 *
 * Each of those cost a failed drag before it was identified. A spec that
 * forgets one of them fails in a way that looks like an editor defect, which
 * is the most expensive kind of wrong answer this suite can give.
 */

const STUDIO_TIMEOUT = 60_000;

/** Deterministic boot: returning user, tour dismissed, arrangement open. */
export async function openArrangement(page: Page): Promise<void> {
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
  await dismissTransientToasts(page);
}

/**
 * The gesture-hint toast is a legitimate, dismissible, temporary overlay — it
 * is not a defect. It is removed here so that hit-testing a surface below it
 * measures the LAYOUT, not a 4.5-second toast.
 */
export async function dismissTransientToasts(page: Page): Promise<boolean> {
  const wasUp = await dismissIfPresent(page, 'button[aria-label="Dismiss onboarding"]');
  const hinted = await dismissIfPresent(page, 'button[aria-label="Dismiss hint"]');
  const tour = await dismissIfPresent(page, 'button[aria-label="Skip tour"]');
  if (wasUp || hinted || tour) await page.waitForTimeout(250);
  return wasUp || hinted || tour;
}

async function dismissIfPresent(page: Page, selector: string): Promise<boolean> {
  const button = page.locator(selector).first();
  if (!(await button.isVisible().catch(() => false))) return false;
  await button.click();
  return true;
}

/**
 * What the pointer at a surface's own centre resolves to, and whether that is
 * the surface itself or something inside it.
 *
 * `closest()` is the right question rather than identity: a clip's centre
 * legitimately contains its name span and its bars badge, and pressing those
 * IS pressing the clip. What must never happen is the hit landing OUTSIDE the
 * surface — an overlay answering for it.
 */
export async function hitAt(
  page: Page,
  selector: string,
  index = 0,
): Promise<{
  found: boolean;
  inside: boolean;
  hit: string;
}> {
  return page.evaluate(
    ({ selector: sel, index: i }) => {
      const el = document.querySelectorAll(sel)[i] as HTMLElement | undefined;
      if (!el) return { found: false, inside: false, hit: "absent" };
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        return { found: true, inside: false, hit: "zero-size" };
      }
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
      const name = (n: HTMLElement | null) =>
        n ? `${n.tagName.toLowerCase()}.${(n.className || "").toString().split(" ")[0]}` : "none";
      return { found: true, inside: Boolean(at?.closest(sel)), hit: name(at) };
    },
    { selector, index },
  );
}

/** Every occurrence of a selector, so a sweep can report "3 of 4 blocked". */
export async function hitAll(page: Page, selector: string): Promise<{ index: number; inside: boolean; hit: string }[]> {
  return page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    return els.map((el, index) => {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
      const name = (n: HTMLElement | null) =>
        n ? `${n.tagName.toLowerCase()}.${(n.className || "").toString().split(" ")[0]}` : "none";
      return { index, inside: Boolean(at?.closest(sel)), hit: name(at) };
    });
  }, selector);
}

/** Committed geometry of the arrangement clips, in DOM order. */
export async function clipGeometry(page: Page): Promise<{ left: number; width: number }[]> {
  return page.locator(".arr-clip").evaluateAll((els) =>
    els.map((e) => ({
      left: parseFloat((e as HTMLElement).style.left) || 0,
      width: parseFloat((e as HTMLElement).style.width) || 0,
    })),
  );
}
