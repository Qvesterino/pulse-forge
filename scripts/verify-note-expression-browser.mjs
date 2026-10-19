import { createServer } from "vite";
import { chromium, firefox, webkit } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5221;
const server = await createServer({
  root,
  logLevel: "error",
  // This verifier imports one focused module and does not need dependency
  // pre-bundling for the application's full HTML corpus.
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { port, host: "127.0.0.1", strictPort: true },
});

let exitCode = 0;
try {
  await server.listen();
  const availableEngines = {
    chromium: { browserType: chromium, launchOptions: {} },
    firefox: { browserType: firefox, launchOptions: {} },
    edge: { browserType: chromium, launchOptions: { channel: "msedge" } },
    webkit: { browserType: webkit, launchOptions: {} },
  };
  const requestedEngine = process.argv[2] ?? process.env.KYX_BROWSER_ENGINE ?? "chromium";
  const selectedEngines =
    requestedEngine === "all"
      ? Object.entries(availableEngines).filter(([name]) => name !== "webkit")
      : Object.entries(availableEngines).filter(([name]) => name === requestedEngine);
  if (selectedEngines.length === 0) {
    throw new Error(`Unknown browser engine "${requestedEngine}". Choose chromium, firefox, edge, webkit, or all.`);
  }

  for (const [engineName, engine] of selectedEngines) {
    let browser;
    try {
      console.log(`\n=== ${engineName}: note-expression verification ===`);
      browser = await engine.browserType.launch({ headless: true, ...engine.launchOptions });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 120_000 });
      const audioApi = await page.evaluate(() => ({
        audioContext: typeof AudioContext,
        offlineAudioContext: typeof OfflineAudioContext,
        audioWorkletNode: typeof AudioWorkletNode,
      }));
      if (Object.values(audioApi).some((value) => value !== "function")) {
        console.error(`[BLOCKED] ${engineName}: Web Audio API unavailable (${JSON.stringify(audioApi)})`);
        exitCode = 1;
        continue;
      }
      const results = await page.evaluate(
        async ({ parityOnly, granularOnly, parityLabels, parityInstruments }) => {
          const { SampleBank } = await import("/src/sample-library/factory.ts");
          const { auditNoteExpressionLiveOfflineParity, auditWorkletReleaseResponseParity } =
            await import("/src/testing/live-offline-parity.ts");
          const bank = new SampleBank();
          if (parityOnly) {
            return [await auditNoteExpressionLiveOfflineParity(bank, parityLabels, parityInstruments)];
          }
          const { runNoteExpressionAudioChecks } = await import("/src/testing/noteExpressionAudioChecks.ts");
          if (granularOnly) {
            const offline = await runNoteExpressionAudioChecks(["granular"]);
            const parity = await auditNoteExpressionLiveOfflineParity(bank, undefined, ["granular"]);
            const releaseParity = await auditWorkletReleaseResponseParity(bank, ["granular"]);
            return [...offline, parity, releaseParity];
          }
          const offline = await runNoteExpressionAudioChecks();
          const parity = await auditNoteExpressionLiveOfflineParity(bank);
          const workletReleaseParity = await auditWorkletReleaseResponseParity(bank);
          return [...offline, parity, workletReleaseParity];
        },
        {
          parityOnly: process.argv.includes("--parity-only"),
          granularOnly: process.argv.includes("--granular-only"),
          parityLabels: process.argv
            .find((argument) => argument.startsWith("--parity-labels="))
            ?.split("=")[1]
            ?.split(",")
            .filter(Boolean),
          parityInstruments: process.argv
            .find((argument) => argument.startsWith("--parity-instruments="))
            ?.split("=")[1]
            ?.split(",")
            .filter(Boolean),
        },
      );

      let failed = 0;
      for (const result of results) {
        console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.name} — ${result.message}`);
        if (!result.ok) failed++;
      }
      console.log(`\n${results.length - failed}/${results.length} ${engineName} note-expression checks passed`);
      if (failed > 0) exitCode = 1;
    } catch (error) {
      console.error(`${engineName} note-expression verification failed:`, error);
      exitCode = 1;
    } finally {
      await browser?.close();
    }
  }
} catch (error) {
  console.error("note-expression browser verification failed:", error);
  exitCode = 1;
} finally {
  await server.close();
}

process.exitCode = exitCode;
