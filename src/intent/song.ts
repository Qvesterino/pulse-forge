import type {
  ArrangementTransitionType,
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
import type { Command } from "../commands/types";
import { createInstrumentTrackModel, sceneRoleOf } from "../project-model/schema";
import { snapshot } from "../commands/commands";
import type { IntentInput, IntentRole, IntentSpec } from "./types";

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
export function planSongForm(intent: IntentSpec): {
  genre: IntentSpec["genre"];
  sections: SongSectionSpec[];
  totalBars: number;
} {
  const sections = SONG_FORMS[intent.genre].map((section) => ({
    ...section,
    energyDelta: clamp01(intent.energy + section.energyDelta),
    densityDelta: clamp01(intent.density + section.densityDelta),
    complexityDelta: clamp01(intent.complexity + section.complexityDelta),
  }));
  return {
    genre: intent.genre,
    sections,
    totalBars: sections.reduce((sum, section) => sum + section.bars, 0),
  };
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
  const form = planSongForm(baseIntent);
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

  // FX cue lane: one instrument track named "FX Cues", reused across song
  // re-generations (no track stacking). Cue clips are plain audioClips, so
  // the live scheduler and the offline renderer play them unchanged.
  const existingFx = next.tracks.find(
    (t): t is InstrumentTrack => t.kind === "instrument" && t.name === FX_CUE_TRACK_NAME,
  );
  const fxTrack: InstrumentTrack =
    existingFx ??
    {
      ...createInstrumentTrackModel("sampler", next.tracks.length),
      name: FX_CUE_TRACK_NAME,
      sampleId: null,
    };
  const cueClips = buildTransitionCueClips(seams, build.resolvedBpm ?? doc.bpm, fxTrack.id);

  const bpmUpdate = build.resolvedBpm != null ? { bpm: build.resolvedBpm } : {};
  next = {
    ...next,
    tracks: existingFx ? next.tracks : [...next.tracks, fxTrack],
    arrangement: {
      ...next.arrangement,
      clips,
      transitions,
      // Replace only THIS lane's previous cue clips — user clips (recorded
      // takes, imported audio) on other tracks survive a re-generate.
      audioClips: [
        ...(next.arrangement.audioClips ?? []).filter((c) => c.trackId !== fxTrack.id),
        ...cueClips,
      ],
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

export type ReviseSectionAttribute = "energy" | "density";

export type SectionReviseOutcome =
  | { ok: true; patternId: string; pattern: Pattern; label: string }
  | { ok: false; error: string };

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
