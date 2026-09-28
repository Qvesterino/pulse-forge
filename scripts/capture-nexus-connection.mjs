/**
 * Capture the real Audiotool NEXUS flow for the demo video.
 *
 * This drives the OAuth popup, the project picker, and the actual write into
 * a real Audiotool project — the whole chain, not a mock. It needs a
 * registered client id in `.env.local` and a signed-in Audiotool session, so
 * it is a manual-run script rather than part of CI.
 *
 * Usage:
 *   npx vite build
 *   npx vite preview --port 5173 --strictPort
 *   node scripts/capture-nexus-connection.mjs
 *
 * Env:
 *   NEXUS_ORIGIN   where KYX is served (must match the registered redirect)
 *   KYX_CAPTURE_OUT output directory (defaults to the remotion public dir)
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT =
  process.env.KYX_CAPTURE_OUT ??
  resolve(HERE, "../../QVESTER_LANDING_PAGE/remotion/audiotool-demo/public");
const ORIGIN = process.env.NEXUS_ORIGIN ?? "http://127.0.0.1:5173";

mkdirSync(OUT, { recursive: true });

const log = (...m) => console.log("[nexus-capture]", ...m);

/**
 * The OAuth popup is a real browser window, so the main page and the popup
 * are two separate Playwright pages. Waiting for the popup to hand control
 * back is the part that has to be right — a naive `waitForEvent("popup")`
 * races the app's own navigation.
 */
const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
  permissions: [],
});
const page = await context.newPage();

let popup = null;
context.on("page", (p) => {
  if (p !== page) popup = p;
});

log(`opening ${ORIGIN}`);
await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(5000);

// Open the studio. The IntentPanel lives inside the studio (App.tsx), not the
// landing page, and the AUDIOTOOL button only renders for an existing
// candidate — so the beat has to be generated from the studio's own field.
await page.goto(new URL("/studio", ORIGIN).href, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);

const openProject = page
  .getByRole("button", { name: /^(open|continue|resume|load|new|blank|empty|house|beat|template)/i })
  .first();
if (await openProject.count()) {
  try {
    await openProject.click({ timeout: 4000 });
    await page.waitForTimeout(8000);
  } catch {
    log("  (studio already open)");
  }
}

// The studio's IntentPanel field, identified by its aria-label.
const intent = page.locator('input[aria-label="Intent description"], textarea[aria-label="Intent description"]').first();
if (!(await intent.count())) {
  log("!! could not find the IntentPanel field — the panel is not mounted");
  await context.close();
  await browser.close();
  process.exit(1);
}
log("  typing the intent");
await intent.click();
await page.keyboard.type("dark trap 140", { delay: 50 });
await page.waitForTimeout(900);

// Enter only previews; GENERATE is what actually produces candidates.
const generate = page.getByRole("button", { name: /^GENERATE$/i }).first();
if (await generate.count()) {
  log("  pressing GENERATE");
  await generate.click();
} else {
  log("  (no GENERATE button — falling back to Enter)");
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(15_000);

// Open the NEXUS export dialog. The trigger in IntentPanel is a button whose
// label is exactly "AUDIOTOOL", and it only renders once a candidate exists —
// so generating a beat above is a precondition, not a nicety.
const nexusButton = page.getByRole("button", { name: "AUDIOTOOL", exact: true }).first();
if (!(await nexusButton.count())) {
  log("!! could not find the AUDIOTOOL button — no candidate was generated");
  await context.close();
  await browser.close();
  process.exit(1);
}
await nexusButton.click();
await page.waitForTimeout(2500);

// Load the connector.
const loadSdk = page.getByRole("button", { name: /načítať audiotoool connector|load audiotoool/i }).first();
if (await loadSdk.count()) {
  await loadSdk.click();
  await page.waitForTimeout(4000);
}

// Connect — this opens the real Audiotool popup.
const connect = page.getByRole("button", { name: /prihlásiť a pripojiť|sign in|connect/i }).first();
if (await connect.count()) {
  log("  clicking connect — a real OAuth popup will open");
  await connect.click();

  // The popup is owned by Audiotool, not us. We give the operator the
  // moment to complete sign-in, then check whether we got handed a session.
  log("  >>> complete sign-in in the Audiotool popup (60s window)");
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    if (popup && !popup.isClosed()) {
      const url = popup.url();
      if (/audiotool/i.test(url)) log(`  popup at ${url.slice(0, 90)}`);
    }
    const connected = await page.getByText(/vlož odkaz na svoj audiotoool studio projekt/i).count();
    if (connected) {
      log("  signed in");
      break;
    }
  }

  // Enter the Audiotool project URL if the environment supplied one.
  const projectUrl = process.env.AUDIOTOOL_PROJECT_URL;
  if (projectUrl) {
    const input = page.locator('input[type="url"]').first();
    if (await input.count()) {
      await input.fill(projectUrl);
      await page.waitForTimeout(800);
      const open = page.getByRole("button", { name: /otvoriť projekt|open project/i }).first();
      if (await open.count()) {
        await open.click();
        await page.waitForTimeout(9000);
      }
    }
  } else {
    log("  (set AUDIOTOOL_PROJECT_URL to also capture opening a real project)");
  }

  // Preview the plan, then confirm the write.
  await page.waitForTimeout(3000);
  const confirm = page
    .getByRole("button", { name: /potvrdiť|confirm|napísať|send|export/i })
    .first();
  if (await confirm.count()) {
    log("  confirming the write into the Audiotool document");
    await confirm.click();
    await page.waitForTimeout(12_000);
  } else {
    log("  (no confirm button found — capturing up to the preview)");
  }
} else {
  log("!! no connect button — is VITE_AUDIOTOOL_NEXUS_CLIENT_ID set?");
}

await page.waitForTimeout(2000);
await context.close();
await browser.close();

const files = readdirSync(OUT).filter((f) => f.endsWith(".webm"));
const newest = files
  .map((f) => ({ f, t: statSync(resolve(OUT, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (newest) {
  const target = resolve(OUT, "06-nexus-connect.webm");
  renameSync(resolve(OUT, newest.f), target);
  log("wrote", target);
}
