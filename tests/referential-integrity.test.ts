/**
 * Referential + structural integrity of `ProjectDocument`.
 *
 * This file is the pin for the PROJECT GRAPH, not for one normalizer. It is
 * deliberately written the other way round from `schema.ts`:
 *
 * - It asks "does every reference in this document resolve?" and re-derives
 *   every answer from the raw document. It imports NO resolver helper from
 *   `schema.ts`, `targets.ts` or `modulators.ts`, because a checker that
 *   shares code with the thing it checks cannot see a defect in it.
 * - It runs the same questions over three families of documents: a canonical
 *   one, one corrupted in each reference class, and one produced by the REAL
 *   command layer (delete track / pattern / scene / effect / return) through
 *   `ProjectStore` including undo.
 *
 * Every `it` states a whole class ("no reference class dangles after X"), not
 * a single field. A per-field pin would pass while the next untested field
 * rots.
 *
 * Contributor rule: when a new persisted field is added to `ProjectDocument`
 * that points at another entity, add it to `auditReferences` AND add it to the
 * corruption classes below. A reference the auditor does not know about is a
 * reference nobody checks.
 */
import { describe, expect, it } from "vitest";
import { normalizeProject } from "../src/project-model/schema";
import {
  addArrangementClip,
  addAudioClip,
  addEffect,
  addMidiClip,
  createPattern,
  deletePattern,
  deleteReturnTrack,
  deleteTrack,
  removeEffectFromTracks,
} from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { commandHarness, deterministicTestDoc, testDoc } from "./fixtures/doc";
import { STEP_TICKS } from "../src/project-model/types";
import type { AutomationTarget, MidiConfig, ProjectDocument } from "../src/project-model/types";

/**
 * Entities that can own modulation / automation, i.e. every audio bus a target
 * may legitimately point at: mixer tracks AND return buses.
 */
function ownerEffects(owner: { effects?: unknown[] } | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const fx of (owner?.effects ?? []) as { id?: unknown }[]) {
    if (typeof fx?.id === "string" && fx.id !== "") out.set(fx.id, fx);
  }
  return out;
}

/** Sidechain + insert-chain effect ids, which share the fxId namespace. */
function insertEffectIds(owner: unknown): Set<string> {
  const insert = (owner as { inputInsert?: { effects?: { id?: unknown }[] } } | undefined)?.inputInsert;
  const ids = new Set<string>();
  for (const fx of insert?.effects ?? []) if (typeof fx?.id === "string" && fx.id !== "") ids.add(fx.id);
  return ids;
}

/**
 * The one place a `AutomationTarget` is judged. Intentionally re-implemented
 * from the raw document rather than delegated to `targets.ts`.
 */
function targetResolves(doc: ProjectDocument, target: AutomationTarget | undefined | null): boolean {
  if (!target || typeof target.trackId !== "string") return false;
  const owner =
    doc.tracks.find((t) => t.id === target.trackId) ?? doc.returns.find((r) => r.id === target.trackId) ?? undefined;
  if (!owner) return false;
  // fxParam / instParam must name a device that exists on the OWNER. A live
  // looking lane at a deleted plugin is the defect this guards.
  if (target.fxId !== undefined) {
    if (!ownerEffects(owner).has(target.fxId) && !insertEffectIds(owner).has(target.fxId)) return false;
  }
  return true;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return [...dup];
}

/**
 * Every dangling / duplicate reference in `doc`, as `path = reason` strings.
 * Empty array = internally consistent.
 */
export function auditReferences(doc: ProjectDocument): string[] {
  const out: string[] = [];
  const bad = (path: string, reason: string) => out.push(`${path} — ${reason}`);

  // ---- backing entity sets -------------------------------------------------
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  const groupIds = new Set(doc.tracks.filter((t) => t.kind === "group").map((t) => t.id));
  const returnIds = new Set(doc.returns.map((r) => r.id));
  const busIds = new Set([...trackIds, ...returnIds]);
  const patternIds = new Set(doc.patterns.map((p) => p.id));
  const sceneIds = new Set(doc.scenes.map((s) => s.id));
  const padIds = new Set(doc.tracks.flatMap((t) => (t.kind === "drum" ? t.pads.map((p) => p.id) : [])));
  const arr = doc.arrangement;
  const sceneClipIds = new Set(arr.clips.map((c) => c.id));
  // Membership lookup set vs the RAW list: markers, transitions and clip
  // groups all resolve against the union, so a repeated clip id is ambiguous
  // for every one of them. The duplicates must be counted on the raw array —
  // counting them on the Set would collapse them to nothing and the check
  // could never fire.
  const rawClipIds = [
    ...arr.clips.map((c) => c.id),
    ...(arr.audioClips ?? []).map((c) => c.id),
    ...(arr.midiClips ?? []).map((c) => c.id),
    ...(arr.automationClips ?? []).map((c) => c.id),
  ];
  const allClipIds = new Set(rawClipIds);
  const takeGroupIds = new Set((arr.takeGroups ?? []).map((g) => g.id));

  // ---- uniqueness ----------------------------------------------------------
  // Each collection owns its own id namespace, EXCEPT the four clip systems:
  // markers, transitions and clip groups all resolve against the union, so a
  // duplicate clip id is ambiguous for every one of them.
  for (const [label, ids] of [
    ["tracks", doc.tracks.map((t) => t.id)],
    ["returns", doc.returns.map((r) => r.id)],
    ["patterns", doc.patterns.map((p) => p.id)],
    ["scenes", doc.scenes.map((s) => s.id)],
    ["automation", doc.automation.map((a) => a.id)],
    ["sceneAutomation", doc.sceneAutomation.map((a) => a.id)],
    ["lfos", doc.lfos.map((l) => l.id)],
    ["macros", doc.macros.map((m) => m.id)],
    ["markers", doc.markers.map((m) => m.id)],
    ["chords", (arr.chords ?? []).map((c) => c.id)],
    ["takeGroups", (arr.takeGroups ?? []).map((g) => g.id)],
    ["transitions", (arr.transitions ?? []).map((t) => t.id)],
    ["clipGroups", (arr.clipGroups ?? []).map((g) => g.id)],
  ] as const) {
    for (const id of duplicates(ids)) bad(`${label}.id`, `duplicate id "${id}"`);
  }
  for (const id of duplicates(rawClipIds)) bad("arrangement.*Clips.id", `duplicate clip id "${id}"`);
  // Effect-instance ids are the fxId key of every AutomationTarget, so two
  // instances sharing one id make every lane at that device ambiguous.
  const effectInstanceIds: string[] = [
    ...doc.tracks.flatMap((t) => [...ownerEffects(t).keys(), ...insertEffectIds(t)]),
    ...doc.returns.flatMap((r) => [...ownerEffects(r).keys()]),
  ];
  for (const id of duplicates(effectInstanceIds)) bad("effects.id", `duplicate id "${id}"`);

  // ---- track-level references ---------------------------------------------
  for (const track of doc.tracks) {
    if (track.kind === "group") continue;
    if (track.groupId !== undefined && !groupIds.has(track.groupId))
      bad(`tracks.${track.id}.groupId`, `group "${track.groupId}" does not exist`);
    for (const fx of track.effects) {
      const sidechain = fx.sidechainTrackId;
      if (sidechain != null && !trackIds.has(sidechain))
        bad(`tracks.${track.id}.effects.${fx.id}.sidechainTrackId`, `track "${sidechain}" does not exist`);
    }
    // `inputInsert` is on the input-insert-capable track kinds only.
    const insertEffects = track.kind === "drum" || track.kind === "instrument" ? track.inputInsert?.effects : undefined;
    for (const fx of insertEffects ?? []) {
      const sidechain = fx.sidechainTrackId;
      if (sidechain != null && !trackIds.has(sidechain))
        bad(`tracks.${track.id}.inputInsert.${fx.id}.sidechainTrackId`, `track "${sidechain}" does not exist`);
    }
  }
  for (const ret of doc.returns)
    for (const fx of ret.effects) {
      const sidechain = fx.sidechainTrackId;
      if (sidechain != null && !trackIds.has(sidechain))
        bad(`returns.${ret.id}.effects.${fx.id}.sidechainTrackId`, `track "${sidechain}" does not exist`);
    }

  // ---- patterns ------------------------------------------------------------
  if (!patternIds.has(doc.activePatternId)) bad("activePatternId", `pattern "${doc.activePatternId}" does not exist`);
  doc.patterns.forEach((pattern, i) => {
    for (const padId of Object.keys(pattern.rows))
      if (!padIds.has(padId)) bad(`patterns[${i}].rows`, `pad "${padId}" does not exist`);
    for (const trackId of Object.keys(pattern.notes ?? {}))
      if (!trackIds.has(trackId)) bad(`patterns[${i}].notes`, `track "${trackId}" does not exist`);
  });

  // ---- scenes --------------------------------------------------------------
  doc.scenes.forEach((scene, i) => {
    if (!patternIds.has(scene.patternId)) bad(`scenes[${i}].patternId`, `pattern "${scene.patternId}" does not exist`);
    // NOT checked, by contract: `scenes[].packs` (fxId), `scenes[].macros`
    // (macroId), `scenes[].ccRemaps` / `ccOverrides` (mappingId) and
    // `scenes[].modulators` (lfoId) deliberately KEEP unknown ids — each is a
    // named identity, matched at use time, and dropping it on load would
    // destroy a user's scene automation because one referenced entity is
    // temporarily absent. See the schema.ts comments on each block and
    // "documented inert-by-contract ids" below.
  });

  // ---- arrangement ---------------------------------------------------------
  arr.clips.forEach((clip, i) => {
    if (!sceneIds.has(clip.sceneId)) bad(`arrangement.clips[${i}].sceneId`, `scene "${clip.sceneId}" does not exist`);
  });
  (arr.audioClips ?? []).forEach((clip, i) => {
    if (!trackIds.has(clip.trackId))
      bad(`arrangement.audioClips[${i}].trackId`, `track "${clip.trackId}" does not exist`);
    if (typeof clip.bufferId !== "string" || clip.bufferId === "")
      bad(`arrangement.audioClips[${i}].bufferId`, `source buffer id is empty`);
    if (clip.takeGroupId !== undefined && !takeGroupIds.has(clip.takeGroupId))
      bad(`arrangement.audioClips[${i}].takeGroupId`, `take group "${clip.takeGroupId}" does not exist`);
  });
  (arr.midiClips ?? []).forEach((clip, i) => {
    if (!trackIds.has(clip.trackId))
      bad(`arrangement.midiClips[${i}].trackId`, `track "${clip.trackId}" does not exist`);
    if (!patternIds.has(clip.patternId))
      bad(`arrangement.midiClips[${i}].patternId`, `pattern "${clip.patternId}" does not exist`);
  });
  (arr.automationClips ?? []).forEach((clip, i) => {
    if (!targetResolves(doc, clip.target))
      bad(`arrangement.automationClips[${i}].target`, `does not resolve (${JSON.stringify(clip.target)})`);
    for (const [j, linked] of (clip.linkedTargets ?? []).entries())
      if (!targetResolves(doc, linked))
        bad(`arrangement.automationClips[${i}].linkedTargets[${j}]`, `does not resolve`);
  });
  (arr.transitions ?? []).forEach((t, i) => {
    if (!sceneClipIds.has(t.fromClipId))
      bad(`arrangement.transitions[${i}].fromClipId`, `clip "${t.fromClipId}" does not exist`);
    if (!sceneClipIds.has(t.toClipId))
      bad(`arrangement.transitions[${i}].toClipId`, `clip "${t.toClipId}" does not exist`);
  });
  (arr.clipGroups ?? []).forEach((g, i) => {
    if (g.clipIds.length === 0) bad(`arrangement.clipGroups[${i}]`, `group with no members survives`);
    for (const clipId of g.clipIds)
      if (!allClipIds.has(clipId)) bad(`arrangement.clipGroups[${i}].clipIds`, `clip "${clipId}" does not exist`);
  });
  (arr.takeGroups ?? []).forEach((g, i) => {
    if (!trackIds.has(g.trackId)) bad(`arrangement.takeGroups[${i}].trackId`, `track "${g.trackId}" does not exist`);
  });

  // ---- markers -------------------------------------------------------------
  for (const marker of doc.markers)
    if (marker.linkedClipId !== undefined && !allClipIds.has(marker.linkedClipId))
      bad(`markers.${marker.id}.linkedClipId`, `clip "${marker.linkedClipId}" does not exist`);

  // ---- automation / modulation --------------------------------------------
  for (const lane of doc.automation)
    if (!targetResolves(doc, lane.target))
      bad(`automation.${lane.id}.target`, `does not resolve (${JSON.stringify(lane.target)})`);
  for (const lane of doc.sceneAutomation) {
    if (!sceneIds.has(lane.sceneId))
      bad(`sceneAutomation.${lane.id}.sceneId`, `scene "${lane.sceneId}" does not exist`);
    if (!targetResolves(doc, lane.target))
      bad(`sceneAutomation.${lane.id}.target`, `does not resolve (${JSON.stringify(lane.target)})`);
  }
  for (const lfo of doc.lfos) {
    if (!busIds.has(lfo.trackId)) bad(`lfos.${lfo.id}.trackId`, `bus "${lfo.trackId}" does not exist`);
    if (lfo.sourceTrackId !== undefined && !trackIds.has(lfo.sourceTrackId))
      bad(`lfos.${lfo.id}.sourceTrackId`, `track "${lfo.sourceTrackId}" does not exist`);
    if (lfo.target !== undefined && !targetResolves(doc, lfo.target))
      bad(`lfos.${lfo.id}.target`, `does not resolve (${JSON.stringify(lfo.target)})`);
  }
  for (const macro of doc.macros)
    for (const mapping of macro.mappings) {
      if (!busIds.has(mapping.trackId))
        bad(`macros.${macro.id}.mappings.${mapping.id}.trackId`, `bus "${mapping.trackId}" does not exist`);
      if (mapping.target !== undefined && !targetResolves(doc, mapping.target))
        bad(`macros.${macro.id}.mappings.${mapping.id}.target`, `does not resolve`);
    }

  // ---- MIDI ----------------------------------------------------------------
  for (const mapping of doc.midi?.ccMappings ?? [])
    if (mapping.target && !targetResolves(doc, mapping.target))
      bad(`midi.ccMappings.${mapping.id}.target`, `does not resolve (${JSON.stringify(mapping.target)})`);
  if (doc.midi?.aftertouchTarget && !targetResolves(doc, doc.midi.aftertouchTarget))
    bad("midi.aftertouchTarget", `does not resolve (${JSON.stringify(doc.midi.aftertouchTarget)})`);
  for (const mapping of doc.midi?.drumNoteMap ?? [])
    if (!padIds.has(mapping.padId))
      bad(`midi.drumNoteMap.note${mapping.midiNote}`, `pad "${mapping.padId}" does not exist`);

  return out;
}

/** Asserts `doc` has no dangling/duplicate reference, printing the findings. */
function expectClean(doc: ProjectDocument, label: string): void {
  const findings = auditReferences(doc);
  expect(findings, `${label} left ${findings.length} violation(s): ${findings.join(" ;; ")}`).toEqual([]);
}

/** A full MidiConfig, for the case the fixture document has none. */
const DEFAULT_MIDI: MidiConfig = {
  enabled: false,
  deviceId: "",
  drumChannel: 0,
  instrumentChannel: 0,
  pitchBendRange: 2,
  ccMappings: [],
  drumNoteMap: [],
};

/** A doc that exercises every reference class the auditor knows about. */
function richDoc(): ProjectDocument {
  let doc = testDoc();
  const drumId = doc.tracks.find((t) => t.kind === "drum")!.id;
  const sceneId = doc.scenes[0].id;

  // Second pattern so pattern deletion is legal.
  doc = createPattern(doc).execute(doc);
  const patternId = doc.patterns[doc.patterns.length - 1].id;
  // testDoc() ships with empty effect chains, so add one: the fxId-keyed
  // reference classes (automation lane, LFO target, CC mapping, scene packs)
  // have nothing to point at otherwise, and a class that corrupts nothing
  // would "pass" for the wrong reason. `compressor.threshold` is a real DEEP
  // param, so `fxParam` targets on it survive normalization instead of being
  // dropped as unknown — a target that vanishes on load would leave the
  // corruption class with nothing to corrupt.
  doc = addEffect(doc, drumId, "compressor").execute(doc);
  // Re-read the track AFTER the mutation. Holding the pre-mutation track
  // object here reads as the honest bug it was: `drum.effects[0]` stayed
  // undefined, every fxId-keyed reference was silently skipped, and the CC
  // mapping fixture never existed — the corruption class then failed on
  // `undefined`, which reads like a product failure and is not one.
  const drum = doc.tracks.find((t) => t.kind === "drum")!;
  const padId = drum.pads[0].id;
  const inst = doc.tracks.find((t) => t.kind === "instrument");

  // One clip of every system: scene clip, audio clip, midi clip.
  doc = addArrangementClip(doc, sceneId, 4, 2).execute(doc);
  const sceneClipId = doc.arrangement.clips[doc.arrangement.clips.length - 1].id;
  doc = addAudioClip(doc, drum.id, "buf-1", 0, 4).execute(doc);
  if (inst) doc = addMidiClip(doc, inst.id, patternId, 0, STEP_TICKS * 64).execute(doc);
  // A second instrument clip for the midi-clip-corruption classes.
  const secondPattern = doc.patterns[0].id;
  if (inst) doc = addMidiClip(doc, inst.id, secondPattern, STEP_TICKS * 128, STEP_TICKS * 64).execute(doc);

  const fxId = drum.effects[0]?.id;
  // The CC mapping needs a param the device actually declares, otherwise the
  // normalizer drops it as invalid and the class below would corrupt nothing.
  const ccTarget = fxId
    ? ({ kind: "fxParam", trackId: drum.id, fxId, paramId: "threshold" } as unknown as AutomationTarget)
    : undefined;
  return normalizeProject({
    ...doc,
    markers: [...doc.markers, { id: "mk-1", name: "Drop", type: "drop", tick: 0, linkedClipId: sceneClipId }],
    sceneAutomation: [
      ...doc.sceneAutomation,
      { id: "sa-1", sceneId, target: { kind: "trackGain", trackId: drum.id }, points: [{ tick: 0, value: 0.5 }] },
    ],
    automation: [
      ...doc.automation,
      { id: "au-1", target: { kind: "trackPan", trackId: drum.id }, points: [{ tick: 0, value: 0 }] },
      ...(ccTarget ? [{ id: "au-2", target: ccTarget, points: [{ tick: 0, value: 0 }] }] : []),
    ],
    lfos: [
      ...doc.lfos,
      { id: "lfo-1", trackId: drum.id, param: "gain", amount: 0.5 },
      ...(ccTarget ? [{ id: "lfo-2", trackId: drum.id, param: "gain" as const, amount: 0.5, target: ccTarget }] : []),
    ],
    midi: {
      ...(doc.midi ?? DEFAULT_MIDI),
      ccMappings: [
        ...(doc.midi?.ccMappings ?? []),
        ...(ccTarget ? [{ id: "cc-1", ccNumber: 7, target: ccTarget, min: 0, max: 1 }] : []),
      ],
      drumNoteMap: [...(doc.midi?.drumNoteMap ?? []), { midiNote: 36, padId }],
    },
    patterns: doc.patterns.map((p) => (p.id === patternId ? { ...p, rows: { ...p.rows, [padId]: [0.9] } } : p)),
    arrangement: {
      ...doc.arrangement,
      clipGroups: [{ id: "cg-1", clipIds: [sceneClipId] }],
    },
  });
}

describe("referential integrity — auditor calibration", () => {
  // Without this the auditor could be vacuously green: an auditor that finds
  // nothing even on a document built from garbage measures nothing.
  it("the auditor itself reports a violation when given one", () => {
    const doc = testDoc();
    const findings = auditReferences({ ...doc, activePatternId: "ghost" });
    expect(findings.some((f) => f.startsWith("activePatternId"))).toBe(true);
  });

  it("the auditor sees a duplicate id", () => {
    const doc = testDoc();
    const findings = auditReferences({ ...doc, tracks: [...doc.tracks, doc.tracks[0]] });
    expect(findings.some((f) => f.includes("duplicate id"))).toBe(true);
  });

  it("a canonical document is internally consistent", () => {
    expect(auditReferences(testDoc())).toEqual([]);
    expect(auditReferences(deterministicTestDoc())).toEqual([]);
  });

  it("the rich fixture is internally consistent before corruption", () => {
    expect(auditReferences(richDoc())).toEqual([]);
  });
});

describe("referential integrity — corruption classes vs normalizeProject", () => {
  /**
   * Each class injects ONE broken reference and asserts normalizeProject
   * repairs it. A class is a product of the table, not a hand-written case per
   * field, so the coverage claim stays checkable.
   */
  const corruptionClasses: { name: string; inject: (doc: ProjectDocument) => ProjectDocument; expected: string }[] = [
    {
      name: "audio clip points at a deleted track",
      inject: (doc) => {
        const [clip] = doc.arrangement.audioClips!;
        return { ...doc, arrangement: { ...doc.arrangement, audioClips: [{ ...clip, trackId: "ghost-track" }] } };
      },
      expected: "audioClips[0].trackId",
    },
    {
      name: "midi clip points at a deleted track",
      inject: (doc) => {
        const [clip] = doc.arrangement.midiClips!;
        return { ...doc, arrangement: { ...doc.arrangement, midiClips: [{ ...clip, trackId: "ghost-track" }] } };
      },
      expected: "midiClips[0].trackId",
    },
    {
      name: "midi clip points at a deleted pattern",
      inject: (doc) => {
        const [clip] = doc.arrangement.midiClips!;
        return { ...doc, arrangement: { ...doc.arrangement, midiClips: [{ ...clip, patternId: "ghost" }] } };
      },
      expected: "midiClips[0].patternId",
    },
    {
      name: "scene clip points at a deleted scene",
      inject: (doc) => {
        const [clip] = doc.arrangement.clips;
        return { ...doc, arrangement: { ...doc.arrangement, clips: [{ ...clip, sceneId: "ghost-scene" }] } };
      },
      expected: "clips[0].sceneId",
    },
    {
      name: "automation lane points at a deleted effect instance",
      inject: (doc) => {
        const [lane] = doc.automation;
        return {
          ...doc,
          automation: [
            {
              ...lane,
              target: { kind: "fxParam", trackId: lane.target.trackId, fxId: "ghost-fx", paramId: "threshold" },
            },
          ],
        };
      },
      expected: "automation.",
    },
    {
      name: "automation lane points at a deleted track",
      inject: (doc) => {
        const [lane] = doc.automation;
        return { ...doc, automation: [{ ...lane, target: { ...lane.target, trackId: "ghost-track" } }] };
      },
      expected: "automation.",
    },
    {
      name: "scene automation points at a deleted scene",
      inject: (doc) => {
        const [lane] = doc.sceneAutomation;
        return { ...doc, sceneAutomation: [{ ...lane, sceneId: "ghost-scene" }] };
      },
      expected: "sceneAutomation.",
    },
    {
      name: "lfo points at a deleted bus",
      inject: (doc) => {
        const [lfo] = doc.lfos;
        return { ...doc, lfos: [{ ...lfo, trackId: "ghost-track" }] };
      },
      expected: "lfos.",
    },
    {
      name: "lfo generic target points at a deleted effect",
      inject: (doc) => {
        const [lfo] = doc.lfos;
        return {
          ...doc,
          lfos: [{ ...lfo, target: { kind: "fxParam", trackId: lfo.trackId, fxId: "ghost-fx", paramId: "gain" } }],
        };
      },
      expected: "lfos.",
    },
    {
      name: "macro mapping points at a deleted bus",
      inject: (doc) => {
        const [macro] = doc.macros;
        return { ...doc, macros: [{ ...macro, mappings: [{ ...macro.mappings[0], trackId: "ghost-track" }] }] };
      },
      expected: "macros.",
    },
    {
      name: "midi cc mapping points at a deleted effect",
      inject: (doc) => {
        const [mapping] = doc.midi!.ccMappings;
        return {
          ...doc,
          midi: {
            ...doc.midi!,
            ccMappings: [{ ...mapping, target: { ...mapping.target!, fxId: "ghost-fx" } }],
          },
        };
      },
      expected: "midi.ccMappings.",
    },
    {
      name: "drum note map points at a deleted pad",
      inject: (doc) => ({ ...doc, midi: { ...doc.midi!, drumNoteMap: [{ midiNote: 36, padId: "ghost-pad" }] } }),
      expected: "midi.drumNoteMap.",
    },
    {
      name: "pattern row keys a deleted pad",
      inject: (doc) => {
        const [pattern] = doc.patterns;
        return { ...doc, patterns: [{ ...pattern, rows: { ...pattern.rows, "ghost-pad": [0.9] } }] };
      },
      expected: "patterns[0].rows",
    },
    {
      name: "pattern notes key a deleted track",
      inject: (doc) => {
        const [pattern] = doc.patterns;
        return { ...doc, patterns: [{ ...pattern, notes: { "ghost-track": [] } }] };
      },
      expected: "patterns[0].notes",
    },
    {
      name: "marker links a deleted clip",
      inject: (doc) => ({ ...doc, markers: doc.markers.map((m) => ({ ...m, linkedClipId: "ghost-clip" })) }),
      expected: "linkedClipId",
    },
    {
      name: "clip group keeps a deleted clip member",
      inject: (doc) => {
        const [group] = doc.arrangement.clipGroups!;
        return {
          ...doc,
          arrangement: { ...doc.arrangement, clipGroups: [{ ...group, clipIds: [...group.clipIds, "ghost-clip"] }] },
        };
      },
      expected: "clipGroups[0].clipIds",
    },
    {
      name: "sidechain points at a deleted track",
      inject: (doc) => {
        const track = doc.tracks[0];
        const fx = (track as { effects: { id: string }[] }).effects[0];
        return {
          ...doc,
          tracks: doc.tracks.map((t) =>
            t.id === track.id ? ({ ...t, effects: [{ ...fx, sidechainTrackId: "ghost-track" }] } as typeof t) : t,
          ),
        };
      },
      expected: "sidechainTrackId",
    },
    {
      name: "track groupId points at a deleted group",
      inject: (doc) => {
        const target = doc.tracks.find((t) => t.kind === "drum")!;
        return {
          ...doc,
          tracks: doc.tracks.map((t) => (t.id === target.id ? ({ ...t, groupId: "ghost-group" } as typeof t) : t)),
        };
      },
      expected: "groupId",
    },
    {
      name: "transition points at a deleted clip",
      inject: (doc) => ({
        ...doc,
        arrangement: {
          ...doc.arrangement,
          transitions: [
            {
              id: "tr-1",
              fromClipId: doc.arrangement.clips[0].id,
              toClipId: "ghost-clip",
              type: "custom" as const,
              lengthBars: 1,
            },
          ],
        },
      }),
      expected: "toClipId",
    },
    {
      name: "audio clip points at a deleted take group",
      inject: (doc) => {
        const [clip] = doc.arrangement.audioClips!;
        return {
          ...doc,
          arrangement: { ...doc.arrangement, audioClips: [{ ...clip, takeGroupId: "ghost-take" }] },
        };
      },
      expected: "takeGroupId",
    },
    {
      name: "duplicate track id",
      inject: (doc) => ({ ...doc, tracks: [...doc.tracks, doc.tracks[0]] }),
      expected: "duplicate id",
    },
    {
      name: "duplicate pattern id",
      inject: (doc) => ({ ...doc, patterns: [...doc.patterns, doc.patterns[0]] }),
      expected: "duplicate id",
    },
    {
      name: "duplicate scene id",
      inject: (doc) => ({ ...doc, scenes: [...doc.scenes, doc.scenes[0]] }),
      expected: "duplicate id",
    },
    {
      name: "duplicate marker id",
      inject: (doc) => ({ ...doc, markers: [...doc.markers, doc.markers[0]] }),
      expected: "duplicate id",
    },
    {
      name: "duplicate automation lane id",
      inject: (doc) => ({ ...doc, automation: [...doc.automation, doc.automation[0]] }),
      expected: "duplicate id",
    },
    {
      name: "duplicate macro id",
      inject: (doc) => ({ ...doc, macros: [...doc.macros, doc.macros[0]] }),
      expected: "duplicate id",
    },
    {
      name: "duplicate lfo id",
      inject: (doc) => ({ ...doc, lfos: [...doc.lfos, doc.lfos[0]] }),
      expected: "duplicate id",
    },
    {
      name: "duplicate audio clip id",
      inject: (doc) => {
        const [clip] = doc.arrangement.audioClips!;
        return { ...doc, arrangement: { ...doc.arrangement, audioClips: [clip, { ...clip }] } };
      },
      expected: "duplicate id",
    },
  ];

  it.each(corruptionClasses)("$name is repaired by normalizeProject", ({ inject, expected }) => {
    const corrupted = inject(richDoc());
    // The corruption must be real before the repair is meaningful.
    expect(auditReferences(corrupted).length).toBeGreaterThan(0);
    const repaired = normalizeProject(corrupted);
    const remaining = auditReferences(repaired).filter((f) => f.includes(expected));
    expect(remaining, `${expected} survived normalizeProject: ${remaining.join(" ;; ")}`).toEqual([]);
  });
});

describe("referential integrity — documented inert-by-contract ids", () => {
  // These are NOT dangling references by design, and the auditor deliberately
  // does not flag them. Without this pin, a future reader sees a scene
  // referencing a missing macro and "fixes" it — destroying scene automation
  // because one referenced entity is temporarily absent. Each is a NAMED
  // identity matched at use time (schema.ts: packs / macros / ccRemaps /
  // ccOverrides / modulators blocks).
  it("a scene keeps a macro pin for a macro that is not present", () => {
    const base = richDoc();
    const doc = normalizeProject({
      ...base,
      scenes: [{ ...base.scenes[0], macros: { ghost: 0.4 } }, ...base.scenes.slice(1)],
    });
    expect(doc.scenes[0].macros).toEqual({ ghost: 0.4 });
  });

  it("a scene keeps ccRemaps / ccOverrides / modulators / packs entries for unknown ids", () => {
    const base = richDoc();
    const scene = {
      ...base.scenes[0],
      ccRemaps: ["ghost"],
      ccOverrides: { ghost: { channel: 3 } },
      modulators: { ghost: { seed: "x" } },
      packs: { ghost: "pair" },
    };
    const doc = normalizeProject({ ...base, scenes: [scene, ...base.scenes.slice(1)] });
    expect(doc.scenes[0].ccRemaps).toEqual(["ghost"]);
    expect(doc.scenes[0].ccOverrides).toEqual({ ghost: { channel: 3 } });
    expect(doc.scenes[0].modulators).toEqual({ ghost: { seed: "x" } });
    expect(doc.scenes[0].packs).toEqual({ ghost: "pair" });
  });
});

describe("referential integrity — delete commands leave no stale references", () => {
  it("deleteTrack: every reference class is clean afterwards", () => {
    const h = commandHarness(richDoc());
    const victim = h.doc.tracks.find((t) => t.kind === "drum")!;
    expectClean(deleteTrack(h.doc, victim.id).execute(h.doc), "deleteTrack");
  });

  it("deleteTrack: undo restores a fully referential document", () => {
    const store = new ProjectStore(richDoc());
    const victim = store.doc.tracks.find((t) => t.kind === "drum")!;
    store.execute(deleteTrack(store.doc, victim.id));
    expectClean(store.doc, "deleteTrack applied");
    store.undo();
    expectClean(store.doc, "deleteTrack undone");
    expect(store.doc.tracks.some((t) => t.id === victim.id)).toBe(true);
    store.redo();
    expectClean(store.doc, "deleteTrack redone");
  });

  it("deleteReturnTrack: bus-scoped references are clean afterwards", () => {
    const store = new ProjectStore(richDoc());
    const ret = store.doc.returns[0];
    if (!ret) throw new Error("fixture must contain a return track for this case to mean anything");
    store.execute(deleteReturnTrack(store.doc, ret.id));
    expectClean(store.doc, "deleteReturnTrack applied");
    store.undo();
    expectClean(store.doc, "deleteReturnTrack undone");
  });

  it("deletePattern: every reference class is clean afterwards", () => {
    const h = commandHarness(richDoc());
    const victim = h.doc.patterns[h.doc.patterns.length - 1];
    expectClean(deletePattern(h.doc, victim.id).execute(h.doc), "deletePattern");
  });

  it("removeEffectFromTracks: automation/macro/LFO lanes at the device are cleaned", () => {
    const store = new ProjectStore(richDoc());
    const drum = store.doc.tracks.find((t) => t.kind === "drum")!;
    store.execute(removeEffectFromTracks(store.doc, [drum.id], drum.effects[0].type));
    expectClean(store.doc, "removeEffectFromTracks applied");
    store.undo();
    expectClean(store.doc, "removeEffectFromTracks undone");
  });
});
