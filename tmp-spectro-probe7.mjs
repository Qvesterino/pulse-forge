import { chromium } from "playwright";
const ctx = await chromium.launchPersistentContext("tmp-spectro-profile", {
  headless: true,
  viewport: { width: 1600, height: 900 },
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 150)));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
const safeState = async () => {
  try {
    return await page.evaluate(() => ({
      url: location.href,
      masterMeter: document.querySelectorAll(".master-meter").length,
      spectrogram: document.querySelectorAll(".spectrogram").length,
      buttons: Array.from(document.querySelectorAll("button"))
        .map((b) => (b.textContent || "").trim().slice(0, 22))
        .filter(Boolean)
        .slice(0, 34),
    }));
  } catch {
    return null;
  }
};
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  const st = await safeState();
  if (!st) { console.log(i, "navigating..."); continue; }
  if (st.masterMeter > 0) { console.log("STUDIO OPEN at", st.url); console.log(JSON.stringify(st).slice(0, 600)); break; }
  const has = (re) => st.buttons.find((b) => re.test(b));
  const openStudio = has(/open the studio/i);
  const house = has(/^HOUSE/);
  const cont = has(/CONTINUE LAST PROJECT/i);
  try {
    if (cont) await page.locator('button:has-text("CONTINUE LAST PROJECT")').first().click({ timeout: 2000 });
    else if (openStudio) await page.locator('button:has-text("Open the studio")').first().click({ timeout: 2000 });
    else if (house) await page.locator('button:has-text("HOUSE")').first().click({ timeout: 2000 });
    if (cont || openStudio || house) console.log(i, "clicked", cont ? "continue" : openStudio ? "openStudio" : "house");
  } catch {}
}
await page.screenshot({ path: "tmp-spectro-shots/studio2.png" });
await ctx.close();
