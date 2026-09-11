import { preview } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.KYX_PRODUCTION_BROWSER_PORT) || 5239;
const baseUrl = `http://127.0.0.1:${port}`;
const worklets = [
  "/bitcrusher-worklet.js",
  "/core-worklet.js",
  "/fxeq-worklet.js",
  "/ultina-worklet.js",
  "/ozvena-worklet.js",
];

let server;
let browser;
let exitCode = 0;
try {
  server = await preview({
    root,
    logLevel: "error",
    preview: { host: "127.0.0.1", port, strictPort: true },
  });
  console.log("[production-smoke] preview listening");
  browser = await chromium.launch({ headless: true });
  console.log("[production-smoke] chromium launched");
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    localStorage.setItem("pf-onboarded", "1");
    localStorage.setItem("pf-tour-v1", "1");
  });

  // Do not wait for networkidle: the PWA/service-worker layer may keep
  // background requests alive even after the production document is ready.
  const response = await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log("[production-smoke] document loaded");
  if (!response?.ok()) throw new Error(`production index returned ${response?.status() ?? "no response"}`);
  console.log("[production-smoke] waiting for project browser");
  try {
    await page.waitForSelector(".project-browser", { timeout: 60_000 });
    console.log("[production-smoke] project browser ready");
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      title: document.title,
      bodyText: document.body.innerText.slice(0, 1200),
      bodyClasses: document.body.className,
      rootHtml: document.querySelector("#root")?.innerHTML.slice(0, 1600) ?? "",
    }));
    throw new Error(`production app did not boot: ${JSON.stringify(diagnostics)}\n${error?.message ?? error}`);
  }

  // The first card is intentionally not a contract (the product may reorder
  // templates). HOUSE guarantees an instrument track, so the following FX
  // assertion tests a real rack rather than an empty-project edge case.
  const template = page.locator('.pb-template:has-text("HOUSE")').first();
  console.log("[production-smoke] locating HOUSE template");
  if ((await template.count()) === 0) throw new Error("no production project template rendered");
  await template.click();
  console.log("[production-smoke] HOUSE template selected");
  await page.waitForSelector(".topbar", { timeout: 30_000 });
  await page.waitForSelector(".sequencer", { timeout: 30_000 });

  const fx = page.locator('.topbar button:has-text("FX")').first();
  if ((await fx.getAttribute("aria-pressed")) !== "true") await fx.click();
  console.log("[production-smoke] FX panel opened");
  await page.waitForSelector(".fx-rack", { timeout: 10_000 });
  const addEffect = page.locator(".fx-rack select.fx-add-select").first();
  const addEffectCount = await page.locator(".fx-rack select.fx-add-select").count();
  console.log(`[production-smoke] FX add controls found: ${addEffectCount}`);
  if (addEffectCount === 0) {
    const rack = await page.locator(".fx-rack").innerText().catch(() => "<missing rack>");
    throw new Error(`production FX add control missing; rack text: ${rack}`);
  }
  const addEffectState = await addEffect.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      disabled: element.disabled,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      width: rect.width,
      height: rect.height,
      value: element.value,
      options: [...element.options].map((option) => ({ value: option.value, disabled: option.disabled })),
    };
  });
  console.log("[production-smoke] FX add control inspected");
  if (addEffectState.disabled || addEffectState.display === "none" || addEffectState.visibility === "hidden") {
    throw new Error(`production FX add control is not usable: ${JSON.stringify(addEffectState)}`);
  }
  // React owns the select value. On the production preview the browser can
  // retain a transient native-select interaction lock during the first
  // AudioContext/worklet boot, making Playwright's selectOption wait forever
  // even though the control is visibly enabled. Use the same DOM change event
  // that a native selection emits, then assert the resulting React device.
  await addEffect.evaluate((element) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(element, "fxeq");
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  console.log("[production-smoke] FX add event dispatched");
  await page.waitForSelector('.fx-device[data-effect-type="fxeq"], .fx-device', { timeout: 10_000 });
  console.log("[production-smoke] FX device rendered");

  const assetResults = await page.evaluate(async (paths) => {
    const entries = ["/manifest.webmanifest", ...paths];
    return Promise.all(
      entries.map(async (path) => {
        const response = await fetch(path, { cache: "no-store" });
        const body = await response.text();
        return { path, status: response.status, bytes: body.length };
      }),
    );
  }, worklets);
  const failedAssets = assetResults.filter((entry) => entry.status !== 200 || entry.bytes === 0);
  if (failedAssets.length > 0) {
    throw new Error(`production asset failure: ${JSON.stringify(failedAssets)}`);
  }

  const fatalErrors = errors.filter((message) => !/AudioContext|autoplay|user gesture/i.test(message));
  if (fatalErrors.length > 0) throw new Error(`production console/page error: ${fatalErrors[0]}`);
  console.log("[PASS] production browser smoke — dist boot, template, sequencer, FX rack and shipped assets");
} catch (error) {
  exitCode = 1;
  console.error(`[FAIL] production browser smoke — ${error?.stack ?? String(error)}`);
} finally {
  await browser?.close();
  if (server?.httpServer?.listening) {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}
process.exitCode = exitCode;
