import type {
  ArrangementTransitionType,
  EffectType,
  InstrumentTrack,
  Marker,
  MusicalKey,
  Pattern,
  ProjectDocument,
  SceneRole,
} from "../project-model/types";
import { BAR_TICKS } from "../project-model/types";
import { normalizeIntent, intentFromGenerateOptions } from "./normalize";
import { generateOptionsFromIntent } from "./plan";
import { generateLocalResult } from "./pipeline";
import { applyTransitionToPattern } from "./transitions";
import { buildTransitionCueClips, FX_CUE_TRACK_NAME, transitionCueAsset, type TransitionSeam } from "./transition-cues";
import { applyGenreKitToDoc } from "./genre-kit";
import { genreMasterTiltDb } from "./mix";
import { GENRE_REFERENCE, SONG_LOUDNESS_TARGET_LUFS, SONG_LOUDNESS_TRIM_LIMIT_DB } from "./genre-reference.generated";
import type { Command } from "../commands/types";
import { addEffect, setBeatManglerSteps, setEffectParam, snapshot, trackEffectsOf } from "../commands/commands";
import { createInstrumentTrackModel, sceneRoleOf } from "../project-model/schema";
import type { IntentInput, IntentRole, IntentSpec } from "./types";
import {
  planProductionActions,
  resolveProductionTargets,
  type ProductionAction,
  type ProductionIntent,
} from "./production";
import { applySectionRequests, type SectionParse } from "./sections";
import { EFFECT_META } from "../effects/definitions";

/**
 * SONG BUILDER (INTENT_ENGINE.md A2) — one intent → a whole arranged song.
 *
 * "dark rolling techno at 140" becomes intro → build → drop → break → build
 * → drop → outro: each section is its own generated pattern (same genre /
 * style / key, seed-derived siblings so sections feel RELATED but not
 * identical), with role-appropriate energy/density deltas, its own scene
 * (role + intensity), a contiguous clip, markers and transitions — installed
 * as ONE undoable command.
 *
 * Split follows the command-etiquette rule (commands never generate):
 * `buildSong()` runs the generation (async, yields between sections so the
 * UI can show progress) and returns a serializable SongBuild;
 * `applySongCommand(doc, build)` installs it as one snapshot.
 */

/** One section of the planned song form. */
export interface SongSectionSpec {
  role: SceneRole;
  label: string;
  bars: number;
  intensity: number;
  marker?: { type: Marker["type"]; name: string };
  transitionIn?: ArrangementTransitionType | null;
  /** Absolute 0..1 deltas applied on top of the base intent sliders. */
  energyDelta: number;
  densityDelta: number;
  complexityDelta: number;
  /**
   * A2 v2 — "ako má vyzerať": which generation roles PLAY in this section.
   * Intersected with the user's intent roles at build time, so an intro is
   * drums+bass only, a break strips to chords+lead, a chorus is full — the
   * arrangement is instrumentation, not just louder/quieter.
   */
  instrumentation: IntentRole[];
  /**
   * Wave 3 — an FX request scoped to THIS section ("vinyl break"). The
   * effect chain is installed on the section's target track and gated to
   * this section via sceneAutomation on its mix param.
   */
  fx?: ProductionIntent | null;
}

/** Per-genre song forms (bar counts + arrangement furniture). */
const SONG_FORMS: Record<IntentSpec["genre"], SongSectionSpec[]> = {
  house: [
    {
      role: "intro",
      label: "Intro",
      bars: 8,
      intensity: 0.4,
      transitionIn: null,
      energyDelta: -0.25,
      densityDelta: -0.15,
      complexityDelta: -0.1,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "build",
      label: "Build A",
      bars: 4,
      intensity: 0.6,
      marker: { type: "buildup", name: "BUILD A" },
      transitionIn: null,
      energyDelta: 0,
      densityDelta: 0,
      complexityDelta: 0,
      instrumentation: ["drums", "bass", "chords"],
    },
    {
      role: "drop",
      label: "Drop A",
      bars: 8,
      intensity: 0.9,
      marker: { type: "drop", name: "DROP A" },
      transitionIn: "riser",
      energyDelta: 0.3,
      densityDelta: 0.3,
      complexityDelta: 0.1,
      instrumentation: ["drums", "bass", "chords", "lead"],
    },
    {
      role: "break",
      label: "Break",
      bars: 4,
      intensity: 0.35,
      marker: { type: "cue", name: "BREAK" },
      transitionIn: "break",
      energyDelta: -0.35,
      densityDelta: -0.25,
      complexityDelta: 0,
      instrumentation: ["chords", "lead"],
    },
    {
      role: "build",
      label: "Build B",
      bars: 4,
      intensity: 0.65,
      marker: { type: "buildup", name: "BUILD B" },
      transitionIn: "fill",
      energyDelta: 0.05,
      densityDelta: 0.05,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "chords"],
    },
    {
      role: "drop",
      label: "Drop B",
      bars: 8,
      intensity: 0.95,
      marker: { type: "drop", name: "DROP B" },
      transitionIn: "riser",
      energyDelta: 0.35,
      densityDelta: 0.35,
      complexityDelta: 0.1,
      instrumentation: ["drums", "bass", "chords", "lead"],
    },
    {
      role: "outro",
      label: "Outro",
      bars: 8,
      intensity: 0.5,
      transitionIn: "break",
      energyDelta: -0.2,
      densityDelta: -0.1,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
  ],
  techno: [
    {
      role: "intro",
      label: "Intro",
      bars: 8,
      intensity: 0.45,
      transitionIn: null,
      energyDelta: -0.2,
      densityDelta: -0.2,
      complexityDelta: -0.1,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "build",
      label: "Build A",
      bars: 4,
      intensity: 0.65,
      marker: { type: "buildup", name: "BUILD A" },
      transitionIn: null,
      energyDelta: 0,
      densityDelta: 0,
      complexityDelta: 0,
      instrumentation: ["drums", "bass", "chords"],
    },
    {
      role: "drop",
      label: "Drop A",
      bars: 8,
      intensity: 0.9,
      marker: { type: "drop", name: "DROP A" },
      transitionIn: "riser",
      energyDelta: 0.3,
      densityDelta: 0.3,
      complexityDelta: 0.1,
      instrumentation: ["drums", "bass", "chords", "lead"],
    },
    {
      role: "break",
      label: "Break",
      bars: 4,
      intensity: 0.4,
      marker: { type: "cue", name: "BREAK" },
      transitionIn: "break",
      energyDelta: -0.3,
      densityDelta: -0.3,
      complexityDelta: 0,
      instrumentation: ["chords", "lead"],
    },
    {
      role: "build",
      label: "Build B",
      bars: 4,
      intensity: 0.7,
      marker: { type: "buildup", name: "BUILD B" },
      transitionIn: "fill",
      energyDelta: 0.05,
      densityDelta: 0,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "chords"],
    },
    {
      role: "drop",
      label: "Drop B",
      bars: 8,
      intensity: 0.95,
      marker: { type: "drop", name: "DROP B" },
      transitionIn: "riser",
      energyDelta: 0.35,
      densityDelta: 0.3,
      complexityDelta: 0.1,
      instrumentation: ["drums", "bass", "chords", "lead"],
    },
    {
      role: "outro",
      label: "Outro",
      bars: 8,
      intensity: 0.5,
      transitionIn: "break",
      energyDelta: -0.2,
      densityDelta: -0.15,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
  ],
  trap: [
    // POP FORM (A2 v2): beats for vocals live in verse/chorus/bridge logic.
    {
      role: "intro",
      label: "Intro",
      bars: 4,
      intensity: 0.4,
      transitionIn: null,
      energyDelta: -0.25,
      densityDelta: -0.15,
      complexityDelta: -0.1,
      instrumentation: ["drums"],
    },
    {
      role: "verse",
      label: "Verse 1",
      bars: 8,
      intensity: 0.6,
      transitionIn: "fill",
      energyDelta: -0.05,
      densityDelta: -0.05,
      complexityDelta: 0,
      instrumentation: ["drums", "bass", "chords"],
    },
    {
      role: "chorus",
      label: "Chorus 1",
      bars: 8,
      intensity: 0.9,
      marker: { type: "impact", name: "CHORUS 1" },
      transitionIn: "riser",
      energyDelta: 0.3,
      densityDelta: 0.25,
      complexityDelta: 0.1,
      instrumentation: ["drums", "bass", "chords", "lead"],
    },
    {
      role: "verse",
      label: "Verse 2",
      bars: 8,
      intensity: 0.65,
      transitionIn: "fill",
      energyDelta: 0,
      densityDelta: 0,
      complexityDelta: 0,
      instrumentation: ["drums", "bass", "chords"],
    },
    {
      role: "chorus",
      label: "Chorus 2",
      bars: 8,
      intensity: 0.9,
      marker: { type: "impact", name: "CHORUS 2" },
      transitionIn: "riser",
      energyDelta: 0.3,
      densityDelta: 0.25,
      complexityDelta: 0.1,
      instrumentation: ["drums", "bass", "chords", "lead"],
    },
    {
      role: "bridge",
      label: "Bridge",
      bars: 4,
      intensity: 0.35,
      marker: { type: "cue", name: "BRIDGE" },
      transitionIn: "break",
      energyDelta: -0.35,
      densityDelta: -0.25,
      complexityDelta: 0.05,
      instrumentation: ["chords", "lead"],
    },
    {
      role: "chorus",
      label: "Chorus 3",
      bars: 8,
      intensity: 0.95,
      marker: { type: "impact", name: "CHORUS 3" },
      transitionIn: "fill",
      energyDelta: 0.35,
      densityDelta: 0.3,
      complexityDelta: 0.1,
      instrumentation: ["drums", "bass", "chords", "lead"],
    },
    {
      role: "outro",
      label: "Outro",
      bars: 4,
      intensity: 0.5,
      transitionIn: "break",
      energyDelta: -0.2,
      densityDelta: -0.1,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
  ],
  ambient: [
    {
      role: "intro",
      label: "Emergence",
      bars: 8,
      intensity: 0.3,
      transitionIn: null,
      energyDelta: -0.2,
      densityDelta: -0.15,
      complexityDelta: -0.1,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "build",
      label: "Swell",
      bars: 8,
      intensity: 0.55,
      marker: { type: "buildup", name: "SWELL" },
      transitionIn: null,
      energyDelta: 0,
      densityDelta: 0,
      complexityDelta: 0,
      instrumentation: ["drums", "bass", "chords"],
    },
    {
      role: "drop",
      label: "Peak",
      bars: 8,
      intensity: 0.8,
      marker: { type: "drop", name: "PEAK" },
      transitionIn: "riser",
      energyDelta: 0.2,
      densityDelta: 0.2,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "chords", "lead"],
    },
    {
      role: "break",
      label: "Stillness",
      bars: 8,
      intensity: 0.3,
      marker: { type: "cue", name: "STILL" },
      transitionIn: "break",
      energyDelta: -0.25,
      densityDelta: -0.2,
      complexityDelta: 0,
      instrumentation: ["chords", "lead"],
    },
    {
      role: "outro",
      label: "Dissolve",
      bars: 8,
      intensity: 0.35,
      transitionIn: "break",
      energyDelta: -0.15,
      densityDelta: -0.1,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
  ],
  drill: [
    // POP FORM, drill dialect: half-time verses, hook lands with impact+riser.
    {
      role: "intro",
      label: "Intro",
      bars: 4,
      intensity: 0.4,
      transitionIn: null,
      energyDelta: -0.25,
      densityDelta: -0.15,
      complexityDelta: -0.1,
      instrumentation: ["drums"],
    },
    {
      role: "verse",
      label: "Verse 1",
      bars: 8,
      intensity: 0.6,
      transitionIn: "fill",
      energyDelta: -0.05,
      densityDelta: 0,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "chorus",
      label: "Hook 1",
      bars: 8,
      intensity: 0.85,
      marker: { type: "impact", name: "HOOK 1" },
      transitionIn: "riser",
      energyDelta: 0.15,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "verse",
      label: "Verse 2",
      bars: 8,
      intensity: 0.6,
      transitionIn: "fill",
      energyDelta: -0.05,
      densityDelta: 0,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "chorus",
      label: "Hook 2",
      bars: 8,
      intensity: 0.85,
      marker: { type: "impact", name: "HOOK 2" },
      transitionIn: "drop",
      energyDelta: 0.15,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "bridge",
      label: "Bridge",
      bars: 4,
      intensity: 0.4,
      marker: { type: "cue", name: "BRIDGE" },
      transitionIn: "break",
      energyDelta: -0.2,
      densityDelta: -0.15,
      complexityDelta: 0,
      instrumentation: ["chords", "lead"],
    },
    {
      role: "chorus",
      label: "Hook 3",
      bars: 8,
      intensity: 0.9,
      marker: { type: "impact", name: "HOOK 3" },
      transitionIn: "riser",
      energyDelta: 0.2,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "outro",
      label: "Outro",
      bars: 4,
      intensity: 0.35,
      transitionIn: "break",
      energyDelta: -0.15,
      densityDelta: -0.1,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
  ],
  phonk: [
    // POP FORM, memphis dialect: cowbell hooks, tape-drop into hook 2.
    {
      role: "intro",
      label: "Intro",
      bars: 4,
      intensity: 0.4,
      transitionIn: null,
      energyDelta: -0.25,
      densityDelta: -0.15,
      complexityDelta: -0.1,
      instrumentation: ["drums"],
    },
    {
      role: "verse",
      label: "Verse 1",
      bars: 8,
      intensity: 0.6,
      transitionIn: "fill",
      energyDelta: -0.05,
      densityDelta: 0,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "chorus",
      label: "Hook 1",
      bars: 8,
      intensity: 0.85,
      marker: { type: "impact", name: "HOOK 1" },
      transitionIn: "riser",
      energyDelta: 0.15,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "verse",
      label: "Verse 2",
      bars: 8,
      intensity: 0.6,
      transitionIn: "fill",
      energyDelta: -0.05,
      densityDelta: 0,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "chorus",
      label: "Hook 2",
      bars: 8,
      intensity: 0.85,
      marker: { type: "impact", name: "HOOK 2" },
      transitionIn: "drop",
      energyDelta: 0.15,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "bridge",
      label: "Bridge",
      bars: 4,
      intensity: 0.4,
      marker: { type: "cue", name: "BRIDGE" },
      transitionIn: "break",
      energyDelta: -0.2,
      densityDelta: -0.15,
      complexityDelta: 0,
      instrumentation: ["chords", "lead"],
    },
    {
      role: "chorus",
      label: "Hook 3",
      bars: 8,
      intensity: 0.9,
      marker: { type: "impact", name: "HOOK 3" },
      transitionIn: "fill",
      energyDelta: 0.2,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "outro",
      label: "Outro",
      bars: 4,
      intensity: 0.35,
      transitionIn: "break",
      energyDelta: -0.15,
      densityDelta: -0.1,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
  ],
  jersey: [
    // CLUB FORM, jersey dialect: shorter sections, triple-kick hooks, the
    // second hook lands via the reverse+boom impact pair.
    {
      role: "intro",
      label: "Intro",
      bars: 4,
      intensity: 0.5,
      transitionIn: null,
      energyDelta: -0.15,
      densityDelta: -0.1,
      complexityDelta: -0.1,
      instrumentation: ["drums"],
    },
    {
      role: "verse",
      label: "Verse 1",
      bars: 8,
      intensity: 0.7,
      transitionIn: "fill",
      energyDelta: 0,
      densityDelta: 0.05,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "chorus",
      label: "Hook 1",
      bars: 8,
      intensity: 0.9,
      marker: { type: "impact", name: "HOOK 1" },
      transitionIn: "riser",
      energyDelta: 0.15,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "verse",
      label: "Verse 2",
      bars: 8,
      intensity: 0.7,
      transitionIn: "fill",
      energyDelta: 0,
      densityDelta: 0.05,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "chorus",
      label: "Hook 2",
      bars: 8,
      intensity: 0.95,
      marker: { type: "impact", name: "HOOK 2" },
      transitionIn: "impact",
      energyDelta: 0.2,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "bridge",
      label: "Bridge",
      bars: 4,
      intensity: 0.45,
      marker: { type: "cue", name: "BRIDGE" },
      transitionIn: "break",
      energyDelta: -0.2,
      densityDelta: -0.15,
      complexityDelta: 0,
      instrumentation: ["chords", "lead"],
    },
    {
      role: "chorus",
      label: "Hook 3",
      bars: 8,
      intensity: 0.95,
      marker: { type: "impact", name: "HOOK 3" },
      transitionIn: "fill",
      energyDelta: 0.2,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "outro",
      label: "Outro",
      bars: 4,
      intensity: 0.4,
      transitionIn: "break",
      energyDelta: -0.15,
      densityDelta: -0.1,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
  ],
  dnb: [
    // DnB dialect: intro → build → DROP. The second drop lands on the
    // reverse-suck + boom pair; the breakdown breathes before the last one.
    {
      role: "intro",
      label: "Intro",
      bars: 8,
      intensity: 0.4,
      transitionIn: null,
      energyDelta: -0.25,
      densityDelta: -0.2,
      complexityDelta: -0.1,
      instrumentation: ["chords", "bass"],
    },
    {
      role: "verse",
      label: "Build 1",
      bars: 8,
      intensity: 0.6,
      marker: { type: "buildup", name: "BUILD 1" },
      transitionIn: "fill",
      energyDelta: 0,
      densityDelta: 0.05,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "chorus",
      label: "Drop 1",
      bars: 8,
      intensity: 0.95,
      marker: { type: "drop", name: "DROP 1" },
      transitionIn: "riser",
      energyDelta: 0.2,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "verse",
      label: "Build 2",
      bars: 8,
      intensity: 0.6,
      marker: { type: "buildup", name: "BUILD 2" },
      transitionIn: "fill",
      energyDelta: 0,
      densityDelta: 0.05,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass"],
    },
    {
      role: "chorus",
      label: "Drop 2",
      bars: 8,
      intensity: 0.95,
      marker: { type: "drop", name: "DROP 2" },
      transitionIn: "impact",
      energyDelta: 0.2,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "bridge",
      label: "Breakdown",
      bars: 8,
      intensity: 0.35,
      marker: { type: "cue", name: "BREAKDOWN" },
      transitionIn: "break",
      energyDelta: -0.25,
      densityDelta: -0.2,
      complexityDelta: 0,
      instrumentation: ["chords", "lead"],
    },
    {
      role: "chorus",
      label: "Drop 3",
      bars: 8,
      intensity: 1.0,
      marker: { type: "drop", name: "DROP 3" },
      transitionIn: "riser",
      energyDelta: 0.25,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums", "bass", "lead"],
    },
    {
      role: "outro",
      label: "Outro",
      bars: 8,
      intensity: 0.4,
      transitionIn: "break",
      energyDelta: -0.2,
      densityDelta: -0.15,
      complexityDelta: 0,
      instrumentation: ["drums", "bass"],
    },
  ],
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Plan the song form for an intent — deterministic (same intent ⇒ same form).
 * Section sliders are the BASE intent shifted by role deltas and clamped.
 */
/**
 * Wave 3 — per-role sound dramaturgy: sections don't just PLAY differently
 * (instrumentation, energy), they SOUND differently. Each recipe installs
 * its effect on the role's track and scopes it to the section via
 * sceneAutomation: `gated` holds a param at `active` inside the section and
 * `neutral` everywhere else (vinyl only in the break); `ramps` sweep a
 * param across the section's bars (the build's filter riser, the outro's
 * filter closing). Lanes are written for EVERY generated scene — the
 * scheduler applies a lane only while its scene is active, so a lane
 * missing from a scene would leak the previous section's value into it.
 */
interface SectionFxRecipe {
  type: EffectType;
  targetRole: "drums" | "bass" | "chords" | "lead";
  /** Static params folded over the effect defaults at install time. */
  params?: Record<string, number>;
  gated?: { paramId: string; active: number; neutral: number }[];
  ramps?: { paramId: string; from: number; to: number; neutral: number }[];
}

const SECTION_FX_RECIPES: Partial<Record<SceneRole, SectionFxRecipe[]>> = {
  intro: [
    // Muffled canvas opening up across the intro.
    {
      type: "svFilter",
      targetRole: "chords",
      params: { mode: 0, resonance: 0.2 },
      ramps: [{ paramId: "cutoff", from: 600, to: 16000, neutral: 16000 }],
    },
  ],
  build: [
    // The riser — music closing, then snapping open at the drop.
    {
      type: "svFilter",
      targetRole: "chords",
      params: { mode: 0, resonance: 0.25 },
      ramps: [{ paramId: "cutoff", from: 300, to: 16000, neutral: 16000 }],
    },
    {
      type: "svFilter",
      targetRole: "bass",
      params: { mode: 0 },
      ramps: [{ paramId: "cutoff", from: 200, to: 9000, neutral: 16000 }],
    },
  ],
  drop: [
    {
      type: "transient",
      targetRole: "drums",
      params: { attack: 0.65, sustain: -0.25 },
      gated: [{ paramId: "mix", active: 1, neutral: 0 }],
    },
  ],
  chorus: [
    {
      type: "transient",
      targetRole: "drums",
      params: { attack: 0.6, sustain: -0.2 },
      gated: [{ paramId: "mix", active: 1, neutral: 0 }],
    },
  ],
  bridge: [
    {
      type: "haasWidener",
      targetRole: "chords",
      params: { delayMs: 14 },
      gated: [{ paramId: "width", active: 0.6, neutral: 0 }],
    },
  ],
  break: [
    {
      type: "vinyl",
      targetRole: "drums",
      params: { amount: 0.7, crackle: 0.5, wow: 0.6, year: 0.7 },
      gated: [{ paramId: "mix", active: 1, neutral: 0 }],
    },
  ],
  outro: [
    // Everything slowly closing down.
    {
      type: "svFilter",
      targetRole: "chords",
      params: { mode: 0 },
      ramps: [{ paramId: "cutoff", from: 16000, to: 500, neutral: 16000 }],
    },
  ],
};

export function planSongForm(
  intent: IntentSpec,
  overrides?: SectionParse,
  length?: SongLengthHint | null,
): {
  genre: IntentSpec["genre"];
  sections: SongSectionSpec[];
  totalBars: number;
} {
  const planned = SONG_FORMS[intent.genre].map((section) => ({
    ...section,
    energyDelta: clamp01(intent.energy + section.energyDelta),
    densityDelta: clamp01(intent.density + section.densityDelta),
    complexityDelta: clamp01(intent.complexity + section.complexityDelta),
  }));
  // Wave 2 — the sentence shapes the form: "16-bar intro", "chorus twice",
  // "no break", "vinyl break". An over-eager request never empties the form
  // (applySectionRequests guards the invariant).
  const sections = overrides ? applySectionRequests(planned, overrides) : planned;
  // #6 dynamic song form — length words ("short", "radio edit", "extended",
  // "epic journey", "3 minutes") scale the form's core cycles to the ask.
  const scaled = length ? applySongLength(sections, length, formBpm(intent)) : sections;
  return {
    genre: intent.genre,
    sections: scaled,
    totalBars: scaled.reduce((sum, section) => sum + section.bars, 0),
  };
}

// ─── #6 DYNAMIC SONG FORM — length words → section plan ─────────────────────

export type SongLengthKind = "short" | "standard" | "radio" | "extended" | "epic" | "exact";

export interface SongLengthHint {
  kind: SongLengthKind;
  /** "exact" mode: requested minutes (clock "2:30" allowed → 2.5). */
  minutes?: number;
  /** Human label for status lines. */
  label: string;
}

/** Genre defaults when the intent carries no bpmRange — centers of the priors. */
const GENRE_DEFAULT_BPM: Record<IntentSpec["genre"], number> = {
  house: 124,
  techno: 132,
  trap: 140,
  ambient: 90,
  drill: 142,
  phonk: 150,
  jersey: 138,
  dnb: 174,
};

function formBpm(intent: IntentSpec): number {
  if (intent.bpmRange) return Math.round((intent.bpmRange[0] + intent.bpmRange[1]) / 2);
  return GENRE_DEFAULT_BPM[intent.genre];
}

/**
 * Length phrases → hint. Exact durations win ("3 minutes", "2:30"), then the
 * named edits. SK stems are DE-ACCENTED (the parser normalizes before match).
 * Pure — same text ⇒ same hint.
 */
export function parseSongLength(text: string): SongLengthHint | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  const clock = /\b(\d{1,2}):(\d{2})\b/.exec(lower);
  if (clock) {
    const minutes = Number(clock[1]) + Number(clock[2]) / 60;
    if (minutes > 0 && minutes <= 20) return { kind: "exact", minutes, label: `${clock[1]}:${clock[2]}` };
  }
  const minutes = /\b(\d{1,2})\s*(?:minutes?|mins?|minut\w*|min)\b/.exec(lower);
  if (minutes) {
    const value = Number(minutes[1]);
    if (value > 0 && value <= 20) return { kind: "exact", minutes: value, label: `${value} min` };
  }
  if (/\bshort(?: version| edit| mix)?\b|\bkratk\w*/.test(lower)) {
    return { kind: "short", label: "short" };
  }
  if (/\bradio(?: edit| version| mix)?\b|\bradiov\w*/.test(lower)) {
    return { kind: "radio", label: "radio edit" };
  }
  if (/\bextended(?: mix| version| edit)?\b|\brozsir\w*/.test(lower)) {
    return { kind: "extended", label: "extended" };
  }
  if (
    /\bepic (?:journey|version|mode)\b|\blong (?:journey|track|version)\b|\bdlh\w* (?:journey|track|verzi)/.test(lower)
  ) {
    return { kind: "epic", label: "epic" };
  }
  return null;
}

const roundBars = (bars: number): number => Math.max(4, Math.round(bars / 4) * 4);

/** Clone a section with a cycle letter appended so labels/markers stay unique. */
function cloneWithCycle(section: SongSectionSpec, cycle: number): SongSectionSpec {
  const letter = String.fromCharCode(64 + cycle); // 1 → "A", 2 → "B", …
  return {
    ...section,
    label: `${section.label} ${letter}`,
    ...(section.marker ? { marker: { ...section.marker, name: `${section.marker.name} ${letter}` } } : {}),
  };
}

/** Core cycle = the FIRST danceable block after the intro (intro excluded,
 *  ends at the next cycle of the same role or at the closing furniture). */
function coreCycle(sections: SongSectionSpec[]): SongSectionSpec[] {
  const start = sections.findIndex((section) => section.role !== "intro");
  if (start < 0) return [];
  const firstRole = sections[start].role;
  let end = start + 1;
  while (
    end < sections.length &&
    sections[end].role !== firstRole &&
    !["break", "bridge", "outro"].includes(sections[end].role)
  ) {
    end += 1;
  }
  return sections.slice(start, end);
}

function insertCoreCycle(sections: SongSectionSpec[], cycle: number): SongSectionSpec[] {
  const cycleSections = coreCycle(sections);
  if (cycleSections.length === 0) return sections;
  const stamped = cycleSections.map((section) => cloneWithCycle(section, cycle));
  // Insert before the first break/bridge/outro — or before the outro at the end.
  let insertAt = sections.findIndex(
    (section, index) => index > 0 && ["break", "bridge", "outro"].includes(section.role),
  );
  if (insertAt < 0) insertAt = sections.length - 1;
  return [...sections.slice(0, insertAt), ...stamped, ...sections.slice(insertAt)];
}

/**
 * Scale the planned form to the length ask:
 * - short: intro/outro halved, only the FIRST core cycle survives;
 * - extended/epic: one/two extra stamped core cycles before the break;
 * - exact: greedy core cycles toward the requested minute count;
 * - standard/radio: untouched (forms are already radio-shaped).
 */
export function applySongLength(sections: SongSectionSpec[], hint: SongLengthHint, bpm: number): SongSectionSpec[] {
  if (hint.kind === "standard" || hint.kind === "radio") return sections;
  if (hint.kind === "short") {
    const intro = sections[0];
    const outro = sections[sections.length - 1];
    const core = sections.slice(1, sections.length - 1).filter((section) => section.role !== "break");
    // First cycle = up to (excluding) the next section sharing the first core role.
    let cut = core.findIndex((section, index) => index > 0 && section.role === core[0]?.role);
    if (cut < 0) cut = Math.ceil(core.length / 2);
    const kept = core.slice(0, cut > 0 ? cut : core.length);
    if (!intro || !outro || kept.length === 0) return sections;
    return [{ ...intro, bars: roundBars(intro.bars / 2) }, ...kept, { ...outro, bars: roundBars(outro.bars / 2) }];
  }
  if (hint.kind === "extended" || hint.kind === "epic") {
    let out = sections;
    const cycles = hint.kind === "extended" ? 1 : 2;
    for (let cycle = 1; cycle <= cycles; cycle++) out = insertCoreCycle(out, cycle + 2);
    return out;
  }
  // exact — greedy cycles toward the minute target (bpm/4 bars per minute).
  if (typeof hint.minutes !== "number" || hint.minutes <= 0) return sections;
  const target = roundBars((hint.minutes * bpm) / 4);
  const totalBars = (list: SongSectionSpec[]) => list.reduce((sum, section) => sum + section.bars, 0);
  let out = sections;
  let guard = 0;
  let cycle = 4;
  while (totalBars(out) < target - 3 && guard < 12) {
    out = insertCoreCycle(out, cycle++);
    guard += 1;
  }
  return out;
}

/** One generated, ready-to-install song section. */
export interface SongBuildSection extends SongSectionSpec {
  pattern: Pattern;
  /** Pattern length in steps (bars × 16). */
  stepCount: number;
  /** The roles ACTUALLY generated: instrumentation ∩ user's intent roles. */
  roles: IntentRole[];
}

/** The complete, installable song (patterns generated, nothing applied yet). */
export interface SongBuild {
  name: string;
  baseIntent: IntentSpec;
  resolvedBpm: number | null;
  key: MusicalKey | null;
  sections: SongBuildSection[];
  totalBars: number;
}

export interface BuildSongOptions {
  /** Progress callback — fired after each section (index, label, total). */
  onProgress?: (done: number, label: string, total: number) => void;
  /** Yield control between sections (UI responsiveness). Default true. */
  yieldBetweenSections?: boolean;
  /**
   * Wave 2 — section requests parsed from the sentence ("16-bar intro",
   * "no break", "vinyl break"). Applied to the planned form before
   * generation; scoped FX ride on the sections into applySongCommand.
   */
  sections?: SectionParse;
  /**
   * #6 dynamic song form — length words ("short", "radio edit", "extended",
   * "epic journey", "3 minutes", "2:30") scale the core cycles.
   */
  length?: SongLengthHint | null;
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Generate the whole song from one intent. Each section is generated through
 * the canonical Intent Engine (sync single-candidate path — deterministic and
 * fast; the audition/ranking UX applies to single patterns, not 7-at-once).
 * Sections share the base seed namespace, so the song feels like ONE idea
 * arranged, not seven unrelated beats.
 */
export async function buildSong(
  doc: ProjectDocument,
  input: IntentInput | IntentSpec,
  options: BuildSongOptions = {},
): Promise<SongBuild> {
  const baseIntent = normalizeIntent(input);
  const form = planSongForm(baseIntent, options.sections, options.length);
  const sections: SongBuildSection[] = [];
  let resolvedBpm: number | null = null;
  let key: MusicalKey | null = baseIntent.key ?? doc.key ?? null;

  const ALL_ROLES: IntentRole[] = ["drums", "bass", "chords", "lead"];
  const userRoles = baseIntent.roles ?? ALL_ROLES;

  for (const [index, section] of form.sections.entries()) {
    // A2 v2 role-aware instrumentation: the section plays only the roles its
    // form asks for, further limited by the USER's role request ("no drums"
    // keeps drums out of every section, including choruses).
    const wanted = section.instrumentation.filter((role) => userRoles.includes(role));
    const sectionRoles: IntentRole[] = wanted.length > 0 ? [...wanted] : [...userRoles];
    const sectionIntent = normalizeIntent({
      genre: baseIntent.genre,
      style: baseIntent.style ?? undefined,
      seed: `${baseIntent.seed}|song:${index}:${section.role}`,
      key: baseIntent.key,
      bpmRange: baseIntent.bpmRange,
      // pattern = the full section length (multi-bar phrase plans, fills)
      length: Math.min(256, section.bars * 16),
      energy: section.energyDelta,
      density: section.densityDelta,
      complexity: section.complexityDelta,
      variation: baseIntent.variation,
      candidateCount: 1,
      roles: sectionRoles,
      constraints: baseIntent.constraints,
      controls: baseIntent.controls,
    });
    const result = generateLocalResult(doc, sectionIntent, "apply");
    if (!result.proposal) {
      throw new Error(`section "${section.label}" failed generation: ${result.diagnostics.errors[0] ?? "rejected"}`);
    }
    if (resolvedBpm === null) resolvedBpm = result.plan.resolvedBpm;
    if (key === null && result.plan.options.key) key = result.plan.options.key;
    sections.push({
      ...section,
      pattern: result.proposal.pattern,
      stepCount: section.bars * 16,
      roles: sectionRoles,
    });
    options.onProgress?.(index + 1, section.label, form.sections.length);
    if (options.yieldBetweenSections !== false && index < form.sections.length - 1) {
      await yieldToUi();
    }
  }

  // T3 real transition sounds: every transition bakes its sound into the
  // OUTGOING section — fill/riser roll into the launch, break drops the last
  // bar silent. Baked at build time (deterministic) so the song stays ONE
  // undo step with reproducible hashes.
  for (let index = 1; index < sections.length; index++) {
    const transitionIn = sections[index].transitionIn;
    if (!transitionIn) continue;
    const outgoing = sections[index - 1];
    sections[index - 1] = {
      ...outgoing,
      pattern: applyTransitionToPattern(doc, outgoing.pattern, transitionIn, {
        // drum-based fills respect the section's instrumentation AND the
        // user's role request — a bridge or a "no drums" intent stays clean
        allowDrums: outgoing.roles.includes("drums"),
      }),
    };
  }

  const nameParts: string[] = [baseIntent.genre];
  if (baseIntent.style) nameParts.push(baseIntent.style);
  return {
    name: `${nameParts.join(" ")} — song`,
    baseIntent,
    resolvedBpm,
    key,
    sections,
    totalBars: form.totalBars,
  };
}

/**
 * Install a built song as ONE undoable command: patterns + scenes (role,
 * intensity, name) + contiguous clips + markers + transitions (now carrying
 * real cue assets) + FX-cue audioClips on a dedicated "FX Cues" lane, plus
 * the genre kit colouring for drill/phonk. Generation happened in buildSong
 * — this only folds the pre-built result into the document (command
 * etiquette).
 */
export function applySongCommand(doc: ProjectDocument, build: SongBuild): import("../commands/types").Command {
  if (build.sections.length === 0) throw new Error("Song build has no sections");

  let next = applyGenreKitToDoc(doc, build.baseIntent.genre);
  const clips: ProjectDocument["arrangement"]["clips"] = [];
  const markers: Marker[] = [];
  const transitions: NonNullable<ProjectDocument["arrangement"]["transitions"]> = [];
  const seams: TransitionSeam[] = [];
  let bar = 0;
  let previousClipId: string | null = null;
  let previousBars = 0;

  for (const section of build.sections) {
    const sceneId = `scene-${section.pattern.id}`;
    next = {
      ...next,
      patterns: [...next.patterns, section.pattern],
      scenes: [
        ...next.scenes,
        {
          id: sceneId,
          name: section.label,
          patternId: section.pattern.id,
          intensity: section.intensity,
          role: section.role,
        },
      ],
    };
    const clip = { id: `clip-${section.pattern.id}`, sceneId, startBar: bar, lengthBars: section.bars };
    clips.push(clip);
    if (previousClipId && section.transitionIn) {
      const transitionId = `trans-${section.pattern.id}`;
      transitions.push({
        id: transitionId,
        fromClipId: previousClipId,
        toClipId: clip.id,
        type: section.transitionIn,
        lengthBars: 1,
        cueAssetId: transitionCueAsset(section.transitionIn) ?? undefined,
      });
      seams.push({
        id: transitionId,
        type: section.transitionIn,
        seamBar: bar,
        outgoingStartBar: bar - previousBars,
      });
    }
    if (section.marker) {
      markers.push({
        id: `marker-${section.pattern.id}`,
        name: section.marker.name,
        type: section.marker.type,
        tick: bar * BAR_TICKS,
        linkedClipId: clip.id,
      });
    }
    previousClipId = clip.id;
    previousBars = section.bars;
    bar += section.bars;
  }

  // ── Section FX (wave 3) ───────────────────────────────────────────────
  // Three FX sources, in increasing scope: per-role recipes (the form's
  // sound dramaturgy), section-scoped requests ("vinyl break") and the
  // intent's GLOBAL fx ("wobbly drill") as always-on static chains. Section
  // FX are gated to their section with sceneAutomation lanes written for
  // EVERY generated scene (see SectionFxRecipe). FX is garnish — any
  // unresolvable track or param skips silently, never kills the song.
  const fxLanes: ProjectDocument["sceneAutomation"] = [];
  const touchedFxIds = new Set<string>();
  // Scoped requests and role recipes can land on the SAME effect instance
  // (both install vinyl on the break) — the lane key dedupes their gates.
  const laneKeys = new Set<string>();

  const laneFx = (
    trackId: string,
    fxId: string,
    paramId: string,
    neutral: number,
    targetSection: SongBuildSection,
    inner: { active: number } | { from: number; to: number },
  ): void => {
    const laneKey = `${fxId}|${paramId}`;
    if (laneKeys.has(laneKey)) return;
    laneKeys.add(laneKey);
    const target = { kind: "fxParam" as const, trackId, fxId, paramId };
    for (const section of build.sections) {
      const span = section.bars * BAR_TICKS;
      const points =
        section === targetSection
          ? "active" in inner
            ? [
                { tick: 0, value: inner.active },
                { tick: span, value: inner.active },
              ]
            : [
                { tick: 0, value: inner.from },
                { tick: span, value: inner.to },
              ]
          : [{ tick: 0, value: neutral }];
      fxLanes.push({
        id: `sceneAuto-${fxId}-${paramId}-${section.pattern.id}`,
        sceneId: `scene-${section.pattern.id}`,
        target,
        points,
      });
    }
  };

  const foldAction = (action: ProductionAction): string | null => {
    try {
      const existing = trackEffectsOf(next, action.trackId).find((f) => f.type === action.type);
      if (!existing) {
        const add = addEffect(next, action.trackId, action.type);
        next = add.execute(next);
      }
      const instance = trackEffectsOf(next, action.trackId).find((f) => f.type === action.type);
      if (!instance) return null;
      for (const [paramId, value] of Object.entries(action.params)) {
        next = setEffectParam(next, action.trackId, instance.id, paramId, value).execute(next);
      }
      if (action.volumeSteps || action.pitchSteps) {
        next = setBeatManglerSteps(next, action.trackId, instance.id, {
          volume: action.volumeSteps,
          pitch: action.pitchSteps,
        }).execute(next);
      }
      return instance.id;
    } catch {
      return null;
    }
  };

  for (const section of build.sections) {
    // a) scoped request — "vinyl break": chain installed, mix gated to the
    //    section (neutral 0 = dry everywhere else).
    if (section.fx) {
      try {
        const { actions } = planProductionActions(next, section.fx);
        for (const action of actions) {
          const fxId = foldAction(action);
          if (!fxId) continue;
          touchedFxIds.add(fxId);
          const active = action.params.mix ?? 1;
          next = setEffectParam(next, action.trackId, fxId, "mix", 0).execute(next);
          laneFx(action.trackId, fxId, "mix", 0, section, { active });
        }
      } catch {
        /* garnish */
      }
    }
    // b) role recipes — gated/ramped per the recipe table.
    for (const recipe of SECTION_FX_RECIPES[section.role] ?? []) {
      try {
        const [resolved] = resolveProductionTargets(next, [recipe.targetRole]);
        // Genre templates name their music tracks freely (Stab, Pad, Lead…)
        // — a music-role recipe falls back to the first instrument track so
        // the dramaturgy survives every kit.
        const trackId =
          resolved ??
          (recipe.targetRole === "drums" ? undefined : next.tracks.find((t) => t.kind === "instrument")?.id);
        if (!trackId) continue;
        const fxId = foldAction({ trackId, type: recipe.type, params: recipe.params ?? {} });
        if (!fxId) continue;
        touchedFxIds.add(fxId);
        // Neutral base values first; lanes only when EVERY entry applied —
        // a half-gated effect would be stuck audible (or stuck silent).
        for (const g of recipe.gated ?? []) {
          next = setEffectParam(next, trackId, fxId, g.paramId, g.neutral).execute(next);
        }
        for (const r of recipe.ramps ?? []) {
          next = setEffectParam(next, trackId, fxId, r.paramId, r.neutral).execute(next);
        }
        for (const g of recipe.gated ?? []) {
          laneFx(trackId, fxId, g.paramId, g.neutral, section, { active: g.active });
        }
        for (const r of recipe.ramps ?? []) {
          laneFx(trackId, fxId, r.paramId, r.neutral, section, { from: r.from, to: r.to });
        }
      } catch {
        /* garnish */
      }
    }
  }

  // c) global intent FX — "wobbly drill": static chains, audible in every
  //    section (that's the distinction from section FX).
  if (build.baseIntent.fx) {
    try {
      const { actions } = planProductionActions(next, build.baseIntent.fx);
      for (const action of actions) {
        const fxId = foldAction(action);
        if (fxId) touchedFxIds.add(fxId);
      }
    } catch {
      /* garnish */
    }
  }

  // FX cue lane: one instrument track named "FX Cues", reused across song
  // re-generations (no track stacking). Cue clips are plain audioClips, so
  // the live scheduler and the offline renderer play them unchanged.
  const existingFx = next.tracks.find(
    (t): t is InstrumentTrack => t.kind === "instrument" && t.name === FX_CUE_TRACK_NAME,
  );
  const fxTrack: InstrumentTrack = existingFx ?? {
    ...createInstrumentTrackModel("sampler", next.tracks.length),
    name: FX_CUE_TRACK_NAME,
    sampleId: null,
  };
  const cueClips = buildTransitionCueClips(seams, build.resolvedBpm ?? doc.bpm, fxTrack.id);

  // Genre master tilt (sound-quality pass): character genres ride the master
  // EQ shelves toward their tone (drill dark, phonk warm, jersey bright);
  // legacy genres leave the document's tilt untouched. Re-generating with a
  // different character genre re-targets the tilt.
  const masterTilt = genreMasterTiltDb(build.baseIntent.genre);
  if (masterTilt !== undefined) {
    next = { ...next, master: { ...next.master, tiltDb: masterTilt } };
  }

  // Genre loudness trim (sound-quality pass): every genre's reference render
  // (scripts/measure-genre-references.mjs) measured a different untrimmed
  // loudness — the trim lands every generated song at
  // SONG_LOUDNESS_TARGET_LUFS so exports are consistent across genres.
  // Computed against the UNTRIMMED reference and applied uniformly, so
  // measured + trim hits the target with no feedback loop.
  const genreRef = GENRE_REFERENCE[build.baseIntent.genre];
  if (genreRef) {
    const trim = Math.max(
      -SONG_LOUDNESS_TRIM_LIMIT_DB,
      Math.min(SONG_LOUDNESS_TRIM_LIMIT_DB, Math.round((SONG_LOUDNESS_TARGET_LUFS - genreRef.integrated) * 10) / 10),
    );
    if (next.master.loudnessTrimDb !== trim) {
      next = { ...next, master: { ...next.master, loudnessTrimDb: trim } };
    }
  }

  const bpmUpdate = build.resolvedBpm != null ? { bpm: build.resolvedBpm } : {};
  next = {
    ...next,
    tracks: existingFx ? next.tracks : [...next.tracks, fxTrack],
    // Section FX lanes replace only lanes targeting fx ids THIS build
    // touches — user automation on other devices survives a re-generate.
    sceneAutomation: [...next.sceneAutomation.filter((lane) => !touchedFxIds.has(lane.target.fxId ?? "")), ...fxLanes],
    arrangement: {
      ...next.arrangement,
      clips,
      transitions,
      // Replace only THIS lane's previous cue clips — user clips (recorded
      // takes, imported audio) on other tracks survive a re-generate.
      audioClips: [...(next.arrangement.audioClips ?? []).filter((c) => c.trackId !== fxTrack.id), ...cueClips],
    },
    markers: [...(next.markers ?? []), ...markers],
    activePatternId: build.sections[build.sections.length - 1].pattern.id,
    ...bpmUpdate,
  };

  return {
    type: "applySong",
    label: `Build song: ${build.name} (${build.totalBars} bars)`,
    execute: () => next,
    undo: () => doc,
  };
}

/** Convenience: plan-only preview for UI (section list, no generation). */
export function previewSongForm(
  input: IntentInput | IntentSpec,
  _doc?: ProjectDocument,
): {
  name: string;
  sections: SongSectionSpec[];
  totalBars: number;
} {
  const intent = normalizeIntent(input);
  const form = planSongForm(intent);
  const nameParts: string[] = [intent.genre];
  if (intent.style) nameParts.push(intent.style);
  return { name: `${nameParts.join(" ")} — song`, sections: form.sections, totalBars: form.totalBars };
}

// Re-exported for the UI's convenience (same canonical pipeline entry points).
export { intentFromGenerateOptions, generateOptionsFromIntent };

// ── C3: TARGETED SECTION REVISE ─────────────────────────────────────────────
// "make bridge more energic" — the section role names the TARGET: the
// pattern's provenance carries its full generation intent + seed, so we
// shift one slider and RE-GENERATE with the same seed (identity kept),
// then swap the pattern in place (scene + clip untouched, one undo step).

/** One derived FX chip for an arrangement section (wave: FX chips UI). */
export interface SectionFxChip {
  type: EffectType;
  /** Display name from the effect registry. */
  label: string;
  /** True when the section automates the device with a sweep (riser/closing). */
  sweep: boolean;
}

/**
 * Derive the FX chips shown on an arrangement section: every device with a
 * sceneAutomation lane in this scene, one chip per device, `sweep` when the
 * lane's value actually moves inside the section (risers, closing filters)
 * versus a flat gate (vinyl only in the break). Pure — reads the document,
 * so chips stay correct across undo/redo and re-generated songs without any
 * extra persisted state.
 */
export function sectionFxChips(doc: ProjectDocument, sceneId: string): SectionFxChip[] {
  const chips: SectionFxChip[] = [];
  const seen = new Set<string>();
  for (const lane of doc.sceneAutomation) {
    if (lane.sceneId !== sceneId || lane.target.kind !== "fxParam" || !lane.target.fxId) continue;
    if (seen.has(lane.target.fxId)) continue;
    seen.add(lane.target.fxId);
    const track = doc.tracks.find((t) => t.id === lane.target.trackId);
    const instance =
      track && "effects" in track
        ? (track.effects as { id: string; type: EffectType }[]).find((f) => f.id === lane.target.fxId)
        : undefined;
    if (!instance) continue;
    const def = EFFECT_META[instance.type];
    if (!def) continue;
    const first = lane.points[0]?.value ?? 0;
    const last = lane.points[lane.points.length - 1]?.value ?? 0;
    chips.push({ type: instance.type, label: def.name, sweep: lane.points.length > 1 && first !== last });
  }
  return chips;
}

export type ReviseSectionAttribute = "energy" | "density";

export type SectionReviseOutcome =
  { ok: true; patternId: string; pattern: Pattern; label: string } | { ok: false; error: string };

/**
 * Re-generate ONE section's pattern with a shifted content slider. Reads the
 * intent snapshot from the pattern's provenance (stored by the engine at
 * generation time), applies the delta, regenerates deterministically with
 * the SAME seed, and returns the replacement keeping the existing pattern id
 * (scenes and clips stay bound to it).
 */
export function reviseSection(
  doc: ProjectDocument,
  targetRole: SceneRole,
  attribute: ReviseSectionAttribute,
  delta: number,
): SectionReviseOutcome {
  const scene = doc.scenes.find((candidate) => sceneRoleOf(candidate) === targetRole);
  if (!scene) return { ok: false, error: `no ${targetRole} section in the project — build a song first` };
  const pattern = doc.patterns.find((candidate) => candidate.id === scene.patternId);
  if (!pattern) return { ok: false, error: `${targetRole} scene has no pattern` };
  const snapshotIntent = pattern.generation?.intent;
  if (!snapshotIntent || typeof snapshotIntent !== "object") {
    return { ok: false, error: `${targetRole} pattern has no intent provenance to revise` };
  }
  try {
    const intent = normalizeIntent(snapshotIntent);
    const fallback = attribute === "energy" ? 0.7 : 0.5;
    const current = typeof intent[attribute] === "number" ? (intent[attribute] as number) : fallback;
    const revised = normalizeIntent({
      ...intent,
      [attribute]: Math.max(0, Math.min(1, current + delta)),
    });
    const result = generateLocalResult(doc, revised, "apply");
    if (!result.proposal) {
      return { ok: false, error: `revision rejected: ${result.diagnostics.errors[0] ?? "unknown"}` };
    }
    // keep the EXISTING id and scene-facing name — the swap is in-place
    const next: Pattern = { ...result.proposal.pattern, id: pattern.id, name: pattern.name };
    return {
      ok: true,
      patternId: pattern.id,
      pattern: next,
      label: `${targetRole}: ${attribute} ${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)} — same seed`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Swap an existing pattern's content IN PLACE (id preserved — scenes and
 * arrangement clips stay bound). One undo step.
 */
export function replacePatternInPlaceCommand(doc: ProjectDocument, patternId: string, next: Pattern): Command {
  const existing = doc.patterns.find((candidate) => candidate.id === patternId);
  if (!existing) throw new Error(`Pattern ${patternId} not found`);
  const replacement: Pattern = { ...next, id: patternId };
  const nextDoc: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((candidate) => (candidate.id === patternId ? replacement : candidate)),
  };
  return snapshot("replacePatternInPlace", `Revise ${replacement.name}`, doc, nextDoc);
}
