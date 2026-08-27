/**
 * Collab hardening — regression suite for the CRDT layer.
 *
 * Covers the three systemic weaknesses found in the audit:
 *   1. Field loss: pattern AI provenance (generation/assist/phrasePlan) was
 *      dropped in BOTH directions by the Y.Doc adapter.
 *   2. Clobbering: the command fallback rewrote whole collections, so a
 *      stale snapshot erased a peer's concurrent edit to sibling entities.
 *   3. Unsanitized reads: doc_ was projected straight from the Y.Doc, so a
 *      dangling activePatternId (remote peer, offline merge) reached the
 *      scheduler and crashed playback.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type {
  DrumTrack,
  InstrumentTrack,
  Pattern,
  PatternAssist,
  PatternGeneration,
  ProjectDocument,
} from "../src/project-model/types";
import { yDocToProject, projectToYDoc, applyProjectToYMap } from "../src/collab/YDocAdapter";
import { YDocStore } from "../src/collab/YDocStore";
import { createScene, setProjectName, setTrackParams } from "../src/commands/commands";

// ─── Harness ────────────────────────────────────────────────────────────────

/** Two peers sharing content via manual bidirectional update exchange. */
function makePeerPair(doc: ProjectDocument) {
  const a = YDocStore.fromDocument(doc);
  const b = new YDocStore(new Y.Doc());
  const sync = () => {
    Y.applyUpdate(b.yDocRef, Y.encodeStateAsUpdate(a.yDocRef));
    Y.applyUpdate(a.yDocRef, Y.encodeStateAsUpdate(b.yDocRef));
  };
  // Initial content must reach the second peer before the test interacts.
  sync();
  return { a, b, sync };
}

const house = () => createProjectFromTemplate("house");

// ─── 1. Pattern provenance round-trip ───────────────────────────────────────

describe("YDocAdapter — pattern provenance (generation / assist / phrasePlan)", () => {
  it("round-trips AI provenance fields losslessly", () => {
    // Regression: patternToYMap/yMapToPattern only knew id/name/stepCount/
    // rows/notes/stepMeta — one collaborative edit permanently stripped the
    // generation recipe, breaking recipe-based variations and Assist hashes.
    const doc = house();
    const generation: PatternGeneration = {
      engineId: "local-markov",
      engineVersion: "2.1.0",
      seed: "abc123",
      genre: "house",
      style: "deep",
      grooveId: "g1",
      stepCount: 16,
      ghostWeight: 0.2,
      microWeight: 0.1,
      velocityVariation: 0.3,
      temperature: 0.8,
      sourcePatternId: null,
      inputContentHash: null,
      outputContentHash: "hash-out",
      intentHash: "hash-intent",
      intent: { foo: "bar", nested: { n: 1 } },
      quality: {
        styleDistance: 0.1,
        styleAccepted: true,
        syncopation: 0.4,
        anchorCoverage: 0.9,
        melodicMotifRepetition: 0.5,
        melodicRestRatio: 0.25,
        melodicDurationLongRatio: 0.3,
      },
    };
    const assist: PatternAssist = {
      engineId: "assist-1",
      engineVersion: "1.0.0",
      operation: "vary",
      seed: "zzz",
      sourceContentHash: "in",
      outputContentHash: "out",
    };
    const phrasePlan = [
      { bar: 0, startStep: 0, endStep: 16, section: "main" as const },
      { bar: 1, startStep: 0, endStep: 8, section: "fill" as const },
    ];
    const withProvenance: ProjectDocument = {
      ...doc,
      patterns: doc.patterns.map((p, i) => (i === 0 ? { ...p, generation, assist, phrasePlan } : p)),
    };

    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(withProvenance, yMap);
    const restored = yDocToProject(yMap);

    expect(restored.patterns[0].generation).toEqual(generation);
    expect(restored.patterns[0].assist).toEqual(assist);
    expect(restored.patterns[0].phrasePlan).toEqual(phrasePlan);
  });

  it("applyProjectToYMap preserves provenance that a peer wrote (targeted diff)", () => {
    const doc = house();
    const generation: PatternGeneration = {
      engineId: "e", engineVersion: "1", seed: "s", genre: "house", style: null,
      grooveId: "g", stepCount: 16, ghostWeight: 0, microWeight: 0,
      velocityVariation: 0, temperature: 1, sourcePatternId: null,
    };
    const withGeneration: ProjectDocument = {
      ...doc,
      patterns: doc.patterns.map((p, i) => (i === 0 ? { ...p, generation } : p)),
    };
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(withGeneration, yMap);

    // A local fallback command (rename) applies over the doc that carries a
    // generation blob — the diff must not strip it.
    applyProjectToYMap(withGeneration, { ...withGeneration, name: "Renamed" }, yMap);
    const restored = yDocToProject(yMap);
    expect(restored.name).toBe("Renamed");
    expect(restored.patterns[0].generation).toEqual(generation);
  });
});

// ─── 2. Full conformance round-trip ─────────────────────────────────────────

describe("YDocAdapter — full-document conformance", () => {
  it("round-trips a fully-populated document without dropping any field", () => {
    // Guard rail: when Pattern/Track/… gains a new field, this fixture should
    // be extended — the deep-equal below then forces the adapter to keep up.
    const doc = house();
    const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const inst = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument")!;
    const pattern = doc.patterns[0];
    const scene = doc.scenes[0];

    const fixture: ProjectDocument = {
      ...doc,
      name: "Conformance",
      key: "C Major",
      tags: ["test", "full"],
      timeSignature: { numerator: 4, denominator: 4 },
      master: { masterGain: 1.25, ceilingDb: -1.5, limiterEnabled: false, clipperEnabled: true },
      groove: { swing: 0.25, humanizeTiming: 0.1, humanizeVelocity: 0.15 },
      midi: {
        enabled: true,
        deviceId: "ctrl-1",
        drumChannel: 10,
        instrumentChannel: 1,
        ccMappings: [{ id: "cc-1", ccNumber: 1, channel: 1, target: { kind: "trackGain", trackId: drum.id }, min: 0, max: 1 }],
        drumNoteMap: [{ midiNote: 36, padId: drum.pads[0].id }],
        pitchBendRange: 12,
      },
      tracks: [
        {
          ...drum,
          pads: drum.pads.map((p, i) => (i === 0 ? { ...p, sliceStart: 0.1, sliceEnd: 0.9, sliceFadeIn: 0.01, sliceReverse: true } : p)),
        },
        {
          ...inst,
          presetId: "preset-7",
          midiOutput: { enabled: true, channel: 3, deviceId: "synth-1" },
        },
      ],
      patterns: [
        {
          ...pattern,
          notes: {
            ...pattern.notes,
            [inst.id]: [...(pattern.notes[inst.id] ?? []), { id: "n1", pitch: 60, start: 0, duration: 120, velocity: 0.9 }],
          },
          stepMeta: {
            [drum.pads[0].id]: { 0: { probability: 0.9, ratchet: 2, microtiming: -0.5 } },
          },
          generation: {
            engineId: "e", engineVersion: "1", seed: "s", genre: "house", style: null,
            grooveId: "g", stepCount: 16, ghostWeight: 0, microWeight: 0,
            velocityVariation: 0, temperature: 1, sourcePatternId: null,
          },
        },
      ],
      scenes: [
        {
          ...scene,
          intensity: 0.8,
          loop: true,
          role: "drop",
          intensityCurve: [
            { offset: 0, value: 0.2 },
            { offset: 480, value: 1 },
          ],
        },
      ],
      arrangement: {
        clips: [{ id: "clip-1", sceneId: scene.id, startBar: 0, lengthBars: 4, loop: false }],
        transitions: [
          { id: "tr-1", fromClipId: "clip-1", toClipId: "clip-1", type: "fill", lengthBars: 1 },
        ],
      },
      markers: [
        { id: "mk-1", name: "Drop", type: "drop", tick: 0, linkedClipId: "clip-1", customId: "c-1" },
      ],
      automation: [
        {
          id: "auto-1",
          target: { kind: "trackGain", trackId: drum.id },
          points: [
            { tick: 0, value: 0.5 },
            { tick: 960, value: 1 },
          ],
        },
      ],
      lfos: [{ id: "lfo-1", trackId: drum.id, param: "pan", wave: "sine", rateMode: "sync", rateHz: 2, division: 2, amount: 0.3 }],
      macros: [
        { id: "macro-1", name: "DRUMS", value: 0.5, mappings: [{ id: "map-1", trackId: drum.id, param: "gain", amount: 0.25, source: "macro" }] },
      ],
    };

    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(fixture, yMap);
    expect(yDocToProject(yMap)).toEqual(fixture);

    // Idempotent targeted apply must not mutate anything observable.
    applyProjectToYMap(fixture, fixture, yMap);
    expect(yDocToProject(yMap)).toEqual(fixture);
  });
});

// ─── 3. Concurrent peer interleaving ────────────────────────────────────────

describe("collab — concurrent peer interleaving", () => {
  it("a stale-snapshot fallback command does not erase a peer's edit to a sibling track", () => {
    // Regression: the fallback used to rewrite whole collections from the
    // command's precomputed `next`, wiping anything a peer changed between
    // command creation and dispatch. With the targeted diff, entities the
    // command did not touch are never written at all.
    const { a, b, sync } = makePeerPair(house());
    const drumA = a.doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const instA = a.doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument")!;

    // Peer B renames the INSTRUMENT track (field the stale command never touches).
    b.execute(setTrackParams(b.doc, instA.id, { name: "Peer B Renamed" }));
    // Peer A builds a command from a now-stale snapshot and dispatches it late.
    const staleDoc = a.doc;
    b.execute(setTrackParams(b.doc, drumA.id, { name: "B touched drums too" }));
    a.execute(createScene(staleDoc, "Local Scene"));

    sync();
    sync(); // settle both directions

    for (const peer of [a, b]) {
      const doc = peer.doc;
      expect(doc.scenes.some((s) => s.name === "Local Scene")).toBe(true);
      expect(doc.tracks.find((t) => t.id === instA.id)?.name).toBe("Peer B Renamed");
      expect(doc.tracks.find((t) => t.id === drumA.id)?.name).toBe("B touched drums too");
    }
  });

  it("two peers creating scenes concurrently both survive the merge", () => {
    const { a, b, sync } = makePeerPair(house());
    a.execute(createScene(a.doc, "From A"));
    b.execute(createScene(b.doc, "From B"));
    sync();
    sync();
    for (const peer of [a, b]) {
      const names = peer.doc.scenes.map((s) => s.name);
      expect(names).toContain("From A");
      expect(names).toContain("From B");
    }
  });
});

// ─── 4. Sanitized reads ─────────────────────────────────────────────────────

describe("YDocStore — normalizeProject on read", () => {
  it("repairs a dangling activePatternId injected by a foreign peer", () => {
    // Regression: doc_ was projected straight from the Y.Doc; a dangling id
    // (offline merge, older client) made getActivePattern() throw on every
    // scheduler tick — playback froze until reload.
    const store = YDocStore.fromDocument(house());
    store.yDocRef.transact(() => {
      store.yDocRef.getMap("project").set("activePatternId", "ghost-pattern");
    });
    expect(store.doc.activePatternId).toBe(store.doc.patterns[0].id);
  });
});

// ─── 5. Undo history labels ─────────────────────────────────────────────────

describe("YDocStore — undo history labels", () => {
  it("redo keeps the original command label (not 'Edit')", () => {
    // Regression: stack-item-added fired again on redo and pendingLabel was
    // null, so the label written at execute time was overwritten with "Edit".
    const store = YDocStore.fromDocument(house());
    store.execute(setProjectName(store.doc, "Collab Name"));
    const label = store.lastCommandLabel;
    expect(label).toContain("Collab Name");
    store.undo();
    store.redo();
    expect(store.lastCommandLabel).toBe(label);
  });
});

// ─── 6. replaceDoc atomicity ────────────────────────────────────────────────

describe("YDocStore — replaceDoc", () => {
  it("clears and repopulates in a single transaction (one update frame)", () => {
    // Regression: yMap.clear() + projectToYDoc() ran as two untagged updates,
    // so remote peers received an intermediate EMPTY project frame.
    const store = YDocStore.fromDocument(house());
    let updates = 0;
    const handler = () => {
      updates += 1;
    };
    store.yDocRef.on("update", handler);
    const next = house();
    store.replaceDoc({ ...next, name: "Replaced" });
    store.yDocRef.off("update", handler);
    expect(updates).toBe(1);
    expect(store.doc.name).toBe("Replaced");
    expect(store.doc.tracks.length).toBe(next.tracks.length);
  });
});

// ─── 7. Performance gate ────────────────────────────────────────────────────

describe("collab — performance gate", () => {
  it("normalize-on-read and targeted apply stay interactive on a large document", () => {
    // normalizeProject now runs on EVERY Y.Doc update (readDoc). This gate
    // keeps its cost — plus a full targeted apply — honest on a big project
    // (40 patterns × 32 steps, 12 tracks) so UI frames are never eaten.
    const base = house();
    const drum = base.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const stepCount = 32;
    const bigPattern = {
      ...base.patterns[0],
      id: "pattern-big",
      stepCount,
      rows: Object.fromEntries(
        drum.pads.map((pad) => [pad.id, new Array<number>(stepCount).fill(0).map((_, i) => (i % 4 === 0 ? 0.8 : 0))]),
      ),
      notes: {} as Pattern["notes"],
    };
    const extraTracks = Array.from({ length: 10 }, (_, i) => ({
      ...drum,
      id: `track-extra-${i}`,
      name: `Drums ${i + 2}`,
      pads: drum.pads.map((pad, padIdx) => ({ ...pad, id: `track-extra-${i}-pad-${padIdx}` })),
    }));
    const bigDoc: ProjectDocument = {
      ...base,
      tracks: [...base.tracks, ...extraTracks],
      patterns: [
        bigPattern,
        ...Array.from({ length: 39 }, (_, i) => ({ ...bigPattern, id: `pattern-big-${i}`, name: `Big ${i}` })),
      ],
    };

    const store = YDocStore.fromDocument(bigDoc);

    // Cold read: projection + full normalization.
    let start = performance.now();
    for (let i = 0; i < 5; i++) store.refreshSnapshot();
    const readMs = (performance.now() - start) / 5;

    // Warm apply: identical doc → the diff must write (almost) nothing.
    start = performance.now();
    applyProjectToYMap(store.doc, store.doc, store.yDocRef.getMap("project"));
    const applyMs = performance.now() - start;

    // Generous budgets — catching order-of-magnitude regressions, not noise.
    expect(readMs).toBeLessThan(25);
    expect(applyMs).toBeLessThan(25);
  });
});
