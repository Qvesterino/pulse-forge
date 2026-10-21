/**
 * Where does the DEV panel's height actually go?
 *
 * The panel measured 250px of client height against 591px of content. Before
 * reaching for `overflow: auto`, this asks the cheaper question: is the kit
 * block oversized, or is the panel simply short?
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const URL = process.env.KYX_URL ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch();
let page;
try {
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(90000);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("text=Open the studio", { timeout: 120000 });
  await page.getByText("Open the studio", { exact: false }).first().click();
  await page.waitForSelector(".pb-template", { timeout: 120000 });
  await page.click(".pb-template:has-text('HOUSE')");
  await page.waitForTimeout(15000);
  for (const t of ["SKIP", "Dismiss"]) {
    const el = await page.$(`text=${t}`);
    if (el) await el.click({ timeout: 5000 }).catch(() => {});
  }
  await page.waitForSelector(".dock-tab");
  await page.locator(".dock-tab", { hasText: "DEV" }).first().click();
  await page.waitForSelector(".essential-kit-dock", { timeout: 120000 });
  await page.click(".essential-kit-load");
  await page.waitForTimeout(3000);

  const budget = await page.evaluate(() => {
    const panel = document.querySelector(".devices-panel");
    const out = {
      panelClientH: Math.round(panel.getBoundingClientRect().height),
      panelScrollH: panel.scrollHeight,
      overflow: panel.scrollHeight - panel.clientHeight,
      overflowY: getComputedStyle(panel).overflowY,
      dockHeightSetting: getComputedStyle(panel.parentElement).height,
      blocks: [],
      kitParts: {},
    };
    // Every direct child of the panel, in document order.
    for (const el of panel.children) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      out.blocks.push({
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 50),
        h: Math.round(r.height),
        flex: s.flex,
        overflow: s.overflow,
        mt: s.marginTop,
        mb: s.marginBottom,
        padY: s.paddingTop + "/" + s.paddingBottom,
      });
    }
    const kit = document.querySelector(".essential-kit-dock");
    for (const el of kit.children) {
      const r = el.getBoundingClientRect();
      out.kitParts[(el.className || "").toString().split(" ")[0] || el.tagName] = Math.round(r.height);
    }
    // How tall is one knob cell? That is the unit that decides whether the
    // multiview can be made to FIT instead of scrolling.
    const cell = document.querySelector(".kit-multiview-device .fx-param-cell");
    if (cell) {
      const r = cell.getBoundingClientRect();
      const s = getComputedStyle(cell);
      out.knobCell = { h: Math.round(r.height), padY: s.paddingTop + "/" + s.paddingBottom, margin: s.margin };
    }
    const col = document.querySelector(".kit-multiview-device[data-type='reverb']");
    if (col) out.reverbColumn = Math.round(col.getBoundingClientRect().height);
    const eqCol = document.querySelector(".kit-multiview-device[data-type='eq']");
    if (eqCol) out.eqColumn = Math.round(eqCol.getBoundingClientRect().height);
    return out;
  });
  writeFileSync(".artifacts/panel-budget.json", JSON.stringify(budget, null, 2));
  console.log("WRITTEN");
  await page.screenshot({ path: ".artifacts/panel-now.png" }).catch(() => {});
} catch (err) {
  console.log("PROBE ERROR:", err.message);
} finally {
  await browser.close();
}
