import { chromium } from "playwright";

const URL = process.argv[2] ?? "http://127.0.0.1:5288";
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultNavigationTimeout(300_000);
page.setDefaultTimeout(300_000);
await page.addInitScript(() => {
  try {
    localStorage.setItem("pf-onboarded", "1");
  } catch {
    /* ignore */
  }
});
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.locator("button.pb-template-start").first().waitFor({ state: "visible", timeout: 120_000 });
await page.locator("button.pb-template-start").first().click();
await page.locator(".sequencer-row").first().waitFor({ state: "visible", timeout: 300_000 });
await page.waitForTimeout(1200);

const info = await page.evaluate(() => {
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : null);
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      h: Math.round(r.height * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      padding: `${cs.paddingTop}/${cs.paddingBottom}`,
      margin: `${cs.marginTop}/${cs.marginBottom}`,
      lineHeight: cs.lineHeight,
      fontSize: cs.fontSize,
      display: cs.display,
    };
  };
  const rows = [...document.querySelectorAll(".sequencer-row")];
  const pitches = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].getBoundingClientRect();
    const b = rows[i].getBoundingClientRect();
    pitches.push(Math.round((b.top - a.top) * 10) / 10);
  }
  return {
    rowBox: box(".sequencer-row"),
    rowLabel: box(".row-label"),
    rowPad: box(".row-pad"),
    rowPadIndex: box(".row-pad-index"),
    rowPadName: box(".row-pad-name"),
    rowToggle: box(".row-toggle"),
    rowMeter: box(".row-pad-meter"),
    step: box(".step"),
    rowSteps: box(".row-steps"),
    pitch: [...new Set(pitches)],
    labelChildren: [...(document.querySelector(".row-label")?.children ?? [])].map((c) => ({
      cls: c.className,
      h: Math.round(c.getBoundingClientRect().height * 10) / 10,
    })),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();