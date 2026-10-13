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
import { CORE_EFFECT_GROUPS, CORE_EFFECT_ORDER, FLAGSHIP_EFFECT_ORDER, ADDITIONAL_EFFECT_GROUPS } from "../src/effects/registry";

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
  // DEV is the devices panel in the bottom dock; the kit lives inside it.
  // A timeout here means the studio shell never appeared; capture what WAS on
  // screen rather than guessing from the stack trace.
  try {
    await page.waitForSelector(".dock-tab", { timeout: 90000 });
    await page.locator(".dock-tab", { hasText: "DEV" }).first().click({ timeout: 30000 });
  } catch (err) {
    await page.screenshot({ path: ".artifacts/kit-gate-failure.png" }).catch(() => {});
    const seen = await page
      .$eval("body", (e) => e.innerText.slice(0, 400))
      .catch(() => "(body unreadable)");
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
    areaGroups.length === 5 && areaGroups.every((g) => g.items.length === 3) &&
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
  const multiview = await page.$(".kit-multiview");
  check("multiview renders under the slot picker", !!multiview);
  if (multiview) {
    const columns = await page.$$eval(".kit-multiview-device", (n) =>
      n.map((e) => ({
        name: e.querySelector(".kit-multiview-name")?.textContent?.trim() ?? "?",
        knobs: e.querySelectorAll(".slider, .fx-param-select").length,
      })),
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
