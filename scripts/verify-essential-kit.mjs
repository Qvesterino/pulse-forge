/**
 * Real-browser gate for the ESSENTIAL KIT dock and the trimmed Add FX order.
 *
 * Unit tests prove the slot table and the command. This proves the SURFACE:
 * that the dock renders in the devices panel, that LOAD KIT inserts the five
 * fundamentals in signal-flow order, that one click is one undo step, that a
 * multiview drag AND an EQ-curve drag each reach the document as a single undo
 * step, and that the daily fifteen are the first fifteen the `✚ ADD FX` grid
 * offers while every effect stays insertable exactly once.
 *
 * Run with vite-node so the effect registry can be imported as the single
 * source of truth for the expected order — a hardcoded list here would rot the
 * same way the literal totals rotted in zenit-composite.test.ts.
 *
 * This surface was REBUILT underneath the gate (a `<select>` of optgroups
 * became `FxAddPopover`, a flat grid with a category filter). The gate was
 * re-derived from a fresh DOM measurement rather than patched to pass: see the
 * comment above the menu checks for what the fifteen claim now means.
 *
 * Usage: npx vite-node scripts/verify-essential-kit.mjs
 */
import { chromium } from "playwright-core";
import { EFFECT_META } from "../src/effects/definitions";
import {
  CORE_EFFECT_GROUPS,
  CORE_EFFECT_ORDER,
  FLAGSHIP_EFFECT_ORDER,
  ADDITIONAL_EFFECT_GROUPS,
} from "../src/effects/registry";

const TOTAL_EFFECTS = Object.keys(EFFECT_META).length;

const URL = process.env.KYX_URL ?? "http://127.0.0.1:5173/";
const TIMEOUT = Number(process.env.KYX_TIMEOUT ?? 120000);

const results = [];
// RETURNS `ok`, on purpose. A version of this gate returned nothing, so
// `if (check(...))` was always false and every conditional block below it — the
// whole curve-drag section, five checks — was silently skipped while the run
// still ended "28/28 passed". A gate that skips checks must not be able to
// report the same score as one that ran them.
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForSelector("text=Open the studio", { timeout: TIMEOUT });
  await page.getByText("Open the studio", { exact: false }).first().click();
  await page.waitForSelector(".pb-template", { timeout: TIMEOUT });
  // The CARD is the button; a text click can land on a child span and, while
  // the card is `disabled` by `busy`, do nothing at all — leaving the gate to
  // time out on `.dock-tab` with no hint that the studio never opened.
  await page.click(".pb-template:has-text('HOUSE')");
  await page.waitForTimeout(15000);
  // Both of these are OPTIONAL surfaces over the studio. Each click may navigate
  // (a recovery banner can reload the app), which destroys the execution context
  // mid-`$()` — so neither is allowed to be the thing that fails the gate. The
  // next `waitForSelector` is the real check that the studio survived.
  const dismissIfPresent = async (text) => {
    try {
      const el = await page.$(`text=${text}`);
      if (!el) return false;
      await el.click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      console.log(`dismissed an optional "${text}" surface`);
      return true;
    } catch (err) {
      console.log(`optional "${text}" surface: ${String(err.message).split("\n")[0]}`);
      return false;
    }
  };
  await dismissIfPresent("SKIP");
  await dismissIfPresent("Dismiss");

  // DEV is the devices panel in the bottom dock; the kit lives inside it.
  // A timeout here means the studio shell never appeared; capture what WAS on
  // screen rather than guessing from the stack trace.
  try {
    await page.waitForSelector(".dock-tab", { timeout: 90000 });
    await page.locator(".dock-tab", { hasText: "DEV" }).first().click({ timeout: 30000 });
  } catch (err) {
    await page.screenshot({ path: ".artifacts/kit-gate-failure.png" }).catch(() => {});
    const seen = await page.$eval("body", (e) => e.innerText.slice(0, 400)).catch(() => "(body unreadable)");
    throw new Error(`studio shell never opened: ${err.message}\nON SCREEN: ${seen}`);
  }
  await page.waitForSelector(".essential-kit-dock", { timeout: TIMEOUT });

  const dock = await page.$(".essential-kit-dock");
  check("essential kit dock renders in the devices panel", !!dock);
  if (!dock) throw new Error("dock never rendered");

  const slotLabels = await page.$$eval(".essential-kit-slot-label", (n) => n.map((e) => e.textContent.trim()));
  check(
    "five slots in signal-flow order",
    JSON.stringify(slotLabels) === JSON.stringify(["EQ", "DYNAMICS", "SATURATION", "DELAY", "REVERB"]),
    slotLabels.join(" → "),
  );

  // THE ADD FX SURFACE — the popover behind `✚ ADD FX` is what a user reaches
  // for now, so it is what this gate reads.
  //
  // WHAT CHANGED, AND WHY THE CLAIM IS NOW ORDER RATHER THAN GROUPING:
  // this surface used to be a <select> with five `optgroup`s of three, which
  // made "fifteen devices, three per area" a structural DOM claim. It is now a
  // FLAT grid of all 57 devices with a category filter on top. Measured:
  //   - the grid renders 57 devices, unscrolled and fully visible: 21
  //   - the tiles are per-CATEGORY, not per-core-membership:
  //     TONE 6, DYNAMICS 9, CHARACTER 17, MOVEMENT 17, SPACE 8
  //   - the grid scrolls: 697px of content in a 300px viewport
  // So "three per area" is FALSE for this surface and must not be re-asserted
  // from the old select. What survives — and is what the trim actually bought —
  // is ORDER: the fifteen daily devices come first, before the flagship suites
  // and the long tail. The registry is the source of truth for what SHOULD be
  // offered; the DOM is the source of truth for what IS offered; comparing them
  // in both directions is what catches a device that quietly stopped being
  // insertable.
  await page.click(".fx-add-trigger");
  await page.waitForSelector(".fx-add-popover", { timeout: 30000 });

  const menu = await page.evaluate(() => {
    const grid = document.querySelector(".fx-add-popover .fx-add-grid");
    if (!grid) return { found: false };
    const g = grid.getBoundingClientRect();
    const tiles = Array.from(document.querySelectorAll(".fx-add-tile")).map((t) => t.textContent.trim());
    const devices = Array.from(grid.querySelectorAll(".fx-add-device")).map((t) => {
      const r = t.getBoundingClientRect();
      return {
        name: t.querySelector(".fx-add-device-name")?.textContent?.trim() ?? "",
        // "Fully visible" is geometry against the grid's own box, not against
        // the viewport: the devices panel is nowhere near the bottom of the
        // screen, so an absolute comparison there says nothing at all.
        visible: r.top >= g.top - 0.5 && r.bottom <= g.bottom + 0.5,
      };
    });
    return {
      found: true,
      tiles,
      names: devices.map((d) => d.name),
      visibleCount: devices.filter((d) => d.visible).length,
      firstHidden: devices.find((d) => !d.visible)?.name ?? null,
      scrollable: grid.scrollHeight - grid.clientHeight,
    };
  });
  if (!menu.found) throw new Error("the ADD FX popover never opened");

  const expectedOrder = [
    ...CORE_EFFECT_GROUPS.flatMap((g) => g.types),
    ...FLAGSHIP_EFFECT_ORDER,
    ...ADDITIONAL_EFFECT_GROUPS.flatMap((g) => g.types),
  ].map((type) => EFFECT_META[type]?.name);

  check(
    "the fifteen daily devices are the FIRST fifteen a user sees",
    JSON.stringify(menu.names.slice(0, CORE_EFFECT_ORDER.length)) ===
      JSON.stringify(expectedOrder.slice(0, CORE_EFFECT_ORDER.length)),
    `${CORE_EFFECT_ORDER.length} core first, then ${FLAGSHIP_EFFECT_ORDER.length} flagship + ${expectedOrder.length - CORE_EFFECT_ORDER.length - FLAGSHIP_EFFECT_ORDER.length} tail`,
  );
  check(
    "all fifteen are on screen without scrolling",
    menu.names.slice(0, CORE_EFFECT_ORDER.length).every((n) => menu.names.includes(n)) &&
      (menu.visibleCount >= CORE_EFFECT_ORDER.length || menu.firstHidden === null),
    `${menu.visibleCount} of ${menu.names.length} fully visible; grid scrolls ${menu.scrollable}px; first hidden: ${menu.firstHidden ?? "none"}`,
  );
  check(
    "every registered effect is offered exactly once",
    menu.names.length === TOTAL_EFFECTS && new Set(menu.names).size === TOTAL_EFFECTS,
    `${menu.names.length} tiles vs ${TOTAL_EFFECTS} in EFFECT_META`,
  );
  check(
    "the grid order matches the registry order, device for device",
    JSON.stringify(menu.names) === JSON.stringify(expectedOrder),
    menu.names.slice(0, 3).join(" | ") + ` … ${menu.names.slice(-2).join(" | ")}`,
  );
  check(
    "the mastered-away devices are still offered, just not first",
    menu.names.includes("ZENIT") && menu.names.includes("PORTAL"),
    `ZENIT at ${menu.names.indexOf("ZENIT")}, PORTAL at ${menu.names.indexOf("PORTAL")}`,
  );
  check(
    "the category tiles cover every area the registry groups into",
    ["ALL", "TONE", "DYNAMICS", "CHARACTER", "MOVEMENT", "SPACE"].every((t) => menu.tiles.includes(t)),
    menu.tiles.join(" "),
  );

  await page.click(".fx-add-close");
  await page.waitForTimeout(800);

  const variantCount = await page.$$eval(".essential-kit-variant", (n) => n.length);
  check("every slot offers its characters (5 × 3)", variantCount === 15, `${variantCount} buttons`);

  // Pick a non-default character and prove the dock reports it as chosen.
  await page.click(".essential-kit-slot:nth-child(5) .essential-kit-variant:nth-child(3)");
  const activeText = await page.$eval(".essential-kit-slot:nth-child(5) .essential-kit-variant.is-active", (e) =>
    e.textContent.trim(),
  );
  check("reverb slot accepts a character choice", activeText === "Hall", `active = ${activeText}`);

  const devices = () =>
    page.$$eval(".devices-chain .device-chain-item", (n) => n.map((e) => e.textContent.replace(/^\d+/, "").trim()));

  const before = await devices();
  await page.click(".essential-kit-load");
  await page.waitForTimeout(2500);

  const deviceNames = await devices();
  // The instrument occupies slot 0, so a five-device kit grows the chain by 5.
  const inserted = deviceNames.slice(before.length);
  const found = ["EQ", "Compressor", "Saturation", "Delay", "Reverb"].filter((name) =>
    inserted.some((t) => t.includes(name)),
  );
  check(
    "LOAD KIT inserts all five fundamentals in signal-flow order",
    JSON.stringify(inserted) === JSON.stringify(["EQ", "Compressor", "Saturation", "Delay", "Reverb"]),
    `inserted: ${inserted.join(" → ") || "none"} | matched ${found.length}/5`,
  );
  check("chain grew by exactly five", inserted.length === 5, `${before.length} → ${deviceNames.length}`);

  // MULTIVIEW — every inserted device shows its own controls at once.
  const eqCol = '.kit-multiview-device[data-type="eq"]';
  const multiview = await page.$(".kit-multiview");
  check("multiview renders under the slot picker", !!multiview);
  if (multiview) {
    const columns = await page.$$eval(".kit-multiview-device", (n) =>
      n.map((e) => {
        const r = e.getBoundingClientRect();
        return {
          name: e.querySelector(".kit-multiview-name")?.textContent?.trim() ?? "?",
          knobs: e.querySelectorAll(".slider, .fx-param-select").length,
          height: Math.round(r.height),
        };
      }),
    );
    check(
      "all five devices show their own MAIN page side by side",
      columns.length === 5,
      columns.map((c) => `${c.name}:${c.knobs}`).join(" "),
    );
    // A column with no knobs is the defect the curated primaryParamIds exist
    // to prevent, and it renders as "nothing to tweak" rather than an error.
    check(
      "every column exposes its four primary knobs",
      columns.every((c) => c.knobs === 4),
      columns.map((c) => `${c.name}:${c.knobs}`).join(" "),
    );
    // The EQ column also paints a curve, so it is TALLER than its four
    // siblings. The claim worth gating is not "does it fit" — the dock is a
    // resizable strip, and the earlier version of this check compared an
    // absolute Y against the viewport height, which says nothing because the
    // devices panel is nowhere near the bottom of the screen. The claim is
    // REACHABILITY: a slider that is painted but covered by something else, or
    // scrolled out of its own container, looks fine and cannot be used.
    // REACHABILITY, restated against the thing that actually occluded it. The
    // first version compared a control's bottom against `.kit-multiview`'s own
    // box and reported PASS while the EQ curve was completely ungrabbable: the
    // strip fitted itself perfectly and was simply painted underneath
    // `footer.statusbar`, 341px of panel content below the fold. Fitting the
    // wrong box proves nothing. The real questions are (a) is the control clear
    // of the statusbar, and (b) if it is not, can the user scroll to it.
    const reach = await page.evaluate((sel) => {
      const target = document.querySelector(sel);
      if (!target) return { found: false };
      const panel = target.closest(".devices-panel");
      if (!panel) return { found: true, inPanel: false };
      const bar = document.querySelector("footer.statusbar");
      const barTop = bar ? bar.getBoundingClientRect().top : window.innerHeight;
      const before = target.getBoundingClientRect();
      const wasObscured = before.bottom > barTop;
      const canScroll = panel.scrollHeight - panel.clientHeight;
      // Scroll THE TARGET into view, not to the bottom of the panel. The kit
      // dock is not the panel's last block — `device-surface` is — so scrolling
      // to the end pushes the kit dock out through the TOP and the probe then
      // reports whatever is behind it. At 281px of dock in a 251px viewport the
      // dock can never be fully visible at any offset, so "reach the control"
      // and "see the whole dock" are different claims and only the first is
      // gated.
      target.scrollIntoView({ block: "nearest" });
      const after = target.getBoundingClientRect();
      const hit = document.elementFromPoint(after.x + after.width / 2, after.y + after.height / 2);
      return {
        found: true,
        inPanel: true,
        wasObscured,
        canScroll,
        afterBottom: Math.round(after.bottom),
        barTop: Math.round(barTop),
        clearOfStatusbar: after.bottom <= barTop,
        hitTest: hit ? `${hit.tagName}.${(hit.className || "").toString().split(" ")[0]}` : "nothing",
        hitIsTarget: hit ? target.contains(hit) : false,
      };
    }, `${eqCol} .slider-track[aria-label*="LOW SHELF"]`);
    check(
      "the EQ column's controls are reachable, not painted but out of reach",
      reach.found &&
        reach.inPanel &&
        reach.clearOfStatusbar &&
        reach.hitIsTarget &&
        (reach.canScroll > 0 ? reach.wasObscured : true),
      reach.found
        ? `started under the statusbar: ${reach.wasObscured}; panel scrolls ${reach.canScroll}px; after scroll bottom ${reach.afterBottom} vs statusbar ${reach.barTop}; pointer hits ${reach.hitTest}`
        : "LOW SHELF not found",
    );
    // THE DRAGGABLE CURVE — a band grabbed on the curve must write the same
    // param the knob under it writes, in ONE undo step, and release must return
    // it. This is the gesture contract the canvas documents; nothing else in the
    // gate proves it.
    const curve = `${eqCol} canvas.kit-eq-curve`;
    // The kit dock is the LAST block of a panel taller than its own viewport,
    // so the curve starts below the fold and the user scrolls to it. The gate
    // has to scroll too: probing an off-screen point measures the occluder,
    // not the gesture. (Before the panel could scroll at all, this line found
    // `footer.statusbar` sitting on top of the canvas and every drag check
    // below it failed for that reason and no other.)
    await page.evaluate((sel) => {
      const c = document.querySelector(sel);
      if (c) c.scrollIntoView({ block: "nearest" });
    }, curve);
    await page.waitForTimeout(600);
    const curveBox = await page.$eval(curve, (c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    // HIGH MID sits at 2500 Hz. On a 20 Hz–20 kHz log axis that is
    // ln(2500/20) / ln(20000/20) = 0.699 of the way across — this gate used to
    // assert ~0.566, which is where 1100 Hz lands. Nothing was under the pointer,
    // the drag never started, and because the FOLLOWING Ctrl+Z then undid the
    // LOAD KIT instead of the (never-made) gesture, the whole kit disappeared and
    // six later checks failed as collateral. A wrong constant does not fail
    // quietly one time; it poisons everything downstream that assumes the step
    // before it worked.
    const HIGH_MID_FRAC = Math.log(2500 / 20) / Math.log(20000 / 20);
    const xAt = (frac) => curveBox.x + curveBox.w * frac;
    const highMidX = xAt(HIGH_MID_FRAC);
    const midY = curveBox.y + curveBox.h / 2; // the 0 dB line — where a flat HIGH MID sits

    const highMidKnob = () =>
      page
        .$eval(`${eqCol} .slider-track[aria-label*="HIGH MID"]`, (el) => el.getAttribute("aria-valuenow"))
        .catch(() => null);

    await page.mouse.move(highMidX, midY);
    await page.waitForTimeout(400);
    const hovering = await page.$eval(curve, (c) => c.className.includes("is-hovering")).catch(() => false);
    const grabbed = check(
      "the curve reports a grabbable point under the pointer",
      hovering,
      `pointer at ${(HIGH_MID_FRAC * 100).toFixed(1)}% across (2500 Hz on the log axis)`,
    );

    if (grabbed) {
      await page.mouse.down();
      await page.mouse.move(highMidX, midY - curveBox.h * 0.28, { steps: 10 });
      const paintedDuringDrag = await page.$eval(curve, (c) => c.className.includes("is-dragging")).catch(() => false);
      const took = check("dragging the curve takes the pointer", paintedDuringDrag);

      // While the pointer is still down the document must NOT have been written:
      // per-frame writes would flood undo with one step per move.
      const highMidDuringDrag = await highMidKnob();
      check(
        "the knob under the curve has not been written mid-drag",
        highMidDuringDrag === "0",
        `HIGH MID reads ${highMidDuringDrag} dB while the pointer is still down`,
      );

      await page.mouse.up();
      await page.waitForTimeout(1500);
      const highMidAfter = await highMidKnob();
      const committed = check(
        "releasing commits the dragged gain to the document",
        highMidAfter !== null && Number(highMidAfter) > 1,
        `HIGH MID ${highMidAfter} dB`,
      );

      // ONE undo must return the whole gesture, not one frame of it — but only
      // if there WAS a gesture. An unconditional undo here would revert the kit
      // load and take every later check with it.
      if (took && committed) {
        await page.keyboard.press("Control+z");
        await page.waitForTimeout(1200);
        const highMidUndone = await highMidKnob();
        check(
          "one undo reverts the whole curve gesture",
          Number(highMidUndone) === 0,
          `HIGH MID ${highMidUndone} dB after a single Ctrl+Z`,
        );

        // A press that does not move must not write anything.
        await page.mouse.move(highMidX, midY);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(800);
        const afterClick = await highMidKnob();
        check("a click that does not move writes nothing", Number(afterClick) === 0, `HIGH MID ${afterClick} dB`);
      } else {
        console.log("skipped the curve undo checks — the gesture never committed");
      }
    } else {
      console.log("skipped the curve drag checks — no point was grabbed");
    }

    await multiview.screenshot({ path: ".artifacts/kit-multiview-debug.png" }).catch(() => {});
  }

  // THE REAL GATE: dragging a multiview knob must change the DOCUMENT, not just
  // the rendered value. Read the reverb column's DECAY before and after a real
  // pointer drag, then undo.
  //
  // `Slider` is NOT an <input type=range>: it is a div role="slider" carrying
  // aria-valuenow, so this gate reads and drags the custom track.
  const decayKnob = () =>
    page.$eval('.kit-multiview-device[data-type="reverb"] .slider-track[aria-label="DECAY"]', (el) => ({
      now: el.getAttribute("aria-valuenow"),
      text: el.getAttribute("aria-valuetext"),
    }));

  const decayBefore = await decayKnob().catch(() => null);
  check(
    "reverb column exposes a DECAY control",
    !!decayBefore,
    decayBefore ? `${decayBefore.text} (aria-valuenow ${decayBefore.now})` : "none",
  );

  if (decayBefore) {
    const track = await page.$('.kit-multiview-device[data-type="reverb"] .slider-track[aria-label="DECAY"]');
    const box = await track.boundingBox();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const decayAfter = await decayKnob();
    check(
      "dragging a multiview knob moves it",
      decayAfter.now !== decayBefore.now,
      `${decayBefore.text} → ${decayAfter.text}`,
    );

    // Undo must return the stored value — proof the drag went through the
    // command path rather than straight into React state.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(1500);
    const decayUndone = await decayKnob().catch(() => null);
    check(
      "one undo restores the knob to its stored value",
      decayUndone?.now === decayBefore.now,
      `${decayAfter.text} → ${decayUndone?.text ?? "gone"} (expected ${decayBefore.text})`,
    );
  }

  // THE EQ CURVE — the deepest part of the column must actually paint pixels
  // that change when the band's gain changes. A canvas that renders nothing is
  // indistinguishable from a canvas that is absent.
  const eqColumn = eqCol;
  const hasCanvas = !!(await page.$(`${eqColumn} canvas.kit-eq-curve`));
  check("EQ column paints a curve canvas", hasCanvas);
  if (hasCanvas) {
    // Count lit pixels AND sum their brightness. A lit-pixel COUNT is not a
    // movement metric: shifting a curve up can light exactly as many pixels as
    // before, so the first version of this gate reported "no repaint" for a
    // curve that had genuinely moved.
    const painted = async () =>
      page.$eval(`${eqColumn} canvas.kit-eq-curve`, (c) => {
        const ctx = c.getContext("2d");
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        let lit = 0;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 8 && data[i] > 80 && data[i + 3] > 40) {
            lit++;
            sum += data[i] + data[i + 1] + data[i + 2];
          }
        }
        return { lit, sum };
      });
    const beforePaint = await painted();
    check("the curve has ink on it", beforePaint.lit > 50, `${beforePaint.lit} lit px, weight ${beforePaint.sum}`);

    const shelfTrack = `${eqColumn} .slider-track[aria-label*="LOW SHELF"]`;
    const shelfBefore = await page.$eval(shelfTrack, (el) => el.getAttribute("aria-valuenow")).catch(() => null);
    const shelf = await page.$(shelfTrack);
    check("EQ column exposes a LOW SHELF control", !!shelf, shelfBefore === null ? "not found" : `${shelfBefore} dB`);

    if (shelf) {
      const box = await shelf.boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(1500);

      const shelfAfter = await page.$eval(shelfTrack, (el) => el.getAttribute("aria-valuenow")).catch(() => null);
      check(
        "dragging LOW SHELF commits to the document",
        shelfAfter !== shelfBefore,
        `${shelfBefore} dB → ${shelfAfter} dB`,
      );

      const afterPaint = await painted();
      check(
        "the committed gain repaints the curve",
        afterPaint.sum !== beforePaint.sum,
        `weight ${beforePaint.sum} → ${afterPaint.sum} (${beforePaint.lit} → ${afterPaint.lit} lit px)`,
      );

      await page.keyboard.press("Control+z");
      await page.waitForTimeout(1500);
      const undonePaint = await painted().catch(() => null);
      const shelfUndone = await page.$eval(shelfTrack, (el) => el.getAttribute("aria-valuenow")).catch(() => null);
      check(
        "undo restores both the gain and the curve",
        shelfUndone === shelfBefore && undonePaint?.sum === beforePaint.sum,
        `gain ${shelfUndone} dB, weight ${undonePaint?.sum} (expected ${shelfBefore} dB, ${beforePaint.sum})`,
      );
    }
  }

  // One undo must remove the whole kit, not just the last device.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1500);
  const afterUndo = await devices();
  check(
    "one undo removes the whole kit",
    afterUndo.length === before.length,
    `${deviceNames.length} → ${afterUndo.length} (expected ${before.length})`,
  );

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[essential-kit] ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`[essential-kit] FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
