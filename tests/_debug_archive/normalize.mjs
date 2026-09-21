import { createDefaultProject, allPadIds } from "./src/project-model/schema.ts";
import { defaultInstrumentParams } from "./src/instruments/registry.ts";

const doc = createDefaultProject();
let changed = false;
const tracks = doc.tracks.map((track) => {
  if (track.kind !== "instrument") return track;
  let next = track;
  if (next.effects === undefined) {
    next = { ...next, effects: [] };
    changed = true;
  }
  if (next.params === undefined) {
    next = { ...next, params: defaultInstrumentParams(next.instrument) };
    changed = true;
  } else {
    const defaults = defaultInstrumentParams(next.instrument);
    const merged = { ...defaults, ...next.params };
    for (const key of Object.keys(defaults)) if (next.params[key] === undefined) changed = true;
    next = { ...next, params: merged };
  }
  return next;
});
const withTracks = changed ? { ...doc, tracks } : doc;
let scenes = withTracks.scenes ?? [];
if (scenes === undefined) {
  scenes = [{ id: "_scene", name: "Scene A", patternId: withTracks.activePatternId }];
  changed = true;
}
let validScenes = scenes;
const patternIds = new Set(withTracks.patterns.map((p) => p.id));
const filteredScenes = scenes.filter((s) => patternIds.has(s.patternId));
if (filteredScenes.length !== scenes.length) {
  validScenes = filteredScenes;
  changed = true;
}
const sceneIds = new Set(validScenes.map((s) => s.id));

let arrangement = withTracks.arrangement;
if (arrangement === undefined) {
  arrangement = { clips: [] };
  changed = true;
}
const sortedClips = [...arrangement.clips]
  .filter((c) => sceneIds.has(c.sceneId) && c.startBar >= 0 && c.lengthBars >= 1)
  .sort((a, b) => a.startBar - b.startBar);
if (sortedClips.length !== arrangement.clips.length || sortedClips.some((c, i) => c !== arrangement.clips[i])) {
  arrangement = { clips: sortedClips };
  changed = true;
}
console.log("after arrangement, changed=", changed);
console.log("arrangement === withTracks.arrangement:", arrangement === withTracks.arrangement);

let automation = withTracks.automation ?? [];
if (withTracks.automation === undefined) changed = true;
const trackIds = new Set(withTracks.tracks.map((t) => t.id));
const filteredAutomation = automation.filter((lane) => trackIds.has(lane.target.trackId));
if (filteredAutomation.length !== automation.length) {
  automation = filteredAutomation;
  changed = true;
}
let lfos = withTracks.lfos ?? [];
if (withTracks.lfos === undefined) changed = true;
const filteredLfos = lfos.filter((lfo) => trackIds.has(lfo.trackId));
if (filteredLfos.length !== lfos.length) {
  lfos = filteredLfos;
  changed = true;
}

let macros = withTracks.macros;
if (!Array.isArray(macros) || macros.length === 0) {
  macros = [];
  changed = true;
}
let returns = withTracks.returns;
if (!Array.isArray(returns)) {
  returns = [];
  changed = true;
}
let master = withTracks.master;
if (master === undefined || typeof master !== "object") {
  master = {};
  changed = true;
}
console.log("after lfos/macros/returns/master, changed=", changed);

let sendsChanged = false;
const tracksWithSends = withTracks.tracks.map((track) => {
  if (track.sends !== undefined) return track;
  sendsChanged = true;
  return { ...track, sends: {} };
});
if (sendsChanged) changed = true;
console.log("after sendsChanged, changed=", changed, "sendsChanged=", sendsChanged);

const withCompositionBase =
  scenes !== withTracks.scenes ||
  arrangement !== withTracks.arrangement ||
  automation !== withTracks.automation ||
  lfos !== withTracks.lfos ||
  macros !== withTracks.macros ||
  returns !== withTracks.returns ||
  master !== withTracks.master ||
  sendsChanged
    ? { ...withTracks, tracks: tracksWithSends, scenes, arrangement, automation, lfos, macros, returns, master }
    : withTracks;
console.log("withCompositionBase === doc:", withCompositionBase === doc);
console.log("withCompositionBase === withTracks:", withCompositionBase === withTracks);

const padIds = new Set(allPadIds(doc));
const patterns = withCompositionBase.patterns.map((pattern) => {
  let next = pattern;
  if (next.notes === undefined) {
    next = { ...next, notes: {} };
    changed = true;
  }
  let rows = next.rows;
  for (const padId of padIds) {
    const row = rows[padId];
    const invalid = !row || row.length !== next.stepCount;
    if (!invalid) continue;
    if (rows === next.rows) rows = { ...next.rows };
    const base = row ?? [];
    rows[padId] = new Array(next.stepCount).fill(0).map((_, i) => base[i] ?? 0);
    changed = true;
  }
  if (rows !== next.rows) next = { ...next, rows };
  return next;
});
console.log("after patterns map, changed=", changed);
const result = changed ? { ...withCompositionBase, patterns } : withCompositionBase;
console.log("result === doc:", result === doc);
console.log("changed=", changed);
