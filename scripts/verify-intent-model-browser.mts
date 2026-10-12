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
 * Usage: npm run verify:intent-model [-- --full-eval]   (PORT env overrides 5291)
 * Exit 0 = the model loaded and decoded the expected chords-down fader route.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5291;
const FULL_EVAL = process.argv.includes("--full-eval");

interface ValidationRow {
  instruction: string;
  lang?: string;
  response: unknown;
}

const validationRows: ValidationRow[] = FULL_EVAL
  ? readFileSync(path.join(root, "scripts", "data", "intent-sft", "val.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ValidationRow)
  : [];

interface RegistrationResult {
  ok: boolean;
  id: string | null;
  version: string | null;
  state: string | null;
  loadMs: number;
}

interface GenerateResult {
  answered: boolean;
  text?: string;
  topLevelType?: string;
  modelKind?: string;
  routeKind?: string | null;
  routeSummary?: unknown;
  routeCorrect?: boolean;
  inferenceMs?: number;
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
      const startedAt = performance.now();
      const ok = await loader.ensureIntentModelProvider();
      const loadMs = performance.now() - startedAt;
      const resolver = await import("/src/intent/model-resolver.ts");
      const provider = resolver.getIntentModelProvider();
      let state: string | null = null;
      const off = loader.onIntentModelStateChange((value) => {
        state = value;
      });
      off();
      return { ok, id: provider?.id ?? null, version: provider?.version ?? null, state, loadMs };
    }),
  );
  console.log(
    `[intent-model] registration: ${registered.ok ? "OK" : "FAILED"} · ${registered.id ?? "no provider"} · v${registered.version ?? "?"} · state=${registered.state} · load=${Math.round(registered.loadMs)}ms`,
  );
  if (!registered.ok || registered.id !== "pulse-forge.intent-model") failed = true;

  // 2 — END-TO-END ACTION: the ONNX worker must return an object-shaped JSON
  // action (not a JSON-encoded string), and the real resolver must turn that
  // response into an executable route. A generate-only smoke had missed a
  // double-serialization bug that made every model result fail validation.
  if (!failed) {
    const instruction = process.env.MODEL_INSTRUCTION || "turn down the chords";
    const answer = await evalWithRetry<GenerateResult>("generate", () =>
      page.evaluate(async (userInstruction) => {
        const resolver = await import("/src/intent/model-resolver.ts");
        const provider = resolver.getIntentModelProvider();
        if (!provider) return { answered: false, reason: "no provider" };
        try {
          const startedAt = performance.now();
          const text = await provider.generate(userInstruction);
          const inferenceMs = performance.now() - startedAt;
          const value: unknown = JSON.parse(text);
          const record = value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
          const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
          const doc = createProjectFromTemplate("house");
          const route = await resolver.tryModelRoute(userInstruction, doc);
          return {
            answered: true,
            text: text.slice(0, 200),
            topLevelType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
            modelKind: typeof record?.kind === "string" ? record.kind : undefined,
            routeKind: route?.kind ?? null,
            routeCorrect:
              route?.kind === "fader" &&
              route.intent.direction === "down" &&
              route.intent.targets.length === 1 &&
              route.intent.targets[0] === "chords" &&
              route.intent.pads.length === 0,
            inferenceMs,
            routeSummary:
              route?.kind === "fader"
                ? { targets: route.intent.targets, pads: route.intent.pads, direction: route.intent.direction }
                : route?.kind,
          };
        } catch (error) {
          return { answered: false, reason: String(error).slice(0, 160) };
        }
      }, instruction),
    );
    if (answer.answered) {
      console.log(
        `[intent-model] route ("${instruction}"): ${answer.routeKind ?? "FAILED"} · model=${answer.modelKind ?? answer.topLevelType} · ${JSON.stringify(answer.routeSummary)} · inference=${Math.round(answer.inferenceMs ?? 0)}ms · ${answer.text}`,
      );
      if (
        answer.topLevelType !== "object" ||
        answer.modelKind !== "fader" ||
        answer.routeKind !== "fader" ||
        answer.routeCorrect !== true
      )
        failed = true;
    } else {
      console.error(`[intent-model] action failed: ${answer.reason ?? "unknown error"}`);
      failed = true;
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

  // 4 — OPTIONAL FULL BROWSER EVALUATION: run the current validation split
  // through the registered worker AND the real model resolver. This catches
  // failures that a node-side ONNX evaluator cannot see (serialization,
  // worker messaging, route guards, and action adaptation).
  if (!failed && FULL_EVAL) {
    const evaluation = await evalWithRetry<{
      rows: number;
      attempted: number;
      exact: number;
      wrongKind: number;
      slotMismatch: number;
      abstain: number;
      causes: Record<string, number>;
      failures: Array<{ instruction: string; outcome: string; cause?: string; expected: unknown; actual: unknown }>;
      modelAttempted: number;
      modelExact: number;
      modelWrongKind: number;
      modelSlotMismatch: number;
      modelAbstain: number;
      workerRecoversAfterAbstain: boolean;
      modelFailures: Array<{
        instruction: string;
        outcome: string;
        cause?: string;
        expected: unknown;
        actual: unknown;
      }>;
    }>("full browser validation", () =>
      page.evaluate(async (rows) => {
        const resolver = await import("/src/intent/model-resolver.ts");
        const dataset = await import("/src/intent/dataset.ts");
        const decoder = await import("/src/intent/model-decoder.ts");
        const schema = await import("/src/intent/model-schema.ts");
        const routeIntent = await import("/src/intent/route.ts");
        const fallback = await import("/src/intent/model-fallback-policy.ts");
        const { datasetDoc } = await import("/scripts/intent-sft-doc.mts");
        const { warmFactoryPresets } = await import("/src/presets/factory-loader.ts");
        await warmFactoryPresets();
        const doc = datasetDoc();
        const result = {
          rows: rows.length,
          attempted: 0,
          exact: 0,
          wrongKind: 0,
          slotMismatch: 0,
          abstain: 0,
          deterministic: 0,
          modelFallback: 0,
          causes: {} as Record<string, number>,
          failures: [] as Array<{
            instruction: string;
            outcome: string;
            cause?: string;
            expected: unknown;
            actual: unknown;
          }>,
          modelAttempted: 0,
          modelExact: 0,
          modelWrongKind: 0,
          modelSlotMismatch: 0,
          modelAbstain: 0,
          workerRecoversAfterAbstain: false,
          modelFailures: [] as Array<{
            instruction: string;
            outcome: string;
            cause?: string;
            expected: unknown;
            actual: unknown;
          }>,
        };
        for (const row of rows) {
          let cause: string | undefined;
          const deterministic = routeIntent.routeIntentText(row.instruction, doc);
          const modelRoute = await resolver.tryModelRoute(row.instruction, doc, deterministic);
          if (modelRoute == null) {
            if (fallback.isCreativeBriefRoute(row.instruction, deterministic)) cause = "creative-brief-guard";
            else {
              const provider = resolver.getIntentModelProvider();
              try {
                if (!provider) cause = "provider-missing";
                else {
                  const raw = await provider.generate(row.instruction, doc);
                  let action: unknown = JSON.parse(raw);
                  if (action != null && typeof action === "object") {
                    const record = action as Record<string, unknown>;
                    const nestedKey = ["intent", "preset", "parse"].find(
                      (key) => record[key] != null && typeof record[key] === "object",
                    );
                    if (nestedKey != null) action = { kind: record.kind, ...(record[nestedKey] as object) };
                  }
                  cause = schema.validateModelAction(action).valid ? "adapter-refused" : "invalid-schema";
                }
              } catch (error) {
                cause = `provider-error:${String(error).slice(0, 80)}`;
              }
            }
          }
          const modelActual = modelRoute == null ? null : dataset.compactIntentResponse(modelRoute);
          let modelOutcome = "exact";
          if (modelActual == null) {
            result.modelAbstain += 1;
            modelOutcome = "abstain";
          } else {
            result.modelAttempted += 1;
            const expectedKind = (row.response as { kind?: unknown } | null)?.kind;
            if (modelActual.kind !== expectedKind) {
              result.modelWrongKind += 1;
              modelOutcome = "wrong-kind";
            } else if (decoder.canonicalModelJson(modelActual) !== decoder.canonicalModelJson(row.response)) {
              result.modelSlotMismatch += 1;
              modelOutcome = "slot-mismatch";
            } else {
              result.modelExact += 1;
            }
          }
          if (modelOutcome !== "exact" && result.modelFailures.length < 12) {
            result.modelFailures.push({
              instruction: row.instruction,
              outcome: modelOutcome,
              ...(cause ? { cause } : {}),
              expected: row.response,
              actual: modelActual,
            });
          }
          if (cause) result.causes[cause] = (result.causes[cause] ?? 0) + 1;

          const modelFallback =
            deterministic.kind === "pattern" && !fallback.isCreativeBriefRoute(row.instruction, deterministic);
          const route = modelFallback ? modelRoute : deterministic;
          if (modelFallback) result.modelFallback += 1;
          else result.deterministic += 1;
          const actual = route == null ? null : dataset.compactIntentResponse(route);
          let outcome = "exact";
          if (actual == null) {
            result.abstain += 1;
            outcome = "abstain";
          } else {
            result.attempted += 1;
            const expectedKind = (row.response as { kind?: unknown } | null)?.kind;
            if (actual.kind !== expectedKind) {
              result.wrongKind += 1;
              outcome = "wrong-kind";
            } else if (decoder.canonicalModelJson(actual) !== decoder.canonicalModelJson(row.response)) {
              result.slotMismatch += 1;
              outcome = "slot-mismatch";
            } else {
              result.exact += 1;
            }
          }
          if (outcome !== "exact" && result.failures.length < 12) {
            result.failures.push({
              instruction: row.instruction,
              outcome,
              ...(cause ? { cause } : {}),
              expected: row.response,
              actual,
            });
          }
        }
        const recovery = await resolver.tryModelRoute("turn down the chords", doc);
        result.workerRecoversAfterAbstain =
          recovery?.kind === "fader" &&
          recovery.intent.direction === "down" &&
          recovery.intent.targets.length === 1 &&
          recovery.intent.targets[0] === "chords";
        return result;
      }, validationRows),
    );
    const attemptedExact = evaluation.exact / Math.max(1, evaluation.attempted);
    const abstainRate = evaluation.abstain / Math.max(1, evaluation.rows);
    console.log(
      `[intent-model/browser] rows=${evaluation.rows} attempted=${evaluation.attempted} exact=${evaluation.exact} ` +
        `attemptedExact=${(attemptedExact * 100).toFixed(1)}% wrongKind=${evaluation.wrongKind} ` +
        `slotMismatch=${evaluation.slotMismatch} abstain=${evaluation.abstain} (${(abstainRate * 100).toFixed(1)}%) ` +
        `deterministic=${evaluation.deterministic} modelFallback=${evaluation.modelFallback}`,
    );
    for (const failure of evaluation.failures) {
      console.log(
        `[intent-model/browser-pipeline] ${failure.outcome}: ${failure.instruction} · expected=${JSON.stringify(failure.expected)} · actual=${JSON.stringify(failure.actual)}`,
      );
    }
    const modelAttemptedExact = evaluation.modelExact / Math.max(1, evaluation.modelAttempted);
    const modelAbstainRate = evaluation.modelAbstain / Math.max(1, evaluation.rows);
    console.log(
      `[intent-model/browser-model-only] attempted=${evaluation.modelAttempted} exact=${evaluation.modelExact} ` +
        `attemptedExact=${(modelAttemptedExact * 100).toFixed(1)}% wrongKind=${evaluation.modelWrongKind} ` +
        `slotMismatch=${evaluation.modelSlotMismatch} abstain=${evaluation.modelAbstain} ` +
        `(${(modelAbstainRate * 100).toFixed(1)}%) ` +
        `workerRecoversAfterAbstain=${evaluation.workerRecoversAfterAbstain}`,
    );
    for (const failure of evaluation.modelFailures) {
      console.log(
        `[intent-model/browser-model-only] ${failure.outcome}${failure.cause ? `/${failure.cause}` : ""}: ${failure.instruction} · expected=${JSON.stringify(failure.expected)} · actual=${JSON.stringify(failure.actual)}`,
      );
    }
    console.log(`[intent-model/browser] abstain causes=${JSON.stringify(evaluation.causes)}`);
    if (
      evaluation.modelWrongKind > 0 ||
      modelAttemptedExact < 0.95 ||
      modelAbstainRate > 0.2 ||
      !evaluation.workerRecoversAfterAbstain ||
      evaluation.wrongKind > 0 ||
      attemptedExact < 0.95 ||
      abstainRate > 0.2
    )
      failed = true;
  }
} catch (error) {
  console.error(`[intent-model] FAILED: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}

process.exit(failed ? 1 : 0);
