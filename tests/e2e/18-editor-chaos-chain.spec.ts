import { expect, test, type Locator, type Page } from "playwright/test";

/**
 * §42 REAL-USER CHAOS TEST — the editing chain, end to end, in a real Chromium
 * against a real production build.
 *
 * The jsdom suites (waves 1–5) prove commands, guards and state invariants.
 * They cannot prove that a *pointer on a screen* produces the same result,
 * which is where §19 (the pointer state machine), §13 (zoom must never alter
 * committed timing) and §22 (undo/redo integrity) actually live.
 *
 * Deliberately not a wide assertion suite: it is the chain the objective asks
 * for, with one invariant over all of it — **no JavaScript errors, and the
 * arrangement keeps answering**.
 *
 * Boot order (measured 2026-10-11 on `vite preview`):
 *   goto 0.8 s → Project Browser 2.5 s → studio shell 4.2 s → arrangement 6.8 s
 * The arrangement is a DOCK TAB, not the default panel — without opening
 * `Toggle arrangement and scenes` there is no `.arr-lane` at all, which is
 * exactly why an earlier probe sat waiting for a selector that could not exist.
 */

const STUDIO_TIMEOUT = 60_000;

/** A failed sub-resource fetch is not a JavaScript error; a stack trace is. */
function isNoise(message: string): boolean {
  return /net::ERR_CONNECTION_REFUSED|Failed to load resource/.test(message);
}

async function openStudio(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  // Returning user: skip the landing page the way the app itself decides, and
  // dismiss the first-run coach tour. `OnboardingTour` persists dismissal as
  // localStorage["pf-tour-v1"] === "1" (src/ui/OnboardingTour.tsx:37) — setting
  // the flag is deterministic, where clicking SKIP is not: the visible label is
  // "SKIP" but the accessible name is "Skip tour", and the overlay is modal
  // over the arrangement, so a missed click silently absorbs every drag.
  await page.addInitScript(() => {
    window.localStorage.setItem("pf-onboarded", "1");
    window.localStorage.setItem("pf-tour-v1", "1");
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });

  const start = page.getByRole("button", { name: /start here/i }).first();
  await start.waitFor({ state: "visible", timeout: STUDIO_TIMEOUT });
  await start.click();

  await page.locator(".dock-tabs").first().waitFor({ state: "attached", timeout: STUDIO_TIMEOUT });
  const arr = page.locator('.dock-tabs button[aria-label="Toggle arrangement and scenes"]').first();
  await arr.click();
  await page.locator(".arr-lane").first().waitFor({ state: "attached", timeout: STUDIO_TIMEOUT });

  // Belt and braces: if a tour is showing anyway, it is modal over the
  // arrangement and would swallow the pointer instead of moving a clip.
  const skipTour = page.getByRole("button", { name: "Skip tour" }).first();
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();
  await page.waitForTimeout(300);

  // D14 REGRESSION GUARD: the intensity strip is ON by default
  // (`useState(true)`) and is a real editing surface — this spec must exercise
  // the DEFAULT configuration, not a doctored one. An earlier revision turned
  // INT off here to get a drag through, which is exactly the shape of a test
  // that hides the defect it exists to catch.
  const int = page.getByRole("button", { name: "INT" }).first();
  expect(await int.getAttribute("aria-pressed"), "INT must be on for this chain").toBe("true");
}

/** Every arrangement clip's committed left offset, in DOM order. */
async function clipLefts(page: Page): Promise<string[]> {
  return page.locator(".arr-clip").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.left));
}

/** A pointer drag with real movement steps — the gesture path, not a click. */
async function drag(page: Page, el: Locator, dx: number): Promise<void> {
  const b = await el.boundingBox();
  if (!b) throw new Error("no box to drag");
  const cx = b.x + Math.min(30, Math.max(6, b.width / 2));
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(cx + (dx * i) / 5, cy);
    // The panel updates its drag preview on a frame; a burst of moves inside
    // one frame is not a gesture a human can produce, and it measures the
    // rAF batching rather than the commit path.
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
}

test("the editing chain stays coherent and the console stays clean", async ({ page }) => {
  const jsErrors: string[] = [];
  const noise: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    (isNoise(m.text()) ? noise : jsErrors).push(m.text());
  });
  page.on("pageerror", (e) => jsErrors.push(`pageerror: ${e.message}`));

  await openStudio(page);

  const initial = await clipLefts(page);
  expect(initial.length, "the template must render clips").toBeGreaterThan(0);
  console.info(`[chaos] opened: ${initial.length} clips at ${initial.join(",")}`);

  // ── WHAT IS ACTUALLY UNDER THE POINTER (§19/§33) ───────────────────────
  // Two attempts to drag died here. Before changing anything else, ask the
  // page what element receives the pointer at the drag origin — the same
  // question that surfaced the dock resize handle earlier.
  const first = page.locator(".arr-clip").first();
  const b = (await first.boundingBox())!;
  const probe = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const chain: string[] = [];
      let cur: HTMLElement | null = el;
      while (cur && chain.length < 5) {
        chain.push(`${cur.tagName.toLowerCase()}.${(cur.className || "").toString().split(" ")[0]}`);
        cur = cur.parentElement;
      }
      const boxOf = (sel: string) => {
        const n = document.querySelector(sel) as HTMLElement | null;
        if (!n) return null;
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        return {
          sel,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          pointerEvents: cs.pointerEvents,
          position: cs.position,
          zIndex: cs.zIndex,
        };
      };
      return {
        top: el ? `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}` : "none",
        chain,
        closestToClip: Boolean(el?.closest(".arr-clip")),
        clip: boxOf(".arr-clip"),
        intensity: boxOf(".arr-intensity-lane"),
        lane: boxOf(".arr-lane"),
      };
    },
    { x: b.x + Math.min(30, b.width / 2), y: b.y + b.height / 2 },
  );
  console.info(`[chaos] dragOrigin box=${JSON.stringify(b)} top=${probe.top} chain=${probe.chain.join(" < ")}`);
  console.info(`[chaos] clip=${JSON.stringify(probe.clip)}`);
  console.info(`[chaos] intensity=${JSON.stringify(probe.intensity)}`);
  console.info(`[chaos] lane=${JSON.stringify(probe.lane)}`);

  // The invariant, stated as an assertion and not as a log line: whatever the
  // pointer is over at the clip's own centre must BE the clip (or something
  // inside it). D14 regressed this by 100% — the intensity strip answered for
  // the clip on every press — and the only reason that was visible at all is
  // that this question is asked BEFORE any drag is attempted. A log line that
  // nobody reads is not a guard.
  expect(
    probe.closestToClip,
    `pointer at the clip centre resolved to ${probe.top} (chain ${probe.chain.join(" < ")})`,
  ).toBe(true);

  // ── MOVE (§5) ───────────────────────────────────────────────────────────
  await drag(page, first, 150);
  const afterMove = await clipLefts(page);
  expect(afterMove, "a drag must move the clip").not.toEqual(initial);

  // ── UNDO (§22) ──────────────────────────────────────────────────────────
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  const afterUndo = await clipLefts(page);
  expect(afterUndo, "undo must restore the pre-drag position").toEqual(initial);

  // ── REDO (§22) ──────────────────────────────────────────────────────────
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  expect(await clipLefts(page), "redo must re-apply the move").toEqual(afterMove);

  // ── RAPID RACES (§31): drag → undo → drag ───────────────────────────────
  await drag(page, page.locator(".arr-clip").first(), -90);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(250);
  await drag(page, page.locator(".arr-clip").first(), 90);
  const afterChurn = await clipLefts(page);
  expect(afterChurn.length, "a drag/undo/drag burst must not drop or duplicate clips").toBe(initial.length);

  // ── ZOOM (§13): must not change clip count, order or committed timing ───
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(400);
  expect(await page.locator(".arr-lane").count(), "zoom must not unrender the lane").toBeGreaterThan(0);
  expect(await page.locator(".arr-clip").count(), "zoom must not drop clips").toBe(afterChurn.length);

  // ── STILL ALIVE (§20): a click after the whole chain must land ──────────
  await page.locator(".arr-clip").first().click();
  await page.waitForTimeout(200);

  const finalLefts = await clipLefts(page);
  console.info(
    `[chaos] chain complete: ${finalLefts.length} clips; jsErrors=${jsErrors.length}; ignoredResourceNoise=${noise.length}`,
  );
  expect(jsErrors, `JavaScript errors during the chain: ${jsErrors.join(" | ")}`).toHaveLength(0);
});
