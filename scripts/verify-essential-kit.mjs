/**
 * Real-browser gate for the ESSENTIAL KIT dock and the trimmed Add Effect menu.
 *
 * Unit tests prove the slot table and the command. This proves the SURFACE:
 * that the dock renders in the devices panel, that LOAD KIT inserts the five
 * fundamentals in signal-flow order, that one click is one undo step, that a
 * multiview drag reaches the document, and that the first menu layer is fifteen
 * devices while every effect stays offered exactly once.
 *
 * Run with vite-node so the effect registry can be imported as the single
 * source of truth for the total — a hardcoded count here would rot the same
 * way the literal totals rotted in zenit-composite.test.ts.
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
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForSelector("text=Open the studio", { timeout: TIMEOUT });
  await page.getByText("Open the studio", { exact: false }).first().click();
  await page.waitForSelector("text=Pick a template", { timeout: TIMEOUT });
  await page.getByText("HOUSE", { exact: true }).first().click();
  await page.waitForTimeout(15000);
  const skip = await page.$("text=SKIP");
  if (skip) {
    await skip.click();
    await page.waitForTimeout(3000);
  }
  // A killed dev server leaves an unsaved-session recovery banner over the
  // studio. It is a real surface, so the gate dismisses it the way a user
  // would instead of assuming the studio shell is broken.
  const dismiss = await page.$("text=Dismiss");
  if (dismiss) {
    await dismiss.click();
    await page.waitForTimeout(1500);
    console.log("dismissed an unsaved-session recovery banner");
  }

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

  // THE TRIMMED MENU — the +FX select in the dock must open on fifteen devices
  // in five groups of three, with everything else one layer down.
  // The registry is the source of truth for "what should be offered"; the DOM
  // is the source of truth for "what IS offered". Comparing them in both
  // directions is what catches a device that quietly stopped being insertable.
  const menu = await page.$eval("select.devices-add-effect", (sel) => {
    const groups = Array.from(sel.querySelectorAll("optgroup")).map((g) => ({
      label: g.label,
      items: Array.from(g.children).map((o) => o.textContent.trim()),
    }));
    // The select carries a `value=""` "+ FX" placeholder that is not a device.
    // Counting it makes the DOM total read one higher than the registry. Note
    // that a CSS `option[value]` selector does NOT help: it matches an empty
    // value too, so the filter has to test the property in JS.
    return {
      total: sel.options.length,
      real: Array.from(sel.options).filter((o) => o.value).length,
      groups,
    };
  });
  // `^(A|B|C)`, not `^A|B|C$`: the alternation binds looser than the anchors,
  // so the loose form also matches "MORE DYNAMICS" and silently counts the
  // second layer as the first.
  const AREA_LABELS = new Set(["TONE", "DYNAMICS", "CHARACTER", "MOVEMENT", "SPACE"]);
  const areaGroups = menu.groups.filter((g) => AREA_LABELS.has(g.label));
  const moreLayer = menu.groups.filter((g) => g.label.startsWith("MORE"));

  check(
    "the first menu layer is fifteen devices, three per area",
    areaGroups.length === 5 &&
      areaGroups.every((g) => g.items.length === 3) &&
      areaGroups.reduce((n, g) => n + g.items.length, 0) === CORE_EFFECT_ORDER.length,
    areaGroups.map((g) => `${g.label}(${g.items.length})`).join(" "),
  );
  check(
    "the mastered-away devices are one layer down, not gone",
    moreLayer.some((g) => g.items.includes("ZENIT")) && moreLayer.some((g) => g.items.includes("PORTAL")),
    moreLayer.map((g) => `${g.label}(${g.items.length})`).join(" "),
  );
  check(
    "every registered effect is offered exactly once",
    menu.real === TOTAL_EFFECTS && new Set(menu.groups.flatMap((g) => g.items)).size === TOTAL_EFFECTS,
    `${menu.real} real options (+${menu.total - menu.real} placeholder) vs ${TOTAL_EFFECTS} in EFFECT_META`,
  );
  check(
    "the menu matches the registry grouping, group for group",
    JSON.stringify(menu.groups.map((g) => g.items.length)) ===
      JSON.stringify([
        ...CORE_EFFECT_GROUPS.map((g) => g.types.length),
        FLAGSHIP_EFFECT_ORDER.length,
        ...ADDITIONAL_EFFECT_GROUPS.map((g) => g.types.length),
      ]),
    menu.groups.map((g) => `${g.label}(${g.items.length})`).join(" "),
  );

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
    const reach = await page.evaluate((sel) => {
      const track = document.querySelector(sel);
      if (!track) return { found: false };
      const scroller = track.closest(".kit-multiview");
      if (!scroller) return { found: true, inScroller: false };
      const r = track.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      // Fully inside the strip: the column was TALLER than the others once it
      // gained a curve, and a knob painted below the fold looks identical to a
      // usable one until the user reaches for it. Compared as geometry against
      // its own container — not against the viewport, and not with
      // elementFromPoint, whose answer at a 3px-tall track depends on which
      // sub-pixel the sample lands on.
      return {
        found: true,
        inScroller: true,
        inside: r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
        overflow: scroller.scrollHeight - scroller.clientHeight,
        bottom: Math.round(r.bottom),
        edge: Math.round(s.bottom),
      };
    }, `${eqCol} .slider-track[aria-label*="LOW SHELF"]`);
    check(
      "the EQ column's controls are reachable, not painted but out of reach",
      reach.found && reach.inScroller && reach.inside && reach.overflow <= 0,
      reach.found
        ? `LOW SHELF bottom ${reach.bottom} vs strip edge ${reach.edge}, ${reach.overflow}px overflow`
        : "LOW SHELF not found",
    );
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
