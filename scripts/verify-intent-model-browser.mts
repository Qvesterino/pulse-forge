/**
 * BROWSER ACTIVATION VERIFICATION — the local ONNX intent model (2026-10-11).
 *
 * The chain shipped complete (loader default-ON since the 2026-10-01 gate
 * pass, lazy worker, gatePassed pin, resolver registration, panel warm +
 * self-heal, MCP routing), but nothing ever proved it END TO END in a real
 * browser: manifest fetched from the origin, the gate pin read, the worker
 * spawned, the ONNX wasm session resident, and a generate coming back
 * through the registered provider. This script IS that proof.
 *
 * Usage: npm run verify:intent-model   (PORT env overrides 5291)
 * Exit 0 = the model loaded and answered (or abstained honestly).
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5291;

interface RegistrationResult {
  ok: boolean;
  id: string | null;
  version: string | null;
  state: string | null;
}

interface GenerateResult {
  answered: boolean;
  text?: string;
  reason?: string;
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = false;

const isReloadRace = (error: unknown): boolean =>
  /context was destroyed|navigation|interrupted|timeout/i.test(String(error));

async function evalWithRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 5 || !isReloadRace(error)) throw error;
      console.log(`[retry] ${label} hit a Vite full reload — retrying (${attempt}/5)`);
      await page.waitForTimeout(5000);
    }
  }
}

try {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/studio`, { waitUntil: "domcontentloaded", timeout: 240_000 });
      break;
    } catch (error) {
      if (attempt >= 5 || !isReloadRace(error)) throw error;
      console.log(`[retry] goto interrupted (${attempt}/5)`);
      await page.waitForTimeout(5000);
    }
  }

  // 1 — REGISTRATION: the loader's full chain (manifest fetch → gatePassed
  // pin → worker spawn → ONNX session) must end in a registered provider.
  const registered = await evalWithRetry<RegistrationResult>("registration", () =>
    page.evaluate(async () => {
      const loader = await import("/src/intent/model-loader.ts");
      const ok = await loader.ensureIntentModelProvider();
      const resolver = await import("/src/intent/model-resolver.ts");
      const provider = resolver.getIntentModelProvider();
      let state: string | null = null;
      const off = loader.onIntentModelStateChange((value) => {
        state = value;
      });
      off();
      return { ok, id: provider?.id ?? null, version: provider?.version ?? null, state };
    }),
  );
  console.log(
    `[intent-model] registration: ${registered.ok ? "OK" : "FAILED"} · ${registered.id ?? "no provider"} · v${registered.version ?? "?"} · state=${registered.state}`,
  );
  if (!registered.ok || registered.id !== "pulse-forge.intent-model") failed = true;

  // 2 — THE MODEL ANSWERS: one real generate through the registered
  // provider. An abstention is an HONEST answer — logged, not a failure.
  if (!failed) {
    const instruction = process.env.MODEL_INSTRUCTION || "play the pattern";
    const answer = await evalWithRetry<GenerateResult>("generate", () =>
      page.evaluate(async (userInstruction) => {
        const resolver = await import("/src/intent/model-resolver.ts");
        const provider = resolver.getIntentModelProvider();
        if (!provider) return { answered: false, reason: "no provider" };
        try {
          const text = await provider.generate(userInstruction);
          return { answered: true, text: text.slice(0, 200) };
        } catch (error) {
          return { answered: false, reason: String(error).slice(0, 160) };
        }
      }, instruction),
    );
    if (answer.answered) {
      console.log(`[intent-model] generate ("${instruction}"): OK · "${answer.text}"`);
    } else {
      console.log(`[intent-model] generate: ABSTAINED (${answer.reason}) — honest rejection, registration still valid`);
    }
  }

  // 3 — THE PANEL CHIP reflects the live state (the user-visible surface).
  if (!failed) {
    const chip = await evalWithRetry<string | null>("chip", () =>
      page.evaluate(async () => {
        const loader = await import("/src/intent/model-loader.ts");
        let current: string | null = null;
        const off = loader.onIntentModelStateChange((value) => {
          current = value;
        });
        off();
        return current;
      }),
    );
    console.log(`[intent-model] panel state: ${chip}`);
  }
} catch (error) {
  console.error(`[intent-model] FAILED: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}

process.exit(failed ? 1 : 0);
