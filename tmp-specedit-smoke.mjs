import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
mkdirSync("tmp-spectro-shots", { recursive: true });
const ctx = await chromium.launchPersistentContext("tmp-spectro-profile", {
  headless: true,
  viewport: { width: 1600, height: 900 },
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + String(e).slice(0, 200)));

try {
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  let opened = false;
  for (let i = 0; i < 40 && !opened; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({
      mm: document.querySelectorAll(".master-meter").length,
      seq: document.querySelectorAll("[class*=sequencer]").length,
      btns: Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").trim().slice(0, 24)),
    })).catch(() => null);
    if (!st) continue;
    if (st.mm > 0 && st.seq > 0) { opened = true; break; }
    const has = (re) => st.btns.find((b) => re.test(b));
    try {
      if (st.seq > 0 && st.mm === 0) await page.locator('button:has-text("MIX")').first().click({ timeout: 1500 });
      else if (has(/CONTINUE LAST PROJECT/i)) await page.locator('button:has-text("CONTINUE LAST PROJECT")').first().click({ timeout: 1500 });
      else if (has(/open the studio/i)) await page.locator('button:has-text("Open the studio")').first().click({ timeout: 1500 });
      else if (has(/^HOUSE/)) await page.locator('button:has-text("HOUSE")').first().click({ timeout: 1500 });
    } catch {}
  }
  if (!opened) throw new Error("studio did not open");
  await page.waitForTimeout(800);

  // Open the ARRANGEMENT panel (topbar ARR). The toggle buttons live in the
  // topbar; ARR may need the panel switch — click and verify ruler appears.
  await page.locator('.topbar button:has-text("ARR"), button:has-text("ARR")').first().click();
  await page.waitForSelector(".arr-ruler", { timeout: 20000 });
  console.log("arrangement open");

  // Drag a time range on the ruler (~2 bars).
  const ruler = await page.locator(".arr-ruler").boundingBox();
  await page.mouse.move(ruler.x + 40, ruler.y + ruler.height / 2);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 40 + 240, ruler.y + ruler.height / 2, { steps: 8 });
  await page.mouse.up();

  // Bounce the zone to an audio clip.
  await page.locator('button:has-text("BOUNCE ZONE")').first().click();
  await page.waitForSelector(".arr-audio-clip", { timeout: 60000 });
  console.log("audio clip created via bounce");
  await page.waitForTimeout(1000);

  // Right-click the clip → AUDIO CLIP menu → Spectral Edit…
  await page.locator(".arr-audio-clip").first().click({ button: "right" });
  await page.waitForSelector('div[role="menu"]', { timeout: 5000 });
  await page.locator('button:has-text("Spectral Edit…")').first().click();
  await page.waitForSelector('[data-testid="spectral-edit-panel"]', { timeout: 5000 });
  console.log("spectral edit panel open");

  // Spectrogram painted?
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="spectral-edit-panel"] canvas');
    if (!canvas) return false;
    const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++;
    return n > 5000;
  });
  console.log("spectrogram painted:", painted);

  // Drag a selection over the middle of the view.
  const box = await page.locator('[data-testid="spectral-edit-overlay"]').boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.85, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const selDrawn = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="spectral-edit-overlay"]');
    const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++;
    return n > 200;
  });
  console.log("selection drawn:", selDrawn);
  await page.screenshot({ path: "tmp-spectro-shots/14-specedit-panel.png" });

  // Slam gain to -60 via native setter, then APPLY.
  await page.evaluate(() => {
    const slider = document.querySelector('[data-testid="spectral-edit-panel"] input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(slider, "-60");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.locator('button:has-text("APPLY")').first().click();
  await page.waitForSelector('[data-testid="spectral-edit-panel"]', { state: "detached", timeout: 30000 });
  console.log("applied — panel closed");

  // Clip must still exist after the rewire.
  const clipCount = await page.locator(".arr-audio-clip").count();
  console.log("clips after apply:", clipCount);

  const pass = painted && selDrawn && clipCount >= 1;
  console.log(pass ? "PASS" : "FAIL");
  if (!pass) process.exitCode = 1;
} catch (err) {
  console.error("ERROR:", String(err).slice(0, 300));
  process.exitCode = 1;
} finally {
  if (consoleErrors.length) console.log("console errors:", JSON.stringify(consoleErrors.slice(0, 8), null, 1));
  await ctx.close();
}
