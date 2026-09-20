import type { EffectType, ProjectDocument } from "../project-model/types";
import {
  addEffectToTracks,
  removeEffectFromTracks,
  setEffectParam,
  setEffectSidechainSource,
  snapshot,
} from "../commands/commands";
import { clampEffectParam } from "../effects/registry";
import { FAMILY_REFERENCE } from "../presets/preset-loudness.generated";
import { roleForTrack } from "./favorites";
import type { IntentSpec } from "./types";

/**
 * INTENT → MIX CHAIN (INTENT_ENGINE.md D1) — the intent shapes not just the
 * NOTES but the SOUND: tone tilt (EQ), punch (compression), drive
 * (saturation), space (reverb) and sidechain pump derived deterministically
 * from genre/mood/energy, optionally overridden by explicit mix words
 * ("more reverb", "drier", "punchier"…).
 *
 * Principles: CONSERVATIVE by default (no mood/override ⇒ no EQ change — the
 * engine must not touch a mix the user didn't ask about), every value is
 * clamped against the effect's own param definitions, and the whole profile
 * applies as ONE undoable command (same fold-into-snapshot etiquette as
 * arrangeWords).
 */

export type MixTarget = "drums" | "bass" | "chords" | "lead";

export interface MixDecision {
  target: MixTarget;
  effectType: EffectType;
  /** Partial params — merged over the effect's defaults, clamped on apply. */
  params: Record<string, number>;
  /** Wire the effect's sidechain input to the drum track (pump). */
  sidechainFromDrums?: boolean;
}

export interface MixProfile {
  decisions: MixDecision[];
  /** Human-readable lines for status/diagnostics. */
  summary: string[];
}

export interface MixOverrides {
  reverb?: "more" | "less" | "huge";
  tone?: "dark" | "bright" | "warm" | "cold";
  punch?: "more" | "less";
  pump?: "on" | "off";
}

const moodTone = (intent: IntentSpec): MixOverrides["tone"] | null => {
  switch (intent.mood) {
    case "dark":
      return "dark";
    case "energetic":
      return "bright";
    case "chill":
      return "warm";
    default:
      return null;
  }
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Deterministic intent → mix profile. Only decisions the intent actually
 * calls for: tone (mood/override), punch (energy/punch override), space
 * (genre/mood/reverb override), pump (house/techno energy or override).
 */
export function planMixProfile(intent: IntentSpec, overrides: MixOverrides = {}): MixProfile {
  const genre = intent.genre;
  // Genre character defaults (sound-quality pass): when neither the user nor
  // the mood asked for a tone/punch, the genre itself defines the color —
  // drill reads dark and driven, phonk warm (tape-ish), jersey bright and
  // club-pumping; dnb carries no tone default (its splits run sub-heavy AND
  // top-bright) but always punches.
  const CHARACTER_TONE: Partial<Record<typeof genre, NonNullable<MixOverrides["tone"]>>> = {
    drill: "dark",
    phonk: "warm",
    jersey: "bright",
  };
  const characterGenre = genre === "drill" || genre === "phonk" || genre === "jersey" || genre === "dnb";
  const tone = overrides.tone ?? moodTone(intent) ?? (CHARACTER_TONE[genre] ?? null);
  const punch: MixOverrides["punch"] | null =
    overrides.punch ??
    (intent.energy >= 0.75 || intent.mood === "aggressive" || characterGenre ? "more" : null);
  const lushGenre = genre === "ambient";
  const dryGenre = genre === "techno" || genre === "trap" || genre === "drill" || genre === "phonk";

  const reverbMore =
    overrides.reverb === "more" ||
    overrides.reverb === "huge" ||
    (!overrides.reverb && (lushGenre || intent.mood === "chill"));
  const reverbLess = overrides.reverb === "less" || (!overrides.reverb && (dryGenre || intent.mood === "aggressive"));
  const pumpWanted =
    overrides.pump === "off"
      ? false
      : overrides.pump === "on"
        ? true
        : (genre === "house" || genre === "techno" || genre === "jersey") && intent.energy >= 0.55;

  const decisions: MixDecision[] = [];
  const summary: string[] = [];

  // ── Tone: EQ tilt on instrument tracks (only when the intent asks) ──────
  if (tone) {
    const tilt: Record<NonNullable<MixOverrides["tone"]>, Record<string, number>> = {
      dark: { lowShelfGain: 2.5, highShelfGain: -2.5, lpFreq: 14000 },
      bright: { lowShelfGain: -1, highShelfGain: 2.5, lpFreq: 19000 },
      warm: { lowShelfGain: 1.5, highShelfGain: -1, lpFreq: 16000 },
      cold: { lowShelfGain: -1.5, highShelfGain: 1.5, lpFreq: 17000 },
    };
    decisions.push({
      target: "bass",
      effectType: "eq",
      params: { ...tilt[tone], ...(tone === "dark" ? { lowShelfGain: 3 } : {}) },
    });
    decisions.push({ target: "chords", effectType: "eq", params: tilt[tone] });
    decisions.push({ target: "lead", effectType: "eq", params: tilt[tone] });
    summary.push(`tone: ${tone}`);
  }

  // ── Punch: drum compression + drive (energy/aggressive/punch words) ─────
  if (punch === "more") {
    // Reference punch (sound-quality pass): for the CHARACTER genres the
    // drum compressor's threshold sits just under the drum family's measured
    // peak activity (integrated + PLR − 3 dB), so it rides the transient tops
    // and adapts when curated content changes (regenerate via
    // `npm run presets:loudness`). Legacy genres keep the hand-tuned value —
    // no sonic change to existing material.
    const drumsRef = FAMILY_REFERENCE.drums;
    const punchThreshold = characterGenre
      ? Math.max(-30, Math.min(-6, Math.round((drumsRef.integrated + drumsRef.punchPlrDb - 3) * 10) / 10))
      : -16;
    decisions.push({
      target: "drums",
      effectType: "compressor",
      params: { threshold: punchThreshold, ratio: 4, attack: 0.006, makeup: 2 },
    });
    decisions.push({ target: "drums", effectType: "saturation", params: { drive: 0.45, mix: 0.6 } });
    decisions.push({ target: "bass", effectType: "saturation", params: { drive: 0.4 } });
    summary.push("punch: compressed + driven");
  } else if (punch === "less") {
    decisions.push({
      target: "drums",
      effectType: "compressor",
      params: { threshold: -10, ratio: 2, attack: 0.02, makeup: 0 },
    });
    summary.push("punch: softened");
  }

  // ── Space: reverb on chords + lead ──────────────────────────────────────
  if (reverbMore || reverbLess) {
    const base = lushGenre
      ? { mix: 0.45, decay: 3.5, tone: 5200, diffusion: 0.7 }
      : intent.mood === "chill" || overrides.reverb === "huge"
        ? { mix: 0.4, decay: 2.8, tone: 6000, diffusion: 0.6 }
        : { mix: 0.25, decay: 1.8, tone: 6500, diffusion: 0.5 };
    const params = reverbLess
      ? { mix: clamp01(base.mix - 0.15), decay: Math.max(0.4, base.decay * 0.5), tone: 7000, diffusion: 0.4 }
      : overrides.reverb === "huge"
        ? { mix: clamp01(base.mix + 0.25), decay: Math.min(6, base.decay * 1.6), tone: base.tone, diffusion: 0.75 }
        : base;
    decisions.push({ target: "chords", effectType: "reverb", params });
    decisions.push({ target: "lead", effectType: "reverb", params: { ...params, mix: clamp01(params.mix * 0.85) } });
    summary.push(reverbLess ? "space: drier" : `space: ${overrides.reverb === "huge" ? "huge" : "lush"} reverb`);
  }

  // ── Pump: sidechain pump on instruments, keyed from the drums ───────────
  if (pumpWanted) {
    const amount = clamp01(0.45 + (intent.energy - 0.5) * 0.4);
    decisions.push({
      target: "bass",
      effectType: "pump",
      params: { amount, release: 0.45 },
      sidechainFromDrums: true,
    });
    decisions.push({
      target: "chords",
      effectType: "pump",
      params: { amount: clamp01(amount * 0.8), release: 0.45 },
      sidechainFromDrums: true,
    });
    summary.push(`pump: sidechain ${Math.round(amount * 100)}%`);
  }

  return { decisions, summary };
}

/** Resolve a mix target to concrete track ids in THIS document. */
function trackIdsForTarget(doc: ProjectDocument, target: MixTarget): string[] {
  if (target === "drums") {
    return doc.tracks.filter((track) => track.kind === "drum").map((track) => track.id);
  }
  // roleForTrack uses the melodic-part naming ("chord"); MixTarget uses the
  // IntentRole naming ("chords") — normalize before comparing.
  const roleWanted = target === "chords" ? "chord" : target;
  return doc.tracks
    .filter((track) => track.kind === "instrument")
    .map((track, index) => ({ id: track.id, role: roleForTrack(track.name, index) }))
    .filter((entry) => entry.role === roleWanted)
    .map((entry) => entry.id);
}

/**
 * Apply a mix profile as ONE undoable command: add missing effects, clamp +
 * set params, wire sidechains. Following the arrangeWords etiquette, the
 * primitives fold over a cursor and the final document becomes one snapshot.
 */
export function applyMixIntent(doc: ProjectDocument, profile: MixProfile): ReturnType<typeof snapshot> {
  if (profile.decisions.length === 0) throw new Error("Mix profile has no decisions — nothing to apply");
  const drumTrackId = doc.tracks.find((track) => track.kind === "drum")?.id ?? null;

  let cursor = doc;
  let updates = 0;
  const labelParts: string[] = [];

  for (const decision of profile.decisions) {
    const trackIds = trackIdsForTarget(doc, decision.target);
    for (const trackId of trackIds) {
      let fx = cursor.tracks
        .find((track) => track.id === trackId)
        ?.effects.find((effect) => effect.type === decision.effectType);
      if (!fx) {
        cursor = addEffectToTracks(cursor, [trackId], decision.effectType).execute(cursor);
        fx = cursor.tracks
          .find((track) => track.id === trackId)
          ?.effects.find((effect) => effect.type === decision.effectType);
        if (!fx) continue;
        labelParts.push(`+${decision.effectType}→${decision.target}`);
        updates += 1;
      }
      for (const [paramId, value] of Object.entries(decision.params)) {
        const clamped = clampEffectParam(decision.effectType, paramId, value);
        if (fx.params[paramId] === clamped) continue;
        cursor = setEffectParam(cursor, trackId, fx.id, paramId, clamped).execute(cursor);
        updates += 1;
      }
      if (decision.sidechainFromDrums && drumTrackId) {
        if (fx.sidechainTrackId !== drumTrackId) {
          cursor = setEffectSidechainSource(cursor, trackId, fx.id, drumTrackId).execute(cursor);
          updates += 1;
        }
      }
    }
  }

  if (updates === 0) throw new Error("Mix profile changed nothing — the mix already matches");

  return snapshot("applyMixIntent", `Mix: ${labelParts.join(", ") || `${updates} updates`}`, doc, cursor);
}

/**
 * Remove effects a previous mix intent added (the "reset" path) — still one
 * command, still target-scoped.
 */
export function removeMixEffect(
  doc: ProjectDocument,
  target: MixTarget,
  effectType: EffectType,
): ReturnType<typeof snapshot> {
  const trackIds = trackIdsForTarget(doc, target);
  let cursor = doc;
  for (const trackId of trackIds) {
    if (cursor.tracks.find((track) => track.id === trackId)?.effects.some((effect) => effect.type === effectType)) {
      cursor = removeEffectFromTracks(cursor, [trackId], effectType).execute(cursor);
    }
  }
  return snapshot("removeMixEffect", `Remove ${effectType} from ${target}`, doc, cursor);
}
