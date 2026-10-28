import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import {
  applyProductionIntentCommand,
  applyProductionIntentToTrackCommand,
  resolveExactTargetTracks,
} from "../commands/intentRouting";
import { snapshot } from "../commands/core";
import { parseProductionIntent, planProductionActions, type ProductionTarget } from "../intent/production";
import { parseEffectIntent } from "../effect-intent/parser";
import { applyEffectIntentOnTrack } from "../effect-intent/applyOnTrack";
import { EFFECT_DEFS } from "../effects/registry";

/**
 * kyx_mix_idea — the remote control that closes the text-to-mix loop:
 *
 *   "warm it up and glue the drums" → PLAN (attributed WHY, nothing changed)
 *   → apply → ONE undo step → verify with kyx_render_summary
 *   → the human judges through a kyx_blind_ab lane.
 *
 * Two interpreters in the FxIntentBar precedence: the PRODUCTION concept
 * planner first for whole-mix language (its parser resolves targets —
 * "drums", "the mix", pad families — straight from the sentence), the
 * ASSISTANT's curated goal language ("teplejšie", "more space") scoped to a
 * concrete track when the sentence or an explicit target names one. An
 * explicit `target` (family word or track id) overrides whatever the text
 * named.
 *
 * Pure module: planning folds commands over LOCAL documents only, so it can
 * never mutate the project. Apply is one snapshot — the whole idea reverts
 * with a single undo.
 */

export interface MixIdeaStep {
  trackId: string;
  track: string;
  /** Device display name, e.g. "Tape Saturator". */
  device: string;
  /** Compact parameter read-out, e.g. "drive 45% · tone 5250 Hz". */
  params: string;
  /** Exact parameter values before and after this planned document change. */
  changes: Array<{ param: string; before: number | null; after: number }>;
  /** The concept or goal that caused this step — the WHY. */
  reason: string;
}

export type MixIdeaPlan =
  | {
      ok: true;
      interpreter: "production" | "assistant";
      targets: string[];
      /** The parsed concepts/goals — the WHY behind every device step. */
      goals: string[];
      steps: MixIdeaStep[];
      label: string;
      /** Element-level notes the caller should surface (pad gain factors…). */
      warnings: string[];
      command: Command;
    }
  | { ok: false; reason: string };

const MIX_IDEA_HINT =
  'Could not read that as a mix idea. Try goals like "warmer", "glue the drums", "more space on the lead", ' +
  '"punchier kick", "brighter mix" — or pass an explicit target (drums | bass | lead | chords | mix | a track id).';

const TARGET_WORDS = new Set(["drums", "bass", "lead", "chords", "mix", "kick", "snare", "hats"]);
type FamilyWord = "drums" | "bass" | "lead" | "chords";

function trackNameOf(doc: ProjectDocument, trackId: string): string {
  return doc.tracks.find((t) => t.id === trackId)?.name ?? trackId;
}

function formatParamValue(key: string, value: number): string {
  if (/hz$|cutoff|frequency|tone/i.test(key)) return `${Math.round(value)} Hz`;
  if (/mix|drive|attack|sustain|amount|width/i.test(key)) return `${Math.round(value * 100)}%`;
  return `${Math.round(value * 100) / 100}`;
}

/** "drive 45% · tone 5250 Hz" — percent/Hz units where the key makes them obvious. */
function formatParams(params: Record<string, number>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => Number.isFinite(value))
    .map(([key, value]) => `${key} ${formatParamValue(key, value)}`);
  return parts.length > 0 ? parts.join(" · ") : "defaults";
}

function deviceName(type: string): string {
  const def = (EFFECT_DEFS as Record<string, { name?: string }>)[type];
  return def?.name ?? type;
}

/** Find one family word inside the sentence for assistant targeting. */
function sentenceTarget(text: string): FamilyWord | null {
  const lower = text.toLowerCase();
  for (const word of ["drums", "bass", "lead", "chords"] as const) {
    if (lower.includes(word)) return word;
  }
  return null;
}

interface PlannedAction {
  trackId: string;
  type: string;
  params: Record<string, number>;
}

function toSteps(doc: ProjectDocument, actions: PlannedAction[]): MixIdeaStep[] {
  const stagedParams = new Map<string, Map<string, number>>();
  const stagedEffects = new Set<string>();
  return actions.map((action) => {
    const key = JSON.stringify([action.trackId, action.type]);
    let current = stagedParams.get(key);
    let hasEffect = stagedEffects.has(key);
    if (!current) {
      const existing = doc.tracks
        .find((track) => track.id === action.trackId)
        ?.effects.find((effect) => effect.type === action.type);
      current = new Map(Object.entries(existing?.params ?? {}));
      stagedParams.set(key, current);
      hasEffect = existing !== undefined;
    }
    const changes = Object.entries(action.params).flatMap(([param, after]) => {
      const before = current!.has(param) ? current!.get(param)! : null;
      current!.set(param, after);
      return before === after ? [] : [{ param, before, after }];
    });
    const step: MixIdeaStep = {
      trackId: action.trackId,
      track: trackNameOf(doc, action.trackId),
      device: `${deviceName(action.type)}${hasEffect ? "" : " (new)"}`,
      params: formatParams(action.params),
      changes,
      reason: "concept mapping",
    };
    stagedEffects.add(key);
    return step;
  });
}

function padGainSteps(before: ProjectDocument, after: ProjectDocument): MixIdeaStep[] {
  const afterTrack = after.tracks.find((track) => track.kind === "drum");
  if (!afterTrack || afterTrack.kind !== "drum") return [];
  const beforeTrack = before.tracks.find((track) => track.id === afterTrack.id);
  if (!beforeTrack || beforeTrack.kind !== "drum") return [];
  return afterTrack.pads.flatMap((pad) => {
    const previous = beforeTrack.pads.find((candidate) => candidate.id === pad.id);
    if (!previous || previous.gain === pad.gain) return [];
    return [
      {
        trackId: afterTrack.id,
        track: trackNameOf(after, afterTrack.id),
        device: `Pad gain · ${pad.name}`,
        params: `gain ${previous.gain} → ${pad.gain}`,
        changes: [{ param: "gain", before: previous.gain, after: pad.gain }],
        reason: "element-level production intent",
      },
    ];
  });
}

function effectChangesForTrack(
  before: ProjectDocument,
  after: ProjectDocument,
  trackId: string,
): Array<{ param: string; before: number | null; after: number }> {
  const beforeTrack = before.tracks.find((track) => track.id === trackId);
  const afterTrack = after.tracks.find((track) => track.id === trackId);
  if (!afterTrack) return [];
  const used = new Set<string>();
  const changes: Array<{ param: string; before: number | null; after: number }> = [];
  for (const effect of afterTrack.effects) {
    const previous =
      beforeTrack?.effects.find((candidate) => candidate.id === effect.id) ??
      beforeTrack?.effects.find((candidate) => candidate.type === effect.type && !used.has(candidate.id));
    if (previous) used.add(previous.id);
    for (const [param, afterValue] of Object.entries(effect.params)) {
      const beforeValue = previous?.params[param] ?? null;
      if (beforeValue !== afterValue) changes.push({ param, before: beforeValue, after: afterValue });
    }
  }
  return changes;
}

function formatChanges(changes: readonly { param: string; before: number | null; after: number }[]): string {
  return changes
    .map((change) => {
      const before = change.before === null ? "unset" : formatParamValue(change.param, change.before);
      const after = formatParamValue(change.param, change.after);
      return `${change.param} ${before} → ${after}`;
    })
    .join(" · ");
}

/**
 * Build the mix-idea plan. Nothing here touches the caller's project — the
 * returned command is pure and every preview fold lands on local docs.
 */
export function planMixIdea(doc: ProjectDocument, idea: string, explicitTarget?: string): MixIdeaPlan {
  const text = idea.trim();
  if (text.length < 3) return { ok: false, reason: MIX_IDEA_HINT };

  const overrideTarget =
    explicitTarget != null && TARGET_WORDS.has(explicitTarget.trim().toLowerCase())
      ? (explicitTarget.trim().toLowerCase() as ProductionTarget)
      : null;
  const explicitTrackId =
    explicitTarget != null && !overrideTarget && doc.tracks.some((t) => t.id === explicitTarget)
      ? explicitTarget
      : null;

  // 1) PRODUCTION — concept language with sentence-level targets.
  const production = parseProductionIntent(text);
  if (production) {
    const intent = overrideTarget ? { ...production, targets: [overrideTarget] } : production;
    try {
      if (explicitTrackId) {
        // Scoped to one track: only that track's actions, same one-snapshot contract.
        const { plan } = planProductionActions(doc, { ...intent, targets: ["mix"] });
        const scoped = plan.actions.filter((action) => action.trackId === explicitTrackId);
        if (scoped.length === 0) {
          return { ok: false, reason: `that idea plans nothing on track ${explicitTrackId}` };
        }
        return {
          ok: true,
          interpreter: "production",
          targets: [explicitTrackId],
          goals: intent.goals.map((goal) => goal.concept),
          steps: toSteps(doc, scoped),
          label: plan.label,
          warnings: [],
          command: applyProductionIntentToTrackCommand(doc, explicitTrackId, intent),
        };
      }
      const { plan, padAdjustments } = planProductionActions(doc, intent);
      if (plan.actions.length === 0) {
        return {
          ok: false,
          reason: `the idea parsed but planned no changes for targets: ${intent.targets.join(", ")}`,
        };
      }
      const warnings = (padAdjustments ?? []).map(
        (pad) => `pad ${pad.family.replace(/s$/, "")} gain ×${Math.round(pad.factor * 100) / 100} (element-level)`,
      );
      const command = applyProductionIntentCommand(doc, intent);
      const plannedDoc = command.execute(doc);
      return {
        ok: true,
        interpreter: "production",
        targets: [...intent.targets],
        goals: intent.goals.map((goal) => goal.concept),
        steps: [...toSteps(doc, plan.actions), ...padGainSteps(doc, plannedDoc)],
        label: plan.label,
        warnings,
        command,
      };
    } catch (error) {
      // The planner throws honestly when a named target has no track —
      // surface that instead of crashing the tool case.
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // 2) ASSISTANT — curated goal language needs a concrete track: explicit
  // track id, an explicit family word, or the same words in the sentence.
  const assistant = parseEffectIntent(text);
  if (assistant.status === "ready") {
    const familyHint = overrideTarget ?? (explicitTrackId ? null : sentenceTarget(text));
    let trackIds: string[] = [];
    if (explicitTrackId) trackIds = [explicitTrackId];
    else if (familyHint) trackIds = resolveExactTargetTracks(doc, familyHint);
    if (trackIds.length === 0) {
      return {
        ok: false,
        reason:
          'assistant goals need a concrete track — pass target: a track id or one of "drums | bass | lead | chords"',
      };
    }
    const steps: MixIdeaStep[] = [];
    const warnings: string[] = [];
    let working = doc;
    let label = "";
    for (const trackId of trackIds) {
      try {
        const command = applyEffectIntentOnTrack(working, trackId, assistant.intent);
        const beforeStep = working;
        working = command.execute(working);
        label = command.label;
        const beforeTrack = beforeStep.tracks.find((track) => track.id === trackId);
        const afterTrack = working.tracks.find((track) => track.id === trackId);
        const createdDevice =
          afterTrack?.effects.some((effect) =>
            beforeTrack?.effects.every((previous) => previous.id !== effect.id || previous.type !== effect.type),
          ) ?? false;
        steps.push({
          trackId,
          track: trackNameOf(doc, trackId),
          device: `assistant (find-or-add${createdDevice ? "; adds device" : "; updates device"})`,
          params: assistant.intent.goals.map((goal) => goal.goal).join(" + "),
          changes: effectChangesForTrack(beforeStep, working, trackId),
          reason: "assistant curated mapping",
        });
      } catch (error) {
        warnings.push(`${trackNameOf(doc, trackId)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (steps.length === 0) {
      return { ok: false, reason: warnings.join(" | ") || MIX_IDEA_HINT };
    }
    return {
      ok: true,
      interpreter: "assistant",
      targets: trackIds,
      goals: assistant.intent.goals.map((goal) => goal.goal),
      steps,
      label,
      warnings,
      command: snapshot("applyMixIdeaAssistant", `Mix idea: ${label}`, doc, working),
    };
  }

  return { ok: false, reason: MIX_IDEA_HINT };
}

/**
 * Agent-facing plan / apply report. `applied` only changes the framing —
 * both forms carry the full attributed plan, because the WHY is the point.
 */
export function formatMixIdea(plan: MixIdeaPlan, applied: boolean): string {
  if (!plan.ok) return plan.reason;
  const head = applied
    ? `Applied "${plan.label}" — ${plan.steps.length} device step${plan.steps.length === 1 ? "" : "s"} as ONE undo (kyx_undo reverts the whole idea).`
    : "PLAN — nothing applied yet. Re-run with apply:true to land it as ONE undo step.";
  const lines = plan.steps.map(
    (step, index) =>
      `  ${index + 1}. ${step.track}: ${step.device} — ${formatChanges(step.changes) || step.params} (${step.reason})`,
  );
  for (const warning of plan.warnings) lines.push(`  + ${warning}`);
  return (
    [
      head,
      `targets: ${plan.targets.join(", ")} · goals: ${plan.goals.join(" + ")} · interpreter: ${plan.interpreter}`,
      ...lines,
    ].join("\n") +
    "\nverify: kyx_render_summary for the measured WHY · human verdict via kyx_blind_ab (op:plan → op:record → op:verdict)"
  );
}
