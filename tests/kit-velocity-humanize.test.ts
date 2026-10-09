import { describe, expect, it } from "vitest";
import { KIT_PRESETS } from "../src/project-model/kit-presets";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { RR_VARIATIONS } from "../src/sample-library/factory";
import {
  FACTORY_BONGOS_RR,
  FACTORY_CONGA_HIGH_RR,
  FACTORY_SHAKER_FAST_RR,
  FACTORY_SHAKER_SOFT_RR,
  FACTORY_TIMBALE_RR,
} from "../src/sample-library/velocity-layers";
import { resolveKitAssignments } from "../src/sample-library/kit-pools";
import { applyGenreKitToDoc } from "../src/intent/genre-kit";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { DrumPad, DrumTrack, ProjectDocument, SampleLayer } from "../src/project-model/types";

/**
 * KIT HUMANIZE (2026-10-09) — the drum-side completion of the velocity-layers
 * wave. The new kits (Latin/Jazz/Rock) and the latin genre swap carried
 * voices but no variant sets, so generated beats machine-gunned the exact
 * voices that exist to sound played; worse, the kit-swap paths kept STALE
 * layers under a swapped asset (a pad re-voiced by a genre change kept
 * playing the previous kit's samples through its old round-robin pool).
 *
 * Locked here: the latin RR pools derive from real bank bases, every kit pad
 * layer set resolves in the bank AND covers its own pad asset (a set that
 * drops the pad's voice would change its sound), the dice assignment emits
 * the sets and clears on uncovered swaps, and the genre path can never again
 * leave stale layers under a re-voiced pad.
 */

/** A bank id is either a manifest asset or a derived RR variant. */
function exists(id: string | null | undefined): boolean {
  if (!id) return false;
  if (FACTORY_ASSETS.some((a) => a.id === id)) return true;
  const base = id.replace(/\.rr\d+$/, "");
  return base !== id && RR_VARIATIONS[base] !== undefined;
}

describe("latin percussion RR pools", () => {
  it("declares real manifest bases (bank can derive the variants)", () => {
    for (const base of [
      "factory.shaker.soft",
      "factory.shaker.fast",
      "factory.perc.bongos",
      "factory.perc.conga.high",
      "factory.perc.timbale",
    ]) {
      expect(
        FACTORY_ASSETS.some((a) => a.id === base),
        `${base} in manifest`,
      ).toBe(true);
      expect(RR_VARIATIONS[base], `${base} RR entry`).toBeDefined();
      for (const v of RR_VARIATIONS[base]) {
        expect(v.rate).toBeGreaterThan(0.95);
        expect(v.rate).toBeLessThan(1.05);
        expect(v.gain).toBeGreaterThan(0.9);
        expect(v.gain).toBeLessThan(1.1);
      }
    }
  });

  it("exports full-window round-robin sets whose members all resolve", () => {
    for (const set of [
      FACTORY_SHAKER_SOFT_RR,
      FACTORY_SHAKER_FAST_RR,
      FACTORY_BONGOS_RR,
      FACTORY_CONGA_HIGH_RR,
      FACTORY_TIMBALE_RR,
    ]) {
      expect(set).toHaveLength(3);
      for (const layer of set as SampleLayer[]) {
        expect(layer.min).toBe(0);
        expect(layer.max).toBe(1);
        expect(exists(layer.sampleId), `${layer.sampleId} resolves`).toBe(true);
      }
    }
  });
});

describe("kit pad layer sets", () => {
  it("every kit pad set resolves in the bank and covers its own pad asset", () => {
    for (const kit of KIT_PRESETS) {
      for (const pad of kit.pads) {
        if (!pad.layers) continue;
        expect(pad.layers.length, `${kit.id} pad ${pad.idx} set`).toBeGreaterThan(0);
        for (const layer of pad.layers) {
          expect(exists(layer.sampleId), `${kit.id} pad ${pad.idx} → ${layer.sampleId}`).toBe(true);
        }
        expect(
          pad.layers.some((l) => l.sampleId === pad.assetId),
          `${kit.id} pad ${pad.idx}: set must cover its own voice (${pad.assetId})`,
        ).toBe(true);
      }
    }
  });

  it("the three new kits carry their humanize sets on the repetition-critical pads", () => {
    const padsOf = (id: string) => KIT_PRESETS.find((k) => k.id === id)!.pads;
    // Latin: timbale backbeat, bongos martillo, conga quinto, güira shaker.
    for (const idx of [4, 6, 7, 8]) {
      expect(padsOf("latin-perc")[idx].layers, `latin pad ${idx}`).toBeDefined();
    }
    // Jazz: the snare dynamic set + the comping hat.
    for (const idx of [5, 7, 8]) {
      expect(padsOf("jazz-kit")[idx].layers, `jazz pad ${idx}`).toBeDefined();
    }
    // Rock: the kick churn, the cracking backbeat, the 8th-note hat.
    for (const idx of [0, 4, 8]) {
      expect(padsOf("rock-kit")[idx].layers, `rock pad ${idx}`).toBeDefined();
    }
  });
});

describe("resolveKitAssignments — layers flow", () => {
  /** 16 stock-shaped pads with NO assets: every preset asset counts as a swap. */
  function pads(): DrumPad[] {
    return Array.from({ length: 16 }, (_, idx) => ({
      id: `pad-${idx}`,
      name: `Pad ${idx}`,
      assetId: null,
      synth: null,
      gain: 1,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      chokeGroup: null,
    })) as unknown as DrumPad[];
  }

  const locks = {
    drums: false,
    bass: false,
    chords: false,
    lead: false,
    kick: false,
    snare: false,
    hats: false,
    kit: false,
    fx: false,
  };

  function latinAssignment(): Map<string, Partial<DrumPad>> {
    // Deterministic search: jitter=1 adds a 20 %-per-pad ±1 sample variation,
    // so find a seed where the asserted pads kept their preset assets.
    for (let i = 0; i < 200; i++) {
      const map = resolveKitAssignments(pads(), `humanize-${i}`, locks, 1, { kitId: "latin-perc" });
      if (map.size === 0) continue;
      const bongos = map.get("pad-6");
      const shaker = map.get("pad-8");
      const clap = map.get("pad-5");
      if (
        bongos?.assetId === "factory.perc.bongos" &&
        shaker?.assetId === "factory.shaker.fast" &&
        clap?.assetId === "factory.clap.soft"
      ) {
        return map;
      }
    }
    throw new Error("no seed produced the unjittered latin assignment");
  }

  it("preset pads emit their covering set; uncovered swaps clear to []", () => {
    const map = latinAssignment();
    // Bongos pad arrives with its martillo pool attached.
    const bongos = map.get("pad-6");
    expect(bongos?.assetId).toBe("factory.perc.bongos");
    expect(bongos?.layers?.some((l) => l.sampleId === "factory.perc.bongos")).toBe(true);
    // Shaker pad: its set rides too.
    const shaker = map.get("pad-8");
    expect(shaker?.assetId).toBe("factory.shaker.fast");
    expect(shaker?.layers?.some((l) => l.sampleId === "factory.shaker.fast")).toBe(true);
    // A swapped pad whose preset slot has NO set clears its layers explicitly.
    const clap = map.get("pad-5");
    expect(clap?.assetId).toBe("factory.clap.soft");
    expect(clap?.layers).toEqual([]);
    // Global invariant: any emitted non-empty set covers the emitted asset.
    for (const [, patch] of map) {
      if (patch.layers && patch.layers.length > 0) {
        expect(patch.layers.some((l) => l.sampleId === patch.assetId)).toBe(true);
      }
    }
  });
});

describe("genre kit path — stale-layer hygiene", () => {
  function drumDoc(): { doc: ProjectDocument; drum: DrumTrack } {
    const doc = createProjectFromTemplate("empty");
    const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    return { doc, drum };
  }

  it("regression: a layerless genre swap clears the pad's old variant set", () => {
    const { doc, drum } = drumDoc();
    // Simulate a previous generation: pad 3 carries a perc voice with a stale
    // RR pool (index 3 is NOT a DEFAULT_BEAT_RR index — no default set saved it).
    const stale = [
      { id: "l0", sampleId: "factory.snare.room", min: 0, max: 1 },
      { id: "l1", sampleId: "factory.snare.room.rr2", min: 0, max: 1 },
      { id: "l2", sampleId: "factory.snare.room.rr3", min: 0, max: 1 },
    ];
    const seeded: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === drum.id && t.kind === "drum"
          ? {
              ...t,
              pads: t.pads.map((p, i) => (i === 3 ? { ...p, assetId: "factory.perc.shaker.pop", layers: stale } : p)),
            }
          : t,
      ),
    };
    // hyperpop swaps pad 3 → rim.chip with NO set of its own.
    const next = applyGenreKitToDoc(seeded, "hyperpop");
    const nextDrum = next.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    expect(nextDrum.pads[3].assetId).toBe("factory.rim.chip");
    expect(nextDrum.pads[3].layers).toBeUndefined();
  });

  it("a default-set index replaces stale layers with the covering dynamic set", () => {
    const { doc, drum } = drumDoc();
    // Pad 4 IS a DEFAULT_BEAT_RR index: the stale room pool must not survive,
    // but the snare dynamic set (whose members include the swapped voice)
    // legitimately rides the pad.
    const stale = [{ id: "l0", sampleId: "factory.snare.room", min: 0, max: 1 }];
    const seeded: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === drum.id && t.kind === "drum"
          ? { ...t, pads: t.pads.map((p, i) => (i === 4 ? { ...p, layers: stale } : p)) }
          : t,
      ),
    };
    const next = applyGenreKitToDoc(seeded, "hyperpop");
    const nextDrum = next.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    expect(nextDrum.pads[4].assetId).toBe("factory.snare.tight");
    const layers = nextDrum.pads[4].layers ?? [];
    expect(layers.length).toBeGreaterThan(1);
    expect(layers.some((l) => l.sampleId === "factory.snare.room")).toBe(false);
    expect(layers.some((l) => l.sampleId === "factory.snare.tight")).toBe(true);
  });

  it("latin generation lands the world-perc voices WITH their pools", () => {
    const { doc } = drumDoc();
    const next = applyGenreKitToDoc(doc, "latin");
    const nextDrum = next.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const quinto = nextDrum.pads[12];
    expect(quinto.assetId).toBe("factory.perc.conga.high");
    expect(quinto.layers?.some((l) => l.sampleId === "factory.perc.conga.high")).toBe(true);
    const bongos = nextDrum.pads[13];
    expect(bongos.assetId).toBe("factory.perc.bongos");
    expect(bongos.layers?.some((l) => l.sampleId === "factory.perc.bongos")).toBe(true);
    const guira = nextDrum.pads[7];
    expect(guira.assetId).toBe("factory.shaker.soft");
    expect(guira.layers?.some((l) => l.sampleId === "factory.shaker.soft")).toBe(true);
    // Idempotent: re-applying leaves the same references.
    expect(applyGenreKitToDoc(next, "latin")).toBe(next);
  });
});
