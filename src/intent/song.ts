import type {
  ArrangementTransitionType,
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
 * intensity, name) + contiguous clips + markers + transitions. Generation
 * happened in buildSong — this only folds the pre-built result into the
 * document (command etiquette).
 */
export function applySongCommand(doc: ProjectDocument, build: SongBuild): import("../commands/types").Command {
  if (build.sections.length === 0) throw new Error("Song build has no sections");

  let next = doc;
  const clips: ProjectDocument["arrangement"]["clips"] = [];
  const markers: Marker[] = [];
  const transitions: NonNullable<ProjectDocument["arrangement"]["transitions"]> = [];
  let bar = 0;
  let previousClipId: string | null = null;

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
      transitions.push({
        id: `trans-${section.pattern.id}`,
        fromClipId: previousClipId,
        toClipId: clip.id,
        type: section.transitionIn,
        lengthBars: 1,
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
    bar += section.bars;
  }

  const bpmUpdate = build.resolvedBpm != null ? { bpm: build.resolvedBpm } : {};
  next = {
    ...next,
    arrangement: { ...next.arrangement, clips, transitions },
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
