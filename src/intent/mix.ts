import type { EffectType, ProjectDocument, SceneAutomation } from "../project-model/types";
import {
  addEffectToTracks,
  removeEffectFromTracks,
  setEffectParam,
  setEffectSidechainSource,
  snapshot,
} from "../commands/commands";
import { clampEffectParam, EFFECT_META } from "../effects/definitions";
import { FAMILY_REFERENCE } from "../presets/preset-loudness.generated";
import { SONG_LOUDNESS_TARGET_LUFS, SONG_LOUDNESS_TRIM_LIMIT_DB } from "./genre-reference.generated";
import { artistMixProfileOf } from "./artist-mix";
import { roleForTrack } from "./favorites";
import { parsePercent } from "./percent";
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

export type MixTarget = "drums" | "bass" | "chords" | "lead" | "vocal";

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
  /**
   * Master integrated-loudness target in LUFS (Phase 2 slice 3). Derived from
   * an artist signature's `lufs` signal as a bounded offset from
   * SONG_LOUDNESS_TARGET_LUFS, so an artist can lift the mix by at most
   * SONG_LOUDNESS_TRIM_LIMIT_DB — the same guard the song builder honors.
   * undefined = leave the document's master target untouched (no artist
   * signal, or the artist is quieter than the streaming target).
   */
  masterLufsTarget?: number;
  /**
   * Master buss-glue state (Phase 2 slice 3). Derived from an artist
   * signature's `glue` signal; undefined = leave the document's
   * master.glueEnabled untouched.
   */
  masterGlueEnabled?: boolean;
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
  // DnB leans dark by default (reese pressure, chopped breaks) — liquid and
  // explicitly bright/chill asks still win via moodTone/overrides above.
  dnb: "dark",
  // Boom bap is the warm-and-dusty genre — the sampled-break tone.
  boombap: "warm",
  // Amapiano is the log-drum warmth — deep and round, never bright.
  amapiano: "warm",
  // Trance is the euphoric-lift genre — the bright end (supersaw air).
  trance: "bright",
  // Detroit is the machine-funk genre — the cold end (raw 808, no warmth).
  detroit: "cold",
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
 * Master tilt for a SONG built from this intent: the ARTIST signature's
 * tone wins over the genre default (drake songs tilt dark even on a
 * bright-leaning genre); no signature → the genre tilt as before.
 */
export function masterTiltForIntent(intent: IntentSpec): number | undefined {
  const tone = artistMixProfileOf(intent)?.tone ?? GENRE_TONE_DEFAULT[intent.genre];
  return tone === undefined ? undefined : TONE_MASTER_TILT_DB[tone];
}

/**
 * Deterministic intent → mix profile. Only decisions the intent actually
 * calls for: tone (mood/override), punch (energy/punch override), space
 * (genre/mood/reverb override), pump (house/techno energy or override),
 * pocket (V2 vocal presence — leaves room for the singer).
 */
export function planMixProfile(
  intent: IntentSpec,
  overrides: MixOverrides = {},
  options: { vocalPresent?: boolean } = {},
): MixProfile {
  const genre = intent.genre;
  // Genre character defaults (sound-quality pass): when neither the user nor
  // the mood asked for a tone/punch, the genre itself defines the color —
  // drill reads dark and driven, phonk warm (tape-ish), jersey bright and
  // club-pumping, dnb dark (reese pressure over crisp breaks) but always
  // punching. GENRE_TONE_DEFAULT (above) is the single source for the tone
  // defaults AND the master tilt mapping.
  const characterGenre =
    genre === "drill" ||
    genre === "phonk" ||
    genre === "jersey" ||
    genre === "dnb" ||
    genre === "boombap" ||
    genre === "amapiano" ||
    genre === "trance" ||
    genre === "detroit";
  // Pop songs default to a bright, airy tilt (Wave 4) — explicit tone words
  // and mood tones still win; the style default only fills silence.
  const popSong = intent.style === "pop";
  // Artist mix signature (Vlna 8): sits ABOVE the genre default but BELOW
  // explicit user words and mood tones — "drake type beat" sounds like
  // Drake, "drake type beat brighter" sounds brighter.
  const artistMix = artistMixProfileOf(intent);
  const tone =
    overrides.tone ?? moodTone(intent) ?? artistMix?.tone ?? GENRE_TONE_DEFAULT[genre] ?? (popSong ? "bright" : null);
  const punch: MixOverrides["punch"] | null =
    overrides.punch ??
    (intent.energy >= 0.75 || intent.mood === "aggressive" || characterGenre ? "more" : (artistMix?.punch ?? null));
  const lushGenre = genre === "ambient";
  const dryGenre =
    genre === "techno" ||
    genre === "trap" ||
    genre === "drill" ||
    genre === "phonk" ||
    genre === "hyperpop" ||
    genre === "boombap" ||
    genre === "trance" ||
    genre === "detroit";

  const reverbMore =
    overrides.reverb === "more" ||
    overrides.reverb === "huge" ||
    (!overrides.reverb &&
      (lushGenre || artistMix?.reverb === "more" || artistMix?.reverb === "huge" || intent.mood === "chill"));
  const reverbLess =
    overrides.reverb === "less" ||
    (!overrides.reverb &&
      artistMix?.reverb !== "more" &&
      artistMix?.reverb !== "huge" &&
      (dryGenre || intent.mood === "aggressive"));
  const pumpWanted =
    overrides.pump === "off"
      ? false
      : overrides.pump === "on"
        ? true
        : artistMix?.pump !== undefined
          ? artistMix.pump
          : (genre === "house" ||
              genre === "techno" ||
              genre === "jersey" ||
              genre === "ukg" ||
              genre === "amapiano" ||
              genre === "trance" ||
              genre === "detroit") &&
            intent.energy >= 0.55;

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

  // ── Width: haasWidener on chords + lead (Phase 2 slice 2) ──────────────
  // Wide → Haas decorrelation pushed to 0.85 (immersive atmospheric trap /
  // emo-rap / future-bass). Narrow → 0.35 (mono-focused jersey club / drill).
  // Normal = genre default (no decision pushed).
  const widthSignal = artistMix?.width;
  if (widthSignal === "wide" || widthSignal === "narrow") {
    const haasWidth = widthSignal === "wide" ? 0.85 : 0.35;
    decisions.push({ target: "chords", effectType: "haasWidener", params: { width: haasWidth } });
    decisions.push({ target: "lead", effectType: "haasWidener", params: { width: haasWidth } });
    summary.push(`width: ${widthSignal} (haas ${haasWidth})`);
  }

  // ── Sub: lowShelfGain on bass (Phase 2 slice 2) ─────────────────────────
  // Prominent → 808 / kick sub becomes dominant (drill / phonk / trap).
  // Subtle → rolled-off, lo-fi character (lo-fi hip-hop / Jersey club kick
  // forward). Moderate = genre default (no decision pushed).
  const subSignal = artistMix?.sub;
  if (subSignal === "prominent" || subSignal === "subtle") {
    const subGain = subSignal === "prominent" ? 3.5 : -1.5;
    decisions.push({ target: "bass", effectType: "eq", params: { lowShelfGain: subGain } });
    summary.push(`sub: ${subSignal} (lowShelf ${subGain > 0 ? "+" : ""}${subGain} dB)`);
  }

  // ── Scoop: low-mid notch (Phase 2 slice 5) ──────────────────────────────
  // A "sub-heavy, scooped low-mids" master needs a 200-500 Hz dip. Nothing
  // else in the mix chain can express it — tone is a shelf pair + lowpass,
  // sub is a lowShelf, and the vocal pocket lives at 2.8 kHz — so the scoop
  // gets its own peaking cut on the tracks that would otherwise fight the
  // 808. Bass is excluded: the notch is on the LOW-mids, the kick/808 own
  // that space.
  if (artistMix?.scoop) {
    const scoop = { lowMidFreq: 320, lowMidGain: -1.5, lowMidQ: 0.9 };
    decisions.push({ target: "chords", effectType: "eq", params: { ...scoop } });
    decisions.push({ target: "lead", effectType: "eq", params: { ...scoop } });
    summary.push("scoop: -1.5 dB @ 320 Hz (low-mid notch)");
  }

  // ── Pop production (Wave 4): vocal-friendly glue + controlled low-end ───
  // Gentle music-bus compression so vocals sit on top without fighting, and
  // a high-pass on the music (not the bass) so the sub stays clean. Merges
  // with tone-tilt EQs on the same instances (disjoint params) and with the
  // vocal pocket above (different bands/purposes).
  if (popSong) {
    decisions.push({
      target: "chords",
      effectType: "compressor",
      params: { threshold: -16, ratio: 3, attack: 0.01, makeup: 1.5 },
    });
    decisions.push({
      target: "lead",
      effectType: "compressor",
      params: { threshold: -16, ratio: 3, attack: 0.01, makeup: 1.5 },
    });
    decisions.push({ target: "chords", effectType: "eq", params: { hpFreq: 40 } });
    decisions.push({ target: "lead", effectType: "eq", params: { hpFreq: 40 } });
    summary.push("pop: vocal glue + low-end control");
  }

  // ── Pocket: leave room for the singer (V2 vocal-driven form) ───────────
  // Two layers with different failure modes, both additive:
  // 1. Static high-mid dip (~2.8 kHz) on the music — universal, works even
  //    without AudioWorklets (native EQ). Also lowers what the solver sees,
  //    so the dynamic stage triggers less aggressively on top of it.
  // 2. VLYX ecosystem unmask on chords/lead, keyed by every other ultina
  //    instance through the SpectralRegistry (max-per-band aggregate). A
  //    default (all-off) ultina rides on the vocal track as a pure
  //    publisher — sonically neutral (all stages off), publishing the clean
  //    vocal spectrum. No sidechainTrackId wiring is involved (the ultina
  //    node exposes a single input; the ecosystem IS the bus).
  // Without worklets the unmask stage sits inert and the dip carries the
  // pocket alone; without installed takes the publisher resolves to nothing.
  if (options.vocalPresent) {
    const pocket = { highMidFreq: 2800, highMidGain: -2.5, highMidQ: 1.2 };
    decisions.push({ target: "chords", effectType: "eq", params: { ...pocket } });
    decisions.push({ target: "lead", effectType: "eq", params: { ...pocket } });
    const unmask = { "unmask.enabled": 1, "unmask.ecosystemEnabled": 1, "unmask.amount": 50 };
    decisions.push({ target: "chords", effectType: "ultina", params: { ...unmask } });
    decisions.push({ target: "lead", effectType: "ultina", params: { ...unmask } });
    decisions.push({ target: "vocal", effectType: "ultina", params: {} });
    summary.push("pocket: vocal space (high-mid dip + VLYX ecosystem unmask)");
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

  // ── Master loudness + glue (Phase 2 slice 3) ────────────────────────────
  // The artist signature carries the artist's MASTERED integrated loudness
  // (e.g. -7 for a modern loud-master, -13 for character-over-loudness).
  // The project ships every generated song at SONG_LOUDNESS_TARGET_LUFS
  // (-14, streaming) and the song builder refuses to trim more than
  // SONG_LOUDNESS_TRIM_LIMIT_DB (6) — so the artist signal is applied as a
  // BOUNDED OFFSET from that target rather than as a raw replacement:
  //
  //   lift = clamp(artistLufs - streamingTarget, 0, TRIM_LIMIT)
  //   target = streamingTarget + lift
  //
  // A loud artist (Travis Scott -7) is 7 dB above the streaming target, so
  // the lift clamps to the 6 dB the song builder already allows and the
  // master lands at -8, never at -7: the cap keeps exports inside the
  // streaming band the product already guarantees, while still giving real
  // per-artist differentiation. An artist AT or BELOW the streaming target
  // (J Dilla -13 and quieter) contributes no lift and leaves the project
  // default untouched.
  let masterLufsTarget: number | undefined;
  const artistLufs = artistMix?.lufs;
  if (artistLufs !== undefined && Number.isFinite(artistLufs)) {
    const lift = Math.max(0, Math.min(SONG_LOUDNESS_TRIM_LIMIT_DB, artistLufs - SONG_LOUDNESS_TARGET_LUFS));
    if (lift > 0) {
      masterLufsTarget = Math.round((SONG_LOUDNESS_TARGET_LUFS + lift) * 10) / 10;
      summary.push(`master loudness ${masterLufsTarget} LUFS (artist ${artistLufs})`);
    }
  }

  // Master buss glue: loud-master / heavily-limited artists engage the
  // SSL-style 2:1, character-over-loudness artists bypass it. undefined
  // leaves the project's own setting alone.
  const masterGlueEnabled = artistMix?.glue;
  if (masterGlueEnabled !== undefined) {
    summary.push(`master glue ${masterGlueEnabled ? "engaged" : "bypassed"}`);
  }

  return { decisions, summary, masterTiltDb, masterLufsTarget, masterGlueEnabled };
}

/** Resolve a mix target to concrete track ids in THIS document. */
function trackIdsForTarget(doc: ProjectDocument, target: MixTarget): string[] {
  if (target === "drums") {
    return doc.tracks.filter((track) => track.kind === "drum").map((track) => track.id);
  }
  if (target === "vocal") {
    // Tracks carrying arrangement audio (the singer's takes) — resolved from
    // clip bindings, never from names. Empty when no take is installed, in
    // which case vocal decisions apply to nothing (graceful, never a throw).
    const clipTrackIds = new Set((doc.arrangement.audioClips ?? []).map((clip) => clip.trackId));
    return doc.tracks.filter((track) => clipTrackIds.has(track.id)).map((track) => track.id);
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
  // Pump instances touched by this application (for the per-section ride below).
  const rides: Array<{ trackId: string; fxId: string; baseAmount: number }> = [];

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
      if (decision.effectType === "pump") {
        // Read back from the cursor (not the stale fx ref): the param loop
        // above may have just set the profile value on a fresh instance.
        const applied = cursor.tracks
          .find((track) => track.id === trackId)
          ?.effects.find((effect) => effect.id === fx.id);
        const baseAmount = clampEffectParam("pump", "amount", applied?.params.amount ?? decision.params.amount ?? 0.5);
        if (!rides.some((ride) => ride.trackId === trackId && ride.fxId === fx.id)) {
          rides.push({ trackId, fxId: fx.id, baseAmount });
        }
      }
    }
  }

  // Per-section pump ride (QA-3): pump instances installed by THIS profile
  // follow scene intensity — drops pump harder, breaks breathe. One lane per
  // (track, pump, scene): value = profile amount × (0.7 + 0.6 × intensity),
  // neutral (×1.0) at intensity 0.5. Lane ids are deterministic, so a second
  // identical apply finds them equal and still throws "changed nothing".
  if (rides.length > 0 && doc.scenes.length > 0) {
    const touchedFx = new Set(rides.map((ride) => ride.fxId));
    const expected: SceneAutomation[] = [];
    for (const ride of rides) {
      for (const scene of doc.scenes) {
        const intensity = clamp01(typeof scene.intensity === "number" ? scene.intensity : 0.5);
        const value =
          Math.round(clampEffectParam("pump", "amount", ride.baseAmount * (0.7 + 0.6 * intensity)) * 1000) / 1000;
        expected.push({
          id: `sceneAuto-${ride.fxId}-amount-${scene.id}`,
          sceneId: scene.id,
          target: { kind: "fxParam", trackId: ride.trackId, fxId: ride.fxId, paramId: "amount" },
          points: [{ tick: 0, value }],
        });
      }
    }
    const kept = cursor.sceneAutomation.filter(
      (lane) =>
        !(lane.target.kind === "fxParam" && lane.target.paramId === "amount" && touchedFx.has(lane.target.fxId ?? "")),
    );
    const merged = [...kept, ...expected];
    if (JSON.stringify(merged) !== JSON.stringify(cursor.sceneAutomation)) {
      cursor = { ...cursor, sceneAutomation: merged };
      labelParts.push("scene pump ride");
      updates += 1;
    }
  }

  if (
    updates === 0 &&
    profile.masterTiltDb === undefined &&
    profile.masterLufsTarget === undefined &&
    profile.masterGlueEnabled === undefined
  )
    throw new Error("Mix profile changed nothing — the mix already matches");

  // Master tilt rides the same undoable snapshot as the track effects.
  if (profile.masterTiltDb !== undefined && cursor.master.tiltDb !== profile.masterTiltDb) {
    cursor = {
      ...cursor,
      master: { ...cursor.master, tiltDb: profile.masterTiltDb },
    };
    labelParts.push("master tilt");
  }

  // Master loudness target (Phase 2 slice 3) — the artist's bounded LUFS
  // lift, applied to master.lufsTarget. The offline render and the master
  // meter both read this field, so the artist signal is visible end to end.
  if (profile.masterLufsTarget !== undefined && cursor.master.lufsTarget !== profile.masterLufsTarget) {
    cursor = {
      ...cursor,
      master: { ...cursor.master, lufsTarget: profile.masterLufsTarget },
    };
    labelParts.push("master loudness");
  }

  // Master buss glue (Phase 2 slice 3) — the artist signature's glue
  // decision. Written last so a signature carrying both signals still
  // records both in one undo step.
  if (profile.masterGlueEnabled !== undefined && cursor.master.glueEnabled !== profile.masterGlueEnabled) {
    cursor = {
      ...cursor,
      master: { ...cursor.master, glueEnabled: profile.masterGlueEnabled },
    };
    labelParts.push("master glue");
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
  /**
   * "more"/"less" turn the primary knob RELATIVE; "remove" takes the
   * instance out; "set" is ABSOLUTE — percent IS the knob's target as a
   * fraction of its own range ("set reverb mix to 25%" → mix 0.25 on a
   * 0..1 knob).
   */
  direction: "more" | "less" | "remove" | "set";
  amount: "subtle" | "medium" | "huge";
  /**
   * Explicit percent ("o 20 %") — fraction of the knob's own range in the
   * parsed direction. For direction "set" it is the absolute target level.
   */
  percent?: number;
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
  // PREFIX stems (no trailing \b) — SK/EN inflections ride on the stem
  // ("reverbu", "delayu", "chorusu"…). Anchor \b at the start only.
  [/\breverb|\bdozvuk|\bozven/, "reverb"],
  [/\bdelay|\bdekou/, "delay"],
  [/\bdistort|\bsaturat|\bdriv/, "saturation"],
  [/\bchorus|\bkorus/, "chorus"],
  [/\bflanger/, "flanger"],
  [/\bphaser|\bfazer/, "phaser"],
  [/\btremolo/, "tremolo"],
  [/\bbitcrush|\bcrush/, "bitcrusher"],
  [/\bcompress|\bkompres/, "compressor"],
  [/\bsidechain|\bpump(?:a|e|u)?/, "pump"],
  [/\beq\b|\bfilter|\bfiltr|\bekvaliz/, "eq"],
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
  [/\bbass\w*|\bbas(?:a|u|y|i|ou|ov|om)?\b|\b808\w*/, "bass"],
  [/\bchord|\bakord|\bpad/, "chords"],
  [/\blead(?:e|om|u|a)?\b|\bmelod/, "lead"],
  [/\bvocals?\b|\bvok\u00e1l/i, "vocal"],
];

/** De-accented lowercase with boundary padding — shared by all scanners. */
function deaccentLower(text: string): string {
  return ` ${text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")} `;
}

function effectWordIn(lower: string): EffectType | null {
  for (const [re, type] of EFFECT_WORDS) {
    if (re.test(lower)) return type;
  }
  return null;
}

/**
 * True when the text names a param of this effect that is NOT the intent
 * knob ("set delay time to 375" names `time`, the knob is `mix`) — the
 * engine must not silently retune a different knob than the one asked for.
 * Only simple lowercase ids can match as words ("lowShelfGain" never is).
 */
function namesForeignKnob(lower: string, effectType: EffectType): boolean {
  const knob = EFFECT_KNOB[effectType];
  return EFFECT_META[effectType].params.some((param: { id: string }) => {
    if (param.id === knob || !/^[a-z][a-z0-9]*$/.test(param.id) || param.id.length < 3) return false;
    return new RegExp(`\\b${param.id}\\b`).test(lower);
  });
}

const SET_VALUE = /\b(?:to|na)\s*(\d{1,3})\s*(?:%|percent\w*|procent\w*)/;

/** Parse a TARGETED effect request. Null when no effect×sentence is present. */
export function parseEffectIntent(text: string): EffectIntent | null {
  const lower = deaccentLower(text);
  const effectType = effectWordIn(lower);
  if (!effectType) return null;

  // remove wins over add (explicit "remove X" / "bez X" / "menej X")
  let direction: EffectIntent["direction"] = "more";
  if (
    /\bremove\b|\btake out\b|\bodstran|\bvyhod|\bbez (?:delay|reverb|ozven|dozvuk|pump|chorus|filtr|eq)\w*|\bmenej (?:delay|dozvuk|ozven)/.test(
      lower,
    )
  ) {
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
    if (new RegExp(`\\b${role}\\b`).test(lower)) {
      for (const target of expanded) targets.add(target);
    }
  }
  // No target word/role ⇒ NOT a targeted effect intent — generic "more
  // reverb" belongs to the mix profile, not a track-scoped change.
  if (targets.size === 0) return null;

  // ABSOLUTE SET ("set the lead reverb mix to 25%", "nastav reverb na basi
  // na 25 %") — v1 addresses only the effect's primary knob, and the number
  // is a fraction of THAT knob's range (mix 0..1 → 25 % = 0.25). Requires
  // an explicit percent word ("set delay time to 375" must never touch the
  // mix knob) and declines when the text names a DIFFERENT param — the
  // engine does not guess which knob was meant.
  if (/\bset\b|\bnastav\b/.test(lower)) {
    const setValue = SET_VALUE.exec(lower);
    if (setValue) {
      if (namesForeignKnob(lower, effectType)) return null;
      const percent = Math.max(0, Math.min(100, Number(setValue[1])));
      return {
        effectType,
        targets: [...targets],
        direction: "set",
        amount: "medium",
        percent,
        detected: [`set ${effectType} → ${percent}%`, `→ ${[...targets].join("+")}`],
      };
    }
  }

  let amount: EffectIntent["amount"] = "medium";
  if (/\bsubtle\b|\btrochu\b|\bmalicko/.test(lower)) amount = "subtle";
  else if (/\bhuge\b|\ba lot\b|\bobri\b|\bvela\b|\bvelmi/.test(lower)) amount = "huge";

  // Explicit numbers beat vibe words ("o 20 %" wins over "trochu").
  const percent = parsePercent(text);
  const detected = [`${direction} ${effectType}`, `→ ${[...targets].join("+")}`];
  if (percent != null) detected.push(`${percent}%`);
  else if (amount !== "medium") detected.push(amount);
  return { effectType, targets: [...targets], direction, amount, ...(percent != null ? { percent } : {}), detected };
}

const AMOUNT_SCALE: Record<EffectIntent["amount"], number> = { subtle: 0.5, medium: 1, huge: 1.75 };

/** The knob delta for one targeted adjustment (pre-clamp). */
export function effectKnobDelta(intent: EffectIntent): number {
  if (intent.direction === "set") return 0; // absolute — no delta
  const scale = AMOUNT_SCALE[intent.amount];
  const base = 0.16 * scale;
  return intent.direction === "more" ? base : -base;
}

/* sentinel-test */

/** Per-effect knob delta multipliers for targeted requests (pre-clamp). */
const TARGETED_KNOB_DELTA: Partial<Record<EffectType, number>> = {
  eq: 2, // dB on shelf gains
  compressor: 2, // ratio turns
};

/**
 * Apply a TARGETED effect request as ONE undoable command: add the effect to
 * each target track if missing, turn its knob by the parsed amount/direction
 * (clamped against the effect's own param defs), or REMOVE it on direction
 * "remove". Effects whose knob the intent does not know are skipped.
 */
export function applyEffectIntent(doc: ProjectDocument, intent: EffectIntent): ReturnType<typeof snapshot> {
  const knob = EFFECT_KNOB[intent.effectType];
  if (!knob) {
    throw new Error(`no knob mapped for effect "${intent.effectType}" — intent understood, effect unsupported`);
  }
  const scale = AMOUNT_SCALE[intent.amount];
  const trackIds = intent.targets.flatMap((target) => trackIdsForTarget(doc, target));
  if (trackIds.length === 0) {
    throw new Error(`no tracks match the target (${intent.targets.join(", ")})`);
  }

  let cursor = doc;
  let updates = 0;
  const parts: string[] = [];

  for (const trackId of trackIds) {
    if (intent.direction === "remove") {
      if (cursor.tracks.find((track) => track.id === trackId)?.effects.some((fx) => fx.type === intent.effectType)) {
        cursor = removeEffectFromTracks(cursor, [trackId], intent.effectType).execute(cursor);
        parts.push(`−${intent.effectType}`);
        updates += 1;
      }
      continue;
    }
    let fx = cursor.tracks.find((track) => track.id === trackId)?.effects.find((fx) => fx.type === intent.effectType);
    if (!fx) {
      cursor = addEffectToTracks(cursor, [trackId], intent.effectType).execute(cursor);
      fx = cursor.tracks
        .find((track) => track.id === trackId)
        ?.effects.find((effect) => effect.type === intent.effectType);
      if (!fx) continue;
      parts.push(`+${intent.effectType}`);
      updates += 1;
    }
    const knobDef = EFFECT_META[intent.effectType].params.find((param: { id: string }) => param.id === knob);
    if (!knobDef) continue;
    if (intent.direction === "set") {
      // SET: percent is ABSOLUTE — the knob lands at min + pct·range.
      const value = knobDef.min + ((intent.percent ?? 0) / 100) * (knobDef.max - knobDef.min);
      const clamped = clampEffectParam(intent.effectType, knob, value);
      if (fx.params[knob] !== clamped) {
        cursor = setEffectParam(cursor, trackId, fx.id, knob, clamped).execute(cursor);
        parts.push(`${intent.effectType}=${Math.round(clamped * 100) / 100}`);
        updates += 1;
      }
      continue;
    }
    const base = fx.params[knob] ?? knobDef.default;
    // Percent = fraction of the knob's own range ("o 20 %" turns mix by a
    // fifth); vibe amounts keep the calibrated fixed steps.
    const range = knobDef.max - knobDef.min;
    const step =
      intent.percent != null
        ? (intent.percent / 100) * range
        : (TARGETED_KNOB_DELTA[intent.effectType] ?? 0.16 * range * 0.25) * scale;
    const value = intent.direction === "more" ? base + step : base - step;
    const clamped = clampEffectParam(intent.effectType, knob, value);
    if (fx.params[knob] === clamped) continue;
    cursor = setEffectParam(cursor, trackId, fx.id, knob, clamped).execute(cursor);
    updates += 1;
  }

  if (updates === 0) throw new Error("effect intent changed nothing — the mix already matches");

  const scaleNote =
    intent.direction === "set" ? `= ${intent.percent}%` : intent.percent != null ? `±${intent.percent}%` : `×${scale}`;
  return snapshot(
    "applyEffectIntent",
    `Effect: ${[...parts, `${intent.effectType} ${intent.direction} ${scaleNote}`].join(", ")}`,
    doc,
    cursor,
  );
}

/**
 * VERIFICATION READ-BACK — the knob's ACTUAL landing value per target track,
 * read from the post-execution document (clamps included). "mix 0.20→0.36 on
 * Lead" proves the instance exists and the param really moved; dispatch
 * alone proves nothing. Removals report the instance gone.
 */
export function effectReadback(before: ProjectDocument, after: ProjectDocument, intent: EffectIntent): string {
  const knob = EFFECT_KNOB[intent.effectType];
  if (!knob) return "";
  const knobDef = EFFECT_META[intent.effectType].params.find((param: { id: string }) => param.id === knob);
  const fmt = (value: number): number => Math.round(value * 100) / 100;
  const entries: string[] = [];
  for (const target of intent.targets) {
    for (const trackId of trackIdsForTarget(after, target)) {
      const track = after.tracks.find((candidate) => candidate.id === trackId);
      if (!track) continue;
      if (intent.direction === "remove") {
        if (!track.effects.some((fx) => fx.type === intent.effectType)) {
          entries.push(`−${intent.effectType} on ${track.name}`);
        }
        continue;
      }
      const fx = track.effects.find((effect) => effect.type === intent.effectType);
      if (!fx) continue;
      const beforeFx = before.tracks
        .find((candidate) => candidate.id === trackId)
        ?.effects.find((effect) => effect.type === intent.effectType);
      const prev = beforeFx?.params[knob] ?? knobDef?.default ?? 0;
      entries.push(`${knob} ${fmt(prev)}→${fmt(fx.params[knob])} on ${track.name}`);
    }
  }
  if (entries.length > 3) return `${entries.slice(0, 3).join(", ")} +${entries.length - 3}`;
  return entries.join(", ");
}

// ── CLARIFICATION: nearest interpretation for DECLINED effect asks ──────────

/** Words that signal an explicit direction/set ask (vs a plain prompt). */
const DIRECTION_WORD =
  /\bmore\b|\bless\b|\bremove\b|\bset\b|\badd\b|\bviac\b|\bmenej\b|\bodstran\w*|\bvyhod\w*|\bpridaj\w*|\bdaj\b/;

export interface DeclinedIntentClarification {
  reason: string;
  /** Canonical, EXECUTABLE phrasings — each re-routes to a working intent. */
  suggestions: string[];
}

/**
 * Probe for effect asks the parser had to decline: an effect noun plus a
 * direction word, but no resolvable track target, or a named parameter the
 * intent layer cannot address. Returns canonical suggestions instead of
 * letting the text fall to pattern generation. Null when the text does not
 * look like a declined effect ask.
 */
export function declinedEffectClarification(text: string): DeclinedIntentClarification | null {
  const lower = deaccentLower(text);
  const effectType = effectWordIn(lower);
  if (!effectType || !DIRECTION_WORD.test(lower)) return null;
  const knob = EFFECT_KNOB[effectType] ?? "mix";
  if (namesForeignKnob(lower, effectType)) {
    return {
      reason: `efekt „${effectType}" má parameter, ktorý intent neovláda — motor vie nastaviť primárny knob „${knob}"`,
      suggestions: [`set ${effectType} ${knob} to 50% on the lead`],
    };
  }
  const setValue = SET_VALUE.exec(lower);
  const isSet = /\bset\b|\bnastav\b/.test(lower) && setValue !== null;
  const pct = isSet && setValue ? Math.min(100, Number(setValue[1])) : 50;
  const wantsRemove = /\bremove\b|\btake out\b|\bodstran|\bvyhod|\bbez\b/.test(lower);
  const less = /\bless\b|\bmenej\b/.test(lower);
  const ask = (target: string) =>
    isSet
      ? `set ${effectType} ${knob} to ${pct}% on the ${target}`
      : wantsRemove
        ? `remove ${effectType} from the ${target}`
        : `${less ? "less" : "more"} ${effectType} on the ${target}`;
  return {
    reason: `na ktorý track má smerovať ${effectType}?`,
    suggestions: ["drums", "bass", "chords", "lead"].map(ask),
  };
}
