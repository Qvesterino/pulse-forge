// Throwaway diagnostic: trace what happens between template click and the app
// returning to the project browser.
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
if (root.toUpperCase() === path.parse(root).root.toUpperCase()) throw new Error("root escaped");
const PORT = 5266;
const T = 300_000;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem("pf-onboarded", "1");
    localStorage.setItem("pf-tour-v1", "1");
  });
  const page = await context.newPage();
  page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text().slice(0, 220)));
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) console.log("[nav]", f.url());
  });

  const snap = () =>
    page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const box = (s) => {
        const el = q(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
      };
      return {
        path: location.pathname + location.search,
        topbar: !!q(".topbar"),
        sequencer: !!q(".sequencer"),
        sequencerBox: box(".sequencer"),
        projectBrowser: !!q(".project-browser"),
        dockButtons: document.querySelectorAll(".dock-tabs button").length,
        crashBanner: !!Array.from(document.querySelectorAll("div")).find((d) =>
          (d.textContent || "").startsWith("The last session did not end"),
        ),
      };
    });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: T });
  await page.waitForSelector(".project-browser", { timeout: T });
  console.log("[diag] browser ok:", JSON.stringify(await snap()));

  console.log("[diag] clicking HOUSE template ...");
  await page.evaluate(() => document.querySelectorAll(".pb-template")[0]?.click());

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const s = await snap();
    console.log(`[diag] +${(i + 1) * 2}s ${JSON.stringify(s)}`);
    if (s.projectBrowser && !s.topbar && i > 4) {
      console.log("[diag] returned to the project browser — stopping trace");
      break;
    }
  }
  await page.screenshot({ path: ".debug-drag2.png" });
  console.log("[diag] screenshot -> .debug-drag2.png");
} catch (e) {
  console.error("[diag] failed:", String(e).split("\n")[0]);
} finally {
  await browser.close();
  await server.close();
}