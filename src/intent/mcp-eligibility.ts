import type { RoutedIntent } from "./route";

/**
 * AS-014 — PER-KIND MCP ELIGIBILITY for natural-language routes.
 *
 * One data table instead of a scattered refusal list: `kyx_intent` runs the
 * SAME deterministic router as the in-app Intent Panel, but a few route
 * kinds genuinely need the KYX window (UI selection state, audition players,
 * the loudness render loop) and must refuse over MCP — honestly, and with a
 * pointer at the structured kyx_* tool that CAN do the job. The table is the
 * single truth for three consumers:
 *
 *   1. executeRoutedIntent's refusal gate (src/mcp/tools.ts),
 *   2. the capabilitySnapshot publishing (kyx_state subject:capabilities),
 *   3. this suite (tests/mcp-intent-eligibility.test.ts).
 *
 * A new RoutedIntent kind is a COMPILE ERROR here until its eligibility is
 * declared — the same contract ROUTE_ADJUSTMENT owns for the ledger.
 */
export type McpIntentEligibility = { eligible: true } | { eligible: false; reason: string; useInstead?: string };

const ELIGIBLE: McpIntentEligibility = { eligible: true };

export const MCP_INTENT_ELIGIBILITY: Readonly<Record<RoutedIntent["kind"], McpIntentEligibility>> = {
  // ── document-mutating kinds — the command layer is transport-neutral ────
  arrange: ELIGIBLE,
  automateIntent: ELIGIBLE,
  bypassIntent: ELIGIBLE,
  clips: ELIGIBLE,
  compound: ELIGIBLE,
  effectIntent: ELIGIBLE,
  exact: ELIGIBLE,
  fader: ELIGIBLE,
  grooveIntent: ELIGIBLE,
  markerIntent: ELIGIBLE,
  paramIntent: ELIGIBLE,
  preset: ELIGIBLE,
  production: ELIGIBLE,
  sceneIntensity: ELIGIBLE,
  sectionGrooveIntent: ELIGIBLE,
  sendIntent: ELIGIBLE,
  soundSwapIntent: ELIGIBLE,
  stepEditIntent: ELIGIBLE,
  tempo: ELIGIBLE,
  selectedClipArrange: ELIGIBLE,
  selectedRangeArrange: ELIGIBLE,
  selectedStepAssist: ELIGIBLE,
  // AS-014: the mix profile is a PURE command fold (planMixProfile +
  // applyMixIntent through ctx.execute) — nothing window-local.
  mix: ELIGIBLE,
  // AS-014: complaint diagnosis is READ-ONLY (findings + verified next asks;
  // nothing mutates until a proposal is picked) — it runs anywhere.
  complaintIntent: ELIGIBLE,
  // session-control kinds with their own executors in executeRoutedIntent
  undoIntent: ELIGIBLE,
  checkpointIntent: ELIGIBLE,
  transport: ELIGIBLE,
  // read-back kinds (no doc mutation)
  automationPlan: ELIGIBLE,
  queryIntent: ELIGIBLE,
  clarify: ELIGIBLE,
  // ── genuinely window-bound kinds — refused with a pointer ───────────────
  loudness: {
    eligible: false,
    reason:
      "the loudness intent drives the in-app measure→trim→verify render loop; over MCP the structured tool covers it",
    useInstead: 'use kyx_loudness {op: "measure" | "match"}',
  },
  select: {
    eligible: false,
    reason: "selection is KYX window state — there is no MCP-side selection to change",
  },
  sectionProduction: {
    eligible: false,
    reason: "section production auditions ONE proposal at a time in the KYX window before anything commits (by design)",
    useInstead: "ask the user to run it in KYX, or apply the concrete mixer/fader ask directly",
  },
  sectionFlow: {
    eligible: false,
    reason: "section flow auditions its section rewrite in the KYX window before anything commits",
    useInstead: "ask the user to run it in KYX, or use kyx_arrange / kyx_song for whole-arrangement work",
  },
  sectionTransition: {
    eligible: false,
    reason: "section transitions propose an auditioned change in the KYX window (confirm/keep chip)",
    useInstead: "ask the user to confirm it in KYX",
  },
  // generation kinds are proposals needing in-app auditioning (their own
  // refusal above the table — mirrored here so the published block is whole)
  pattern: {
    eligible: false,
    reason: "generation candidates need in-app auditioning before they land",
    useInstead: "rephrase as a mixer/groove command, or use kyx_generate for the structured path",
  },
  revise: {
    eligible: false,
    reason: "generation candidates need in-app auditioning before they land",
    useInstead: "rephrase as a concrete edit, or open KYX",
  },
  presetUnknown: {
    eligible: false,
    reason: "an unknown preset name needs the human to pick the real one (bank browse is in-app)",
    useInstead: "use kyx_tracks listPresets, then re-ask with a real preset name",
  },
  // persistence/recorder kinds have their own honest refusals above the table
  save: {
    eligible: false,
    reason: "the save intent refuses over MCP by policy",
    useInstead: 'use kyx_save (force-flush) — and kyx_save {op: "saveAs", confirm: true} for a copy',
  },
  export: {
    eligible: false,
    reason: "the export intent refuses over MCP by policy",
    useInstead: "use kyx_export (wav/mp3/stems/midi/json)",
  },
  record: {
    eligible: false,
    reason: "recording needs a device-permission gesture and the KYX recording state — human-only by design",
  },
};

/** Compact shape for the capability block: what an agent can ask in ONE
 * natural-language sentence, and what is refused with its pointer. */
export function mcpIntentEligibilitySnapshot(): {
  eligibleKinds: string[];
  refused: Array<{ kind: string; reason: string; useInstead?: string }>;
} {
  const eligibleKinds: string[] = [];
  const refused: Array<{ kind: string; reason: string; useInstead?: string }> = [];
  for (const [kind, entry] of Object.entries(MCP_INTENT_ELIGIBILITY)) {
    if (entry.eligible) eligibleKinds.push(kind);
    else refused.push({ kind, reason: entry.reason, ...(entry.useInstead ? { useInstead: entry.useInstead } : {}) });
  }
  return { eligibleKinds, refused };
}
