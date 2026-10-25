import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import {
  addToGroup,
  createGroupTrack,
  createInstrumentTrack,
  createReturnTrack,
  deleteReturnTrack,
  deleteTrack,
  removeEffectFromTracks,
  removeInputEffect,
  clearInputInsert,
  clearAllSolos,
  clearAllMutes,
  addEffectToTracks,
  setInputInsertMode,
  addInputEffect,
  removeFromGroup,
} from "../src/commands/tracks";
import { setTrackSend } from "../src/commands/master";
import { removeEffect } from "../src/commands/effectInstances";
import { addAudioClip, addAudioTakeClip, deleteAudioClip } from "../src/commands/audioClips";
import { addArrangementClip, deleteArrangementClip } from "../src/commands/commands";
import { deleteArrangementClipRipple } from "../src/commands/clipPlayback";
import { addMidiClip, deleteMidiClip } from "../src/commands/midiClips";
import {
  addAutomationClip,
  addAutomationClipPoint,
  deleteAutomationClip,
  removeAutomationClipPoint,
} from "../src/commands/automationClips";
import {
  addAutomationLane,
  addAutomationPoint,
  addLfo,
  addMacroMapping,
  deleteAutomationPoint,
  removeAutomationLane,
  removeLfo,
  removeMacroMapping,
} from "../src/commands/automation";
import { addChord, removeChord } from "../src/commands/chordTrack";
import { createLiveSet, deleteLiveSet, setLiveSetOptions } from "../src/commands/liveSets";
import { addMarker, removeMarker } from "../src/commands/markers";
import { createPattern, deletePattern, clearPattern } from "../src/commands/patterns";
import { addNote, deleteNote, deleteNotes } from "../src/commands/notes";
import { addMidiCcMapping, removeMidiCcMapping } from "../src/commands/quantize";
import { addSceneAutomation, addSceneAutomationPoint, removeSceneAutomation, removeSceneAutomationPoint } from "../src/commands/sceneAutomation";
import { createScene, deleteScene } from "../src/commands/scenes";
import { addArrangementTransition, removeArrangementTransition } from "../src/commands/arrangementShapes";
import { removeProjectProducerBriefFactCommand, saveProjectProducerBriefCommand } from "../src/commands/producerBriefCommands";
import { setTrackParams } from "../src/commands/project";
import type { Command, ProjectDocument } from "../src/project-model/types";

/**
 * R-03 — THE CLASS-ENDING GUARD: the post-apply normalizer must not prune
 * anything the undo delta does not carry.
 *
 * store.execute() runs the command (whose backward delta is captured from the
 * pre-normalize documents) and THEN normalizes the result — so whatever
 * normalizeProject prunes is pruned OUTSIDE the delta, and undo cannot
 * restore it. This class bit twice before it was guarded per-case
 * (sidechain/MIDI cross-references, then take lanes + Live Set routing).
 *
 * The guard is mechanical, not a per-case pin: for every removal-shaped
 * command in the battery, executed through the REAL store (normalize
 * included), undo must restore the document EXACTLY. A future command whose
 * normalize pass eats a cross-reference goes red here, whatever the field.
 */

interface BatteryEntry {
  name: string;
  setup(store: ProjectStore): void;
  remove(doc: ProjectDocument): Command;
}

const instrumentTrackId = (doc: ProjectDocument): string =>
  doc.tracks.find((track) => track.kind === "instrument")!.id;
const drumTrackId = (doc: ProjectDocument): string => doc.tracks.find((track) => track.kind === "drum")!.id;

const gainTarget = (doc: ProjectDocument) => ({ kind: "trackGain" as const, trackId: instrumentTrackId(doc) });

const BATTERY: BatteryEntry[] = [
  {
    name: "deleteTrack (take lanes, Live Set, send, effect, notes and a group membership behind it)",
    setup(store) {
      const before = new Set(store.doc.tracks.map((track) => track.id));
      store.execute(createInstrumentTrack(store.doc, "keys"));
      store.execute(createGroupTrack(store.doc));
      const id = store.doc.tracks.find((track) => !before.has(track.id) && track.kind === "instrument")!.id;
      const group = store.doc.tracks.find((track) => !before.has(track.id) && track.kind === "group")!.id;
      store.execute(addToGroup(store.doc, id, group));
      store.execute(addEffectToTracks(store.doc, [id], "eq"));
      store.execute(addNote(store.doc, id, { pitch: 60, start: 0, duration: 120, velocity: 0.8 }));
      // The cross-refs the normalizer prunes OUTSIDE the undo delta - the
      // exact shape that destroyed take lanes and Live Set routing once.
      store.execute(addAudioTakeClip(store.doc, "group-1", "take-1", id, "factory.kick", 0, 4));
      store.execute(addAudioTakeClip(store.doc, "group-1", "take-2", id, "factory.kick", 0, 4));
      store.execute(createLiveSet(store.doc, "Set"));
      store.execute(setLiveSetOptions(store.doc, store.doc.liveSets![0]!.id, { trackId: id }));
      store.execute(createReturnTrack(store.doc, "Wet"));
      store.execute(setTrackSend(store.doc, id, store.doc.returns[store.doc.returns.length - 1]!.id, 0.4));
    },
    remove: (doc) => {
      const target = doc.tracks.filter((track) => track.kind === "instrument" && track.instrument === "keys").at(-1);
      if (!target) throw new Error("setup: no keys track");
      return deleteTrack(doc, target.id);
    },
  },
  {
    name: "deleteReturnTrack (with a send cross-reference)",
    setup(store) {
      store.execute(createReturnTrack(store.doc, "Wet"));
      const returnId = store.doc.returns[store.doc.returns.length - 1]!.id;
      store.execute(setTrackSend(store.doc, instrumentTrackId(store.doc), returnId, 0.5));
    },
    remove: (doc) => deleteReturnTrack(doc, doc.returns[doc.returns.length - 1]!.id),
  },
  {
    name: "removeFromGroup",
    setup(store) {
      store.execute(createGroupTrack(store.doc));
      const group = store.doc.tracks.find((track) => track.kind === "group")!.id;
      store.execute(addToGroup(store.doc, instrumentTrackId(store.doc), group));
    },
    remove: (doc) => {
      const member = doc.tracks.find((track) => track.kind === "instrument" && track.groupId);
      if (!member) throw new Error("setup: no grouped track");
      return removeFromGroup(doc, member.id);
    },
  },
  {
    name: "removeEffectFromTracks",
    setup(store) {
      store.execute(addEffectToTracks(store.doc, [instrumentTrackId(store.doc)], "eq"));
    },
    remove: (doc) => removeEffectFromTracks(doc, [instrumentTrackId(doc)], "eq"),
  },
  {
    name: "removeEffect (one instance by id)",
    setup(store) {
      store.execute(addEffectToTracks(store.doc, [instrumentTrackId(store.doc)], "eq"));
    },
    remove: (doc) => {
      const fx = doc.tracks.find((track) => track.id === instrumentTrackId(doc))!.effects[0];
      if (!fx) throw new Error("setup: no effect");
      return removeEffect(doc, instrumentTrackId(doc), fx.id);
    },
  },
  {
    name: "removeInputEffect",
    setup(store) {
      const trackId = instrumentTrackId(store.doc);
      store.execute(setInputInsertMode(store.doc, trackId, "external"));
      store.execute(addInputEffect(store.doc, trackId, "eq"));
    },
    remove: (doc) => {
      const track = doc.tracks.find((candidate) => candidate.id === instrumentTrackId(doc));
      const insert = track && "inputInsert" in track ? track.inputInsert : undefined;
      const fx = insert && "effects" in insert ? insert.effects[0] : undefined;
      if (!fx) throw new Error("setup: no input effect");
      return removeInputEffect(doc, instrumentTrackId(doc), fx.id);
    },
  },
  {
    name: "clearInputInsert",
    setup(store) {
      const trackId = instrumentTrackId(store.doc);
      store.execute(setInputInsertMode(store.doc, trackId, "external"));
      store.execute(addInputEffect(store.doc, trackId, "eq"));
    },
    remove: (doc) => clearInputInsert(doc, instrumentTrackId(doc)),
  },
  {
    name: "clearAllSolos",
    setup(store) {
      for (const track of store.doc.tracks.filter((candidate) => candidate.kind === "instrument").slice(0, 2)) {
        store.execute(setTrackParams(store.doc, track.id, { solo: true }));
      }
    },
    remove: (doc) => clearAllSolos(doc),
  },
  {
    name: "clearAllMutes",
    setup(store) {
      for (const track of store.doc.tracks.filter((candidate) => candidate.kind === "instrument").slice(0, 2)) {
        store.execute(setTrackParams(store.doc, track.id, { mute: true }));
      }
    },
    remove: (doc) => clearAllMutes(doc),
  },
  {
    name: "deleteAudioClip",
    setup(store) {
      store.execute(addAudioClip(store.doc, instrumentTrackId(store.doc), "factory.kick", 1, 2));
    },
    remove: (doc) => {
      const clip = doc.arrangement.audioClips?.[0];
      if (!clip) throw new Error("setup: no audio clip");
      return deleteAudioClip(doc, clip.id);
    },
  },
  {
    name: "deleteArrangementClip (scene lane)",
    setup(store) {
      store.execute(addArrangementClip(store.doc, store.doc.scenes[0]!.id, 2, 2));
    },
    remove: (doc) => {
      const clip = doc.arrangement.clips[doc.arrangement.clips.length - 1];
      if (!clip) throw new Error("setup: no arrangement clip");
      return deleteArrangementClip(doc, clip.id);
    },
  },
  {
    name: "deleteArrangementClipRipple",
    setup(store) {
      store.execute(addArrangementClip(store.doc, store.doc.scenes[0]!.id, 2, 2));
      store.execute(addArrangementClip(store.doc, store.doc.scenes[0]!.id, 6, 2));
    },
    remove: (doc) => {
      const clip = doc.arrangement.clips[doc.arrangement.clips.length - 1];
      if (!clip) throw new Error("setup: no arrangement clip");
      return deleteArrangementClipRipple(doc, clip.id);
    },
  },
  {
    name: "deleteMidiClip",
    setup(store) {
      store.execute(addMidiClip(store.doc, instrumentTrackId(store.doc), store.doc.patterns[0]!.id, 0, 1920));
    },
    remove: (doc) => {
      const clip = doc.arrangement.midiClips?.[doc.arrangement.midiClips.length - 1];
      if (!clip) throw new Error("setup: no midi clip");
      return deleteMidiClip(doc, clip.id);
    },
  },
  {
    name: "deleteAutomationClip",
    setup(store) {
      store.execute(addAutomationClip(store.doc, gainTarget(store.doc), 0, 1920, [{ tick: 0, value: 0.5 }]));
    },
    remove: (doc) => {
      const clip = doc.arrangement.automationClips?.[doc.arrangement.automationClips.length - 1];
      if (!clip) throw new Error("setup: no automation clip");
      return deleteAutomationClip(doc, clip.id);
    },
  },
  {
    name: "removeAutomationClipPoint",
    setup(store) {
      store.execute(addAutomationClip(store.doc, gainTarget(store.doc), 0, 1920, [{ tick: 0, value: 0.2 }]));
      const clipId = store.doc.arrangement.automationClips![0]!.id;
      store.execute(addAutomationClipPoint(store.doc, clipId, 960, 0.8));
    },
    remove: (doc) => {
      const clip = doc.arrangement.automationClips?.[0];
      if (!clip || clip.points.length < 2) throw new Error("setup: no 2-point automation clip");
      return removeAutomationClipPoint(doc, clip.id, 1);
    },
  },
  {
    name: "removeAutomationLane",
    setup(store) {
      store.execute(addAutomationLane(store.doc, gainTarget(store.doc)));
    },
    remove: (doc) => {
      const lane = doc.automation[0];
      if (!lane) throw new Error("setup: no automation lane");
      return removeAutomationLane(doc, lane.id);
    },
  },
  {
    name: "deleteAutomationPoint",
    setup(store) {
      store.execute(addAutomationLane(store.doc, gainTarget(store.doc)));
      const laneId = store.doc.automation[0]!.id;
      store.execute(addAutomationPoint(store.doc, laneId, 480, 0.7));
    },
    remove: (doc) => {
      const lane = doc.automation[0];
      if (!lane) throw new Error("setup: no automation lane");
      return deleteAutomationPoint(doc, lane.id, lane.points.length - 1);
    },
  },
  {
    name: "removeLfo",
    setup(store) {
      store.execute(addLfo(store.doc, instrumentTrackId(store.doc), "osc"));
    },
    remove: (doc) => {
      const lfo = doc.lfos[0];
      if (!lfo) throw new Error("setup: no lfo");
      return removeLfo(doc, lfo.id);
    },
  },
  {
    name: "removeMacroMapping",
    setup(store) {
      const macroId = store.doc.macros[0]!.id;
      store.execute(addMacroMapping(store.doc, macroId, instrumentTrackId(store.doc), "gain"));
    },
    remove: (doc) => {
      const mapping = doc.macros.flatMap((macro) => macro.mappings ?? [])[0];
      if (!mapping) throw new Error("setup: no macro mapping");
      const owner = doc.macros.find((macro) => (macro.mappings ?? []).some((m) => m.id === mapping.id))!;
      return removeMacroMapping(doc, owner.id, mapping.id);
    },
  },
  {
    name: "removeChord",
    setup(store) {
      store.execute(addChord(store.doc, 0, 1, 0, "maj"));
    },
    remove: (doc) => {
      const chord = doc.arrangement.chords?.[0];
      if (!chord) throw new Error("setup: no chord");
      return removeChord(doc, chord.id);
    },
  },
  {
    name: "deleteLiveSet (with a destination track)",
    setup(store) {
      store.execute(createLiveSet(store.doc, "Set"));
      const setId = store.doc.liveSets![0]!.id;
      store.execute(setLiveSetOptions(store.doc, setId, { trackId: instrumentTrackId(store.doc) }));
    },
    remove: (doc) => {
      const set = doc.liveSets?.[0];
      if (!set) throw new Error("setup: no live set");
      return deleteLiveSet(doc, set.id);
    },
  },
  {
    name: "removeMarker",
    setup(store) {
      store.execute(addMarker(store.doc, { tick: 480, name: "Drop" }));
    },
    remove: (doc) => {
      const marker = doc.markers[0];
      if (!marker) throw new Error("setup: no marker");
      return removeMarker(doc, marker.id);
    },
  },
  {
    name: "deletePattern (unreferenced)",
    setup(store) {
      store.execute(createPattern(store.doc, "Spare"));
    },
    remove: (doc) => {
      const pattern = doc.patterns.find((candidate) => candidate.id !== doc.activePatternId);
      if (!pattern) throw new Error("setup: no spare pattern");
      return deletePattern(doc, pattern.id);
    },
  },
  {
    name: "clearPattern (with notes inside)",
    setup(store) {
      const trackId = drumTrackId(store.doc);
      store.execute(addNote(store.doc, trackId, { pitch: 36, start: 0, duration: 120, velocity: 0.9 }));
      store.execute(addNote(store.doc, trackId, { pitch: 38, start: 480, duration: 120, velocity: 0.8 }));
    },
    remove: (doc) => clearPattern(doc, doc.activePatternId),
  },
  {
    name: "deleteNote",
    setup(store) {
      store.execute(addNote(store.doc, drumTrackId(store.doc), { pitch: 36, start: 0, duration: 120, velocity: 0.9 }));
    },
    remove: (doc) => {
      const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId)!;
      const note = pattern.notes[drumTrackId(doc)]?.[0];
      if (!note) throw new Error("setup: no note");
      return deleteNote(doc, drumTrackId(doc), note.id);
    },
  },
  {
    name: "deleteNotes (two at once)",
    setup(store) {
      store.execute(addNote(store.doc, drumTrackId(store.doc), { pitch: 36, start: 0, duration: 120, velocity: 0.9 }));
      store.execute(addNote(store.doc, drumTrackId(store.doc), { pitch: 38, start: 480, duration: 120, velocity: 0.8 }));
    },
    remove: (doc) => {
      const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId)!;
      const notes = pattern.notes[drumTrackId(doc)] ?? [];
      if (notes.length < 2) throw new Error("setup: fewer than 2 notes");
      return deleteNotes(
        doc,
        drumTrackId(doc),
        notes.map((note) => note.id),
      );
    },
  },
  {
    name: "removeMidiCcMapping",
    setup(store) {
      store.execute(addMidiCcMapping(store.doc, 1, gainTarget(store.doc), 0, 1));
    },
    remove: (doc) => {
      const mapping = doc.midi?.ccMappings?.[0];
      if (!mapping) throw new Error("setup: no cc mapping");
      return removeMidiCcMapping(doc, mapping.id);
    },
  },
  {
    name: "removeSceneAutomation",
    setup(store) {
      store.execute(addSceneAutomation(store.doc, store.doc.scenes[0]!.id, gainTarget(store.doc)));
    },
    remove: (doc) => {
      const lane = doc.sceneAutomation[0];
      if (!lane) throw new Error("setup: no scene automation lane");
      return removeSceneAutomation(doc, lane.id);
    },
  },
  {
    name: "removeSceneAutomationPoint",
    setup(store) {
      store.execute(addSceneAutomation(store.doc, store.doc.scenes[0]!.id, gainTarget(store.doc)));
      const laneId = store.doc.sceneAutomation[0]!.id;
      store.execute(addSceneAutomationPoint(store.doc, laneId, 240, 0.9));
    },
    remove: (doc) => {
      const lane = doc.sceneAutomation[0];
      if (!lane) throw new Error("setup: no scene automation lane");
      return removeSceneAutomationPoint(doc, lane.id, lane.points.length - 1);
    },
  },
  {
    name: "deleteScene (a SECOND scene — the active one stays)",
    setup(store) {
      store.execute(createScene(store.doc, "Spare"));
    },
    remove: (doc) => {
      const scene = doc.scenes.find((candidate) => candidate.id !== doc.activeSceneId);
      if (!scene) throw new Error("setup: no spare scene");
      return deleteScene(doc, scene.id);
    },
  },
  {
    name: "removeArrangementTransition",
    setup(store) {
      store.execute(addArrangementClip(store.doc, store.doc.scenes[0]!.id, 0, 2));
      store.execute(addArrangementClip(store.doc, store.doc.scenes[0]!.id, 4, 2));
      const clips = store.doc.arrangement.clips;
      store.execute(addArrangementTransition(store.doc, clips[0]!.id, clips[1]!.id, "custom", 1));
    },
    remove: (doc) => {
      const transition = doc.arrangement.transitions?.[0];
      if (!transition) throw new Error("setup: no transition");
      return removeArrangementTransition(doc, transition.id);
    },
  },
  {
    name: "removeProjectProducerBriefFactCommand",
    setup(store) {
      store.execute(
        saveProjectProducerBriefCommand(store.doc, {
          version: 1,
          savedAt: new Date(0).toISOString(),
          facts: [
            { origin: "user", confidence: "confirmed", field: "genre", section: "preference", value: "techno" },
            { origin: "user", confidence: "confirmed", field: "bars", section: "hard", value: 16 },
          ],
        }),
      );
    },
    remove: (doc) => removeProjectProducerBriefFactCommand(doc, "genre"),
  },
];

describe("R-03: the normalizer must not prune what the undo delta does not carry", () => {
  for (const entry of BATTERY) {
    it(`${entry.name}: execute -> undo restores the document exactly`, () => {
      const store = new ProjectStore(testDoc());
      entry.setup(store);
      const baseline = store.doc;

      const depthBefore = store.undoStackLength;
      store.execute(entry.remove(store.doc));
      expect(store.undoStackLength, `${entry.name}: the removal must not be a silent no-op`).toBeGreaterThan(
        depthBefore,
      );

      store.undo();

      expect(store.doc, `${entry.name}: undo must restore the exact pre-removal document`).toEqual(baseline);
    });
  }

  it("the battery is not silently shrinking", () => {
    expect(BATTERY.length).toBeGreaterThanOrEqual(30);
  });
});
