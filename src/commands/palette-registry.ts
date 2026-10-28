/**
 * PALETTE COMMAND REGISTRY — the curated second list behind Ctrl+K.
 *
 * THE PROBLEM THIS SOLVES (HCP-05-01, HCP-05-02, HCP-02-01).
 *
 * The palette was a view of the KEYBOARD layer: `buildPaletteActions` read
 * `getActiveShortcuts()`, so it could only ever show what the global shortcut
 * table already had. Measured 2026-10-27: 297 command factories exist, the
 * palette reached 22 of them (7.4 %) and any keyboard path reached 26
 * (8.8 %) — 151 factories in 30 modules had NEITHER. The 30 blind modules were
 * the expressive ones: automation, quantize, scenes, plugins, effectParams,
 * clipPlayback, instrument, chordTrack, liveSets, markers, master, freeze,
 * smart-comp, stemTracks.
 *
 * WHY A CURATED LIST AND NOT "ALL 297".
 *
 * A registry-driven palette over every factory would leak internal and
 * destructive commands into the user's search box by default, and the brief's
 * own "cognitive clutter" axis is a real cost. So this list is a WHITELIST:
 * a command earns a place here by being (a) a one-shot operation, (b) fully
 * described by the document plus the selection, and (c) reversible through
 * the ordinary undo stack.
 *
 * The three rules a spec here must obey:
 *
 *   1. ONE SHOT. A spec that needs a dialog, a value the user has to type or
 *      a rendered audio buffer does NOT belong here — it belongs to the
 *      surface that already owns that flow (the FX picker, the bounce
 *      review, the REC strip). "Set the tempo to …" needs a value; a palette
 *      row cannot ask for one, so tempo is not here.
 *   2. HONEST. `precondition` returns the reason the action is unavailable
 *      and the palette renders it disabled WITH that reason. An action that
 *      cannot run must never look runnable, and must never fail silently.
 *   3. NO NEW POWER. `build` returns a command the product already has. This
 *      registry adds no mutation, no audio path and no edit semantics — it
 *      only gives the existing commands a way in.
 *
 * The live selection is NOT in the document (it lives in the SelectionStore)
 * and the playhead is not in the document either (it lives in the transport),
 * so both arrive through the context.
 */
import type { ProjectDocument } from "../project-model/types";
import { GRID_16TH, grooveOf } from "../project-model/types";
import type { SelectionState } from "../store/SelectionStore";
import type { Command } from "./types";

import { addMacroMapping } from "./automation";
import { conformInstrumentClipsToChordTrack } from "./chordTrack";
import { crossfadeAudioClips, splitAudioClipAtTick } from "./clipEditing";
import { trackEffectsOf } from "./docOps";
import { applyEssentialKit, toggleEffectBypass } from "./effectParams";
import { unfreezeTrack } from "./freeze";
import { clearStepLocks, clearSteps, createFill, setGroove, setStepsVelocity } from "./groove";
import { seedBasslineCommand } from "./instrument";
import { createLiveSet } from "./liveSets";
import { addMarker } from "./markers";
import { quantizePatternToGrid, quantizePatternToScale } from "./quantize";
import { createScene, duplicateSceneAsVariation } from "./scenes";

export interface PaletteCommandContext {
  /** The live project document. */
  doc: ProjectDocument;
  /** The live selection — the document does not carry it. */
  selection: SelectionState;
  /** The playhead position in ticks — the transport owns it, not the document. */
  playheadTick: number;
}

export interface PaletteCommandSpec {
  /** Stable id — it becomes the palette action id (`cmd:<id>`). */
  id: string;
  /** What the user reads. */
  label: string;
  /** The palette group the action sits in. */
  group: string;
  /** Extra searchable words beyond the title. */
  keywords: string;
  /**
   * The precondition. Returns the reason the action cannot run right now, or
   * null when it can. The palette renders the action disabled and shows this
   * reason — an action that cannot run must never look runnable.
   */
  precondition?: (ctx: PaletteCommandContext) => string | null;
  /** Build the command, or return null when there is nothing to build. */
  build: (ctx: PaletteCommandContext) => Command | null;
}

/* ------------------------------------------------------------------ helpers */

const selectedTrackIds = (ctx: PaletteCommandContext): string[] => ctx.selection.trackIds;

const selectedTrack = (ctx: PaletteCommandContext) => {
  const id = selectedTrackIds(ctx)[0];
  return id ? ctx.doc.tracks.find((t) => t.id === id) : undefined;
};

/** The selected arrangement clips — both clip systems (scene clips and audio clips). */
const selectedClipIds = (ctx: PaletteCommandContext): string[] => ctx.selection.clipIds;

const selectedAudioClipIds = (ctx: PaletteCommandContext): string[] => {
  const ids = new Set(selectedClipIds(ctx));
  const audio = ctx.doc.arrangement.audioClips ?? [];
  return audio.filter((clip) => ids.has(clip.id)).map((clip) => clip.id);
};

const activePattern = (ctx: PaletteCommandContext) => ctx.doc.patterns.find((p) => p.id === ctx.doc.activePatternId);

const hasDrumTrack = (doc: ProjectDocument): boolean => doc.tracks.some((t) => t.kind === "drum");

/** The pads the current step selection covers, in the ACTIVE pattern. */
const stepSelectionPads = (ctx: PaletteCommandContext): string[] => {
  const sel = ctx.selection.stepSelection;
  if (!sel) return [];
  const pattern = activePattern(ctx);
  if (!pattern) return [];
  return sel.padIds.filter((padId) => pattern.rows[padId] !== undefined);
};

/* -------------------------------------------------------------------- specs */

export const PALETTE_COMMAND_SPECS: PaletteCommandSpec[] = [
  /* ------------------------------------------------------------- Pattern */
  {
    id: "pattern.quantizeGrid",
    label: "Quantize the active pattern to the 1/16 grid",
    group: "Pattern",
    keywords: "quantize grid snap timing sixteenth 16th notes",
    precondition: (ctx) => (activePattern(ctx) ? null : "There is no active pattern to quantize"),
    build: (ctx) => {
      const pattern = activePattern(ctx);
      return pattern ? quantizePatternToGrid(ctx.doc, pattern.id, GRID_16TH) : null;
    },
  },
  {
    id: "pattern.quantizeScale",
    label: "Quantize the active pattern to the project key",
    group: "Pattern",
    keywords: "quantize scale key pitch notes snap",
    precondition: (ctx) => {
      if (!activePattern(ctx)) return "There is no active pattern to quantize";
      if (!ctx.doc.key) return "The project has no key set — set one first";
      return null;
    },
    build: (ctx) => {
      const pattern = activePattern(ctx);
      return pattern && ctx.doc.key ? quantizePatternToScale(ctx.doc, pattern.id, ctx.doc.key) : null;
    },
  },
  {
    id: "pattern.fill",
    label: "Create a fill",
    group: "Pattern",
    keywords: "fill drum break variation fill-in one shot",
    precondition: (ctx) => {
      if (!activePattern(ctx)) return "There is no active pattern";
      if (!hasDrumTrack(ctx.doc)) return "A fill needs a drum track";
      return null;
    },
    build: (ctx) => {
      const pattern = activePattern(ctx);
      return pattern ? createFill(ctx.doc, pattern.id) : null;
    },
  },
  {
    id: "pattern.clearSteps",
    label: "Clear the selected steps",
    group: "Pattern",
    keywords: "clear empty reset wipe steps erase",
    precondition: (ctx) => {
      if (!activePattern(ctx)) return "There is no active pattern";
      if (stepSelectionPads(ctx).length === 0) return "Select the steps to clear first";
      return null;
    },
    build: (ctx) => {
      const pattern = activePattern(ctx);
      const sel = ctx.selection.stepSelection;
      const pads = stepSelectionPads(ctx);
      if (!pattern || !sel || pads.length === 0) return null;
      return clearSteps(ctx.doc, pattern.id, pads, sel.from, sel.to);
    },
  },
  {
    id: "pattern.velocity",
    label: "Set the selected steps to full velocity",
    group: "Pattern",
    keywords: "velocity accent loudness hit strength",
    precondition: (ctx) => {
      if (!activePattern(ctx)) return "There is no active pattern";
      if (stepSelectionPads(ctx).length === 0) return "Select the steps to change first";
      return null;
    },
    build: (ctx) => {
      const pattern = activePattern(ctx);
      const sel = ctx.selection.stepSelection;
      const pads = stepSelectionPads(ctx);
      if (!pattern || !sel || pads.length === 0) return null;
      const entries = pads.flatMap((padId) =>
        Array.from({ length: sel.to - sel.from + 1 }, (_, i) => ({
          padId,
          stepIndex: sel.from + i,
          velocity: 1,
        })),
      );
      return setStepsVelocity(ctx.doc, pattern.id, entries);
    },
  },
  {
    id: "pattern.clearLocks",
    label: "Clear the locks on the selected steps",
    group: "Pattern",
    keywords: "lock unlock step ratchet p-lock",
    precondition: (ctx) => {
      if (!activePattern(ctx)) return "There is no active pattern";
      if (stepSelectionPads(ctx).length === 0) return "Select the steps to unlock first";
      return null;
    },
    build: (ctx) => {
      const pattern = activePattern(ctx);
      const sel = ctx.selection.stepSelection;
      const pads = stepSelectionPads(ctx);
      if (!pattern || !sel || pads.length === 0) return null;
      return clearStepLocks(ctx.doc, pattern.id, pads, sel.from, sel.to);
    },
  },

  /* -------------------------------------------------------------- Groove */
  {
    id: "groove.humanize",
    label: "Humanize the groove",
    group: "Groove",
    keywords: "humanize timing velocity loose organic groove feel",
    build: (ctx) => setGroove(ctx.doc, { humanizeTiming: 0.25, humanizeVelocity: 0.25 }),
  },
  {
    id: "groove.swing",
    label: "Increase the swing",
    group: "Groove",
    keywords: "swing shuffle groove feel offbeat",
    build: (ctx) => {
      const current = grooveOf(ctx.doc).swing ?? 0;
      return setGroove(ctx.doc, { swing: Math.min(1, Math.round((current + 0.1) * 100) / 100) });
    },
  },

  /* ------------------------------------------------------------- Markers */
  {
    id: "marker.add",
    label: "Add a marker at the playhead",
    group: "Markers",
    keywords: "marker cue add bookmark annotation point",
    build: (ctx) => addMarker(ctx.doc, { tick: Math.max(0, Math.floor(ctx.playheadTick)) }),
  },

  /* -------------------------------------------------------------- Scenes */
  {
    id: "scene.create",
    label: "Add a new scene",
    group: "Scenes",
    keywords: "scene section arrangement new add part",
    build: (ctx) => createScene(ctx.doc),
  },
  {
    id: "scene.variation",
    label: "Create a variation of the first scene",
    group: "Scenes",
    keywords: "scene variation duplicate alternative copy",
    precondition: (ctx) => (ctx.doc.scenes.length === 0 ? "There are no scenes to vary yet" : null),
    build: (ctx) => {
      const scene = ctx.doc.scenes[0];
      return scene ? duplicateSceneAsVariation(ctx.doc, scene.id) : null;
    },
  },

  /* ----------------------------------------------------------- Live sets */
  {
    id: "liveSet.create",
    label: "Create a live set",
    group: "Live sets",
    keywords: "live set performance pads live set",
    precondition: (ctx) => ((ctx.doc.liveSets?.length ?? 0) >= 32 ? "A project can hold up to 32 live sets" : null),
    build: (ctx) => createLiveSet(ctx.doc),
  },

  /* ----------------------------------------------------------- Instrument */
  {
    id: "instrument.bassline",
    label: "Seed a bassline",
    group: "Instrument",
    keywords: "bassline bass generate seed sub pattern",
    build: (ctx) => seedBasslineCommand(ctx.doc),
  },

  /* ------------------------------------------------------------- Effects */
  {
    id: "fx.bypass",
    label: "Bypass the selected track's last effect",
    group: "Effects",
    keywords: "bypass effect plugin fx device compare toggle",
    precondition: (ctx) => {
      const track = selectedTrack(ctx);
      if (!track) return "Select a track first";
      if (trackEffectsOf(ctx.doc, track.id).length === 0) return "This track has no effects yet";
      return null;
    },
    build: (ctx) => {
      const track = selectedTrack(ctx);
      if (!track) return null;
      const effects = trackEffectsOf(ctx.doc, track.id);
      const last = effects[effects.length - 1];
      return last ? toggleEffectBypass(ctx.doc, track.id, last.id) : null;
    },
  },
  {
    id: "fx.essentialKit",
    label: "Apply the Essential Kit to the selected track",
    group: "Effects",
    keywords: "essential kit chain devices starter sound",
    precondition: (ctx) => (selectedTrack(ctx) ? null : "Select a track first"),
    build: (ctx) => {
      const track = selectedTrack(ctx);
      return track ? applyEssentialKit(ctx.doc, track.id) : null;
    },
  },

  /* ----------------------------------------------------------------- Mix */
  {
    id: "mix.unfreeze",
    label: "Unfreeze the selected track",
    group: "Mix",
    keywords: "unfreeze freeze audio asset render cpu",
    precondition: (ctx) => {
      const track = selectedTrack(ctx);
      if (!track) return "Select a track first";
      if (!track.frozen) return "This track is not frozen";
      return null;
    },
    build: (ctx) => {
      const track = selectedTrack(ctx);
      return track?.frozen ? unfreezeTrack(ctx.doc, track.id) : null;
    },
  },

  /* -------------------------------------------------------------- Chords */
  {
    id: "chord.conform",
    label: "Conform the selected clips to the chord track",
    group: "Chords",
    keywords: "chord conform scale harmonize clip",
    precondition: (ctx) => {
      if ((ctx.doc.arrangement.chords ?? []).length === 0) return "The chord track has no chords";
      if (selectedClipIds(ctx).length === 0) return "Select the clips to conform first";
      return null;
    },
    build: (ctx) => {
      const clipIds = selectedClipIds(ctx);
      return clipIds.length > 0 ? conformInstrumentClipsToChordTrack(ctx.doc, clipIds) : null;
    },
  },

  /* -------------------------------------------------------------- Macros */
  {
    id: "macro.mapGain",
    label: "Map macro 1 to the selected track's gain",
    group: "Macros",
    keywords: "macro gain map modulation route control",
    precondition: (ctx) => {
      if (ctx.doc.macros.length === 0) return "This project has no macros yet";
      if (!selectedTrack(ctx)) return "Select a track first";
      return null;
    },
    build: (ctx) => {
      const macro = ctx.doc.macros[0];
      const track = selectedTrack(ctx);
      return macro && track ? addMacroMapping(ctx.doc, macro.id, track.id, "gain") : null;
    },
  },

  /* ---------------------------------------------------------------- Clip */
  {
    id: "clip.split",
    label: "Split the selected audio clip at the playhead",
    group: "Clips",
    keywords: "split cut divide chop audio clip",
    precondition: (ctx) => (selectedAudioClipIds(ctx).length === 0 ? "Select an audio clip first" : null),
    build: (ctx) => {
      const clipId = selectedAudioClipIds(ctx)[0];
      return clipId ? splitAudioClipAtTick(ctx.doc, clipId, ctx.playheadTick) : null;
    },
  },
  {
    id: "clip.crossfade",
    label: "Crossfade the two selected audio clips",
    group: "Clips",
    keywords: "crossfade transition blend overlap audio",
    precondition: (ctx) => {
      const ids = selectedAudioClipIds(ctx);
      if (ids.length < 2) return "Select two audio clips to crossfade";
      return null;
    },
    build: (ctx) => {
      const ids = selectedAudioClipIds(ctx);
      if (ids.length < 2) return null;
      return crossfadeAudioClips(ctx.doc, ids[0], ids[1]);
    },
  },
];

/** The spec with this id, if the registry has one. */
export function paletteCommandSpec(id: string): PaletteCommandSpec | undefined {
  return PALETTE_COMMAND_SPECS.find((spec) => spec.id === id);
}
