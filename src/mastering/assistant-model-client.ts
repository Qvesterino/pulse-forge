/**
 * MASTERING ASSISTANT SHADOW CLIENT (learning loop Phase 4).
 *
 * Loads the trained correction model (mastering-assistant-v1.onnx) and
 * runs it in SHADOW MODE alongside the rules-based planner: the model's
 * predicted deltas are logged alongside the rules' proposals but NEVER
 * override them. The rules are always the authority — the model is a
 * suggestion for the user to compare.
 *
 * When the learned layer consistently beats the rules on held-out
 * corrections (the training gate's threshold), the shadow can be
 * promoted — but that decision belongs to the user, not the code.
 *
 * Manifest-pinned (same contract as the mastering ranker): gatePassed
 * must be true in the manifest for the model to load.
 */

export interface AssistantModelManifest {
  modelVersion: string;
  schemaVersion: number;
  model: { url: string; bytes: number; features: string[] };
  training: { rows: number; trainRows: number; valRows: number; epochs: number; finalLoss: number };
  validation: { model_mae: number; baseline_mae: number; beats_baseline: boolean; improvement_pct: number };
  report: { gatePassed: boolean };
}

export interface AssistantPrediction {
  paramId: string;
  predictedDelta: number;
}

let cachedSession: { session: unknown; manifest: AssistantModelManifest } | null = null;

/** Check the manifest's gatePassed (the model must have passed training validation). */
export function assistantGatePassed(manifest: AssistantModelManifest): boolean {
  return manifest?.report?.gatePassed === true;
}

/**
 * Predict corrections given the measurement context. Returns null when the
 * model is not loaded, the gate has not passed, or the input is invalid.
 * The caller (the planner) logs the predictions in shadow mode — they never
 * override the rules-based plan.
 */
export async function predictAssistantCorrections(
  context: {
    lufs: number | null;
    crestDb: number | null;
    correlation: number | null;
    hfShare: number | null;
    lowEndShare: number | null;
  },
  featureNames: string[],
): Promise<number[] | null> {
  if (!cachedSession) {
    try {
      const manifestRes = await fetch("/models/mastering-assistant-v1.manifest.json", {
        signal: AbortSignal.timeout(3000),
      });
      if (!manifestRes.ok) return null;
      const manifest: AssistantModelManifest = await manifestRes.json();
      if (!assistantGatePassed(manifest)) return null;
      const ort = await import("onnxruntime-web");
      const session = await ort.InferenceSession.create(`/models/${manifest.model.url}`, {
        executionProviders: ["wasm"],
      });
      cachedSession = { session, manifest };
    } catch {
      return null;
    }
  }
  try {
    const ort = await import("onnxruntime-web");
    const features = featureNames.map((name) => {
      const value = (context as Record<string, unknown>)[name];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    });
    const input = new ort.Tensor("float32", Float32Array.from(features), [1, features.length]);
    const outputs = await (
      cachedSession.session as { run: (a: string, b: unknown) => Promise<Record<string, { data: Float32Array }>> }
    ).run((cachedSession.session as unknown as { inputNames: string[] }).inputNames[0], {
      [(cachedSession.session as unknown as { inputNames: string[] }).inputNames[0]]: input,
    });
    const outputName = Object.keys(outputs)[0];
    return Array.from(outputs[outputName]!.data);
  } catch {
    return null;
  }
}

/** Clear the cached session (project switch, model update). */
export function resetAssistantModel(): void {
  cachedSession = null;
}
