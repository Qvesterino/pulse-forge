/**
 * Jam roles — a lightweight rights model for collab sessions.
 *
 * One session, several musicians: the drummer lives on the pads, the keyboard
 * player owns the piano roll, the engineer mixes, the arranger builds the
 * song. Roles are self-selected presence (the collab server is auth-free by
 * design — see collab-server.mjs) and enforced as a FOCUS GUARD at the local
 * command choke point: your UI stops your hands, not the network.
 *
 * Enforcement is allowlist-based per role. Commands that are not on any list
 * fail closed — only OWNER runs them — so future command types can never
 * silently leak past a role.
 */

export type JamRole = "owner" | "drums" | "keys" | "mixer" | "arranger";

export interface JamRoleDef {
  id: JamRole;
  label: string;
  blurb: string;
}

export const JAM_ROLES: JamRoleDef[] = [
  { id: "owner", label: "OWNER", blurb: "Everything" },
  { id: "drums", label: "DRUMS", blurb: "Pads, steps, patterns, kits, grooves" },
  { id: "keys", label: "KEYS", blurb: "Notes, instruments, presets" },
  { id: "mixer", label: "MIXER", blurb: "Levels, FX, sends, automation, master" },
  { id: "arranger", label: "ARRANGE", blurb: "Scenes, clips, markers, tempo, tracks" },
];

export function isJamRole(value: unknown): value is JamRole {
  return typeof value === "string" && JAM_ROLES.some((r) => r.id === value);
}

export function normalizeJamRole(value: unknown, fallback: JamRole = "owner"): JamRole {
  return isJamRole(value) ? value : fallback;
}

// ── Capability sets (command type → role buckets) ──────────────────────────

/** Housekeeping every role may do: names, labels, colours. */
const SHARED = new Set([
  "setProjectName",
  "setProjectTags",
  "setPadColor",
  "setTrackColor",
  "renamePattern",
  "renameScene",
  "renameMarker",
  "setMarkerType",
  "setGroupCollapsed",
  "setActivePattern",
]);

/** Drum-rack work: steps, p-locks, pads, kits, pattern content, grooves. */
const DRUMS = new Set([
  "toggleStep",
  "setStepVelocity",
  "setStepsVelocity",
  "setStepMeta",
  "setStepsLocks",
  "setStepsVelocity",
  "clearSteps",
  "clearStepLocks",
  "pasteStepLocks",
  "setPadParams",
  "setPadSynth",
  "setPadMod",
  "setPadLoop",
  "resetPadSlice",
  "applyKitToDrumTrack",
  "setDrumNoteMapping",
  "resetDrumNoteMapping",
  "sliceToPads",
  "chopSampleToPads",
  "stealGrooveIntoPattern",
  "setGroove",
  "createPattern",
  "duplicatePattern",
  "duplicatePatternForScene",
  "duplicateSceneAsVariation",
  "deletePattern",
  "clearPattern",
  "mutatePattern",
  "pastePattern",
  "generatePattern",
  "createFill",
  "buildup",
  "quantizePatternToGrid",
  "quantizePatternToScale",
  "setPatternLength",
  "reorderPattern",
  "installPackSketch",
  "assistVary",
  "assistBuild",
  "assistReplace",
  "assistFill",
]);

/** Melodic work: notes, instruments, instrument presets. */
const KEYS = new Set([
  "addNote",
  "deleteNote",
  "deleteNotes",
  "duplicateNotes",
  "moveNote",
  "nudgeNotes",
  "resizeNote",
  "setNoteVelocity",
  "setNotesVelocity",
  "setNotesVelocities",
  "glueNotes",
  "splitNotes",
  "quantizeNotes",
  "setInstrumentParam",
  "setInstrumentSample",
  "applyInstrumentPreset",
  "setTrackPreset",
  "applyUltinaPreset",
  "setUltinaParam",
  "applyOzvenaStatePatch",
  "applyUltinaProposal",
]);

/** Mix work: channels, FX, sends, groups, automation, macros, master. */
const MIXER = new Set([
  "setTrackParams",
  "setTrackSend",
  "setEffectParam",
  "setEffectSteps",
  "setEffectSidechainSource",
  "toggleEffectBypass",
  "addEffect",
  "removeEffect",
  "moveEffect",
  "applyEffectPreset",
  "applyFxEqPreset",
  "setFxEqParam",
  "setReturnGain",
  "setMasterConfig",
  "freezeTrack",
  "unfreezeTrack",
  "setGroupMute",
  "setGroupSolo",
  "addLfo",
  "setLfoParams",
  "removeLfo",
  "addAutomationLane",
  "removeAutomationLane",
  "addAutomationPoint",
  "moveAutomationPoint",
  "deleteAutomationPoint",
  "setMacroValue",
  "setMacroMappingAmount",
  "addMacroMapping",
  "removeMacroMapping",
  "addMacroMappingMidiCC",
  "addSceneAutomation",
  "addSceneAutomationPoint",
  "moveSceneAutomationPoint",
  "removeSceneAutomationPoint",
  "removeSceneAutomation",
]);

/** Song-building work: scenes, clips, markers, tempo, tracks, MIDI routing. */
const ARRANGE = new Set([
  "createScene",
  "deleteScene",
  "setScenePattern",
  "setSceneIntensity",
  "setSceneIntensityCurve",
  "setSceneLoop",
  "setSceneRole",
  "reorderScenes",
  "addArrangementClip",
  "deleteArrangementClip",
  "moveArrangementClip",
  "resizeArrangementClip",
  "duplicateArrangementClip",
  "setArrangementClipLoop",
  "addArrangementTransition",
  "updateArrangementTransition",
  "removeArrangementTransition",
  "addMarker",
  "moveMarker",
  "removeMarker",
  "setMarkerLinkedClip",
  "autoArrangeSong",
  "createArrangementSkeleton",
  "appendCapturedArrangement",
  "captureLastTake",
  "addAudioClip",
  "deleteAudioClip",
  "moveAudioClip",
  "resizeAudioClip",
  "updateAudioClip",
  "duplicateAudioClip",
  "sliceAudioClipToArrangement",
  "fitAudioClipTempo",
  "consolidateAudioClips",
  "stripSilence",
  "duplicateTimeRange",
  "consolidateTimeRange",
  "setBpm",
  "setProjectKey",
  "createDrumTrack",
  "createInstrumentTrack",
  "createGroupTrack",
  "createReturnTrack",
  "deleteTrack",
  "duplicateTrack",
  "addToGroup",
  "removeFromGroup",
  "createVariationAndPlaceClip",
  "setMidiConfig",
  "setMidiClockMode",
  "setMidiAftertouch",
  "setMidiProgramMap",
  "addMidiCcMapping",
  "removeMidiCcMapping",
]);

const ROLE_SETS: Partial<Record<JamRole, Set<string>>> = {
  drums: DRUMS,
  keys: KEYS,
  mixer: MIXER,
  arranger: ARRANGE,
};

/**
 * Can `role` execute a command of this type? Owners run everything; every
 * other role gets SHARED + its own bucket; unknown command types fail closed.
 */
export function roleAllows(role: JamRole, commandType: string): boolean {
  if (role === "owner") return true;
  if (SHARED.has(commandType)) return true;
  return ROLE_SETS[role]?.has(commandType) ?? false;
}
