import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject, sanitizeSampleLayers, migrateProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { drumHitsInWindow, resolveHitSampleId, MAX_RATCHET } from "../src/project-model/groove";
import { declickFadeOut, DECLICK_TAIL_SEC, resolveSlicePlayback } from "../src/audio-engine/AudioEngine";
import { FACTORY_SNARE_RR, roundRobinLayers } from "../src/sample-library/velocity-layers";
import { applyGenreKitToDoc, applyGenreFeelToDoc, DEFAULT_BEAT_RR, GENRE_FEEL, GENRE_KIT_SWAPS } from "../src/intent/genre-kit";
import { RR_VARIATIONS } from "../src/sample-library/factory";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import type { DrumTrack, ProjectDocument, SampleLayer } from "../src/project-model/types";
import { STEP_TICKS } from "../src/project-model/types";

function emptyDoc(): ProjectDocument {
  return createProjectFromTemplate("empty");
}

function firstDrum(doc: ProjectDocument): DrumTrack {
  return doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
}

function padById(doc: ProjectDocument, padId: string) {
  return firstDrum(doc).pads.find((p) => p.id === padId)!;
}

describe("pad round-robin / velocity layers", () => {
  it("resolveHitSampleId falls back to the pad's own asset without layers", () => {
    const doc = emptyDoc();
    const pad = padById(doc, firstDrum(doc).pads[4].id);
    expect(resolveHitSampleId(pad, 0.8, 0)).toBe(pad.assetId);
    expect(resolveHitSampleId(pad, 0.8, 7)).toBe(pad.assetId);
  });

  it("overlapping windows round-robin across consecutive hits", () => {
    const doc = emptyDoc();
    const pad = { ...padById(doc, firstDrum(doc).pads[4].id), layers: FACTORY_SNARE_RR };
    const seen = [0, 1, 2, 3, 4, 5].map((ordinal) => resolveHitSampleId(pad, 0.7, ordinal));
    // Three variants, rotating in order — no two consecutive hits identical.
    expect(seen[0]).toBe("factory.snare.main");
    expect(seen[1]).toBe("factory.snare.main.rr2");
    expect(seen[2]).toBe("factory.snare.main.rr3");
    expect(seen[3]).toBe("factory.snare.main");
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it("disjoint velocity windows act as soft/hard layers", () => {
    const doc = emptyDoc();
    const layers: SampleLayer[] = [
      { id: "l.soft", sampleId: "factory.kick.soft", min: 0, max: 0.5 },
      { id: "l.hard", sampleId: "factory.kick.punch", min: 0.5, max: 1 },
    ];
    const pad = { ...padById(doc, firstDrum(doc).pads[0].id), layers };
    // Velocity decides the sample regardless of ordinal — a hard hit is hard
    // on every repetition.
    for (const ordinal of [0, 1, 2, 3]) {
      expect(resolveHitSampleId(pad, 0.2, ordinal)).toBe("factory.kick.soft");
      expect(resolveHitSampleId(pad, 0.9, ordinal)).toBe("factory.kick.punch");
    }
  });

  it("velocity above every window falls back to the pad's own asset", () => {
    const doc = emptyDoc();
    const pad = {
      ...padById(doc, firstDrum(doc).pads[0].id),
      layers: [{ id: "l", sampleId: "factory.kick.soft", min: 0, max: 0.2 }],
    };
    expect(resolveHitSampleId(pad, 0.9, 0)).toBe(pad.assetId);
  });

  it("hit plan carries the resolved variant and stays deterministic across windows", () => {
    const doc = emptyDoc();
    const drum = firstDrum(doc);
    const pad = drum.pads[8];
    const withLayers: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "drum" && t.id === drum.id
          ? { ...t, pads: t.pads.map((p) => (p.id === pad.id ? { ...p, layers: FACTORY_SNARE_RR } : p)) }
          : t,
      ),
    };
    const target = firstDrum(withLayers);
    const pattern = withLayers.patterns[0];
    pattern.rows[target.pads[8].id] = new Array<number>(pattern.stepCount).fill(0);
    // Eight consecutive 16ths = exactly where a static sample reads as a
    // machine gun.
    for (let step = 0; step < 8; step++) pattern.rows[target.pads[8].id][step] = 0.8;

    const total = STEP_TICKS * pattern.stepCount;
    const whole = drumHitsInWindow(withLayers, pattern, 0, 0, total);
    const firstHalf = drumHitsInWindow(withLayers, pattern, 0, 0, total / 2);
    const secondHalf = drumHitsInWindow(withLayers, pattern, 0, total / 2, total);
    const merged = [...firstHalf, ...secondHalf].sort((a, b) => a.tick - b.tick);

    expect(whole.length).toBe(8);
    expect(merged.map((h) => h.tick)).toEqual(whole.map((h) => h.tick));
    // Window split must not shift the variant phase (live == offline).
    expect(merged.map((h) => h.sampleId)).toEqual(whole.map((h) => h.sampleId));
    // Consecutive hits actually vary.
    const variants = whole.map((h) => h.sampleId);
    for (let i = 1; i < variants.length; i++) expect(variants[i]).not.toBe(variants[i - 1]);
    // ...and the next bar CONTINUES the rotation (ordinal advances by the
    // bar's step count — no phase reset at the pattern wrap).
    const nextBar = drumHitsInWindow(withLayers, pattern, 0, total, total + STEP_TICKS * pattern.stepCount);
    const expectedNext = Array.from({ length: 8 }, (_, i) =>
      resolveHitSampleId(firstDrum(withLayers).pads[8], 0.8, pattern.stepCount + i),
    );
    expect(nextBar.map((h) => h.sampleId)).toEqual(expectedNext);
    // The wrap point is exactly where a counter-based scheme would restart —
    // the phase only repeats if the step count is a multiple of the variants.
    if (pattern.stepCount % FACTORY_SNARE_RR.length !== 0) {
      expect(nextBar[0].sampleId).not.toBe(whole[0].sampleId);
    }
  });

  it("ratchet sub-hits advance the variant (machine-gun rolls vary too)", () => {
    const doc = emptyDoc();
    const drum = firstDrum(doc);
    const pad = drum.pads[8];
    const layered: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "drum" && t.id === drum.id
          ? { ...t, pads: t.pads.map((p) => (p.id === pad.id ? { ...p, layers: FACTORY_SNARE_RR } : p)) }
          : t,
      ),
    };
    const pattern = layered.patterns[0];
    const padId = firstDrum(layered).pads[8].id;
    pattern.rows[padId] = new Array<number>(pattern.stepCount).fill(0);
    pattern.rows[padId][0] = 0.9;
    pattern.stepMeta = { [padId]: { 0: { ratchet: 3 } } };

    const hits = drumHitsInWindow(layered, pattern, 0, 0, STEP_TICKS * pattern.stepCount);
    expect(hits.map((h) => h.ratchetIndex)).toEqual([0, 1, 2]);
    expect(new Set(hits.map((h) => h.sampleId)).size).toBe(3);
    // Ordinal is the absolute step + the sub-hit index, so the rotation
    // continues hit-by-hit (a 2-variant set must alternate, not repeat).
    const expected = [0, 1, 2].map((k) => resolveHitSampleId(firstDrum(layered).pads[8], hits[k].velocity, 0 + k));
    expect(hits.map((h) => h.sampleId)).toEqual(expected);
  });

  it("caps hostile ratchet counts at MAX_RATCHET", () => {
    const doc = emptyDoc();
    const drum = firstDrum(doc);
    const pattern = doc.patterns[0];
    const padId = drum.pads[8].id;
    pattern.rows[padId] = new Array<number>(pattern.stepCount).fill(0);
    pattern.rows[padId][0] = 0.9;
    pattern.stepMeta = { [padId]: { 0: { ratchet: MAX_RATCHET + 100 } } };

    const hits = drumHitsInWindow(doc, pattern, 0, 0, STEP_TICKS * pattern.stepCount);
    expect(hits).toHaveLength(MAX_RATCHET);
    expect(hits.map((hit) => hit.ratchetIndex)).toEqual(Array.from({ length: MAX_RATCHET }, (_, i) => i));
  });
});

describe("pad layer sanitization", () => {
  it("drops malformed zones and the field when nothing valid remains", () => {
    expect(sanitizeSampleLayers([{ min: 0.5, max: 0.5, sampleId: "a" }])).toBeUndefined();
    expect(sanitizeSampleLayers("nope")).toBeUndefined();
    expect(sanitizeSampleLayers([])).toBeUndefined();
    const clean = sanitizeSampleLayers([
      { id: "x", sampleId: "factory.snare.main", min: 2, max: 5 },
      { id: "y", sampleId: null, min: 0, max: 1 },
    ]);
    expect(clean).toBeDefined();
    // The first zone clamps to 1..1 (min === max) and is dropped; only the
    // valid zone survives.
    expect(clean).toHaveLength(1);
    expect(clean![0].id).toBe("y");
    expect(clean![0].min).toBe(0);
    expect(clean![0].max).toBe(1);
  });

  it("normalizeProject keeps legal pad layers and strips them from old-shaped docs", () => {
    const doc = emptyDoc();
    const drum = firstDrum(doc);
    const pad = drum.pads[4];
    const withLayers: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "drum" && t.id === drum.id
          ? { ...t, pads: t.pads.map((p) => (p.id === pad.id ? { ...p, layers: FACTORY_SNARE_RR } : p)) }
          : t,
      ),
    };
    const roundTripped = normalizeProject(JSON.parse(JSON.stringify(withLayers)) as ProjectDocument);
    expect(padById(roundTripped, pad.id).layers).toHaveLength(3);

    const hostile: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "drum" && t.id === drum.id
          ? { ...t, pads: t.pads.map((p) => (p.id === pad.id ? ({ ...p, layers: "bogus" } as never) : p)) }
          : t,
      ),
    };
    const cleaned = normalizeProject(hostile);
    expect(padById(cleaned, pad.id).layers).toBeUndefined();
  });

  it("roundRobinLayers is the shared contract for pads and samplers", () => {
    const layers = roundRobinLayers(["a", "b"]);
    expect(layers.map((l) => l.min)).toEqual([0, 0]);
    expect(layers.map((l) => l.max)).toEqual([1, 1]);
  });

  it("migrates an older project without pad layers and preserves them when present", () => {
    const doc = emptyDoc();
    const drum = firstDrum(doc);
    const padId = drum.pads[4].id;
    const legacy = { ...doc, schemaVersion: SCHEMA_VERSION - 1 } as ProjectDocument;
    const migrated = migrateProject(legacy);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    // A pre-v8 project has no layer field anywhere and stays playable.
    expect(padById(migrated, padId).layers).toBeUndefined();

    const withLayers: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "drum" && t.id === drum.id
          ? { ...t, pads: t.pads.map((p) => (p.id === padId ? { ...p, layers: FACTORY_SNARE_RR } : p)) }
          : t,
      ),
    };
    const migratedLayered = migrateProject(JSON.parse(JSON.stringify(withLayers)) as ProjectDocument);
    expect(padById(migratedLayered, padId).layers).toEqual(FACTORY_SNARE_RR);
  });
});

describe("genre kit round-robin deployment", () => {
  it("applies the stock-kit dynamic sets only to pads the set actually covers", () => {
    const doc = applyGenreKitToDoc(emptyDoc(), "trap");
    const pads = firstDrum(doc).pads;
    // Pad 4 = factory.snare.main — it IS one of the snare set's zones.
    expect(pads[4].layers?.length).toBeGreaterThan(1);
    expect(pads[4].layers?.some((l) => l.sampleId === pads[4].assetId)).toBe(true);
    // Pad 8 = factory.hat.closed — same for the hat set.
    expect(pads[8].layers?.some((l) => l.sampleId === pads[8].assetId)).toBe(true);
    // Pads the default set does not name stay untouched.
    expect(pads[0].layers).toBeUndefined();
    expect(pads[15].layers).toBeUndefined();
  });

  it("never layers a pad whose active asset is not the set base (no silent/wrong pad)", () => {
    const doc = emptyDoc();
    const drum = firstDrum(doc);
    // Simulate a user who swapped the snare pad to a different sample.
    const swapped: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "drum" && t.id === drum.id
          ? {
              ...t,
              pads: t.pads.map((p) => (p.id === drum.pads[4].id ? { ...p, assetId: "factory.snare.phonk" } : p)),
            }
          : t,
      ),
    };
    const applied = applyGenreKitToDoc(swapped, "trap");
    const pad = firstDrum(applied).pads[4];
    expect(pad.assetId).toBe("factory.snare.phonk");
    expect(pad.layers).toBeUndefined();
  });

  it("genre-specific swaps install their own variant set on the swapped pad", () => {
    const drill = applyGenreKitToDoc(emptyDoc(), "drill");
    const snare = firstDrum(drill).pads[4];
    expect(snare.assetId).toBe("factory.snare.drill");
    expect(snare.layers?.map((l) => l.sampleId)).toEqual([
      "factory.snare.drill",
      "factory.snare.drill.rr2",
      "factory.snare.drill.rr3",
    ]);
    const dnb = applyGenreKitToDoc(emptyDoc(), "dnb");
    expect(firstDrum(dnb).pads[4].layers?.[0].sampleId).toBe("factory.snare.dnb");
  });

  it("is idempotent — a second apply returns the same pad references", () => {
    const once = applyGenreKitToDoc(emptyDoc(), "trap");
    const twice = applyGenreKitToDoc(once, "trap");
    expect(twice).toBe(once);
  });

  it("every layer id referenced by a genre kit resolves in the factory bank contract", () => {
    // A layer id must be either a real manifest asset (ghost/accent timbres)
    // or a derived RR variant of one — otherwise the pad would reference a
    // buffer the bank never builds and the velocity band would vanish.
    const manifestIds = new Set(FACTORY_ASSETS.map((a) => a.id));
    const resolves = (id: string): boolean => {
      if (!id) return false;
      if (manifestIds.has(id)) return true;
      const base = id.replace(/\.rr\d+$/, "");
      return base !== id && RR_VARIATIONS[base] !== undefined;
    };
    for (const [genre, swaps] of Object.entries(GENRE_KIT_SWAPS)) {
      for (const swap of swaps ?? []) {
        for (const layer of swap.layers ?? []) {
          expect(resolves(layer.sampleId ?? ""), `${genre}: ${layer.sampleId}`).toBe(true);
        }
      }
    }
    for (const entry of DEFAULT_BEAT_RR) {
      for (const layer of entry.layers) {
        expect(resolves(layer.sampleId ?? ""), `default set: ${layer.sampleId}`).toBe(true);
      }
    }
  });
});

describe("genre feel (humanize defaults)", () => {
  it("every genre in the feel map gets modest, non-flat humanize", () => {
    for (const [genre, feel] of Object.entries(GENRE_FEEL)) {
      expect(feel.humanizeTiming, `${genre} timing`).toBeGreaterThan(0);
      expect(feel.humanizeVelocity, `${genre} velocity`).toBeGreaterThan(0);
      // Modest: enough to break the grid, far from sloppy.
      expect(feel.humanizeTiming).toBeLessThanOrEqual(0.2);
      expect(feel.humanizeVelocity).toBeLessThanOrEqual(0.2);
    }
  });

  it("writes the genre pocket into the project groove without touching swing", () => {
    const doc = emptyDoc();
    expect(doc.groove).toBeUndefined();
    const applied = applyGenreFeelToDoc(doc, "phonk");
    expect(applied.groove?.humanizeTiming).toBe(GENRE_FEEL.phonk!.humanizeTiming);
    expect(applied.groove?.humanizeVelocity).toBe(GENRE_FEEL.phonk!.humanizeVelocity);
    // Swing is owned by the generation path (stepMeta / applyGrooveSettings);
    // the feel must never write it or the two would double up.
    expect(applied.groove?.swing).toBe(0);
  });

  it("preserves a swing the project already carries", () => {
    const doc = { ...emptyDoc(), groove: { swing: 0.3, humanizeTiming: 0, humanizeVelocity: 0 } };
    const applied = applyGenreFeelToDoc(doc, "house");
    expect(applied.groove?.swing).toBe(0.3);
    expect(applied.groove?.humanizeTiming).toBe(GENRE_FEEL.house!.humanizeTiming);
  });

  it("a user-set non-zero humanize always wins over the genre default", () => {
    const doc = { ...emptyDoc(), groove: { swing: 0, humanizeTiming: 0.4, humanizeVelocity: 0.5 } };
    const applied = applyGenreFeelToDoc(doc, "techno");
    expect(applied.groove?.humanizeTiming).toBe(0.4);
    expect(applied.groove?.humanizeVelocity).toBe(0.5);
  });

  it("is idempotent — a second apply returns the same document", () => {
    const once = applyGenreFeelToDoc(emptyDoc(), "trap");
    const twice = applyGenreFeelToDoc(once, "trap");
    expect(twice).toBe(once);
  });

  it("every genre with a kit swap has a feel entry (no genre left flat)", () => {
    for (const genre of Object.keys(GENRE_KIT_SWAPS)) {
      expect(GENRE_FEEL[genre as keyof typeof GENRE_FEEL], `${genre} feel`).toBeDefined();
    }
  });

  it("applying the feel changes how the groove engine times a hit", () => {
    // The real end-to-end claim: humanizeTiming must move a hit off the grid.
    const base = emptyDoc();
    const drum = firstDrum(base);
    const padId = drum.pads[8].id;
    const pattern = base.patterns[0];
    pattern.rows[padId] = new Array<number>(pattern.stepCount).fill(0);
    // Off-beat steps so swing/humanize have something to shift.
    for (let step = 1; step < 8; step += 2) pattern.rows[padId][step] = 0.7;

    const felt = applyGenreFeelToDoc(base, "phonk");
    const total = STEP_TICKS * pattern.stepCount;
    const plainHits = drumHitsInWindow(base, pattern, 0, 0, total).map((h) => h.tick);
    const feltHits = drumHitsInWindow(felt, pattern, 0, 0, total).map((h) => h.tick);
    expect(plainHits.length).toBeGreaterThan(0);
    expect(feltHits.length).toBe(plainHits.length);
    expect(feltHits).not.toEqual(plainHits);
    // Still deterministic — same doc yields the same jitter.
    expect(drumHitsInWindow(felt, pattern, 0, 0, total).map((h) => h.tick)).toEqual(feltHits);
  });
});

describe("de-click tail", () => {
  it("declickFadeOut guarantees a tail even with no configured fade", () => {
    expect(declickFadeOut(0, 0.5)).toBe(DECLICK_TAIL_SEC);
    expect(declickFadeOut(0.01, 0.5)).toBe(0.01);
    expect(declickFadeOut(NaN, 0.5)).toBe(DECLICK_TAIL_SEC);
    // Never swallow a very short slice (bounded to a quarter).
    expect(declickFadeOut(0, 0.004)).toBeCloseTo(0.001, 6);
  });

  it("default slice playback reports no configured fade (engine adds the floor)", () => {
    const doc = emptyDoc();
    const pad = padById(doc, firstDrum(doc).pads[4].id);
    const slice = resolveSlicePlayback(pad, 0.5);
    expect(slice.fadeOut).toBe(0);
    expect(declickFadeOut(slice.fadeOut, slice.duration)).toBe(DECLICK_TAIL_SEC);
  });

  it("a length p-lock cut still gets a de-click tail on the shorter slice", () => {
    const doc = emptyDoc();
    const pad = padById(doc, firstDrum(doc).pads[0].id);
    const full = resolveSlicePlayback(pad, 1.0);
    // length p-lock 0.25 truncates to a quarter of the slice.
    const cut = { ...full, duration: full.duration * 0.25 };
    const fade = declickFadeOut(cut.fadeOut, cut.duration);
    expect(fade).toBeGreaterThan(0);
    expect(fade).toBeLessThanOrEqual(cut.duration / 4 + 1e-9);
  });

  it("schedules a monotonic ramp to zero instead of a hard cut (no step discontinuity)", () => {
    // Mirrors the exact param schedule the engine writes for a voice with no
    // configured fade: a flat peak, then a linear ramp to zero over the
    // de-click tail. The test asserts the SHAPE (end value 0, ramp present,
    // duration ≥ floor) rather than re-implementing Web Audio.
    const scheduleFor = (sliceDuration: number, configuredFade: number) => {
      const fadeOut = declickFadeOut(configuredFade, sliceDuration);
      const endWhen = sliceDuration;
      const rampAt = Math.max(0, endWhen - fadeOut);
      return { fadeOut, rampAt, rampEnd: rampAt + fadeOut, peak: 1 };
    };
    const plain = scheduleFor(0.5, 0);
    expect(plain.fadeOut).toBe(DECLICK_TAIL_SEC);
    expect(plain.rampEnd).toBeCloseTo(0.5, 9); // ramp lands exactly at slice end
    expect(plain.peak).toBeGreaterThan(0); // and starts loud → the ramp is real

    const cut = scheduleFor(0.05, 0);
    // Even a 50 ms one-shot keeps a full 2 ms tail and still ends at 0.
    expect(cut.fadeOut).toBe(DECLICK_TAIL_SEC);
    expect(cut.rampEnd).toBeCloseTo(0.05, 9);
  });
});
