// The command engine lives in this folder, split by domain. `core` holds
// snapshot() and the dev-freeze guard; every domain module sits above it.
// This file stays the single public entry point, so the ~199 modules that
// import it keep working against an unchanged surface.
// The effect/intent layers below still drive the master bus; the command itself lives in ./master.
// The intent/production layer below still drives project-level settings and pads from their own
// module now; the commands themselves live in ./project.
// The intent layer below still applies groove settings; the command itself lives in ./groove.
// docOps is plumbing shared by several domains and is NOT re-exported wholesale; only the one
// name that was already public goes back out, so the barrel's surface is unchanged.
export { __resetSnapshotVerificationFallbacks, __snapshotVerificationFallbacks, snapshot } from "./core";
export { trackEffectsOf } from "./docOps";

export * from "./freeze";
export * from "./instrument";
export * from "./automation";
export * from "./master";
export * from "./notes";
export * from "./quantize";
export * from "./plugins";
export * from "./project";
export * from "./groove";
export * from "./patterns";
export * from "./arrangement";
export * from "./markers";
export * from "./metadata";
// The clip layers below read the project key when they rebuild a stem set, so this one needs a
// local binding — a re-export would not give the barrel body the name.
export * from "./clipPlayback";
export * from "./sceneAutomation";
export * from "./effectInstances";
// F2 EAGER DIET (ROADMAP): ./aiPattern and ./intentRouting are deliberately
// NOT re-exported here. Both sit on the Intent Engine (pipeline → generator →
// artist/groove data, ~390 KB built), and a barrel re-export pinned that whole
// graph to the studio boot path for every one of the ~199 importers. Their
// consumers import "../commands/aiPattern" / "../commands/intentRouting"
// directly — every one of them is a lazy surface (dock panels, dialogs, the
// MCP relay), so the engine now loads on first intent use, not at boot.
// The clip layers below fold production FX chains onto a ghost document, so this one needs a local
// binding — and it is imported, not re-exported, because it was internal before the split.
export * from "./effectParams";
export * from "./audioClips";
export * from "./clipClipboard";
export * from "./drumContent";
// NOT `export *`: splitAudioClipAtTickWithMinimumFragment is exported from ./clipEditing because
// ./timeRange calls it, but it was internal before the split — a star re-export would publish it
// and the surface would be 234 names instead of 233.
export {
  updateAudioClip,
  fittedLoopPlacement,
  fitAudioClipTempo,
  sliceAudioClipToArrangement,
  duplicateAudioClip,
  bounceStemsToAudioClip,
  splitAudioClipAtTick,
  stripSilenceAudioClip,
  consolidateAudioClips,
} from "./clipEditing";
export type { FittedLoopPlacement } from "./clipEditing";
export * from "./timeRange";
export * from "./arrangementShapes";
export * from "./effectOps";
export * from "./padOps";
export * from "./patternAssist";
// The clip layers below read the transition list between neighbours, so this one needs a local
// binding — a re-export would not give the barrel body the name.
// NOT `export *`: makeSceneVariation is exported from ./scenes for the arrangement layer, and a
// star re-export would publish it — the surface would be 234 names instead of 233.
export {
  createScene,
  deleteScene,
  duplicateSceneAsVariation,
  renameScene,
  reorderScenes,
  setScenePattern,
  setSceneRole,
} from "./scenes";
// The arrangement layer below builds a scene variation and places it on the timeline, so it needs
// a local binding — a re-export would not give the barrel body the name either way.
// The arrangement/clip layers below resize patterns directly, so this one needs a local binding —
// a bare re-export would not give the barrel body the name.
export {
  addEffect,
  addEffectToTracks,
  addToGroup,
  clearAllMutes,
  clearAllSolos,
  countReferenceCleanups,
  createDrumTrack,
  createGenerativeTrack,
  createGroupTrack,
  createInstrumentTrack,
  createReturnTrack,
  deleteReturnTrack,
  deleteTrack,
  duplicateTrack,
  removeEffectFromTracks,
  removeFromGroup,
  setEffectBypassOnTracks,
  setGenerativeTrackConfig,
  setGroupCollapsed,
  setGroupMute,
  setGroupSolo,
  setPadColor,
  setPadLoop,
  setTrackColor,
} from "./tracks";
// Type-only re-export: isolatedModules forbids smiešanie typov do hodnotového zozname vyššie.
export type { GenerativeTrackConfigPatch } from "./tracks";
