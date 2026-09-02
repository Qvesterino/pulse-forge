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
      const btn = appPage.locator(`.topbar button:has-text("${label}")`).first();
      await btn.click();
      await appPage.waitForTimeout(150);
      await btn.click();
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
    await appPage.locator('.topbar button[aria-label="Toggle export panel"]').click();
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
    localStorage.setItem('pf-onboarded', '1');
    localStorage.setItem('pf-tour-v1', '1');
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

  const total = results.length + 5;
  const passed =
    results.length -
    failed +
    (appBootOk ? 1 : 0) +
    (collabOk ? 1 : 0) +
    (embedOk ? 1 : 0) +
    (importOk ? 1 : 0) +
    (touchOk ? 1 : 0);
  console.log(`\n${passed}/${total} checks passed`);
  if (consoleErrors.length > 0) {
    console.log("console errors during audio checks:", consoleErrors.slice(0, 5));
  }
  exitCode = failed > 0 || !appBootOk || !collabOk || !embedOk || !importOk || !touchOk ? 1 : 0;
} catch (error) {
  console.error("browser verification failed:", error);
  exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  process.exit(exitCode);
}
