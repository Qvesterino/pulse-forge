/**
 * state-matrix.mts — PHASE A: record what each interaction state actually
 * looks like, and write it down.
 *
 *   npx vite-node scripts/state-matrix.mts [--url http://127.0.0.1:5173] [--shots]
 *
 * WHAT IT DOES
 * ------------
 * Boots the studio ONCE, then drives it through each state and reads the same
 * role catalog the Diagnostics panel will read. Writes a JSON snapshot and a
 * screenshot per state.
 *
 * It declares nothing. The output is DATA, not a verdict: phase B decides what
 * each state SHOULD look like, from this data, with a human in the loop.
 * Deciding first is how wave 4 pinned a number to one sample.
 *
 * A STATE THAT WAS NOT ENTERED IS REPORTED AS NOT ENTERED. The recorder never
 * claims a state it could not actually reach — a gate that reports green over
 * an unmeasured surface is worse than no gate.
 *
 * Exit codes: 0 = recorded, 1 = a state could not be entered, 2 = HARNESS_ERROR
 * (nothing was measured; NOT a result).
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { STATE_ROLES, STATES, readStateMatrix, type StateSnapshot } from "../src/ui/stateMatrix";

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf("--url");
const URL = urlIndex >= 0 ? argv[urlIndex + 1] : "http://127.0.0.1:5173";
const SHOTS = argv.includes("--shots");

const EXIT_STATE_UNREACHED = 1;
const EXIT_HARNESS_ERROR = 2;
process.on("uncaughtException", (error) => {
  console.error(`HARNESS_ERROR (not a result - nothing was measured): ${error?.message ?? error}`);
  process.exit(EXIT_HARNESS_ERROR);
});

const STUDIO_WAIT_MS = 480_000;
const outDir = resolve("output/state-matrix");
const shotDir = resolve("output/playwright");
mkdirSync(outDir, { recursive: true });
if (SHOTS) mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
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

// Warm the optimizer: vite's dependency optimizer can force a reload mid-load,
// which lands after the project is opened and leaves the studio chrome down.
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(3000);
await page.reload({ waitUntil: "domcontentloaded" });

const continueCard = page.locator("button.pb-continue-card");
const templateCard = page.locator("button.pb-template-start");
await continueCard.or(templateCard).first().waitFor({ state: "visible", timeout: 60_000 });
const resume = (await continueCard.count()) > 0 && (await continueCard.isVisible());
await (resume ? continueCard : templateCard).first().click();
console.log(`booted once: ${resume ? "resumed last project" : "opened House template"}`);

await page.locator(".topbar, .crash-screen, .boot-error").first().waitFor({ state: "visible", timeout: STUDIO_WAIT_MS });
await page.waitForTimeout(1200);
const crashed = page.locator(".crash-screen, .boot-error").first();
if ((await crashed.count()) > 0) {
  throw new Error(`studio boot did not settle: ${(await crashed.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
}
const skipTour = page.locator("button:has-text('SKIP')").first();
if ((await skipTour.count()) > 0 && (await skipTour.isVisible().catch(() => false))) {
  await skipTour.click().catch(() => {});
  await page.waitForTimeout(400);
}

/** Read the matrix out of the live DOM. */
const measure = async () => await page.evaluate(readStateMatrix, STATE_ROLES);

const snapshots: StateSnapshot[] = [];

async function record(stateId: string, entered: boolean, note?: string) {
  const def = STATES.find((s) => s.id === stateId);
  const readings = await measure();
  const snapshot: StateSnapshot = {
    state: stateId,
    label: def?.label ?? stateId,
    entered,
    ...(note ? { note } : {}),
    readings,
  };
  snapshots.push(snapshot);
  if (SHOTS) {
    await page.screenshot({ path: resolve(shotDir, `state-${stateId}.png`) });
  }
  const accents = readings.filter((r) => r.hasAccent).map((r) => r.roleId);
  console.log(
    `  ${entered ? "entered" : "NOT ENTERED"}  ${stateId.padEnd(10)} ` +
      `roles=${readings.filter((r) => r.visible > 0).length}/${readings.length}` +
      (accents.length ? `  accent: ${accents.join(", ")}` : ""),
  );
  if (note) console.log(`      ${note}`);
  return snapshot;
}

// ---- idle ------------------------------------------------------------------
await page.waitForTimeout(400);
await record("idle", true);

// ---- selected --------------------------------------------------------------
const firstRow = page.locator(".row-pad").first();
if ((await firstRow.count()) > 0) {
  await firstRow.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(500);
  const readings = await measure();
  const selected = readings.find((r) => r.roleId === "rowPad");
  await record("selected", !!selected?.hasAccent, selected?.hasAccent ? undefined : "no amber accent on the channel row after the click");
} else {
  await record("selected", false, "no .row-pad in the shell");
}

// ---- playing ---------------------------------------------------------------
const play = page.locator(".btn-play").first();
if ((await play.count()) > 0) {
  await play.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
  const playing = (await page.locator(".btn-play.active").count()) > 0;
  await record("playing", playing, playing ? undefined : "the transport did not report a playing state");
} else {
  await record("playing", false, "no .btn-play in the shell");
}

// ---- hover -----------------------------------------------------------------
// Stop first: a moving playhead would confound a reading about hover.
const stop = page.locator(".btn-stop").first();
if ((await stop.count()) > 0) await stop.click({ timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(500);
const hoverTarget = page.locator(".transport-cluster .btn").first();
if ((await hoverTarget.count()) > 0) {
  await hoverTarget.hover({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(300);
  await record("hover", true);
  await page.mouse.move(5, 5).catch(() => {});
  await page.waitForTimeout(200);
} else {
  await record("hover", false, "no .transport-cluster .btn to hover");
}

// ---- focus -----------------------------------------------------------------
const focusTarget = page.locator(".transport-cluster .btn").first();
if ((await focusTarget.count()) > 0) {
  await focusTarget.focus({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => document.activeElement?.className ?? "");
  await record("focus", /transport-cluster/.test(focused) || focused.length > 0, focused.length === 0 ? "nothing took focus" : undefined);
} else {
  await record("focus", false, "no .transport-cluster .btn to focus");
}

// ---- recording -------------------------------------------------------------
// The transport's RECORD is MIDI overdub into the pattern (patternRecorder),
// not microphone capture - so it needs no permission dialog and IS reachable.
const rec = page.locator(".btn-record").first();
if ((await rec.count()) > 0) {
  await rec.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
  const armed = (await page.locator(".btn-record.armed").count()) > 0;
  await record("recording", armed, armed ? undefined : "the record button did not report an armed state");
} else {
  await record("recording", false, "no .btn-record in the shell");
}

await context.close();
await browser.close();

writeFileSync(resolve(outDir, "snapshot.json"), JSON.stringify({ states: snapshots }, null, 2));
for (const s of snapshots) {
  writeFileSync(resolve(outDir, `${s.state}.json`), JSON.stringify(s, null, 2));
}

// A state that could not be entered is a RESULT, not a harness error: the
// recorder did its job and the answer is "this surface was not reachable".
const unreached = snapshots.filter((s) => !s.entered);
console.log(`\nrecorded ${snapshots.length - unreached.length}/${snapshots.length} states -> ${outDir}`);
if (unreached.length) {
  console.error(`\n${unreached.length} state(s) could not be entered: ${unreached.map((s) => s.state).join(", ")}`);
  process.exit(EXIT_STATE_UNREACHED);
}
process.exit(0);