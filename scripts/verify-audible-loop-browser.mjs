import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5297;
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("[pageerror]", error.message));
page.on("console", (message) => console.log(`[page ${message.type()}]`, message.text()));

const isReloadRace = (error) => /context was destroyed|navigation|interrupted|timeout/i.test(String(error));

async function runProbe() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/studio`, {
        waitUntil: "domcontentloaded",
        timeout: 240_000,
      });
      break;
    } catch (error) {
      if (attempt >= 2 || !isReloadRace(error)) throw error;
      console.log(`[retry] goto interrupted (${attempt}/5)`);
      await page.waitForTimeout(5_000);
    }
  }

  await page.waitForTimeout(10_000);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await Promise.race([
        page.evaluate(async () => {
          const { createCoreServices, openProject } = await import("/src/services.ts");
          const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
          const { runAudibleVerification } = await import("/src/mcp/audible-verification.ts");
          const { setTrackParams } = await import("/src/commands/project.ts");

          console.log("audible-probe: boot services");
          const core = await createCoreServices();
          const services = await openProject(core, createProjectFromTemplate("trap"));
          const store = services.store;
          const doc = store.getDoc();
          const lead =
            doc.tracks.find((track) => track.kind === "instrument" && /lead/i.test(track.name)) ??
            doc.tracks.find((track) => track.kind === "instrument");
          if (!lead) throw new Error("trap template lost its instrument track");

          console.log("audible-probe: capture");
          const baseline = await runAudibleVerification(services, {
            op: "capture",
            trackId: lead.id,
            startBar: 1,
            bars: 2,
          });
          console.log("audible-probe: compare unchanged");
          const unchanged = await runAudibleVerification(services, { op: "compare", token: baseline.token });

          console.log("audible-probe: gain edit + compare");
          store.execute(setTrackParams(store.getDoc(), lead.id, { gain: 0.25 }));
          const changed = await runAudibleVerification(services, { op: "compare", token: baseline.token });
          await services.closeProject();

          return {
            baseline: {
              token: baseline.token,
              lufs: baseline.before.lufs,
              rmsDb: baseline.before.rmsDb,
              hash: baseline.before.contentHash,
            },
            unchanged: {
              verified: unchanged.comparison?.verified,
              changed: unchanged.comparison?.audibleChanged,
              verdict: unchanged.comparison?.verdict,
              residual: unchanged.comparison?.deltas.nullResidualDb,
              lufsDelta: unchanged.comparison?.deltas.lufs,
            },
            changed: {
              verified: changed.comparison?.verified,
              changed: changed.comparison?.audibleChanged,
              verdict: changed.comparison?.verdict,
              residual: changed.comparison?.deltas.nullResidualDb,
              rmsDelta: changed.comparison?.deltas.rmsDb,
              lufsDelta: changed.comparison?.deltas.lufs,
              dominant: changed.comparison?.bands.dominant,
            },
          };
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate timeout")), 90_000)),
      ]);
    } catch (error) {
      if (attempt >= 2 || !isReloadRace(error)) throw error;
      console.log(`[retry] probe interrupted by a Vite reload — retrying (${attempt}/5)`);
      await page.waitForTimeout(5_000);
    }
  }
}

try {
  const result = await runProbe();
  console.log(JSON.stringify(result, null, 2));

  const unchanged = result.unchanged ?? {};
  const changed = result.changed ?? {};
  const ok =
    result.baseline?.token != null &&
    unchanged.verified === true &&
    unchanged.changed === false &&
    unchanged.verdict === "unchanged" &&
    unchanged.residual < -60 &&
    changed.verified === true &&
    changed.changed === true &&
    changed.verdict === "changed" &&
    Math.abs((changed.rmsDelta ?? 0) + 12.04) < 1.5;
  if (!ok) {
    console.error("[audible-verification] FAIL");
    process.exitCode = 1;
  } else {
    console.log(
      "[audible-verification] PASS — identical PCM unchanged; -12 dB gain detected through the export renderer",
    );
  }
} finally {
  await browser.close();
  await server.close();
}
