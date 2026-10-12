/**
 * Compare LIVE and Studio HQ offline mastering render cost in Chromium.
 *
 * Uses factory templates with a representative master chain (PRISM + DRIFT +
 * the default master limiter). Short fixtures warm both paths; both benchmark
 * modes interleave repeated renders so clock/turbo drift is less likely to
 * bias one quality tier.
 * This is a wall-clock render benchmark, not a subjective quality test or a
 * browser memory guarantee.
 *
 * Usage: node scripts/benchmark-mastering-quality.mjs
 * Full generated song: REPEATS=2 npm run benchmark:mastering-quality -- --full-song
 * Full song + PRISM/DRIFT: REPEATS=2 npm run benchmark:mastering-quality -- --full-song --with-master-inserts
 * Optional: PORT=5259 REPEATS=3 node scripts/benchmark-mastering-quality.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT) || 5259;
const fullSong = process.argv.includes("--full-song");
const withMasterInserts = !fullSong || process.argv.includes("--with-master-inserts");
const repeats = Math.max(fullSong ? 1 : 2, Math.min(7, Number(process.env.REPEATS) || (fullSong ? 1 : 3)));
const warmupPairs = fullSong ? 0 : 1;
const templateIds = fullSong ? ["house"] : ["house", "ambient"];
const sampleRates = fullSong ? [44_100] : [44_100, 96_000];

const server = await createServer({
  root,
  logLevel: "error",
  // Concurrent source saves must not reload a multi-minute benchmark page.
  server: { hmr: false, port, host: "127.0.0.1", strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "log" && message.text().startsWith("[mastering-benchmark]")) {
      console.log(message.text());
    }
  });
  await page.goto(`http://127.0.0.1:${port}/studio`, {
    waitUntil: "domcontentloaded",
    timeout: 240_000,
  });

  const evaluateBenchmark = () =>
    page.evaluate(
      async ({ templateIds, sampleRates, repeats, fullSong, warmupPairs, withMasterInserts }) => {
        console.log(`[mastering-benchmark] loading templates: ${templateIds.join(", ")}`);
        const [
          { createProjectFromTemplate },
          { normalizeIntent },
          { buildSong, applySongCommand },
          { generateFactoryBank },
          { loadCuratedLayer },
          { normalizePluginParams },
          { renderProject },
        ] = await Promise.all([
          import("/src/project-model/templates.ts"),
          import("/src/intent/normalize.ts"),
          import("/src/intent/song.ts"),
          import("/src/sample-library/factory.ts"),
          import("/src/sample-library/curated.ts"),
          import("/src/effects/definitions.ts"),
          import("/src/rendering/renderer.ts"),
        ]);

        const bank = await generateFactoryBank();
        console.log("[mastering-benchmark] generated factory bank");
        await loadCuratedLayer(bank);
        console.log("[mastering-benchmark] curated sample layer ready");
        const reports = [];

        for (const templateId of templateIds) {
          let doc = createProjectFromTemplate(templateId);
          if (fullSong) {
            const intent = normalizeIntent({ genre: templateId, seed: `mastering-benchmark-${templateId}` });
            const builtSong = await buildSong(doc, intent);
            doc = applySongCommand(doc, builtSong).execute(doc);
            console.log(
              `[mastering-benchmark] built deterministic ${templateId} arrangement: ${doc.tracks.length} tracks · ${doc.arrangement.clips.length} clips`,
            );
          }
          if (!doc.master?.limiterEnabled) {
            throw new Error(`${templateId} template must have the master limiter enabled for this benchmark.`);
          }

          if (withMasterInserts) {
            const prismParams = normalizePluginParams("fxeq", {});
            const driftParams = normalizePluginParams("ozvena", {});
            if (!prismParams || !driftParams)
              throw new Error("Could not create valid PRISM/DRIFT benchmark parameters.");
            doc.master.effects = [
              { id: `benchmark-prism-${templateId}`, type: "fxeq", bypassed: false, params: prismParams },
              { id: `benchmark-drift-${templateId}`, type: "ozvena", bypassed: false, params: driftParams },
            ];
          }
          const originalDocument = JSON.stringify(doc);
          const effectCount = doc.master.effects.length;

          for (const sampleRate of sampleRates) {
            const times = { live: [], studio: [] };
            const pairOrder = [];
            let durationSeconds = 0;

            const render = async (quality) => {
              console.log(`[mastering-benchmark] starting ${templateId} ${sampleRate} Hz ${quality}`);
              const start = performance.now();
              const buffer = await renderProject(doc, bank, {
                mode: "song",
                sampleRate,
                quality,
                tailSeconds: 1,
              });
              const elapsed = performance.now() - start;
              if (buffer.numberOfChannels !== 2 || buffer.length < 1) {
                throw new Error(`${templateId} ${quality} render returned an invalid audio buffer.`);
              }
              if (durationSeconds && Math.abs(buffer.duration - durationSeconds) > 1 / sampleRate) {
                throw new Error(`${templateId} ${quality} changed render duration between LIVE/HQ runs.`);
              }
              durationSeconds = buffer.duration;
              if (JSON.stringify(doc) !== originalDocument) {
                throw new Error(`${quality} render mutated the ${templateId} source document.`);
              }
              console.log(
                `[mastering-benchmark] ${templateId} ${sampleRate} Hz ${quality} ${elapsed.toFixed(0)} ms (${buffer.duration.toFixed(1)} s audio)`,
              );
              return elapsed;
            };

            // Full-song renders are multi-minute on slower hosts, so default
            // to one direct paired sample. Short fixtures warm both paths and
            // collect repeated measurements for a median.
            for (let warmup = 0; warmup < warmupPairs; warmup++) {
              await render("live");
              await render("studio");
            }

            for (let iteration = 0; iteration < repeats; iteration++) {
              const order = iteration % 2 === 0 ? ["live", "studio"] : ["studio", "live"];
              pairOrder.push(order.join("→"));
              for (const quality of order) {
                const elapsed = await render(quality);
                times[quality].push(Math.round(elapsed));
              }
              console.log(
                `[mastering-benchmark] ${templateId} ${sampleRate} Hz: completed pair ${iteration + 1}/${repeats}`,
              );
            }

            const median = (values) => {
              const sorted = [...values].sort((a, b) => a - b);
              const middle = Math.floor(sorted.length / 2);
              return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
            };
            const liveMedianMs = median(times.live);
            const studioMedianMs = median(times.studio);
            reports.push({
              templateId,
              sampleRate,
              tracks: doc.tracks.length,
              arrangementClips: doc.arrangement.clips.length,
              activeMasterInserts: effectCount,
              limiterEnabled: doc.master.limiterEnabled,
              durationSeconds: Number(durationSeconds.toFixed(2)),
              repeats,
              pairOrder,
              liveRenderMs: times.live,
              studioRenderMs: times.studio,
              liveMedianMs,
              studioMedianMs,
              studioOverheadPercent: Number(((studioMedianMs / liveMedianMs - 1) * 100).toFixed(1)),
              liveRealtimeFactor: Number((liveMedianMs / (durationSeconds * 1000)).toFixed(3)),
              studioRealtimeFactor: Number((studioMedianMs / (durationSeconds * 1000)).toFixed(3)),
            });
          }
        }

        return {
          userAgent: navigator.userAgent,
          generatedAt: new Date().toISOString(),
          repeats,
          warmupPairs,
          fixture: fullSong ? "deterministic full arrangement" : "factory starter arrangement",
          masterChain: withMasterInserts ? "PRISM + DRIFT inserts + limiter" : "built-in master + limiter only",
          reports,
        };
      },
      { templateIds, sampleRates, repeats, fullSong, warmupPairs, withMasterInserts },
    );

  const isReloadRace = (error) => /context was destroyed|navigation|interrupted|timeout/i.test(String(error));
  let result;
  for (let attempt = 1; ; attempt++) {
    try {
      result = await evaluateBenchmark();
      break;
    } catch (error) {
      if (fullSong || attempt >= 5 || !isReloadRace(error)) throw error;
      console.log(`[retry] workspace reload interrupted benchmark — retrying (${attempt}/5)`);
      await page.waitForTimeout(5000);
      await page.goto(`http://127.0.0.1:${port}/studio`, {
        waitUntil: "domcontentloaded",
        timeout: 240_000,
      });
    }
  }

  console.log("\n[mastering-benchmark] Summary");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
