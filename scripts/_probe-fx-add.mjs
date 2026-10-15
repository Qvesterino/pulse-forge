/**
 * Probe: measure what the ADD FX surface actually renders.
 * Run: node scripts/_probe-fx-add.mjs
 */
import { chromium } from "playwright-core";

const URL = process.env.KYX_URL ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text().slice(0, 300));
  });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("text=Open the studio", { timeout: 120000 });
  await page.getByText("Open the studio", { exact: false }).first().click();
  await page.waitForSelector("text=Pick a template", { timeout: 120000 }).catch(() => {});
  // Click the real template CARD, not the text node: the card is the
  // <button class="pb-template">, and a text click can land on a child span
  // whose handler is the button's — but if the card is disabled by `busy`,
  // the text click silently does nothing and the studio never opens.
  const houseCard = await page.$(".pb-template:has-text('HOUSE')");
  if (!houseCard) console.log("NO .pb-template HOUSE CARD");
  else {
    const disabled = await houseCard.isDisabled();
    console.log("HOUSE card disabled?", disabled);
    await houseCard.click();
  }
  await page.waitForTimeout(15000);
  for (const t of ["SKIP", "Dismiss"]) {
    const el = await page.$(`text=${t}`);
    if (el) {
      await el.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }
  const dockTabs = await page.$$eval(".dock-tab", (n) => n.map((e) => e.textContent.trim()));
  console.log("DOCK TABS:", JSON.stringify(dockTabs));
  console.log("BODY NOW:", (await page.$eval("body", (e) => e.innerText)).slice(0, 900));
  await page.screenshot({ path: ".artifacts/probe-before-dev.png" }).catch(() => {});
  await page.waitForSelector(".dock-tab", { timeout: 90000 });
  await page.locator(".dock-tab", { hasText: "DEV" }).first().click({ timeout: 30000 });
  await page.waitForSelector(".essential-kit-dock", { timeout: 120000 });

  const survey = () =>
    page.evaluate(() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      return {
        legacySelect: q("select.devices-add-effect").length,
        chainSelect: q("select.devices-add-chain").length,
        triggers: q(".fx-add-trigger").length,
        popoverOpen: q(".fx-add-popover").length,
        grid: q(".fx-add-grid").length,
        gridScroll: q(".fx-add-grid").map((g) => ({
          scrollH: g.scrollHeight,
          clientH: g.clientHeight,
          overflow: g.scrollHeight - g.clientHeight,
        })),
        tiles: q(".fx-add-tile").map((t) => t.textContent.trim()),
        devices: q(".fx-add-device .fx-add-device-name").map((n) => n.textContent.trim()),
        deviceCount: q(".fx-add-device").length,
      };
    });

  console.log("BEFORE OPEN:", JSON.stringify(await survey(), null, 2));

  const trigger = await page.$(".fx-add-trigger");
  if (!trigger) {
    console.log("NO .fx-add-trigger ON SCREEN");
    console.log("BODY:", (await page.$eval("body", (e) => e.innerText)).slice(0, 1500));
  } else {
    await trigger.click();
    await page.waitForSelector(".fx-add-popover", { timeout: 20000 });
    await page.waitForTimeout(1500);
    const after = await survey();
    console.log("AFTER OPEN:", JSON.stringify(after, null, 2));
    await page.screenshot({ path: ".artifacts/probe-fx-add.png" }).catch(() => {});
  }
} catch (err) {
  console.log("PROBE ERROR:", err.message);
  console.log("PAGE ERRORS:", JSON.stringify(errors.slice(0, 6), null, 2));
  await page?.screenshot?.({ path: ".artifacts/probe-fx-add-error.png" }).catch(() => {});
} finally {
  await browser.close();
}