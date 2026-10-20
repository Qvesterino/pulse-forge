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
import { bootStudio } from "./lib/studio-boot.mjs";
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

// ONE boot, shared with every other gate (scripts/lib/studio-boot.mjs).
// The first draft of this script carried its own copy and waited on
// `button.pb-template-start` — a class commit 8d11f16b removed from the
// markup. The template now lives in a CLOSED <details>, so the button is in
// the DOM but NOT visible, and waiting on visibility is what timed out.
await bootStudio(page, URL, { label: "state-matrix" });

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
  const marked = readings.filter((r) => r.accentCount > 0).map((r) => `${r.roleId}(${r.accentCount})`);
  const rings = readings.filter((r) => r.ringCount > 0).map((r) => `${r.roleId}(${r.ringCount})`);
  const borders = readings.filter((r) => r.borderAccentCount > 0).map((r) => `${r.roleId}(${r.borderAccentCount})`);
  console.log(
    `  ${entered ? "entered" : "NOT ENTERED"}  ${stateId.padEnd(10)} ` +
      `roles=${readings.filter((r) => r.visible > 0).length}/${readings.length}` +
      (marked.length ? `  inset: ${marked.join(", ")}` : "") +
      (borders.length ? `  border: ${borders.join(", ")}` : "") +
      (rings.length ? `  rings: ${rings.join(", ")}` : ""),
  );
  if (note) console.log(`      ${note}`);
  return snapshot;
}

// ---- idle ------------------------------------------------------------------
// "Idle" is a CLAIM: nothing is playing and nothing is marked as the
// playhead. Asserting it costs two queries and stops a green run from
// meaning "the transport was already running when we called it idle".
const idlePlay = (await page.locator(".btn-play.active").count()) > 0;
const idleHead = (await page.locator(".step.playhead").count()) > 0;
await page.waitForTimeout(400);
await record("idle", !idlePlay && !idleHead, idlePlay || idleHead ? "the transport was already running" : undefined);

// ---- selected --------------------------------------------------------------
// The selection has to MOVE for this state to mean anything.
//
// The first version clicked `.row-pad` — the FIRST row — which is ALREADY
// selected, so the reading came back byte-identical to idle and "selected"
// was indistinguishable from "idle" in the data while the screenshot looked
// the same too. Now it clicks a row that is not selected and proves the mark
// moved to it.
const beforeSelection = (await measure()).find((r) => r.roleId === "rowPad")?.accentSample ?? null;
const otherRow = page.locator(".row-pad:not(.selected)").first();
if ((await otherRow.count()) > 0) {
  await otherRow.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(600);
  const after = (await measure()).find((r) => r.roleId === "rowPad");
  const moved = !!after?.accentSample && after.accentSample !== beforeSelection;
  await record(
    "selected",
    moved,
    moved ? undefined : `the selection did not move (still "${after?.accentSample}")`,
  );
} else {
  await record("selected", false, "no unselected .row-pad to click");
}

// ---- playing ---------------------------------------------------------------
// Two independent signals, not one: the transport says it is running AND the
// grid is actually marking a playhead column. A run that only checks the
// button class would happily record "playing" over a frozen grid.
const play = page.locator(".btn-play").first();
if ((await play.count()) > 0) {
  await play.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
  const transportRunning = (await page.locator(".btn-play.active").count()) > 0;
  const playheadCells = (await page.locator(".step.playhead").count()) > 0;
  await record(
    "playing",
    transportRunning && playheadCells,
    !transportRunning
      ? "the transport did not report a playing state"
      : !playheadCells
        ? "the transport is running but no step carries the playhead mark"
        : undefined,
  );
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
  // `:hover` is the pointer's real answer, not an assumption that the hover
  // call worked. The first version recorded "hover" unconditionally.
  const hovering = await hoverTarget.evaluate((el) => el.matches(":hover")).catch(() => false);
  await record("hover", hovering, hovering ? undefined : "the pointer is not actually over the control");
  await page.mouse.move(5, 5).catch(() => {});
  await page.waitForTimeout(200);
} else {
  await record("hover", false, "no .transport-cluster .btn to hover");
}

// ---- focus -----------------------------------------------------------------
// Keyboard focus has to be reached WITH THE KEYBOARD.
//
// The first version called `element.focus()`, which moves DOM focus but does
// NOT arm `:focus-visible` — and every focus ring in this shell is a
// `:focus-visible` outline. So the recorded "focus" state was pixel-identical
// to "idle" and the state was not measurable at all. Pressing Tab is what a
// keyboard user does, and it is the only way the shell actually paints a
// focus ring.
await page.mouse.move(5, 5).catch(() => {});
await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
await page.waitForTimeout(200);

let focusReached = false;
for (let i = 0; i < 40 && !focusReached; i += 1) {
  await page.keyboard.press("Tab");
  focusReached = await page.evaluate(() => {
    const el = document.activeElement;
    return !!el && !!el.closest(".transport-cluster");
  });
}
await page.waitForTimeout(300);
await record(
  "focus",
  focusReached,
  focusReached ? undefined : "keyboard focus never reached a transport control",
);

// ---- recording -------------------------------------------------------------
// The transport's RECORD is MIDI overdub into the pattern (patternRecorder),
// not microphone capture - so it needs no permission dialog and IS reachable.
// Two signals: the button is lit, and the OVERDUB/REPLACE mode selector that
// only exists while armed is present.
const rec = page.locator(".btn-record").first();
if ((await rec.count()) > 0) {
  await rec.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
  const armed = (await page.locator(".btn-record.armed").count()) > 0;
  const modeSelector = (await page.locator("select.rec-option").count()) > 0;
  await record(
    "recording",
    armed && modeSelector,
    !armed
      ? "the record button did not report an armed state"
      : !modeSelector
        ? "the record button is armed but the record-mode selector is absent"
        : undefined,
  );
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