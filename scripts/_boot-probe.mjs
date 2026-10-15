import { chromium } from "playwright";

const URL = process.argv[2] ?? "http://127.0.0.1:5199";
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("console", (m) => console.log(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
page.on("requestfailed", (r) =>
  console.log(`[reqfail] ${r.url().slice(0, 140)} :: ${r.failure()?.errorText}`),
);

await page.addInitScript(() => {
  try {
    localStorage.setItem("pf-onboarded", "1");
  } catch {
    /* ignore */
  }
});

console.log("goto", URL);
await page.goto(URL, { waitUntil: "domcontentloaded" });

// Poll the boot screen text so we see WHERE it settles.
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => ({
    text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 220),
    hasTopbar: !!document.querySelector(".topbar"),
    hasPb: !!document.querySelector(".pb-template"),
    rootChildren: document.getElementById("root")?.childElementCount ?? -1,
  }));
  console.log(`t+${(i + 1) * 5}s topbar=${state.hasTopbar} pb=${state.hasPb} :: ${state.text}`);
  if (state.hasTopbar) break;
}

await page.screenshot({ path: "output/playwright/_boot-probe.png" });
await browser.close();