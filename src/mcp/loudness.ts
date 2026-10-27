import type { Command } from "../commands/types";
import type { Services } from "../services";

/**
 * KYX MCP — LOUDNESS BRIDGE (kyx_loudness's render-backed loop, P2).
 *
 * `measure` renders the CURRENT mix offline and reads its integrated LUFS
 * (BS.1770-4); `apply` runs the in-app measure→trim→verify loop
 * (intent/loudness.ts) and returns the UNEXECUTED command so the MCP tool
 * still lands the mutation through the regular context executor (same store,
 * same undo semantics, verification read-back).
 *
 * Both are async and window-local — the honest-refusal contract lives in the
 * tool layer (hooks absent → refusal), errors surface as isError results.
 */
export async function mcpMeasureLoudness(
  services: Services,
  signal?: AbortSignal,
): Promise<{ integrated: number; measured: boolean }> {
  // AS-009 phase 2: entry-boundary check — the measure pipeline behind
  // intent/loudness has no signal parameter yet, so the abort lands before
  // the first render rather than mid-pipeline (honest granularity).
  const { throwIfAborted } = await import("../rendering/renderer");
  throwIfAborted(signal);
  const { measureLoudness } = await import("../intent/loudness");
  return measureLoudness(services.store.getDoc(), services.bank);
}

export async function mcpApplyLoudness(
  services: Services,
  input: { targetDb?: number; direction: "louder" | "quieter" },
  signal?: AbortSignal,
): Promise<
  | {
      ok: true;
      command: Command;
      report: { measuredBefore: number; measuredAfter: number | null; trim: number; target: number };
    }
  | { ok: false; error: string }
> {
  const { throwIfAborted } = await import("../rendering/renderer");
  throwIfAborted(signal);
  const { applyLoudnessIntent } = await import("../intent/loudness");
  const outcome = await applyLoudnessIntent(services.store.getDoc(), services.bank, {
    direction: input.direction,
    ...(input.targetDb !== undefined ? { targetDb: input.targetDb } : {}),
    detected: ["MCP"],
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  return {
    ok: true,
    command: outcome.command,
    report: {
      measuredBefore: outcome.report.measuredBefore,
      measuredAfter: outcome.report.measuredAfter,
      trim: outcome.report.trim,
      target: outcome.report.target,
    },
  };
}
