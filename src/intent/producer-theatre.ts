import type { ProducerPersona } from "./producer-personas";
import { defaultCast } from "./producer-personas";

/**
 * SESSION THEATRE — PURE ORCHESTRATION (AI Producer Sessions, killer-feature
 * wave). Turns (user brief, cast, interjections) into a DETERMINISTIC run
 * script the UI layer executes: per-producer flavored prompts, seeds, and
 * a stage timeline the theatre view can stream.
 *
 * PURE by contract: no audio, no rendering, no engine calls — the UI layer
 * (IntentPanel) executes each stage through the existing composeFullTrack
 * pipeline and reports back. Deterministic: same brief + cast + interjects
 * → same prompts/seeds (AGENTS invariant #4).
 *
 * Design rules:
 * - The USER BRIEF is sacred: a persona RECOLORS it (flavor phrase +
 *   mix words appended), it never overrides explicit section requests or
 *   keys already in the brief.
 * - Interjections stack onto the producer's prompt as plain words — the
 *   deterministic parser does the actual work downstream.
 * - Seeds derive from (seedTag, brief hash, interject count) so an
   interjection CHANGES the take (new randomness) without a new universe.
 */

export interface TheatreInterjection {
  producerSlug: string;
  note: string;
}

export interface TheatreRun {
  producerSlug: string;
  name: string;
  avatar: string;
  tagline: string;
  /** The exact prompt the pipeline receives (brief + persona flavor + interjects). */
  prompt: string;
  /** Extra intent-input words (mix character) parsed by the FX lane. */
  mixWords: string;
  seed: string;
  /** UI stage labels streamed during the compose pipeline run. */
  stages: string[];
  /** Interjections applied so far (echoed back on the theatre card). */
  interjections: string[];
}

/** Hash the brief for seed derivation — deterministic, no deps. */
function hashBrief(brief: string): number {
  let hash = 5381;
  for (let i = 0; i < brief.length; i++) hash = ((hash << 5) + hash + brief.charCodeAt(i)) & 0x7fffffff;
  return hash;
}

/** Flavor the user brief with the persona's voice. The brief is ALWAYS the
 * first sentence — the persona recolors, never replaces. */
export function personaPrompt(brief: string, persona: ProducerPersona, interjects: readonly string[]): string {
  const trimmed = brief.trim().replace(/[.\s]+$/, "");
  const flavorParts = [persona.flavorPhrase, ...interjects].filter(Boolean);
  return `${trimmed}. ${flavorParts.join(", ")}. ${persona.mixWords}.`;
}

export interface TheatrePlanInput {
  brief: string;
  cast?: readonly ProducerPersona[];
  interjections?: readonly TheatreInterjection[];
  /** RETAKE counter — bumps the seed version even with no new interjection,
   * so "skús to ešte raz" yields a fresh take, not the one the user has. */
  retake?: number;
}

/** Build one run script per producer in the cast. Deterministic. */
export function buildTheatrePlan(input: TheatrePlanInput): TheatreRun[] {
  const cast = input.cast ?? defaultCast();
  const briefHash = hashBrief(input.brief.trim());
  return cast.map((persona) => {
    const interjects = (input.interjections ?? [])
      .filter((interjection) => interjection.producerSlug === persona.slug)
      .map((interjection) => interjection.note.trim())
      .filter(Boolean);
    const seed = `theatre|${persona.seedTag}|${briefHash}|v${interjects.length + (input.retake ?? 0)}`;
    const stages = [
      `${persona.name}: reading the brief…`,
      `${persona.name}: sketching sections…`,
      `${persona.name}: drums + bass…`,
      `${persona.name}: chords + lead…`,
      `${persona.name}: transitions…`,
      `${persona.name}: mixing — ${persona.mixWords}`,
      `${persona.name}: loudness pass…`,
    ];
    return {
      producerSlug: persona.slug,
      name: persona.name,
      avatar: persona.avatar,
      tagline: persona.tagline,
      prompt: personaPrompt(input.brief, persona, interjects),
      mixWords: persona.mixWords,
      seed,
      stages,
      interjections: interjects,
    };
  });
}

/** Stage label at a given execution index (the UI streams these). */
export function stageLabel(run: TheatreRun, stageIndex: number): string {
  return run.stages[Math.min(stageIndex, run.stages.length - 1)] ?? run.stages[0];
}
