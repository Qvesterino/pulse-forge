import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
mkdirSync("tmp-spectro-shots", { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 180)); });
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + String(e).slice(0, 180)));

try {
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator('button:has-text("Open the studio")').first().click();
  await page.waitForSelector('button:has-text("HOUSE")', { timeout: 30000 });
  await page.locator('button:has-text("HOUSE")').first().click();
  await page.waitForSelector(".spectrogram", { timeout: 60000 });
  console.log("studio open, spectrogram strip present");
  console.log("collapsed data-open:", await page.getAttribute(".spectrogram", "data-open"));
  await page.waitForTimeout(1200);
  await page.locator(".master-meter").screenshot({ path: "tmp-spectro-shots/1-collapsed.png" });

  await page.locator(".spectrogram-collapse").click();
  await page.waitForSelector(".spectrogram-body canvas", { timeout: 10000 });
  console.log("expanded data-open:", await page.getAttribute(".spectrogram", "data-open"));
  await page.waitForTimeout(600);
  await page.locator(".master-meter").screenshot({ path: "tmp-spectro-shots/2-open-idle.png" });

  await page.keyboard.press("Space");
  await page.waitForTimeout(6000);

  const stats = await page.evaluate(() => {
    const canvas = document.querySelector(".spectrogram-canvas");
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    const { width: w, height: h } = canvas;
    const img = ctx.getImageData(0, 0, w, h).data;
    const colors = new Set();
    let painted = 0;
    for (let i = 0; i < img.length; i += 4) {
      colors.add(`${img[i]},${img[i + 1]},${img[i + 2]}`);
      if (img[i + 3] > 0) painted++;
    }
    return { w, h, distinctColors: colors.size, paintedPx: painted, totalPx: w * h };
  });
  console.log("canvas stats:", JSON.stringify(stats));
  await page.locator(".master-meter").screenshot({ path: "tmp-spectro-shots/3-open-playing.png" });

  const box = await page.locator(".spectrogram-overlay").boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
    await page.waitForTimeout(500);
    await page.locator(".master-meter").screenshot({ path: "tmp-spectro-shots/4-hover-readout.png" });
  }

  if (!stats || stats.distinctColors < 20) {
    console.error("FAIL: canvas flat/empty — no real FFT data");
    process.exitCode = 1;
  } else {
    console.log("PASS:", stats.distinctColors, "distinct colors,", stats.paintedPx, "painted px");
  }
} catch (err) {
  console.error("ERROR:", String(err).slice(0, 400));
  process.exitCode = 1;
} finally {
  if (consoleErrors.length) console.log("console errors:", JSON.stringify(consoleErrors.slice(0, 8), null, 1));
  await browser.close();
}
