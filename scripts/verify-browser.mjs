import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5199;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

let exitCode = 0;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

  const results = await page.evaluate(async () => {
    const mod = await import("/src/browser-checks.ts");
    return mod.runChecks();
  });

  let failed = 0;
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failed++;
    console.log(`[${status}] ${r.name}${r.message && r.message !== "ok" ? ` — ${r.message}` : ""}`);
  }

  let appBootOk = false;
  const appErrors = [];
  const appPage = await browser.newPage();
  appPage.on("console", (msg) => {
    if (msg.type() === "error") appErrors.push(msg.text());
  });
  appPage.on("pageerror", (err) => appErrors.push(String(err)));
  await appPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  try {
    // New boot flow: the app always starts in the project browser.
    await appPage.waitForSelector(".project-browser", { timeout: 15000 });
    // Create a project from the House template — one click from browser to sound.
    await appPage.locator('.pb-template:has-text("HOUSE")').first().click();
    await appPage.waitForSelector(".topbar", { timeout: 15000 });
    await appPage.waitForSelector(".sequencer", { timeout: 15000 });
    const panels = ["MIX", "FX", "ARR", "MOD", "EXPORT"];
    for (const label of panels) {
      const btn = appPage.locator(`.topbar button:has-text("${label}")`).first();
      await btn.click();
      await appPage.waitForTimeout(150);
      await btn.click();
      await appPage.waitForTimeout(100);
    }
    // Groove workflow: controls visible, right-click step editor, scene strip.
    await appPage.waitForSelector(".pattern-groove", { timeout: 5000 });
    await appPage.waitForSelector(".scene-strip .scene-launch", { timeout: 5000 });
    const step = appPage.locator(".step").first();
    await step.click({ button: "right" });
    await appPage.waitForSelector(".step-editor", { timeout: 5000 });
    await appPage.locator(".step-editor-close").click();
    await appPage.waitForSelector(".step-editor", { state: "detached", timeout: 5000 });
    // Multi-select: shift+drag across steps selects the range.
    const firstStep = await appPage.locator(".step").nth(0).boundingBox();
    const fourthStep = await appPage.locator(".step").nth(3).boundingBox();
    if (firstStep && fourthStep) {
      await appPage.mouse.move(firstStep.x + 5, firstStep.y + firstStep.height / 2);
      await appPage.keyboard.down("Shift");
      await appPage.mouse.down();
      await appPage.mouse.move(fourthStep.x + fourthStep.width - 5, fourthStep.y + fourthStep.height / 2, { steps: 6 });
      await appPage.mouse.up();
      await appPage.keyboard.up("Shift");
    }
    const selectedSteps = await appPage.locator(".step.in-selection").count();
    if (selectedSteps < 2) throw new Error(`multi-select expected >=2 selected steps, got ${selectedSteps}`);
    await appPage.keyboard.press("Escape");
    // Arrangement ruler seeks the transport.
    await appPage.locator('.topbar button:has-text("ARR")').first().click();
    await appPage.waitForSelector(".arr-ruler", { timeout: 5000 });
    const ruler = appPage.locator(".arr-ruler").first();
    const box = await ruler.boundingBox();
    if (box) {
      await appPage.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    }
    await appPage.locator('.topbar button:has-text("ARR")').first().click();
    // Return to the browser — the freshly created project must be listed.
    await appPage.locator('.topbar button:has-text("PROJECTS")').first().click();
    await appPage.waitForSelector(".project-browser", { timeout: 15000 });
    await appPage.waitForSelector(".pb-row", { timeout: 15000 });
    const fatal = appErrors.filter((e) => !/AudioContext|autoplay|user gesture/i.test(e));
    if (fatal.length === 0) {
      appBootOk = true;
      console.log("[PASS] app boots into browser, opens a template, panels mount, project listed on return");
    } else {
      console.log("[FAIL] app boot — console errors:", fatal.slice(0, 5));
    }
  } catch (error) {
    console.log("[FAIL] app boot — UI did not mount:", String(error).split("\n")[0]);
    if (appErrors.length > 0) console.log("  console errors:", appErrors.slice(0, 5));
  }
  await appPage.close();

  const total = results.length + 1;
  const passed = results.length - failed + (appBootOk ? 1 : 0);
  console.log(`\n${passed}/${total} checks passed`);
  if (consoleErrors.length > 0) {
    console.log("console errors during audio checks:", consoleErrors.slice(0, 5));
  }
  exitCode = failed > 0 || !appBootOk ? 1 : 0;
} catch (error) {
  console.error("browser verification failed:", error);
  exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  process.exit(exitCode);
}
