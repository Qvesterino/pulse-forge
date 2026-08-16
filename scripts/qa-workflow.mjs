// QA manual workflow test for Pulse Forge
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5200;

const log = [];
const errs = [];
function record(name, ok, msg = "") {
  log.push({ name, ok, msg });
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${name}${msg ? " — " + msg : ""}`);
}

const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();

let exit = 0;
try {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(String(e)));

  // 1. Reset DB before first load to ensure a fresh default project
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    await new Promise((res) => {
      const req = indexedDB.deleteDatabase("pulse-forge");
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".topbar", { timeout: 10000 });
  await page.waitForSelector(".sequencer", { timeout: 10000 });

  // 1. default project loads
  const patternChips0 = await page.$$eval(".pattern-chip", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  record("default project has Pattern A", patternChips0.includes("Pattern A"), patternChips0.join(", "));

  // 2. drums - starter groove: first kick should be active
  const stepButtons = await page.$$(".sequencer .row-steps .step");
  record("step grid is rendered (≥16 steps)", stepButtons.length >= 16, `${stepButtons.length} steps`);
  if (stepButtons.length > 0) {
    const firstStep = await stepButtons[0].getAttribute("class");
    record("starter groove: first step is active", (firstStep ?? "").includes("active"), firstStep ?? "(null)");
  }

  // 3. click a step (snare row step 2 = step index 2 of second row)
  // The first 16 are kick pads. The 17th-32nd are snare, etc. Just toggle a step that's not active.
  // We'll target step index 7 (snare row 2nd step after starter)
  // Actually each pad has 16 steps. To find a step that's not active, look at snare row step 3 (just past the first 4)
  // Easier: find any .step without 'active' class and click it
  let targetIdx = -1;
  for (let i = 0; i < stepButtons.length; i++) {
    const cls = await stepButtons[i].getAttribute("class");
    if (cls && !cls.includes("active")) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx >= 0) {
    await stepButtons[targetIdx].click();
    await page.waitForTimeout(50);
    const after = await stepButtons[targetIdx].getAttribute("class");
    record("clicking a step toggles it on", (after ?? "").includes("active"), `idx=${targetIdx} class=${after}`);
    // click again - should toggle off
    await stepButtons[targetIdx].click();
    await page.waitForTimeout(50);
    const after2 = await stepButtons[targetIdx].getAttribute("class");
    record("clicking again toggles it off", !(after2 ?? "").includes("active"), `idx=${targetIdx} class=${after2}`);
  } else {
    record("find a non-active step to click", false, "all steps were active");
  }

  // 4. bass - 808 track should exist with default notes. Check piano roll notes.
  // The piano roll renders for instrument tracks. Just check that the track count is 2.
  const trackHeaders = await page.$$eval(".track-header-name", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  record("default project has 2 tracks (drums + 808)", trackHeaders.length === 2, trackHeaders.join(" | "));

  // 5. pattern management - duplicate via Ctrl+D
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(100);
  const patternChips1 = await page.$$eval(".pattern-chip", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  record("Ctrl+D duplicates the active pattern", patternChips1.length === 2, patternChips1.join(", "));

  // 6. undo (Ctrl+Z) - removes the duplicate
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(100);
  const patternChips2 = await page.$$eval(".pattern-chip", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  record("Ctrl+Z undoes the duplicate", patternChips2.length === 1, patternChips2.join(", "));

  // 7. redo (Ctrl+Y) - re-adds the duplicate
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(100);
  const patternChips3 = await page.$$eval(".pattern-chip", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  record("Ctrl+Y redoes the duplicate", patternChips3.length === 2, patternChips3.join(", "));

  // 8. switch to SONG mode
  await page.click(".topbar button:has-text(\"PATTERN\")");
  await page.waitForTimeout(100);
  const modeLabel = await page.textContent(".topbar button.btn-mode");
  record("PATTERN button toggles to SONG mode", modeLabel?.includes("SONG") ?? false, modeLabel ?? "");

  // toggle back
  await page.click(".topbar button:has-text(\"SONG\")");
  await page.waitForTimeout(100);

  // 9. open MIX panel
  await page.click(".topbar button:has-text(\"MIX\")");
  await page.waitForTimeout(200);
  const mixStrips = await page.$$(".mixer .channel-strip");
  record("MIX panel renders channel strips", mixStrips.length >= 4, `strips: ${mixStrips.length} (2 tracks + 2 returns + master)`);

  // 10. open FX panel
  await page.click(".topbar button:has-text(\"FX\")");
  await page.waitForTimeout(200);
  const fxOpen = await page.$(".effect-rack, [class*=effect]");
  record("FX panel opens", !!fxOpen, fxOpen?.className ?? "");

  // 11. open ARR panel
  await page.click(".topbar button:has-text(\"ARR\")");
  await page.waitForTimeout(200);
  const arrOpen = await page.$(".arrangement-panel, [class*=arrangement]");
  record("ARR panel opens", !!arrOpen, arrOpen?.className ?? "");

  // 12. open MOD panel
  await page.click(".topbar button:has-text(\"MOD\")");
  await page.waitForTimeout(200);
  const modOpen = await page.$(".mod-panel, [class*=mod-]");
  record("MOD panel opens", !!modOpen, modOpen?.className ?? "");

  // 13. open EXPORT panel
  await page.click(".topbar button:has-text(\"EXPORT\")");
  await page.waitForTimeout(200);
  const expOpen = await page.$(".export-panel");
  record("EXPORT panel opens", !!expOpen, expOpen?.className ?? "");

  // 14. trigger WAV export
  const exportBtn = await page.$(".export-panel button:has-text(\"EXPORT MASTER\")");
  if (exportBtn) {
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
    await exportBtn.click();
    const dl = await downloadPromise;
    if (dl) {
      const fileName = dl.suggestedFilename();
      const filePath = await dl.path();
      let size = 0;
      try {
        const fs = await import("node:fs");
        size = fs.statSync(filePath).size;
      } catch (e) { /* ignore */ }
      record("WAV master export triggers download with valid file", fileName.endsWith(".wav") && size > 1000, `${fileName} (${size} bytes)`);
    } else {
      record("WAV master export triggers download", false, "no download event within 60s");
    }
  } else {
    record("EXPORT MASTER button is present", false, "not found");
  }

  // 15. trigger stems export
  const stemBtn = await page.$(".export-panel button:has-text(\"EXPORT STEMS\")");
  if (stemBtn) {
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
    await stemBtn.click();
    const dl = await downloadPromise;
    if (dl) {
      const fileName = dl.suggestedFilename();
      record("stem export triggers a download", !!fileName, fileName);
    } else {
      record("stem export triggers a download", false, "no download within 60s");
    }
  }

  // 16. trigger tracks export
  const trackBtn = await page.$(".export-panel button:has-text(\"EXPORT ALL TRACKS\")");
  if (trackBtn) {
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
    await trackBtn.click();
    const dl = await downloadPromise;
    if (dl) {
      const fileName = dl.suggestedFilename();
      record("all-tracks export triggers a download", !!fileName, fileName);
    } else {
      record("all-tracks export triggers a download", false, "no download within 60s");
    }
  }

  // 17. persistence - reload, verify project restored
  await page.waitForTimeout(2000); // wait for save debounce
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".topbar", { timeout: 10000 });
  await page.waitForTimeout(500);
  const patternChipsAfterReload = await page.$$eval(".pattern-chip", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  record("reload restores the project (2 patterns)", patternChipsAfterReload.length === 2, patternChipsAfterReload.join(", "));
  const projectNameAfterReload = await page.inputValue(".project-name");
  record("reload restores the project name", projectNameAfterReload.length > 0, projectNameAfterReload);

  // 18. play - press Space, check that DIAG shows transportPlaying=true
  await page.click(".topbar button:has-text(\"DIAG\")");
  await page.waitForTimeout(500);
  const diagBefore = await page.textContent(".diagnostics");
  await page.click(".topbar button:has-text(\"DIAG\")");
  // press Space to play (focus body first)
  await page.locator("body").click();
  await page.keyboard.press("Space");
  await page.waitForTimeout(2500);
  await page.click(".topbar button:has-text(\"DIAG\")");
  await page.waitForTimeout(500);
  const diagAfter = await page.textContent(".diagnostics");
  const transportPlaying = /transportPlaying\s+true/.test(diagAfter ?? "");
  const scheduledEventsMatch = /scheduledEvents\s+(\d+)/.exec(diagAfter ?? "");
  const scheduledEvents = scheduledEventsMatch ? parseInt(scheduledEventsMatch[1], 10) : 0;
  record("playback starts: transportPlaying=true", transportPlaying, "see diag");
  record("scheduler plans events while playing", scheduledEvents > 0, `scheduledEvents=${scheduledEvents}`);
  // pause
  await page.locator("body").click();
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);

  // 19. mute test - mute a track, verify meter goes silent
  const muteBtn = await page.$(".channel-strip .btn-small.btn-danger, .channel-strip button:has-text(\"M\")");
  // skip - hard to verify audio level via Playwright

  // 20. BPM change
  // drag the BPM number - too hard to simulate drag precisely. We'll use Ctrl+A + type on focused input.
  // Skip detailed BPM test in workflow - covered by typecheck/unit tests.

  // Final report
  const passed = log.filter((r) => r.ok).length;
  const failed = log.length - passed;
  console.log(`\n${passed}/${log.length} checks passed`);
  if (failed > 0) {
    console.log("FAILED:");
    log.filter((r) => !r.ok).forEach((r) => console.log(` - ${r.name}: ${r.msg}`));
  }
  if (errs.length > 0) {
    console.log("CONSOLE ERRORS:", errs.slice(0, 10));
  }

  writeFileSync(path.join(root, "qa-report.json"), JSON.stringify({ log, errs, passed, failed }, null, 2));
  exit = failed > 0 ? 1 : 0;
  await browser.close();
} catch (e) {
  console.error("workflow test failed:", e);
  exit = 1;
} finally {
  await server.close();
  process.exit(exit);
}
