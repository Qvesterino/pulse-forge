import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// PORT=5219 npm run test:browser — override when 5199 is contended (a second
// verify loop, a stuck dev server). StrictPort keeps behaviour deterministic.
const PORT = Number(process.env.PORT) || 5199;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

/**
 * Click a topbar panel action whether it is direct or collapsed into the
 * "⋯" overflow menu (the topbar spends its width budget by priority, so on
 * narrower viewports lower-priority panels live behind the overflow trigger).
 */
async function clickPanelAction(page, label) {
  const direct = page.locator(`.topbar button:has-text("${label}")`).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  const trigger = page.locator('button[aria-label^="More topbar controls"]').first();
  await trigger.click();
  await page
    .locator('#topbar-overflow-menu button:has-text("' + label + '")')
    .first()
    .click();
  // Close the menu so the next action starts from a clean state.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
}

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

  // A save from a concurrent agent mid-goto triggers a Vite full reload
  // which interrupts the navigation — retry like the evaluate below.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      break;
    } catch (error) {
      if (attempt >= 3 || !/interrupted|context was destroyed|navigation/i.test(String(error))) throw error;
      console.log("[retry] checks page navigation race — retrying goto");
      await page.waitForTimeout(2000);
    }
  }

  // A shared dev machine means another agent may save files mid-run, which
  // Vite turns into a full page reload ("Execution context was destroyed").
  // Retry the whole evaluate on that specific failure.
  let results = null;
  for (let attempt = 1; attempt <= 3 && !results; attempt++) {
    try {
      results = await page.evaluate(async () => {
        const mod = await import("/src/browser-checks.ts");
        return mod.runChecks();
      });
    } catch (error) {
      if (attempt === 3 || !/context was destroyed|navigation/i.test(String(error))) throw error;
      console.log("[retry] checks page reload race — retrying evaluate");
      // A save from a concurrent agent mid-goto triggers a Vite full reload
      // which interrupts the navigation — retry like the evaluate below.
      for (let attempt = 1; ; attempt++) {
        try {
          await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
          break;
        } catch (error) {
          if (attempt >= 3 || !/interrupted|context was destroyed|navigation/i.test(String(error))) throw error;
          console.log("[retry] checks page navigation race — retrying goto");
          await page.waitForTimeout(2000);
        }
      }
    }
  }

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
  await appPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  try {
    // First-time visitors get the landing page — exercise it: hero renders,
    // CTA enters the studio (and marks the browser onboarded). The landing
    // is a lazy chunk since the route split — wait for it OR the browser.
    await appPage.waitForSelector(".landing, .project-browser", { timeout: 30_000 });
    const onLanding = await appPage.$(".landing");
    if (onLanding) {
      await appPage.waitForSelector(".landing-hero-player .embed-play", { timeout: 30_000 });
      // Click the STUDIO button specifically — the nav also holds the gallery link.
      await appPage.evaluate(() => document.querySelector(".landing-nav button.landing-cta")?.click());
    }
    await appPage.waitForSelector(".project-browser", { timeout: 30_000 });
    // Create a project from the House template — one click from browser to sound.
    // Evaluate-clicks keep this flow immune to HMR reload races from a busy
    // shared dev machine (locator actionability would time out mid-reload).
    await appPage.evaluate(() => document.querySelectorAll(".pb-template")[0]?.click());
    await appPage.waitForSelector(".topbar", { timeout: 30_000 });
    await appPage.waitForSelector(".sequencer", { timeout: 30_000 });
    // First-run onboarding tour: walk all four steps, then finish.
    // The card appears ~600 ms after studio mount — wait for it.
    {
      const tour = await appPage.waitForSelector(".tour-card", { timeout: 5000 }).catch(() => null);
      if (tour) {
        for (let s = 0; s < 3; s++) {
          await appPage.evaluate(() => {
            const btns = [...document.querySelectorAll(".tour-card button")];
            btns.find((b) => b.textContent?.includes("NEXT"))?.click();
          });
          await appPage.waitForTimeout(150);
        }
        await appPage.evaluate(() => {
          const btns = [...document.querySelectorAll(".tour-card button")];
          btns.find((b) => b.textContent?.includes("LET'S FORGE"))?.click();
        });
        await appPage.waitForSelector(".tour-card", { state: "detached", timeout: 5000 });
      }
    }
    // MIX panel — the default is "mixer" open, so explicit toggle semantics:
    // ensure it's open, verify the master meter, toggle LIMIT/CLIP, then close.
    {
      const mixBtn = appPage.locator('.topbar button:has-text("MIX")').first();
      const mixOpen = await mixBtn.evaluate((el) => el.getAttribute("aria-pressed"));
      if (mixOpen !== "true") await mixBtn.click();
      await appPage.waitForSelector(".master-meter", { timeout: 5000 });
      await appPage.waitForSelector(".master-headroom", { timeout: 5000 });
      const limit = appPage.locator('.master-toggles button:has-text("LIMIT")').first();
      const clip = appPage.locator('.master-toggles button:has-text("CLIP")').first();
      const beforeLimit = await limit.getAttribute("aria-pressed");
      await limit.click();
      await appPage.waitForTimeout(120);
      const afterLimit = await limit.getAttribute("aria-pressed");
      if (beforeLimit === afterLimit) throw new Error("LIMIT toggle did not change aria-pressed");
      await clip.click();
      await appPage.waitForTimeout(120);
      await limit.click();
      await clip.click();
    }
    const panels = ["MIX", "FX", "ARR", "MOD", "EXPORT"];
    for (const label of panels) {
      await clickPanelAction(appPage, label);
      await appPage.waitForTimeout(150);
      await clickPanelAction(appPage, label);
      await appPage.waitForTimeout(100);
    }
    // Offline generation workflow: preview the local plan, accept it, undo,
    // redo, export JSON, reload the app, and reopen the persisted project.
    // This is intentionally exercised through the real UI rather than an
    // internal store call so browser persistence and command history are both covered.
    const patternsBeforeGenerate = await appPage.locator(".pattern-chip").count();
    await appPage.locator('.pattern-actions button:has-text("GEN")').click();
    await appPage.waitForSelector('.generate-dialog-backdrop[role="dialog"]', { timeout: 5000 });
    const generateSeed = appPage.locator(".generate-dialog input.generate-seed-input").first();
    await generateSeed.fill("browser-seed");
    await appPage.locator(".generate-dialog select.generate-select").nth(2).selectOption("32");
    await appPage.waitForSelector(".generate-dialog .preview-grid", { timeout: 5000 });
    await appPage.locator('.generate-dialog button:has-text("GENERATE")').click();
    await appPage.waitForSelector('.generate-dialog-backdrop[role="dialog"]', { state: "detached", timeout: 10000 });
    const patternsAfterGenerate = await appPage.locator(".pattern-chip").count();
    if (patternsAfterGenerate !== patternsBeforeGenerate + 1) {
      throw new Error(
        `generation accept expected ${patternsBeforeGenerate + 1} patterns, got ${patternsAfterGenerate}`,
      );
    }
    await appPage.locator('button[aria-label="Undo"]').click();
    await appPage.waitForFunction(
      (count) => document.querySelectorAll(".pattern-chip").length === count,
      patternsBeforeGenerate,
      { timeout: 5000 },
    );
    await appPage.locator('button[aria-label="Redo"]').click();
    await appPage.waitForFunction(
      (count) => document.querySelectorAll(".pattern-chip").length === count,
      patternsAfterGenerate,
      { timeout: 5000 },
    );
    await clickPanelAction(appPage, "EXPORT");
    await appPage.waitForSelector('.export-panel[aria-label="Export"]', { timeout: 5000 });
    const projectDownload = appPage.waitForEvent("download");
    await appPage.locator('.export-panel button:has-text("EXPORT JSON")').click();
    const download = await projectDownload;
    if (!download.suggestedFilename().endsWith(".pulseforge.json")) {
      throw new Error(`unexpected project export filename: ${download.suggestedFilename()}`);
    }
    await appPage.waitForTimeout(1200); // allow autosave to settle before reload
    await appPage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await appPage.waitForSelector(".project-browser", { timeout: 30_000 });
    const continueCard = appPage.locator(".pb-continue-card").first();
    if (await continueCard.count()) {
      await continueCard.click();
    } else {
      await appPage.locator(".pb-row button:has-text(OPEN)").first().click();
    }
    await appPage.waitForSelector(".sequencer", { timeout: 30_000 });
    const patternsAfterReload = await appPage.locator(".pattern-chip").count();
    if (patternsAfterReload !== patternsAfterGenerate) {
      throw new Error(`reload lost generated pattern: ${patternsAfterReload}/${patternsAfterGenerate}`);
    }
    console.log("[PASS] offline generation: preview → accept → undo/redo → JSON export → reload preserved the pattern");
    // Groove workflow: controls visible, right-click step editor, scene strip.
    await appPage.waitForSelector(".pattern-groove", { timeout: 5000 });
    await appPage.waitForSelector(".scene-launcher .scene-action-launch", { timeout: 5000 });
    const step = appPage.locator(".step").first();
    await step.click({ button: "right" });
    await appPage.waitForSelector(".step-editor", { timeout: 5000 });
    await appPage.locator(".step-editor-close").click();
    await appPage.waitForSelector(".step-editor", { state: "detached", timeout: 5000 });
    // Multi-select: shift+drag across steps selects the range. The dock's
    // fixed height can leave the virtualized sequencer scrolled — rows
    // measured while clipped break the coordinate-based drag. Snap to top.
    await appPage.evaluate(() => {
      const seq = document.querySelector(".sequencer");
      if (seq) seq.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await appPage.waitForTimeout(120);
    const dbg = await appPage.evaluate(() => {
      const at = document.elementFromPoint(
        document.querySelector(".step").getBoundingClientRect().x + 5,
        document.querySelector(".step").getBoundingClientRect().y + 15,
      );
      return {
        hit: at ? at.tagName + "." + String(at.className).slice(0, 40) : "null",
        seqTop: document.querySelector(".sequencer")?.scrollTop ?? -1,
        seqH: document.querySelector(".sequencer")?.clientHeight ?? -1,
        stepY: document.querySelector(".step")?.getBoundingClientRect().y ?? -1,
      };
    });
    console.log("[DBG]", JSON.stringify(dbg));
    // Close the export panel first — an open dock panel covers the step grid
    // (elementFromPoint hits the panel, not the steps) and the lasso selects 0.
    await clickPanelAction(appPage, "EXPORT");
    await appPage.waitForTimeout(200);
    await appPage
      .locator(".step")
      .nth(3)
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    // Re-measure AFTER closing the panel — closing the dock re-layouts the grid.
    const firstStep = await appPage.locator(".step").nth(0).boundingBox();
    const fourthStep = await appPage.locator(".step").nth(3).boundingBox();
    if (firstStep && fourthStep) {
      // Explicit, paced drag: under heavy machine load, coalesced pointermoves
      // can skip the "first move starts the lasso" window → 0 selected.
      const startX = firstStep.x + 5;
      const startY = firstStep.y + firstStep.height / 2;
      const endX = fourthStep.x + fourthStep.width - 5;
      const endY = fourthStep.y + fourthStep.height / 2;
      await appPage.mouse.move(startX, startY);
      await appPage.waitForTimeout(60);
      await appPage.keyboard.down("Shift");
      await appPage.mouse.down();
      await appPage.waitForTimeout(60);
      for (let i = 1; i <= 8; i++) {
        await appPage.mouse.move(startX + (endX - startX) * (i / 8), startY + (endY - startY) * (i / 8));
        await appPage.waitForTimeout(40);
      }
      await appPage.mouse.up();
      await appPage.keyboard.up("Shift");
      await appPage.waitForTimeout(120);
    }
    const selectedSteps = await appPage.locator(".step.in-selection").count();
    if (selectedSteps < 2) throw new Error(`multi-select expected >=2 selected steps, got ${selectedSteps}`);
    await appPage.keyboard.press("Escape");
    // Curated content: sample browser (search/category/mood/preview/favorite).
    await appPage.waitForSelector(".sample-browser", { timeout: 5000 });
    await appPage.waitForSelector(".sample-fav", { timeout: 5000 });
    await appPage.locator("button.sample-preview").first().click();
    await appPage.locator(".sample-fav").first().click();
    // Switch to the 808 instrument track → preset browser with mood/favorite/recent filters.
    const instrTab = appPage.locator(".track-tab").filter({ hasText: "808" }).first();
    await instrTab.click();
    await appPage.waitForSelector(".preset-browser", { timeout: 5000 });
    await appPage.waitForSelector(".preset-fav", { timeout: 5000 });
    await appPage.locator(".preset-fav").first().click();
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
    await appPage.waitForSelector(".project-browser", { timeout: 30_000 });
    await appPage.waitForSelector(".pb-row", { timeout: 15000 });
    const fatal = appErrors.filter((e) => !/AudioContext|autoplay|user gesture/i.test(e));
    if (fatal.length === 0) {
      appBootOk = true;
      console.log("[PASS] app boots into browser, opens a template, panels mount, project listed on return");
    } else {
      console.log("[FAIL] app boot — console errors:", fatal.slice(0, 5));
    }
  } catch (error) {
    console.log("[FAIL] app boot — UI did not mount:", error?.stack ?? String(error));
    if (appErrors.length > 0) console.log("  console errors:", appErrors.slice(0, 5));
  }
  await appPage.close();

  // Fresh contexts get flags pre-set so E2E flows skip the landing and tour.
  const SKIP_FLAGS = () => {
    localStorage.setItem("pf-onboarded", "1");
    localStorage.setItem("pf-tour-v1", "1");
  };

  // ── Collab E2E: two pages, one room, real server, real websockets ──────
  let collabOk = false;
  let collabServer;
  try {
    const { spawn } = await import("node:child_process");
    const COLLAB_PORT = 1247;
    collabServer = spawn(process.execPath, ["server/collab-server.mjs"], {
      env: { ...process.env, PORT: String(COLLAB_PORT) },
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 1200));

    const setup = async (page, room, name) =>
      page.evaluate(
        async ({ room, name, port }) => {
          const { YDocStore } = await import("/src/collab/YDocStore.ts");
          const { CollabSession } = await import("/src/collab/CollabSession.ts");
          const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
          const store = YDocStore.fromDocument(createProjectFromTemplate("house"));
          const session = new CollabSession(store.yDocRef, room, `ws://127.0.0.1:${port}`, {
            id: name,
            name,
            color: "#f59e0b",
          });
          session.connect();
          window.__collab = { store, session };
          return true;
        },
        { room, name, port: COLLAB_PORT },
      );

    const ROOM = `e2e-${Date.now().toString(36)}`;
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await pageB.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await setup(pageA, ROOM, "Producer A");
    await setup(pageB, ROOM, "Producer B");
    await new Promise((r) => setTimeout(r, 1000));

    // A edits; B must receive it through the server.
    await pageA.evaluate(async () => {
      const { setBpm } = await import("/src/commands/commands.ts");
      window.__collab.store.execute(setBpm(window.__collab.store.doc, 141));
    });
    await pageB.waitForFunction(() => window.__collab?.store.doc.bpm === 141, null, { timeout: 8000 });

    // Presence: each page sees the other producer.
    await pageA.waitForFunction(
      () => window.__collab?.session.participants.some((p) => p.name === "Producer B"),
      null,
      {
        timeout: 8000,
      },
    );
    await pageB.waitForFunction(
      () => window.__collab?.session.participants.some((p) => p.name === "Producer A"),
      null,
      {
        timeout: 8000,
      },
    );

    // Local undo must NOT revert the remote-synced base (still user-scoped).
    const undoScope = await pageB.evaluate(() => {
      window.__collab.store.undo(); // nothing local to undo
      return window.__collab.store.doc.bpm;
    });
    if (undoScope !== 141) throw new Error(`undo scope broken: bpm=${undoScope}`);

    await pageA.evaluate(() => window.__collab.session.dispose());
    await pageB.evaluate(() => window.__collab.session.dispose());
    await pageA.close();
    await pageB.close();
    collabOk = true;
    console.log("[PASS] collab: two pages sync edits + presence over the real server");
  } catch (error) {
    console.log("[FAIL] collab E2E:", String(error).split("\n")[0]);
  } finally {
    collabServer?.kill();
  }

  // ── Embed widget + share link E2E ───────────────────────────────────────
  let embedOk = false;
  let importOk = false;
  try {
    const code = await page.evaluate(async () => {
      const { encodeShareCode } = await import("/src/export/shareCode.ts");
      const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
      return encodeShareCode(createProjectFromTemplate("house"));
    });

    // 1. The /embed player: renders the shared project, plays, links back.
    const embedPage = await browser.newPage();
    const embedErrors = [];
    embedPage.on("pageerror", (err) => embedErrors.push(String(err)));
    await embedPage.goto(`http://127.0.0.1:${PORT}/embed/#p=${code}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await embedPage.waitForSelector(".embed-play:not([disabled])", { timeout: 45_000 });
    await embedPage.click(".embed-play");
    await embedPage.waitForFunction(() => document.querySelector(".embed-play")?.textContent?.includes("❚❚"), null, {
      timeout: 5_000,
    });
    await new Promise((r) => setTimeout(r, 1_100)); // cross the 1 s display granularity + headless clock startup
    const time1 = await embedPage.textContent(".embed-time");
    await new Promise((r) => setTimeout(r, 1_400));
    const time2 = await embedPage.textContent(".embed-time");
    const cta = await embedPage.locator(".embed-cta").getAttribute("href");
    if (time1 === time2) throw new Error("embed playback time is frozen");
    if (!cta || !cta.includes("?import=")) throw new Error("CTA link missing ?import=");
    if (embedErrors.length > 0) throw new Error(`page errors: ${embedErrors[0]}`);
    await embedPage.close();
    embedOk = true;
    console.log("[PASS] embed: /embed player renders, plays and links back into the studio");

    // 2. The share link: ?import= opens the project straight into the studio.
    const importPage = await browser.newPage();
    await importPage.addInitScript(SKIP_FLAGS);
    await importPage.goto(`http://127.0.0.1:${PORT}/?import=${code}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await importPage.waitForSelector(".topbar", { timeout: 45_000 });
    await importPage.waitForSelector(".sequencer", { timeout: 15_000 });
    if (await importPage.$(".project-browser")) throw new Error("project browser shown — import was skipped");
    await importPage.close();
    importOk = true;
    console.log("[PASS] share link: ?import= opens the project straight into the studio");
  } catch (error) {
    console.log("[FAIL] embed/share E2E:", String(error).split("\n")[0]);
  }

  // ── Touch E2E: long-press a step opens the step editor ─────────────────
  let touchOk = false;
  try {
    const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 900, height: 800 } });
    const touchPage = await touchContext.newPage();
    await touchPage.addInitScript(SKIP_FLAGS);
    await touchPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await touchPage.waitForSelector(".project-browser", { timeout: 15_000 });
    await touchPage.locator('.pb-template:has-text("HOUSE")').first().click();
    await touchPage.waitForSelector(".sequencer", { timeout: 15_000 });
    const step = touchPage.locator(".row-steps .step").first();
    await step.dispatchEvent("pointerdown", { pointerType: "touch", buttons: 1 });
    await touchPage.waitForTimeout(700);
    await touchPage.waitForSelector(".step-editor", { timeout: 3_000 });
    await touchContext.close();
    touchOk = true;
    console.log("[PASS] touch: long-press on a step opens the step editor (no right-click needed)");
  } catch (error) {
    console.log("[FAIL] touch long-press E2E:", String(error).split("\n")[0]);
  }

  // ── Plugin workflow E2E: add flagship effect → collapse → bypass → macro → play ──
  let pluginWorkflowOk = false;
  try {
    const plugContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const plugPage = await plugContext.newPage();
    await plugPage.addInitScript(SKIP_FLAGS);
    await plugPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await plugPage.waitForSelector(".project-browser", { timeout: 15_000 });
    await plugPage.locator('.pb-template:has-text("HOUSE")').first().click();
    await plugPage.waitForSelector(".sequencer", { timeout: 15_000 });
    // Open the FX rack dock panel and add the flagship FXEQ to the selected track.
    await clickPanelAction(plugPage, "FX");
    await plugPage.waitForSelector(".fx-rack", { timeout: 5000 });
    // Scope to the rack — .track-tabs has its own .fx-add-select.track-add.
    await plugPage.locator(".fx-rack select.fx-add-select").first().selectOption("fxeq");
    await plugPage.waitForSelector(".fx-device", { timeout: 5000 });
    // Collapse must keep the device mounted and flip aria-expanded.
    await plugPage.locator(".fx-device-toggle").first().click();
    const collapsedAria = await plugPage.locator(".fx-device-toggle").first().getAttribute("aria-expanded");
    if (collapsedAria !== "false") throw new Error(`collapse did not flip aria-expanded (${collapsedAria})`);
    await plugPage.locator(".fx-device-toggle").first().click();
    // Bypass flips the device state label.
    await plugPage.locator('button[title="Bypass effect"]').first().click();
    await plugPage.waitForSelector(".fx-device.bypassed", { timeout: 5000 });
    const stateLabel = await plugPage.locator(".fx-device-state").first().textContent();
    if (!stateLabel?.includes("BYPASSED")) throw new Error(`device state did not flip (${stateLabel})`);
    // Undo once — the bypass must roll back (command layer, not local state).
    await plugPage.keyboard.press("Control+z");
    await plugPage.waitForSelector(".fx-device:not(.bypassed)", { timeout: 5000 });
    // Macro: focus the first macro slider in the MOD panel and nudge it.
    await clickPanelAction(plugPage, "MOD");
    await plugPage.waitForSelector(".macro-card", { timeout: 5000 });
    const macroSliderBox = plugPage.locator(".macro-card .slider").first();
    const macroKnob = macroSliderBox.locator('[role="slider"]');
    const before = await macroSliderBox.textContent();
    await macroKnob.focus();
    await plugPage.keyboard.press("ArrowRight");
    await plugPage.waitForTimeout(150);
    const after = await macroSliderBox.textContent();
    if (!before || !after || before === after) throw new Error("macro slider did not move on ArrowRight");
    // Transport: play then stop must toggle without errors.
    await plugPage.locator('button[title="Play / Pause (Space)"]').first().click();
    await plugPage.waitForTimeout(400);
    await plugPage.locator('button.btn-stop[title="Stop"]').first().click();
    await plugContext.close();
    pluginWorkflowOk = true;
    console.log("[PASS] plugin workflow: add flagship effect, collapse, bypass, undo, macro nudge, play/stop");
  } catch (error) {
    console.log("[FAIL] plugin workflow E2E:", String(error).split("\n")[0]);
  }

  const total = results.length + 6;
  const passed =
    results.length -
    failed +
    (appBootOk ? 1 : 0) +
    (collabOk ? 1 : 0) +
    (embedOk ? 1 : 0) +
    (importOk ? 1 : 0) +
    (touchOk ? 1 : 0) +
    (pluginWorkflowOk ? 1 : 0);
  console.log(`\n${passed}/${total} checks passed`);
  if (consoleErrors.length > 0) {
    console.log("console errors during audio checks:", consoleErrors.slice(0, 5));
  }
  exitCode = failed > 0 || !appBootOk || !collabOk || !embedOk || !importOk || !touchOk || !pluginWorkflowOk ? 1 : 0;
} catch (error) {
  console.error("browser verification failed:", error);
  exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  process.exit(exitCode);
}
