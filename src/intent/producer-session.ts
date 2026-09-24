/**
 * PRODUCER SESSION — the producer remembers the working context (bod 3).
 *
 * Three pieces of producer memory, session-scoped (like session-context, NOT
 * persisted — a reload legitimately starts a new session):
 *
 *   1. DECISIONS — genre/bpm/key/mood/style decided across this session, so
 *      "ten istý, len hneďavejší" resolves without repeating everything.
 *   2. FOLLOW-UPS — "ten istý, len pomalšie" / "ešte raz" / "ten druhý ale
 *      tvrdší" resolve against the LAST GENERATION's intent into a patch the
 *      panel merges into the next generation (same seed family = same idea).
 *   3. VARIANTS — quick B/C directions off the current intent ("tmavšie",
 *      "energetickejšie") for the after-generation chips.
 *
 * All functions are session-scoped module state + PURE resolvers — no
 * persistence, no throwing; empty session = every resolver returns null.
 */
import type { IntentInput } from "./types";

export type DecisionKind = "genre" | "bpm" | "key" | "mood" | "style";

export interface SessionDecision {
  value: string;
  at: number;
  /** Where it was decided — the prompt/command text. */
  from: string;
}

export interface ProducerSessionState {
  decisions: Partial<Record<DecisionKind, SessionDecision>>;
  generations: number;
}

const decisions = new Map<DecisionKind, SessionDecision>();
let generationCounter = 0;

export function recordDecision(kind: DecisionKind, value: string, from: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  decisions.set(kind, { value: trimmed, at: Date.now(), from });
}

export function bumpGenerationCount(): void {
  generationCounter += 1;
}

export function producerSessionState(): ProducerSessionState {
  return {
    decisions: Object.fromEntries(decisions.entries()),
    generations: generationCounter,
  };
}

export function hasProducerSession(): boolean {
  return decisions.size > 0 || generationCounter > 0;
}

/** Test/diagnostic hook: wipe the session (unlike a real reload, explicit). */
export function resetProducerSession(): void {
  decisions.clear();
  generationCounter = 0;
}

/** Decision values from an intent, recorded after every generation. */
export function recordIntentDecisions(intent: IntentInput, from: string): void {
  if (intent.genre) recordDecision("genre", intent.genre, from);
  if (intent.style) recordDecision("style", intent.style, from);
  if (intent.key) recordDecision("key", intent.key, from);
  if (intent.mood) recordDecision("mood", intent.mood, from);
  const bpm = intent.bpmRange ? Math.round((intent.bpmRange[0] + intent.bpmRange[1]) / 2) : null;
  if (bpm) recordDecision("bpm", String(bpm), from);
}

/** Short HUD summary — "techno · 132 BPM · E Natural Minor". */
export function producerSessionSummary(): string | null {
  const parts: string[] = [];
  const genre = decisions.get("genre");
  if (genre) parts.push(genre.value);
  const bpm = decisions.get("bpm");
  if (bpm) parts.push(`${bpm.value} BPM`);
  const key = decisions.get("key");
  if (key) parts.push(key.value);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ── FOLLOW-UPS ("ten istý, len pomalšie" / "ešte raz" / "ten druhý tvrdší") ──

export interface FollowUpPatch {
  /** Merged patch the panel applies on top of the base intent. */
  patch: IntentInput;
  /** Regenerate with a fresh seed even though the intent matches. */
  reroll: boolean;
  /** Candidate index into the last generation, when the text named one. */
  baseIndex: number | null;
}

export interface FollowUpResolution {
  /** Merged patch the panel applies on top of the base intent. */
  patch: IntentInput;
  /** Regenerate with a fresh seed even though the intent matches. */
  reroll: boolean;
  /** Candidate index into the last generation, when the text named one. */
  baseIndex: number | null;
}

const FOLLOWUP_SAME = /\bten ist|ten isty|\biste raz|\beste raz\b|\bznova\b|\bone more\b|\bznovu\b/;
const BPM_STEP = 6;
const ENERGY_STEP = 0.15;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Resolve a conversational follow-up against the session's last intent.
 * Returns null when the text carries no session phrase (the normal parser
 * handles it) or when there is nothing to refer back to.
 */
export function resolveProducerFollowUp(text: string, lastIntent: IntentInput | null): FollowUpResolution | null {
  try {
    const lower = ` ${text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")} `;
    const same = FOLLOWUP_SAME.test(lower);
    if (!same) return null;

    const base = lastIntent ?? {};
    const patch: IntentInput = {};
    let bpmRange = base.bpmRange ?? null;

    // tempo follow-up: "len pomalšie" shifts the decided bpm down a step
    if (/pomal|slow|nizs(?:ie)? tempo|tempo (?:dole|down)/.test(lower)) {
      if (bpmRange) patch.bpmRange = [Math.max(40, bpmRange[0] - BPM_STEP), Math.max(40, bpmRange[1] - BPM_STEP)];
    } else if (/rychl|faster|tempo (?:hore|up)|hne#{0,2}davej/.test(lower)) {
      if (bpmRange) patch.bpmRange = [Math.min(220, bpmRange[0] + BPM_STEP), Math.min(220, bpmRange[1] + BPM_STEP)];
    }

    // character follow-ups nudge energy/mood like the revise intent does
    if (/tazs|tvrd|agresiv|hard/.test(lower)) {
      patch.energy = clamp01((base.energy ?? 0.7) + ENERGY_STEP);
      patch.mood = "aggressive";
    } else if (/mak|jemn|chill|soft/.test(lower)) {
      patch.energy = clamp01(Math.max(0.2, (base.energy ?? 0.7) - ENERGY_STEP));
      patch.mood = "chill";
    } else if (/tma[vr]|dark/.test(lower)) {
      patch.mood = "dark";
    }

    // no actual modifier, just "ten istý" → reroll the same idea with a fresh seed
    const reroll = Object.keys(patch).length === 0;

    return { patch, reroll, baseIndex: null };
  } catch {
    return null;
  }
}

// ── VARIANTS ("B tmavšie", "C energetické") after a generation ───────────────

export interface VariantSpec {
  label: string;
  chip: string;
  patch: IntentInput;
}

const clampEnergy = (value: number): number => Math.max(0.15, Math.min(0.95, value));

/**
 * Quick B/C directions off the current intent for the after-generation
 * chips: "B — tmavšie" and "C — energetické". Pure and deterministic.
 */
export function planVariantIntents(intent: IntentInput): VariantSpec[] {
  const energy = intent.energy ?? 0.7;
  return [
    {
      label: "tmavšie",
      chip: "◐ B tmavšie",
      patch: { energy: clampEnergy(energy - 0.18), mood: "dark" },
    },
    {
      label: "energetickejšie",
      chip: "◑ C energetické",
      patch: {
        energy: clampEnergy(energy + 0.18),
        mood: "energetic",
        density: clampUnit((intent.density ?? 0.6) + 0.12),
      },
    },
  ];
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}
