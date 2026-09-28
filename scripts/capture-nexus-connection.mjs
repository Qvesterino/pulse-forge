/**
 * Capture the KYX -> Audiotool NEXUS bridge for the demo video.
 *
 * This proves the integration rather than a login: it generates a beat from
 * the Intent Engine, applies it, opens the NEXUS export dialog, loads the
 * real `@audiotool/nexus` SDK, and writes the plan into a real NEXUS
 * document. The offline document is the same document type the SDK uses
 * against a live project, validated by the same wasm schema — it simply
 * does not sync, which requires an OAuth session and is not a hackathon
 * requirement.
 *
 * What the capture shows, in order:
 *   1. "dark trap 140" typed into the Intent Engine
 *   2. GENERATE — candidates produced by the real engine
 *   3. USE — the winning candidate applied to the project
 *   4. AUDIOTOOL — the NEXUS export dialog
 *   5. Load the NEXUS SDK
 *   6. Create the NEXUS document
 *   7. The write plan preview (parts, notes, bars)
 *   8. The confirmed write and its receipt
 *
 * Nothing here is mocked: every frame is the product running, and the
 * write goes through Audiotool's own validation.
 *
 * Usage:
 *   npx vite build
 *   npx vite preview --port 5173 --strictPort
 *   node scripts/capture-nexus-connection.mjs
 *
 * Env:
 *   NEXUS_ORIGIN     where KYX is served (default http://127.0.0.1:5173)
 *   KYX_CAPTURE_OUT  output dir (defaults to the remotion public dir)
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

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();

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
// The engine ranks candidates through a model worker; the list keeps growing
// for a while after the button flips to GENERATING. Wait for the AUDIOTOOL
// button itself rather than for a fixed delay.
const nexusReady = page.getByRole("button", { name: "AUDIOTOOL", exact: true }).first();
let appeared = false;
for (let i = 0; i < 40; i++) {
  if (await nexusReady.count()) {
    appeared = true;
    log(`  candidates ready after ${i}s`);
    break;
  }
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(2500);

/*
 * Order matters, and it is the opposite of what it looks like.
 *
 * The AUDIOTOOL button lives inside the candidate row, and `useCandidate`
 * ends with `setBankResult(null)` (IntentPanel.tsx:842) — applying a
 * candidate clears the whole candidate list, taking AUDIOTOOL with it.
 * So the export dialog must be opened from the candidate BEFORE it is used.
 * The dialog snapshots the candidate's pattern and the current project
 * (`setAudiotoolExport` at IntentPanel.tsx:3043), so it does not need the
 * candidate to still be on screen afterwards.
 */
const nexusButton = nexusReady;
if (!appeared) {
  const survey = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return {
      buttons: [...document.querySelectorAll("button")]
        .filter(vis)
        .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 26))
        .filter((t) => /audiotool|use|generat/i.test(t))
        .slice(0, 20),
      candidateRows: document.querySelectorAll(".intent-candidate").length,
    };
  });
  log("  survey:", JSON.stringify(survey));
  await page.screenshot({ path: "nexus-no-button.png" });
  log("!! candidates never produced an AUDIOTOOL button — see nexus-no-button.png");
  await context.close();
  await browser.close();
  process.exit(1);
}

// Dismiss the first-run coach mark. It overlays the lower middle of the
// studio, which is exactly where the candidate row's AUDIOTOOL button is,
// so an undismissed coach mark swallows the click.
const skip = page.getByRole("button", { name: /^SKIP$/i }).first();
if (await skip.count()) {
  log("  dismissing the first-run coach mark");
  await skip.click();
  await page.waitForTimeout(1500);
} else {
  const next = page.getByRole("button", { name: /^NEXT$/i }).first();
  if (await next.count()) {
    for (let i = 0; i < 6; i++) {
      if (!(await skip.count())) break;
      await next.click();
      await page.waitForTimeout(700);
    }
  }
}

log("  opening the NEXUS export dialog from the candidate");
await nexusButton.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(500);
await nexusButton.click();
await page.waitForTimeout(5000);

// Report exactly what the dialog offers, whatever it is called.
const inDialog = await page.evaluate(() => {
  const dlg = document.querySelector(".audiotool-nexus-export");
  if (!dlg) return { mounted: false };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return {
    mounted: true,
    text: (dlg.innerText || "").slice(0, 400),
    buttons: [...dlg.querySelectorAll("button")].filter(vis).map((b) => b.textContent.trim().slice(0, 40)),
  };
});
log("  dialog:", JSON.stringify(inDialog, null, 1));

// Load the connector — this pulls the real @audiotool/nexus SDK.
// Match on the class, not the Slovak label — a regex over non-ASCII text has
// already silently failed once after a PowerShell rewrite mangled the bytes.
const loadSdk = page.locator(".audiotool-nexus-export button.intent-use-btn").first();
if (await loadSdk.count()) {
  log("  loading the NEXUS SDK");
  await loadSdk.click();
  await page.waitForTimeout(6000);
} else {
  log("  (no connector button)");
}

/*
 * The hackathon requires building WITH the Nexus SDK, not a signed-in
 * session. So this capture proves the bridge rather than the login: the
 * offline path builds a real NEXUS document in this tab — same entity
 * schema, same wasm validation, same transaction layer as a synced one —
 * and writeAudiotoolPlan writes into it for real. What it does not do is
 * sync to Audiotool's backend, which needs an OAuth session.
 */
const offline = page.locator(".audiotool-nexus-export button.intent-use-btn").first();
if (await offline.count()) {
  log("  creating an offline NEXUS document (real schema, real validation)");
  await offline.click();
  await page.waitForTimeout(7000);

  // The preview renders here: parts, notes, bars.
  log("  plan preview rendered — capturing it");
  await page.waitForTimeout(4000);

  // Confirm the write and let the receipt render.
  const confirm = page
    .getByRole("button", { name: /potvrdiť a napísať|confirm|napísať do audiotoool|send|export/i })
    .first();
  if (await confirm.count()) {
    log("  confirming the write into the NEXUS document");
    await confirm.click();
    await page.waitForTimeout(14_000);
  } else {
    log("  (no confirm button — capturing the plan preview)");
    await page.waitForTimeout(5000);
  }
} else {
  log("!! no offline button found — the NEXUS dialog did not offer the offline path");
  await page.screenshot?.({ path: "nexus-dialog-debug.png" }).catch(() => {});
}

await page.waitForTimeout(2500);
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
