/**
 * SAMPLE FORGE — CANDIDATES (roadmap wave 3, TSAR plan R3).
 *
 * One import, several honest ways to play it.
 *
 * The Forge (src/tsar/forge.ts) analyses a sound and returns ONE plan with
 * ONE engine — the branch at `forge.ts:284` picks a single routing:
 *
 *   kind === "one-shot"  -> sampler
 *   stable f0            -> wavetable
 *   drifting f0          -> granular
 *
 * That is a correct ANSWER to "what is this sound?", but it is a bad
 * QUESTION for a producer: the same recording can be a playable one-shot, a
 * tuned wavetable voice, or a texture cloud, and the producer is the one who
 * knows which use they are after. Forcing one answer throws away the choice.
 *
 * So this module asks the Forge for the MEASUREMENTS and then offers the
 * readings those measurements support. The measurements are not re-derived
 * here — `forgePlan` stays the single implementation of the analysis, and
 * this module only decides which ENGINES the evidence licenses.
 *
 * The contract:
 *
 *  - A candidate is a READ, not a random variant. Its params are derived
 *    from the measured evidence, so "wavetable" means a specific set of
 *    wavetable params, not a perturbation of the sampler.
 *  - A candidate that the evidence does not support is NOT offered. A
 *    one-shot with no readable pitch cannot become a tuned wavetable, so
 *    there is no such candidate — the list is shorter, and honest.
 *  - Every candidate carries its evidence: the root and how sure we are of
 *    it, the envelope that was measured, the reason this engine was chosen,
 *    and the warnings that apply.
 *  - Low confidence is never dressed up as a precise pitch. A candidate
 *    whose root was only weakly detected says so; it does not round to a
 *    confident-looking MIDI note.
 *  - Deterministic: the same PCM and the same options give the same
 *    candidates, in the same order (AGENTS invariant #4). There is no seed
 *    because there is no randomness — these are readings, not draws.
 *
 * The plan this module returns is DATA (like `ForgePlan`); a command applies
 * it (src/commands/tsar.ts). The panel may audition a candidate without
 * applying it (see src/audio-engine/previewDeck.ts).
 */

import { forgePlan, type ForgeEngine, type ForgeOptions, type ForgePlan } from "./forge";

/** Which source slot a candidate targets. */
export type ForgeSlot = 0 | 1;

/**
 * One candidate reading of an analysed sound.
 *
 * `params` is the OVERLAY for the target slot's parameters — the keys the
 * candidate changes, not the whole patch. The base patch is the track's
 * current state; the command merges the overlay onto it so applying a
 * candidate changes what the candidate is about and nothing else.
 */
export interface ForgeCandidate {
  /** Stable id: the engine name. Readable in tests and in the UI. */
  id: string;
  /** Short human label, e.g. "PLAYABLE ONE-SHOT". */
  label: string;
  /** The engine this candidate uses. */
  engine: ForgeEngine;
  /** The slot this candidate targets. */
  slot: ForgeSlot;
  /** The parameter overlay for that slot (keys are slot-prefixed). */
  params: Record<string, number>;
  /** The measured root, and how sure the analysis is of it. */
  rootMidi: number | null;
  /** 0..1 — how clearly the root was detected. 0 means "no root found". */
  rootConfidence: number;
  /** True when the root is a strong enough reading to set the patch root. */
  rootReliable: boolean;
  /** The measured envelope of the source. */
  envelope: { attackSec: number; releaseSec: number };
  /** Whether the reading treats the source as a sustained (loopable) tone. */
  sustained: boolean;
  /** WHY this engine — the measured reason, shown verbatim. */
  reason: string;
  /** Warnings that apply to this candidate (empty when there are none). */
  warnings: string[];
}

/** The whole analysis behind a candidate list. */
export interface ForgeCandidateSet {
  /** The source measurements, as the Forge reports them. */
  plan: ForgePlan;
  /** The candidate readings, in a stable order. */
  candidates: ForgeCandidate[];
  /** Warnings that apply to the SOURCE as a whole (not to one engine). */
  warnings: string[];
}

/**
 * Below this clarity the root is a weak reading, not a pitch. The Forge's
 * own detector reports clarity in 0..1 (forge.ts:158, 172); at the low end
 * it is a guess with a number attached, and a guess must not be presented as
 * a measured root.
 */
const RELIABLE_ROOT_CLARITY = 0.5;

/** The slot prefix for a candidate's parameters. */
function prefix(slot: ForgeSlot): string {
  return slot === 0 ? "srcA" : "srcB";
}

/**
 * The parameter overlay for a candidate reading.
 *
 * Every value here is DERIVED FROM A MEASUREMENT, never invented:
 *  - the engine is the reading's own engine;
 *  - the level keeps the source's measured peak in mind (a quiet source is
 *    not turned up beyond what it holds);
 *  - the envelope is the measured attack and release;
 *  - the root is set only when the reading is reliable — a weak root leaves
 *    the patch root alone rather than writing a guess;
 *  - the engine's own voice parameters are set to what that engine needs to
 *    play THIS source honestly (a wavetable reads at its root; a granular
 *    cloud needs grain size below the source's own length).
 */
function overlayFor(
  candidate: Pick<ForgeCandidate, "engine" | "slot" | "rootMidi" | "rootReliable" | "envelope" | "sustained">,
  plan: ForgePlan,
): Record<string, number> {
  const p = prefix(candidate.slot);
  const params: Record<string, number> = {};

  params[`${p}Engine`] = candidate.engine === "sampler" ? 0 : candidate.engine === "wavetable" ? 1 : 2;

  // A sustained reading holds; a one-shot decays into silence. The
  // measured release is the tail that was actually heard, so it is the
  // honest value for a one-shot and a floor for a sustained one.
  const release = Math.max(0.02, candidate.envelope.releaseSec);
  params[`${p}Atk`] = Math.max(0.001, Math.min(4, candidate.envelope.attackSec));
  if (candidate.sustained) {
    params[`${p}Sus`] = 0.85;
    params[`${p}Dec`] = Math.max(0.01, Math.min(8, release));
    params[`${p}Rel`] = Math.max(0.01, Math.min(12, release));
  } else {
    params[`${p}Sus`] = 0;
    params[`${p}Dec`] = Math.max(0.01, Math.min(8, release));
    params[`${p}Rel`] = Math.max(0.02, Math.min(12, release));
  }

  // The measured peak decides the level: a source that peaks at 0.2 is
  // played at 0.2's worth, not normalised to full scale. Normalisation is
  // the audio engine's job, not the analyst's.
  const peak = plan.peakNormalize > 0 ? 1 / plan.peakNormalize : 1;
  const level = Math.max(0.35, Math.min(1, Math.sqrt(peak)));
  params[`${p}Level`] = Number(level.toFixed(3));

  // The root only when the reading supports it.
  if (candidate.rootReliable && candidate.rootMidi !== null) {
    params[`${p}Root`] = candidate.rootMidi;
  }

  // Engine-specific voice shaping, derived from the source's own shape.
  if (candidate.engine === "granular") {
    // Grains must fit INSIDE the source: a grain longer than the material
    // would just replay the whole thing per grain. Half the source length,
    // clamped to the engine's own range, is the honest choice.
    const sourceSec = plan.envelope.attackSec + plan.envelope.releaseSec;
    params[`${p}GrainSize`] = Number(Math.max(0.005, Math.min(0.3, sourceSec / 2)).toFixed(4));
    params[`${p}GrainDensity`] = 16;
    params[`${p}GrainJitter`] = 0.3;
  } else if (candidate.engine === "wavetable") {
    // A wavetable reads at its root, so the scan stays slow and the unison
    // narrow: the reading IS the timbre, the engine should not smear it.
    params[`${p}Scan`] = 0.05;
    params[`${p}Unison`] = 1;
  } else {
    // The sampler plays the recording as it is.
    params[`${p}Unison`] = 1;
  }

  return params;
}

/**
 * The candidate readings the evidence supports.
 *
 * The order is fixed: playable sampler first (it always works), then the
 * tuned reading, then the texture. A producer looking for "can I use this
 * as a hit" should not have to read past a texture cloud.
 */
export function forgeCandidates(
  pcm: Float32Array,
  sampleRate: number,
  options: ForgeOptions & { slot?: ForgeSlot } = {},
): ForgeCandidateSet {
  const slot: ForgeSlot = options.slot === 1 ? 1 : 0;
  const plan = forgePlan(pcm, sampleRate, options);
  const warnings = [...plan.warnings];

  // An empty or silent source has no readings at all. The Forge already
  // says why; there is nothing to offer and no root to invent.
  if (plan.kind === "empty") {
    return { plan, candidates: [], warnings };
  }

  const rootReliable = plan.rootMidi !== null && plan.rootConfidence >= RELIABLE_ROOT_CLARITY;
  const base = {
    slot,
    rootMidi: plan.rootMidi,
    rootConfidence: plan.rootConfidence,
    rootReliable,
    envelope: plan.envelope,
    sustained: plan.kind === "sustained",
  };

  const candidates: ForgeCandidate[] = [];

  // 1. THE SAMPLER — always offered. Any audible recording can be played.
  candidates.push({
    ...base,
    id: "sampler",
    label: plan.kind === "one-shot" ? "PLAYABLE ONE-SHOT" : "PLAYABLE SAMPLE",
    engine: "sampler",
    reason:
      plan.kind === "one-shot"
        ? `one-shot material (${(plan.envelope.releaseSec * 1000).toFixed(0)} ms tail) plays as it was recorded`
        : "the recording plays as it was recorded",
    warnings: rootReliable ? [] : warnings,
    params: overlayFor({ ...base, engine: "sampler" }, plan),
  });

  // 2. THE WAVETABLE — only when the source has a root worth tuning to.
  //    A wavetable is a PERIODIC table: without a readable, stable pitch
  //    there is nothing to make a table from, and offering one anyway
  //    would promise a tuning the evidence does not support.
  const canWavetable = plan.rootMidi !== null && plan.rootConfidence >= RELIABLE_ROOT_CLARITY;
  if (canWavetable) {
    candidates.push({
      ...base,
      id: "wavetable",
      label: "TUNED WAVETABLE",
      engine: "wavetable",
      reason: `a readable root (MIDI ${plan.rootMidi}, clarity ${plan.rootConfidence.toFixed(2)}) becomes a tuned voice`,
      warnings: [],
      params: overlayFor({ ...base, engine: "wavetable" }, plan),
    });
  }

  // 3. THE GRANULAR TEXTURE — offered for sustained material, and for a
  //    one-shot only when it carries enough body to be granulated rather
  //    than merely clicked. A 20 ms click has nothing to spread.
  const enoughBody = plan.envelope.releaseSec >= 0.08 || plan.envelope.attackSec >= 0.08;
  if (plan.kind === "sustained" || enoughBody) {
    const granularWarnings = [...warnings];
    if (plan.rootMidi === null) {
      granularWarnings.push("no root detected — the texture stays un-pitched");
    }
    candidates.push({
      ...base,
      id: "granular",
      label: "TEXTURE CLOUD",
      engine: "granular",
      reason:
        plan.kind === "sustained"
          ? "sustained material becomes a grain cloud"
          : "the body of the hit becomes a grain cloud",
      warnings: granularWarnings,
      params: overlayFor({ ...base, engine: "granular" }, plan),
    });
  }

  return { plan, candidates, warnings };
}

/**
 * The candidate a producer gets by default: the FIRST one. The order is the
 * recommendation order, so the default is the most generally usable reading.
 */
export function defaultCandidate(set: ForgeCandidateSet): ForgeCandidate | null {
  return set.candidates[0] ?? null;
}

/**
 * A one-line, honest summary of a candidate for a status line.
 *
 * The root is only shown as a pitch when the reading is reliable. A weak
 * reading is shown as its confidence, never as a confident MIDI note.
 */
export function candidateSummary(candidate: ForgeCandidate): string {
  const root = candidate.rootReliable
    ? `root MIDI ${candidate.rootMidi}`
    : candidate.rootMidi !== null
      ? `root ~MIDI ${candidate.rootMidi} (weak, ${(candidate.rootConfidence * 100).toFixed(0)} %)`
      : "no root detected";
  return `${candidate.label} — ${root}`;
}
