import { generatePattern, resolveGrooveForGeneration } from "../../ai/generator";
import { degreeToPitch, expandChord } from "../../ai/melodic";
import { MELODIC_BY_GENRE } from "../../ai/grooves/melodic-data";
import { inferPadRole } from "../../ai/pad-roles";
import { forkRandom } from "../../shared/rng";
import { uid } from "../../shared/ids";
import { parseKey, snapToScale, SCALE_INTERVALS } from "../../project-model/scales";
import { STEP_TICKS, type InstrumentTrack, type NoteEvent, type Pattern } from "../../project-model/types";
import {
  buildPriorGridRows,
  priorGenreOf,
  PRIOR_GENRES,
  PRIOR_STYLE_VOCAB,
  PRIOR_FEATURES_VERSION,
  PRIOR_FEATURE_COUNT,
} from "../../ai/symbolic/prior-features";
import {
  buildMelodicFeatureRow,
  melodicGenreOf,
  MELODIC_GENRES,
  MELODIC_DURATION_VALUES,
  MELODIC_FEATURE_COUNT,
  MELODIC_FEATURES_VERSION,
  type MelodicRole,
} from "../../ai/symbolic/melodic-features";
import { runMelodicNext, runPriorGrid } from "../../ai/symbolic/prior-client";
import { rankCandidateBank, type CandidateBankEntry } from "../candidate-bank";
import { attachProvenance, candidatePlan, evaluateCandidate } from "./local";
import type { GenerationContext, GenerationPlan, GenerationProposal, GenerationProvider } from "../types";
import type { GenerateOptions } from "../../ai/types";

/**
 * SymbolicPriorProvider — the SECOND generation source (INTENT_ENGINE.md T2).
 *
 * Samples drums AND melody from tiny trained ONNX priors over the groove
 * library (learned style×role×position hit distribution + next-note model)
 * and hands the candidates to the SAME candidate bank as the template
 * generator, where they cross the SAME invariant gates, deterministic repair
 * and heuristic + ONNX ranking. The priors never mutate the project and never
 * bypass a gate; a missing model or a timeout only shrinks/softens the
 * candidate (drums → candidate skipped, melody → template melody kept), never
 * blocking generation.
 *
 * v1 scope (T2): drums prior; melodic from the template engine.
 * v2 scope (T2 v2): melodic next-note prior — degrees are scale-relative, so
 * every sampled note is in-key BY CONSTRUCTION; the provider maps degree →
 * pitch through the same root+intervals math as the template engine
 * (degreeToPitch + snapToScale). Density/energy act as runtime gains; the
 * models stay pure style×role×position distributions.
 */

export const SYMBOLIC_ENGINE_ID = "pulse-forge.symbolic-prior";
export const SYMBOLIC_ENGINE_VERSION = "prior.v2";

/** Whether a plan requests symbolic-prior candidates at all. */
export function symbolicWanted(plan: GenerationPlan): boolean {
  return (plan.intent.symbolicCandidates ?? 0) > 0 && plan.symbolicSeeds.length > 0;
}

const NOTES_PER_BAR: Record<MelodicRole, number> = { bass: 4, chord: 2, lead: 3 };
const BASE_VELOCITY: Record<MelodicRole, number> = { bass: 0.8, chord: 0.6, lead: 0.7 };
const ROLE_INDEX: Record<MelodicRole, number> = { bass: 0, chord: 1, lead: 2 };

/** Mirror the generator's role→track mapping (name match, else positional). */
function melodicTrackForRole(doc: GenerationContext["project"], options: GenerateOptions, role: MelodicRole) {
  const instrumentTracks = doc.tracks.filter((track): track is InstrumentTrack => track.kind === "instrument");
  const targetTracks =
    options.instrumentTrackIds && options.instrumentTrackIds.length > 0
      ? instrumentTracks.filter((track) => options.instrumentTrackIds!.includes(track.id))
      : instrumentTracks;
  if (targetTracks.length === 0) return null;
  const named = targetTracks.find((track) => track.name.toLowerCase().includes(role));
  return named ?? targetTracks[ROLE_INDEX[role] % targetTracks.length];
}

function normalizeDistribution(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return values.map(() => 1 / values.length);
  return values.map((value) => Math.max(0, value) / total);
}

/** Temperature-sharpened multinomial draw (temperature 1 = plain sampling). */
function sampleFrom(distribution: number[], rand: () => number, temperature: number): number {
  const scaled =
    temperature === 1
      ? normalizeDistribution(distribution)
      : normalizeDistribution(
          distribution.map((value) => Math.pow(Math.max(1e-6, value), 1 / Math.max(0.2, temperature))),
        );
  const roll = rand();
  let cumulative = 0;
  for (let index = 0; index < scaled.length; index++) {
    cumulative += scaled[index];
    if (roll <= cumulative) return index;
  }
  return scaled.length - 1;
}

/**
 * Sample melodic parts from the next-note prior. Autoregressive per role
 * (each note's context includes the sampled previous note), role loops run
 * concurrently. Returns null when the prior is unavailable — callers keep
 * the template melody in that case.
 */
async function sampleMelodicParts(
  plan: GenerationPlan,
  context: GenerationContext,
  rand: () => number,
): Promise<Record<MelodicRole, NoteEvent[]> | null> {
  const options = plan.options;
  const stepCount = options.stepCount;
  const bars = stepCount / 16;
  const genre = melodicGenreOf(options.genre);
  const temperature = plan.intent.controls.temperature;
  const velocitySpread = 0.08 + plan.intent.controls.velocityVariation * 0.1;

  const effectiveKey = options.key ?? context.project.key;
  const parsed = effectiveKey ? parseKey(effectiveKey) : null;
  const root = parsed?.root ?? 0;
  const intervals = SCALE_INTERVALS[parsed?.scaleType ?? "major"];

  const roleEnabled = (role: MelodicRole) =>
    !options.roles || options.roles.includes(role === "chord" ? "chords" : role);
  const roles = (["bass", "chord", "lead"] as const).filter(roleEnabled);
  if (roles.length === 0) return { bass: [], chord: [], lead: [] };

  const octaveOffsetFor = (role: MelodicRole): number | null => {
    const pattern = MELODIC_BY_GENRE[genre]?.find((entry) => entry.role === role);
    return pattern ? pattern.octaveOffset : null;
  };

  const sampleRole = async (role: MelodicRole): Promise<NoteEvent[] | null> => {
    const octaveOffset = octaveOffsetFor(role);
    if (octaveOffset === null) return null;
    const targetNotes = Math.ceil(NOTES_PER_BAR[role] * bars);
    const notes: NoteEvent[] = [];
    let position = 0;
    let prevDegree = -1;
    let prevDuration = 2;
    let prevPrevDegree = -1;
    while (notes.length < targetNotes && position < stepCount) {
      const row = buildMelodicFeatureRow({
        genre,
        role,
        startStep: position,
        prevDegree,
        prevDuration,
        prevPrevDegree,
      });
      if (row.length !== MELODIC_FEATURE_COUNT) return null;
      const run = await runMelodicNext(Float32Array.from(row), 1);
      if (!run.ok || !run.degree || !run.duration) return null;
      const degreeClass = sampleFrom(run.degree.slice(0, 8), rand, temperature);
      const durationClass = sampleFrom(run.duration.slice(0, MELODIC_DURATION_VALUES.length), rand, 1);
      const degree = degreeClass - 1; // class 0 = rest
      const duration = MELODIC_DURATION_VALUES[durationClass];

      if (degree >= 0) {
        const velocity = Math.max(0.15, Math.min(1, BASE_VELOCITY[role] + (rand() - 0.5) * 2 * velocitySpread));
        const start = position * STEP_TICKS;
        const durationTicks = duration * STEP_TICKS;
        if (role === "chord") {
          for (const cn of expandChord(degree, octaveOffset, root, intervals, velocity, rand)) {
            let pitch = degreeToPitch(cn.degree, octaveOffset, root, intervals);
            if (effectiveKey) pitch = snapToScale(pitch, effectiveKey);
            notes.push({
              id: uid("note"),
              pitch: Math.max(0, Math.min(127, pitch)),
              start,
              duration: durationTicks,
              velocity: cn.velocity,
            });
          }
        } else {
          let pitch = degreeToPitch(degree, octaveOffset, root, intervals);
          if (effectiveKey) pitch = snapToScale(pitch, effectiveKey);
          notes.push({
            id: uid("note"),
            pitch: Math.max(0, Math.min(127, pitch)),
            start,
            duration: durationTicks,
            velocity,
          });
        }
      }
      prevPrevDegree = prevDegree;
      prevDegree = degree;
      prevDuration = duration;
      position += duration;
    }
    return notes;
  };

  const settled = await Promise.all(roles.map((role) => sampleRole(role)));
  if (settled.some((part) => part === null)) return null;
  const parts: Record<MelodicRole, NoteEvent[]> = { bass: [], chord: [], lead: [] };
  roles.forEach((role, index) => {
    parts[role] = settled[index] ?? [];
  });
  return parts;
}

export class SymbolicPriorProvider implements GenerationProvider {
  readonly id = SYMBOLIC_ENGINE_ID;
  readonly version = SYMBOLIC_ENGINE_VERSION;
  readonly capabilities = ["offline", "drums", "bass", "chords", "lead", "deterministic", "neural-prior"] as const;

  /**
   * Collect prior-sampled candidates for the shared bank. NEVER throws —
   * every failure is reported in `failures` and simply means fewer
   * candidates / template melody. `startIndex` continues the bank's candidate
   * numbering so heuristic/model tie-breaks stay stable across sources.
   */
  async collectCandidates(
    plan: GenerationPlan,
    context: GenerationContext,
    startIndex: number,
  ): Promise<{ entries: CandidateBankEntry[]; failures: string[] }> {
    const entries: CandidateBankEntry[] = [];
    const failures: string[] = [];
    const options = plan.options;
    const stepCount = options.stepCount;
    const doc = context.project;

    const drumTracks = doc.tracks.filter((track) => track.kind === "drum");
    const targetDrumTrack = options.drumTrackId
      ? (drumTracks.find((track) => track.id === options.drumTrackId) ?? drumTracks[0])
      : drumTracks[0];
    const melodicRolesWanted = (["bass", "chords", "lead"] as const).some(
      (role) => !options.roles || options.roles.includes(role),
    );
    if (
      (!targetDrumTrack || targetDrumTrack.kind !== "drum" || targetDrumTrack.pads.length === 0) &&
      !melodicRolesWanted
    ) {
      return { entries, failures: ["no-drum-track"] };
    }
    const pads = targetDrumTrack?.kind === "drum" ? targetDrumTrack.pads : [];
    const padRoles = pads.map((pad, index) => inferPadRole(pad.name, index));
    const styleId = resolveGrooveForGeneration(doc, options).id;
    // These models have a fixed, versioned vocabulary. New groove-library
    // genres must stay on the template path until matching models are trained;
    // mapping (for example) drill onto the house one-hot silently biases it.
    const supportsDrumPrior =
      (PRIOR_GENRES as readonly string[]).includes(options.genre) &&
      (PRIOR_STYLE_VOCAB as readonly string[]).includes(styleId);
    const supportsMelodicPrior = (MELODIC_GENRES as readonly string[]).includes(options.genre);
    const densityGain = 0.55 + plan.intent.density * 0.9;
    const velocityJitter = plan.intent.controls.velocityVariation * 0.24;

    for (const [offset, symbolicSeed] of plan.symbolicSeeds.entries()) {
      try {
        // Template base (structure + template melodic parts). Melodic roles
        // are generated WITHOUT drums so they adapt rather than follow
        // template kick rows; when the melodic prior answers below, the
        // template melody is REPLACED by prior-sampled notes.
        const melodicOnly = generatePattern(doc, {
          ...options,
          seed: symbolicSeed,
          roles: supportsDrumPrior
            ? (options.roles ?? ["drums", "bass", "chords", "lead"]).filter((role) => role !== "drums")
            : options.roles,
        });

        // Melodic prior (T2 v2) — replaces template melody when available.
        const priorMelody = supportsMelodicPrior
          ? await sampleMelodicParts(plan, context, forkRandom(`${symbolicSeed}|melody.neural`, "stream"))
          : null;
        let notes: Pattern["notes"] = melodicOnly.notes;
        if (priorMelody) {
          notes = {};
          for (const role of ["bass", "chord", "lead"] as const) {
            const part = priorMelody[role];
            if (!part || part.length === 0) continue;
            const track = melodicTrackForRole(doc, options, role);
            if (!track) continue;
            notes[track.id] = [...(notes[track.id] ?? []), ...part];
          }
        }

        const rowsById: Record<string, number[]> = {};
        if (pads.length > 0 && supportsDrumPrior) {
          const featureRows = buildPriorGridRows({
            genre: priorGenreOf(options.genre),
            styleId,
            stepCount,
            padRoles,
          });
          const batch = new Float32Array(featureRows.length * PRIOR_FEATURE_COUNT);
          featureRows.forEach((row, index) => batch.set(row, index * PRIOR_FEATURE_COUNT));
          const run = await runPriorGrid(batch, featureRows.length);
          if (!run.ok || !run.probs) {
            failures.push(`candidate-${startIndex + offset}:prior-${run.source}`);
            continue;
          }

          // Seeded sampling around the learned probabilities: identical plan +
          // model ⇒ identical grid.
          const rand = forkRandom(`${symbolicSeed}|drums.neural`, "stream");
          for (const [padIndex, pad] of pads.entries()) {
            const row = new Array<number>(stepCount).fill(0);
            for (let step = 0; step < stepCount; step++) {
              const probability = run.probs[padIndex * stepCount + step];
              if (rand() < probability * densityGain) {
                const jitter = (rand() - 0.5) * velocityJitter;
                row[step] = Math.max(0.05, Math.min(1, 0.35 + probability * 0.6 + jitter));
              }
            }
            rowsById[pad.id] = row;
          }
          // Anchor floor: the downbeat kick exists even where the prior is shy.
          if (plan.intent.constraints.preserveAnchors) {
            const kickIndex = padRoles.findIndex((role) => role === "kick");
            if (kickIndex >= 0 && rowsById[pads[kickIndex].id][0] === 0) rowsById[pads[kickIndex].id][0] = 0.9;
          }
        }

        const candidate: Pattern = attachProvenance(
          {
            ...melodicOnly,
            name: `${melodicOnly.name} (${Object.keys(rowsById).length > 0 ? "prior" : "template"}${priorMelody ? "+melody" : ""})`,
            rows: { ...melodicOnly.rows, ...rowsById },
            ...(notes ? { notes } : {}),
            generation: {
              ...(melodicOnly.generation ?? plan.recipe),
              engineId: this.id,
              engineVersion: this.version,
              intentHash: plan.intentHash,
            },
          },
          plan,
          doc,
        );

        const evaluated = evaluateCandidate(candidate, candidatePlan(plan, symbolicSeed), context);
        if (!evaluated) {
          failures.push(`candidate-${startIndex + offset}:invariant-gate`);
          continue;
        }
        entries.push({
          candidateIndex: startIndex + offset,
          seed: symbolicSeed,
          pattern: evaluated.pattern,
          status: evaluated.status,
          repairs: evaluated.repairs,
          score: 0,
          contentHash: "",
          source: Object.keys(rowsById).length > 0 || priorMelody ? "symbolic-prior" : "template",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`candidate-${startIndex + offset}:prior-error:${reason}`);
      }
    }
    return { entries, failures };
  }

  /**
   * Standalone provider entry (GenerationProvider contract). The interactive
   * path merges collectCandidates() into the shared bank instead; this method
   * exists so the provider is testable and swappable in isolation.
   */
  async generate(plan: GenerationPlan, context: GenerationContext): Promise<GenerationProposal> {
    const { entries, failures } = await this.collectCandidates(plan, context, 0);
    const ranked = rankCandidateBank(context.project, entries);
    if (ranked.length === 0) {
      throw new Error(`symbolic prior produced no valid candidates: ${failures.join("|") || "unavailable"}`);
    }
    const selected = ranked[0];
    return {
      status: selected.status,
      pattern: selected.pattern,
      diagnostics: {
        warnings: [
          "symbolic-prior-provider",
          `candidate-bank-selected:${selected.candidateIndex}:${selected.source ?? "symbolic-prior"}`,
          PRIOR_FEATURES_VERSION,
          MELODIC_FEATURES_VERSION,
        ],
        repairs: selected.repairs,
        errors: [],
        ...(failures.length > 0 ? { fallbackReason: failures.join("|") } : {}),
        quality: selected.pattern.generation?.quality,
      },
    };
  }
}

export const symbolicPriorProvider = new SymbolicPriorProvider();
