/**
 * Real-browser gate for the ESSENTIAL KIT dock.
 *
 * Unit tests prove the slot table and the command. This proves the SURFACE:
 * that the dock renders in the devices panel, that LOAD KIT inserts the five
 * fundamentals in signal-flow order, and that one click is one undo step.
 *
 * Usage: node scripts/verify-essential-kit.mjs
 */
import { chromium } from "playwright-core";

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
  await page.locator(".dock-tab", { hasText: "DEV" }).first().click();
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

  const variantCount = await page.$$eval(".essential-kit-variant", (n) => n.length);
  check("every slot offers its characters (5 × 3)", variantCount === 15, `${variantCount} buttons`);

  // Pick a non-default character and prove the dock reports it as chosen.
  await page.click('.essential-kit-slot:nth-child(5) .essential-kit-variant:nth-child(3)');
  const activeText = await page.$eval(".essential-kit-slot:nth-child(5) .essential-kit-variant.is-active", (e) =>
    e.textContent.trim(),
  );
  check("reverb slot accepts a character choice", activeText === "Hall", `active = ${activeText}`);

  const devices = () =>
    page.$$eval(".devices-chain .device-chain-item", (n) =>
      n.map((e) => e.textContent.replace(/^\d+/, "").trim()),
    );

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

  // One undo must remove the whole kit, not just the last device.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1500);
  const afterUndo = await devices();
  check("one undo removes the whole kit", afterUndo.length === before.length, `${deviceNames.length} → ${afterUndo.length} (expected ${before.length})`);

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