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
  /**
   * Master tilt in dB for the master EQ shelves (sound-quality pass) —
   * undefined = leave the document's master tilt untouched. Emitted only for
   * the character genres (drill/phonk/jersey/dnb), so legacy mixes keep
   * their exact sound.
   */
  masterTiltDb?: number;
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
 * Resolved tone → master tilt (dB, sound-quality pass). Positive = dark,
 * negative = bright — the master shelves nudge the WHOLE mix (drums
 * included, which per-track tone EQ skips) toward the requested color.
 * Modest by design: the shelves are complementary (±tilt/2), so ±2 dB here
 * is a gentle lean, not an EQ slam.
 */
const TONE_MASTER_TILT_DB: Record<"dark" | "bright" | "warm" | "cold", number> = {
  dark: 2,
  warm: 1.5,
  bright: -1.5,
  cold: -1,
};

/** Genre → tone default (kept in one place with the mix character above). */
const GENRE_TONE_DEFAULT: Partial<Record<IntentSpec["genre"], keyof typeof TONE_MASTER_TILT_DB>> = {
  drill: "dark",
  phonk: "warm",
  jersey: "bright",
};

/**
 * Master tilt a genre's SONG should carry (consumed by applySongCommand).
 * Character genres get their tone default's tilt; legacy genres return
 * undefined = the document's master tilt is left untouched.
 */
export function genreMasterTiltDb(genre: IntentSpec["genre"]): number | undefined {
  const tone = GENRE_TONE_DEFAULT[genre];
  return tone === undefined ? undefined : TONE_MASTER_TILT_DB[tone];
}

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
  // top-bright) but always punches. GENRE_TONE_DEFAULT (above) is the single
  // source for the tone defaults AND the master tilt mapping.
  const characterGenre = genre === "drill" || genre === "phonk" || genre === "jersey" || genre === "dnb";
  const tone = overrides.tone ?? moodTone(intent) ?? (GENRE_TONE_DEFAULT[genre] ?? null);
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

  // Master tilt (sound-quality pass): ONLY for the character genres, so a
  // "dark techno" or "warm ambient" never changes the master sound of
  // existing material. Follows the RESOLVED tone — an explicit override
  // ("bright drill") steers the tilt away from the genre default.
  let masterTiltDb: number | undefined;
  if (characterGenre && tone !== null && tone in TONE_MASTER_TILT_DB) {
    masterTiltDb = TONE_MASTER_TILT_DB[tone as keyof typeof TONE_MASTER_TILT_DB];
    summary.push(`master tilt ${masterTiltDb > 0 ? "+" : ""}${masterTiltDb} dB`);
  }

  return { decisions, summary, masterTiltDb };
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

  if (updates === 0 && profile.masterTiltDb === undefined)
    throw new Error("Mix profile changed nothing — the mix already matches");

  // Master tilt rides the same undoable snapshot as the track effects.
  if (profile.masterTiltDb !== undefined && cursor.master.tiltDb !== profile.masterTiltDb) {
    cursor = {
      ...cursor,
      master: { ...cursor.master, tiltDb: profile.masterTiltDb },
    };
    labelParts.push("master tilt");
  }

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


// ── D1 v2a: TARGETED EFFECT INTENTS ─────────────────────────────────────────
// "viac delayu na leade", "add reverb to the bridge", "menej filtra na basi" —
// effect × target × direction grammar above the profile-level mix. Targets
// are TRACK roles; scene roles expand through the song-builder instrumentation
// map (a bridge plays chords+lead, so reverb "on the bridge" lands there).

export interface EffectIntent {
  effectType: EffectType;
  targets: MixTarget[];
  direction: "more" | "less" | "remove";
  amount: "subtle" | "medium" | "huge";
  detected: string[];
}

/** Primary knob per effect — the one a "more/less X" request turns. */
export const EFFECT_KNOB: Partial<Record<EffectType, string>> = {
  delay: "mix",
  reverb: "mix",
  saturation: "drive",
  distortion: "drive",
  chorus: "mix",
  flanger: "mix",
  phaser: "mix",
  tremolo: "mix",
  bitcrusher: "mix",
  compressor: "ratio",
  pump: "amount",
};

const EFFECT_WORDS: ReadonlyArray<readonly [RegExp, EffectType]> = [
  [/\breverb\b|\bdozvuk\b|\bozven/, "reverb"],
  [/\bdelay\b|\bdelayu\b|\bdekou/, "delay"],
  [/\bdistortion\b|\bdistort|\bsaturat|\bdrive\b|\bdriv/, "saturation"],
  [/\bchorus\b|\bkorus/, "chorus"],
  [/\bflanger\b/, "flanger"],
  [/\bphaser\b|\bfazer/, "phaser"],
  [/\btremolo\b/, "tremolo"],
  [/\bbitcrusher\b|\bcrush/, "bitcrusher"],
  [/\bcompress(?:ion|or)?\b|\bkompres/, "compressor"],
  [/\bsidechain\b|\bpump(?:a|e|u)?\b/, "pump"],
  [/\beq\b|\bfilter\b|\bfiltr/, "eq"],
];

/** Scene role → the tracks its instrumentation plays (song-builder map). */
const ROLE_TARGETS: Record<string, MixTarget[]> = {
  intro: ["drums", "bass"],
  outro: ["drums", "bass"],
  verse: ["drums", "bass", "chords"],
  build: ["drums", "bass", "chords"],
  break: ["chords", "lead"],
  bridge: ["chords", "lead"],
  chorus: ["drums", "bass", "chords", "lead"],
  drop: ["drums", "bass", "chords", "lead"],
  fill: ["drums"],
};

const TARGET_WORDS: ReadonlyArray<readonly [RegExp, MixTarget]> = [
  [/\bdrum|\bbic/, "drums"],
  [/\bbass\b|\bbas(?:a|u|y|ou|ov)?\b|\b808\b/, "bass"],
  [/\bchord|\bakord|\bpad/, "chords"],
  [/\blead(?:om|u|a)?\b|\bmelod/, "lead"],
];

/** Parse a TARGETED effect request. Null when no effect×sentence is present. */
export function parseEffectIntent(text: string): EffectIntent | null {
  const lower = ` ${text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")} `;
  let effectType: EffectType | null = null;
  for (const [re, type] of EFFECT_WORDS) {
    if (re.test(lower)) {
      effectType = type;
      break;
    }
  }
  if (!effectType) return null;

  // remove wins over add (explicit "remove X" / "bez X" / "menej X")
  let direction: EffectIntent["direction"] = "more";
  if (/\bremove\b|\btake out\b|\bodstran|\bvyhod|\bbez (?:delay|reverb|ozven|dozvuk|pump|chorus|filtr|eq)\b|\bmenej (?:delay|dozvuk|ozven)/.test(lower)) {
    direction = "remove";
  } else if (/\bless\b|\bmenej/.test(lower)) {
    direction = "less";
  }

  const targets = new Set<MixTarget>();
  for (const [re, target] of TARGET_WORDS) {
    if (re.test(lower)) targets.add(target);
  }
  // scene-role targets expand to their instrumentation
  for (const [role, expanded] of Object.entries(ROLE_TARGETS)) {
    if (new RegExp(`\b${role}\b`).test(lower)) {
      for (const target of expanded) targets.add(target);
    }
  }
  if (targets.size === 0) {
    // no explicit target — every drum/instrument role (the whole beat)
    targets.add("drums");
    targets.add("bass");
    targets.add("chords");
    targets.add("lead");
  }

  let amount: EffectIntent["amount"] = "medium";
  if (/\bsubtle\b|\btrochu\b|\bmalicko/.test(lower)) amount = "subtle";
  else if (/\bhuge\b|\ba lot\b|\bobri\b|\bvela\b|\bvelmi/.test(lower)) amount = "huge";

  const detected = [`${direction} ${effectType}`, `→ ${[...targets].join("+")}`];
  if (amount !== "medium") detected.push(amount);
  return { effectType, targets: [...targets], direction, amount, detected };
}

const AMOUNT_SCALE: Record<EffectIntent["amount"], number> = { subtle: 0.5, medium: 1, huge: 1.75 };

/** The knob delta for one targeted adjustment (pre-clamp). */
export function effectKnobDelta(intent: EffectIntent): number {
  const scale = AMOUNT_SCALE[intent.amount];
  const base = 0.16 * scale;
  return intent.direction === "more" ? base : -base;
}

/* sentinel-test */
