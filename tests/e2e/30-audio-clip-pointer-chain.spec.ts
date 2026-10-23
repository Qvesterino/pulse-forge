import { expect, test, type Locator, type Page } from "playwright/test";
import { openArrangement } from "./_studio";

/**
 * WAVE 30 — the browser pointer chain, per verb.
 *
 * THE POINT OF THIS WAVE. The wave-3 matrices drive the COMMANDS directly and
 * assert the document; wave 29 proves the render follows the document. Neither
 * touches the layer in between, and that layer is where a user loses work:
 *
 *     pointer → handler → command → store → DOM
 *
 * A verb can be perfectly implemented in the command layer and still be
 * unreachable, wired to the wrong handle, snapped to the wrong target, or
 * commit three undo entries for one drag. This spec drives the REAL input
 * path — `page.mouse` presses, drags and releases; `page.keyboard` verbs; the
 * real context menu — and then reads what the browser actually committed.
 *
 * THE ORACLE IS THE DOM, AND THE DOM IS A STATE FINGERPRINT. The audio clip
 * carries a title that spells out its committed state:
 *
 *     <track> · <buffer> · [LOCKED ][MUTED ][REV ][LOOP ]3b · trim 0.00/0.00
 *     fade 0.00/0.00 gain 1.00 — M mutes · …
 *
 * plus its committed `left`/`width` in px and its class list. Together they
 * are enough to tell "the gesture reached the command" from "the gesture
 * moved the picture but changed nothing".
 *
 * ONE GESTURE = ONE UNDO ENTRY is asserted the only way a browser can
 * assert it: after the gesture, ONE Ctrl+Z must restore the pre-gesture
 * fingerprint EXACTLY, and ONE Ctrl+Y must re-apply it exactly. If a drag
 * wrote intermediate states into the store, the first undo would land on an
 * intermediate state instead of the original — which is the defect, caught
 * where it actually hurts the user.
 *
 * THE FIXTURE IS THE APP'S OWN. `BOUNCE ZONE` offline-renders the selected
 * zone and flips it into a real audio clip — a real buffer in the live bank,
 * waveform included. That matters for the verbs that read the bank: SLIP
 * computes its ceiling from the sample's real duration, and a clip with no
 * buffer would make the slip gesture a no-op that silently "passes".
 */

/** The committed state of the arrangement's audio clips, read from the DOM. */
interface ClipState {
  count: number;
  title: string;
  left: number;
  width: number;
  classes: string;
  fadeInTitle: string;
  fadeOutTitle: string;
  gainTitle: string;
}

async function clipState(page: Page): Promise<ClipState> {
  return page.evaluate(() => {
    const clip = document.querySelector(".arr-audio-clip") as HTMLElement | null;
    const title = (el: Element | null) => (el ? (el.getAttribute("title") ?? "") : "");
    return {
      count: document.querySelectorAll(".arr-audio-clip").length,
      title: title(clip),
      left: clip ? parseFloat(clip.style.left) || 0 : 0,
      width: clip ? parseFloat(clip.style.width) || 0 : 0,
      classes: clip ? clip.className : "",
      fadeInTitle: title(clip?.querySelector(".arr-audio-clip-handle-fade.left") ?? null),
      fadeOutTitle: title(clip?.querySelector(".arr-audio-clip-handle-fade.right") ?? null),
      gainTitle: title(clip?.querySelector(".arr-audio-clip-handle-gain") ?? null),
    };
  });
}

/**
 * A hash of the committed waveform pixels. The slip gesture writes
 * `offsetSec`, which the title does NOT show — the only way to see the
 * committed slip in the DOM is the envelope the waveform draws, because that
 * window is derived from the same offset the engine plays.
 */
async function waveformHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector(".arr-audio-clip canvas") as HTMLCanvasElement | null;
    if (!canvas) return "";
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 7) {
      hash ^= pixels[index];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  });
}

/** The clip's box in viewport coordinates, after scrolling it into view. */
async function clipBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const clip = page.locator(".arr-audio-clip").first();
  await clip.scrollIntoViewIfNeeded();
  const box = await clip.boundingBox();
  if (!box) throw new Error("the audio clip has no box");
  return box;
}

/**
 * A point ON a handle, in viewport coordinates.
 *
 * The fade handles are triangles cut with `clip-path`, which DOES affect
 * hit-testing: the centre of a 12×12 triangle is on its hypotenuse, and a
 * click there lands on the clip body instead — the gesture would then be a
 * MOVE, not a fade, and the test would measure the wrong verb. The corners
 * named below are inside the visible triangle.
 */
async function handlePoint(
  page: Page,
  selector: string,
  corner: "top-left" | "top-right" | "center",
): Promise<{ x: number; y: number }> {
  const handle = page.locator(`.arr-audio-clip ${selector}`).first();
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error(`handle ${selector} has no box`);
  if (corner === "top-left") return { x: box.x + 3, y: box.y + 3 };
  if (corner === "top-right") return { x: box.x + box.width - 3, y: box.y + 3 };
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}


/**
 * A real drag: press, move in steps, release. The steps matter — a single
 * jump-move would let a handler that only reacts to the last event miss the
 * gesture, which is a real class of bug and not worth papering over.
 */
async function dragBy(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
  modifiers: Array<"Alt" | "Shift" | "Control"> = [],
): Promise<void> {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 8;
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(from.x + (dx * step) / steps, from.y + (dy * step) / steps);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  await page.waitForTimeout(220);
}

/**
 * The fixture: a real audio clip, produced by the app itself.
 *
 * BOUNCE ZONE is `disabled={!selection.timeRange}`, so the whole spec
 * depends on producing a real time range. The attempt list mirrors
 * `audio-fades.spec.ts`: the ruler's plain drag, then the lane's ctrl- and
 * shift-drag, with the button's own enabled state as the oracle. Each
 * attempt scrolls its target into view FIRST — layout coordinates below the
 * fold are not pointer coordinates, and a gesture that never arrives looks
 * exactly like a gesture that does nothing.
 */
async function bounceAudioClip(page: Page): Promise<Locator> {
  const bounce = page.getByRole("button", { name: /BOUNCE ZONE/i });
  const lane = page.locator(".arr-lane").first();
  const ruler = page.locator(".arr-ruler").first();

  const attempt = async (
    label: string,
    selector: Locator,
    modifier: "none" | "Control" | "Shift",
    dx: number,
  ): Promise<boolean> => {
    await selector.scrollIntoViewIfNeeded();
    const box = await selector.boundingBox();
    if (!box) return false;
    const y = box.y + box.height / 2;
    const startX = box.x + Math.min(120, box.width / 3);
    if (modifier !== "none") await page.keyboard.down(modifier);
    await page.mouse.move(startX, y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step++) {
      await page.mouse.move(startX + (dx * step) / 6, y);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    if (modifier !== "none") await page.keyboard.up(modifier);
    await page.waitForTimeout(350);
    const enabled = await bounce.isEnabled();
    console.info(`[chain] zone attempt ${label}: BOUNCE ZONE enabled=${enabled}`);
    if (enabled) return true;
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    return false;
  };

  const gotZone =
    (await attempt("ruler plain drag", ruler, "none", 260)) ||
    (await attempt("lane ctrl+drag", lane, "Control", 260)) ||
    (await attempt("lane shift+drag", lane, "Shift", 260));
  expect(gotZone, "no gesture produced the time range BOUNCE ZONE requires").toBe(true);

  await bounce.click();

  // The offline render is real work: its completion is the only signal that
  // an audio clip exists. Waiting on the CLIP beats waiting on a delay.
  const clip = page.locator(".arr-audio-clip").first();
  await clip.waitFor({ state: "attached", timeout: 60_000 });
  await expect(clip).toBeVisible();
  return clip;
}

/** Ctrl+Z / Ctrl+Y, then let the panel re-render. */
async function undo(page: Page): Promise<void> {
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(220);
}
async function redo(page: Page): Promise<void> {
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(220);
}

/**
 * ONE GESTURE = ONE UNDO ENTRY. After the gesture committed, a single undo
 * must restore the pre-gesture fingerprint exactly and a single redo must
 * re-apply it exactly.
 */
async function assertOneUndoStep(page: Page, before: ClipState, after: ClipState, label: string): Promise<void> {
  await undo(page);
  const undone = await clipState(page);
  expect(undone, `${label}: ONE undo did not restore the pre-gesture state`).toEqual(before);
  await redo(page);
  const redone = await clipState(page);
  expect(redone, `${label}: ONE redo did not re-apply the gesture`).toEqual(after);
}

test.describe("30 — audio clip pointer chain per verb", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    page.on("pageerror", (e) => jsErrors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/net::ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) {
        jsErrors.push(m.text());
      }
    });
  });

  test("every pointer gesture reaches the command and lands exactly one undo step", async ({ page }) => {
    test.setTimeout(240_000);
    await openArrangement(page);
    const clip = await bounceAudioClip(page);

    const pristine = await clipState(page);
    expect(pristine.count, "the bounce produced no audio clip").toBe(1);
    expect(pristine.title, "the clip carries no state fingerprint").toContain("gain");
    console.info(`[chain] clip title: ${pristine.title}`);

    // ── MOVE (drag the body) ──────────────────────────────────────────────
    {
      const before = await clipState(page);
      const box = await clipBox(page);
      const dx = Math.max(24, Math.round(box.width * 0.25));
      await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, dx, 0);
      const after = await clipState(page);
      expect(after.left, "the move did not move the clip").toBeGreaterThan(before.left);
      expect(after.width, "the move changed the clip's width").toBe(before.width);
      expect(after.title, "the move changed the clip's state").toBe(before.title);
      await assertOneUndoStep(page, before, after, "move");
    }

    // ── RESIZE (drag the right edge) ──────────────────────────────────────
    {
      const before = await clipState(page);
      const box = await clipBox(page);
      const dx = Math.max(20, Math.round(box.width * 0.3));
      await dragBy(page, { x: box.x + box.width - 4, y: box.y + box.height / 2 }, dx, 0);
      const after = await clipState(page);
      expect(after.width, "the resize did not widen the clip").toBeGreaterThan(before.width);
      expect(after.left, "the resize moved the clip").toBe(before.left);
      await assertOneUndoStep(page, before, after, "resize");
    }

    // ── TRIM START (drag the left edge right) ─────────────────────────────
    {
      const before = await clipState(page);
      const box = await clipBox(page);
      const dx = Math.max(12, Math.round(box.width * 0.15));
      await dragBy(page, { x: box.x + 4, y: box.y + box.height / 2 }, dx, 0);
      const after = await clipState(page);
      expect(after.width, "the trim did not shorten the clip").toBeLessThan(before.width);
      expect(after.left, "the trim did not move the clip's head").toBeGreaterThan(before.left);
      expect(after.title, "the trim did not write the source advance").not.toBe(before.title);
      await assertOneUndoStep(page, before, after, "trim start");
    }

    // ── FADE IN (drag the top-left fade handle right) ─────────────────────
    {
      const before = await clipState(page);
      const box = await clipBox(page);
      await dragBy(page, await handlePoint(page, ".arr-audio-clip-handle-fade.left", "top-left"), Math.max(16, Math.round(box.width * 0.3)), 0);
      const after = await clipState(page);
      expect(after.fadeInTitle, "the fade-in handle did not report a fade").not.toBe(before.fadeInTitle);
      expect(after.title, "the fade in did not reach the clip's state").not.toBe(before.title);
      await assertOneUndoStep(page, before, after, "fade in");
    }

    // ── FADE OUT (drag the top-right fade handle left) ────────────────────
    {
      const before = await clipState(page);
      const box = await clipBox(page);
      await dragBy(page, await handlePoint(page, ".arr-audio-clip-handle-fade.right", "top-right"), -Math.max(16, Math.round(box.width * 0.3)), 0);
      const after = await clipState(page);
      expect(after.fadeOutTitle, "the fade-out handle did not report a fade").not.toBe(before.fadeOutTitle);
      expect(after.title, "the fade out did not reach the clip's state").not.toBe(before.title);
      await assertOneUndoStep(page, before, after, "fade out");
    }

    // ── GAIN (drag the top-middle handle up) ──────────────────────────────
    {
      const before = await clipState(page);
      await dragBy(page, await handlePoint(page, ".arr-audio-clip-handle-gain", "center"), 0, -40);
      const after = await clipState(page);
      expect(after.gainTitle, "the gain handle did not report a gain").not.toBe(before.gainTitle);
      expect(after.title, "the gain did not reach the clip's state").not.toBe(before.title);
      await assertOneUndoStep(page, before, after, "gain");
    }

    // ── SLIP (Alt + drag the body) ────────────────────────────────────────
    // The slip writes `offsetSec`, which the title does not show. The only
    // DOM witness is the waveform envelope, which is drawn from the same
    // offset the engine plays.
    {
      const before = await clipState(page);
      const beforeWave = await waveformHash(page);
      const box = await clipBox(page);
      const dx = Math.max(16, Math.round(box.width * 0.2));
      await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, dx, 0, ["Alt"]);
      const after = await clipState(page);
      const afterWave = await waveformHash(page);
      expect(afterWave, "the slip did not move the drawn source window").not.toBe(beforeWave);
      expect(after.title, "the slip changed the clip's title").toBe(before.title);
      await undo(page);
      expect(await waveformHash(page), "ONE undo did not restore the slipped waveform").toBe(beforeWave);
      await redo(page);
      expect(await waveformHash(page), "ONE redo did not re-apply the slip").toBe(afterWave);
    }

    // ── STRETCH (Alt + drag the right edge) ───────────────────────────────
    {
      const before = await clipState(page);
      const box = await clipBox(page);
      const dx = Math.max(20, Math.round(box.width * 0.3));
      await dragBy(page, { x: box.x + box.width - 4, y: box.y + box.height / 2 }, dx, 0, ["Alt"]);
      const after = await clipState(page);
      expect(after.title, "the stretch did not change the clip's rate").not.toBe(before.title);
      await assertOneUndoStep(page, before, after, "stretch");
    }

    expect(jsErrors, "the pointer chain logged page errors").toEqual([]);
    expect(await clip.count()).toBe(1);
  });

  test("a cancelled gesture commits nothing and consumes no undo step", async ({ page }) => {
    test.setTimeout(180_000);
    await openArrangement(page);
    await bounceAudioClip(page);

    const before = await clipState(page);

    // Start a real drag, cancel it mid-flight, then release the mouse. The
    // panel's terminator has to abort the gesture: releasing afterwards must
    // NOT commit the move the user cancelled.
    const box = await clipBox(page);
    const dx = Math.max(24, Math.round(box.width * 0.25));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 4; step++) {
      await page.mouse.move(box.x + box.width / 2 + (dx * step) / 4, box.y + box.height / 2);
      await page.waitForTimeout(30);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(250);

    const cancelled = await clipState(page);
    expect(cancelled.left, "the cancelled gesture still moved the clip").toBe(before.left);
    expect(cancelled.width, "the cancelled gesture still resized the clip").toBe(before.width);
    expect(cancelled.title, "the cancelled gesture still changed the clip's state").toBe(before.title);

    // The cancel must not have eaten an undo slot: ONE undo after ONE real
    // gesture has to undo the GESTURE, not the cancelled one.
    const fadeBox = await clipBox(page);
    await dragBy(
      page,
      await handlePoint(page, ".arr-audio-clip-handle-fade.left", "top-left"),
      Math.max(16, Math.round(fadeBox.width * 0.3)),
      0,
    );
    const afterGesture = await clipState(page);
    expect(afterGesture.title, "the follow-up gesture did not commit").not.toBe(cancelled.title);

    await undo(page);
    const undone = await clipState(page);
    expect(undone, "the cancelled gesture consumed an undo step").toEqual(cancelled);

    expect(jsErrors, "the cancelled gesture logged page errors").toEqual([]);
  });

  test("the keyboard and menu verbs reach the command and land exactly one undo step", async ({ page }) => {
    test.setTimeout(240_000);
    await openArrangement(page);
    const clip = await bounceAudioClip(page);

    const pristine = await clipState(page);
    expect(pristine.count).toBe(1);

    // A time range would swallow the Delete key (App.tsx checks the range
    // BEFORE the clip selection), so the range the bounce left behind has to
    // go first. A short ruler drag is the panel's own "clear the range" path.
    if ((await page.locator(".arr-time-range").count()) > 0) {
      const ruler = page.locator(".arr-ruler").first();
      await ruler.scrollIntoViewIfNeeded();
      const rulerBox = await ruler.boundingBox();
      if (rulerBox) {
        await dragBy(page, { x: rulerBox.x + 60, y: rulerBox.y + rulerBox.height / 2 }, 3, 0);
      }
    }
    expect(await page.locator(".arr-time-range").count(), "the time range survived the bounce").toBe(0);

    // ── MUTE (M) ──────────────────────────────────────────────────────────
    {
      await clip.click();
      const before = await clipState(page);
      await page.keyboard.press("m");
      await page.waitForTimeout(220);
      const after = await clipState(page);
      expect(after.title, "M did not mute the clip").toContain("MUTED");
      expect(after.classes, "M did not mark the clip muted").toContain("muted");
      await assertOneUndoStep(page, before, after, "mute");
      await undo(page);
    }

    // ── DUPLICATE (Ctrl+D) ────────────────────────────────────────────────
    {
      await clip.click();
      const before = await clipState(page);
      await page.keyboard.press("Control+d");
      await page.waitForTimeout(250);
      const after = await clipState(page);
      expect(after.count, "Ctrl+D did not duplicate the clip").toBe(2);
      await assertOneUndoStep(page, before, after, "duplicate");
      await undo(page);
      expect((await clipState(page)).count, "the duplicate survived the undo").toBe(1);
    }

    // ── COPY + PASTE (Ctrl+C, Ctrl+V) ─────────────────────────────────────
    {
      await clip.click();
      const before = await clipState(page);
      await page.keyboard.press("Control+c");
      await page.waitForTimeout(150);
      await page.keyboard.press("Control+v");
      await page.waitForTimeout(250);
      const after = await clipState(page);
      expect(after.count, "Ctrl+C / Ctrl+V did not paste a clip").toBe(2);
      await assertOneUndoStep(page, before, after, "paste");
      await undo(page);
      expect((await clipState(page)).count, "the pasted clip survived the undo").toBe(1);
    }

    // ── GROUP / UNGROUP (Ctrl+G, Ctrl+Shift+G) ───────────────────────────
    {
      await clip.click();
      const before = await clipState(page);
      await page.keyboard.press("Control+g");
      await page.waitForTimeout(250);
      const grouped = await clipState(page);
      expect(grouped.classes, "Ctrl+G did not group the clip").toContain("grouped");
      await undo(page);
      expect((await clipState(page)).classes, "the group survived the undo").not.toContain("grouped");

      // Group again, then ungroup: the ungroup is a command of its own and
      // has to undo on its own too.
      await page.keyboard.press("Control+g");
      await page.waitForTimeout(250);
      expect((await clipState(page)).classes, "the second group did not take").toContain("grouped");
      await page.keyboard.press("Control+Shift+g");
      await page.waitForTimeout(250);
      const ungrouped = await clipState(page);
      expect(ungrouped.classes, "Ctrl+Shift+G did not ungroup the clip").not.toContain("grouped");
      await undo(page);
      expect((await clipState(page)).classes, "the ungroup survived the undo").toContain("grouped");
      await undo(page);
      expect((await clipState(page)).classes, "the second group survived the undo").not.toContain("grouped");
      expect((await clipState(page)).classes).toBe(before.classes);
    }

    // ── REVERSE (context menu) ────────────────────────────────────────────
    {
      await clip.click();
      const before = await clipState(page);
      await clip.click({ button: "right" });
      const reverse = page.getByRole("menuitem", { name: /^Reverse/ });
      await reverse.waitFor({ state: "visible", timeout: 10_000 });
      await reverse.click();
      await page.waitForTimeout(250);
      const after = await clipState(page);
      expect(after.title, "the context menu did not reverse the clip").toContain("REV");
      await assertOneUndoStep(page, before, after, "reverse");
      await undo(page);
    }

    // ── LOOP (context menu) ───────────────────────────────────────────────
    {
      await clip.click();
      const before = await clipState(page);
      await clip.click({ button: "right" });
      const loop = page.getByRole("menuitem", { name: /^Loop/ });
      await loop.waitFor({ state: "visible", timeout: 10_000 });
      await loop.click();
      await page.waitForTimeout(250);
      const after = await clipState(page);
      expect(after.title, "the context menu did not loop the clip").toContain("LOOP");
      await assertOneUndoStep(page, before, after, "loop");
      await undo(page);
    }

    // ── LOCK (Shift+L) — last, because a locked clip refuses the geometry
    //    verbs and would make every later gesture a no-op.
    {
      await clip.click();
      const before = await clipState(page);
      await page.keyboard.press("Shift+L");
      await page.waitForTimeout(250);
      const after = await clipState(page);
      expect(after.title, "Shift+L did not lock the clip").toContain("LOCKED");
      expect(after.classes, "Shift+L did not mark the clip locked").toContain("locked");
      await assertOneUndoStep(page, before, after, "lock");
      await undo(page);
    }

    // ── DELETE (Delete key) ───────────────────────────────────────────────
    {
      await clip.click();
      const before = await clipState(page);
      await page.keyboard.press("Delete");
      await page.waitForTimeout(250);
      const after = await clipState(page);
      expect(after.count, "Delete did not remove the clip").toBe(0);
      await undo(page);
      const undone = await clipState(page);
      expect(undone.count, "undo did not bring the deleted clip back").toBe(1);
      expect(undone.title, "the restored clip is not the clip that was deleted").toBe(before.title);
    }

    expect(jsErrors, "the keyboard chain logged page errors").toEqual([]);
  });
});
