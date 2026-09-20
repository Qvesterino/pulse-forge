import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { testDoc } from "./fixtures/doc";
import {
  buildTransitionCueClips,
  CUE_ASSET_SECONDS,
  transitionCueAsset,
  FX_CUE_TRACK_NAME,
} from "../src/intent/transition-cues";
import { applyGenreKitToDoc, GENRE_KIT_SWAPS } from "../src/intent/genre-kit";
import { applySongCommand, buildSong, planSongForm } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { parseIntentText } from "../src/intent/text-parser";
import { planMixProfile } from "../src/intent/mix";
import { generatePattern, resolveGroove } from "../src/ai/generator";
import { GROOVE_LIBRARY, getGroovesForGenre } from "../src/ai/grooves";
import { DEFAULT_GENERATE_OPTIONS, GENRES } from "../src/ai/types";
import { FAMILY_REFERENCE } from "../src/presets/preset-loudness.generated";
import { buildPhrasePlan } from "../src/ai/phrase";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * Sound-quality pass (transition cue sounds + drill/phonk genres + genre
 * kit colouring). Behavioral coverage for the T3 wave-2 cue wiring and the
 * genre expansion end to end (parser → groove → generator → song builder →
 * applySongCommand).
 */

function makePattern(id: string, stepCount: number): Pattern {
  return {
    id,
    name: id,
    stepCount,
    rows: {},
    notes: {},
    phrasePlan: buildPhrasePlan(stepCount),
  };
}

type ApplyBuild = Parameters<typeof applySongCommand>[1];

function fakeBuild(genre: "drill" | "phonk" | "house", suffix: string, bpm: number | null): ApplyBuild {
  const sections = [
    {
      role: "intro" as const,
      label: "Intro",
      bars: 4,
      intensity: 0.4,
      transitionIn: null,
      energyDelta: -0.25,
      densityDelta: -0.15,
      complexityDelta: -0.1,
      instrumentation: ["drums" as const],
      pattern: makePattern(`p-intro-${suffix}`, 64),
      stepCount: 64,
      roles: ["drums" as const],
    },
    {
      role: "chorus" as const,
      label: "Hook 1",
      bars: 8,
      intensity: 0.85,
      marker: { type: "impact" as const, name: "HOOK 1" },
      transitionIn: "riser" as const,
      energyDelta: 0.15,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums" as const, "bass" as const],
      pattern: makePattern(`p-hook-${suffix}`, 128),
      stepCount: 128,
      roles: ["drums" as const, "bass" as const],
    },
    {
      role: "chorus" as const,
      label: "Hook 2",
      bars: 8,
      intensity: 0.85,
      marker: { type: "impact" as const, name: "HOOK 2" },
      transitionIn: "drop" as const,
      energyDelta: 0.15,
      densityDelta: 0.1,
      complexityDelta: 0.05,
      instrumentation: ["drums" as const, "bass" as const],
      pattern: makePattern(`p-hook2-${suffix}`, 128),
      stepCount: 128,
      roles: ["drums" as const, "bass" as const],
    },
  ];
  return {
    name: `${genre} test`,
    baseIntent: normalizeIntent({ genre, seed: `sq-${suffix}` }),
    resolvedBpm: bpm,
    key: null,
    sections,
    totalBars: 20,
  };
}

describe("transition cue assets (T3 wave 2)", () => {
  it("maps transition types to cue assets (fill/custom stay drum-only)", () => {
    expect(transitionCueAsset("riser")).toBe("factory.fx.riser");
    expect(transitionCueAsset("impact")).toBe("factory.fx.impact");
    expect(transitionCueAsset("drop")).toBe("factory.fx.impact");
    expect(transitionCueAsset("break")).toBe("factory.fx.sweep");
    expect(transitionCueAsset("fill")).toBeNull();
    expect(transitionCueAsset("custom")).toBeNull();
  });

  it("before-seam cues END at the seam and clamp into the outgoing section", () => {
    // 140 BPM → bar ≈ 1.714 s; a 2 s riser needs ceil(2/1.714) = 2 bars.
    const clips = buildTransitionCueClips(
      [{ id: "t1", type: "riser", seamBar: 16, outgoingStartBar: 8 }],
      140,
      "track-fx",
    );
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ bufferId: "factory.fx.riser", startBar: 14, lengthBars: 2, trackId: "track-fx" });

    // Outgoing section too short for the full asset → clamp, never cross back
    // into the PREVIOUS section.
    const clamped = buildTransitionCueClips(
      [{ id: "t2", type: "riser", seamBar: 16, outgoingStartBar: 15 }],
      140,
      "track-fx",
    );
    expect(clamped[0]).toMatchObject({ startBar: 15, lengthBars: 1 });
  });

  it("drop fires impact + downlifter at the seam; break sweeps under the silence", () => {
    const drop = buildTransitionCueClips(
      [{ id: "d1", type: "drop", seamBar: 20, outgoingStartBar: 12 }],
      140,
      "track-fx",
    );
    expect(drop.map((c) => c.bufferId).sort()).toEqual(["factory.fx.downlifter", "factory.fx.impact"]);
    for (const clip of drop) expect(clip.startBar).toBe(20);

    const brk = buildTransitionCueClips(
      [{ id: "b1", type: "break", seamBar: 20, outgoingStartBar: 12 }],
      140,
      "track-fx",
    );
    expect(brk).toHaveLength(1);
    expect(brk[0].gain).toBeLessThan(1);
  });

  it("cue seconds stay in sync with factory DURATIONS (source-grep pin)", () => {
    const source = readFileSync(resolve(process.cwd(), "src/sample-library/factory.ts"), "utf8");
    for (const [assetId, seconds] of Object.entries(CUE_ASSET_SECONDS)) {
      const match = source.match(new RegExp(`"${assetId.replace(/\./g, "\\.")}":\\s*([0-9.]+)`));
      expect(match, `${assetId} must exist in factory DURATIONS`).not.toBeNull();
      expect(seconds).toBeCloseTo(Number(match![1]), 5);
    }
  });
});

describe("applySongCommand — cue lane + genre kit (one undo step)", () => {
  it("installs cue clips on a dedicated FX track, fills cueAssetId, keeps user clips", () => {
    const doc = testDoc();
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const userClip = {
      id: "user-take",
      trackId: drumTrack.id,
      bufferId: "user.take",
      startBar: 2,
      lengthBars: 2,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 0,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    };
    const withUser: ProjectDocument = {
      ...doc,
      arrangement: { ...doc.arrangement, audioClips: [userClip] },
    };

    const command = applySongCommand(withUser, fakeBuild("house", "a", 140));
    const next = command.execute(testDoc());

    const fxTrack = next.tracks.find((t) => t.name === FX_CUE_TRACK_NAME);
    expect(fxTrack).toBeDefined();
    expect(fxTrack!.kind).toBe("instrument");

    const cueClips = (next.arrangement.audioClips ?? []).filter((c) => c.trackId === fxTrack!.id);
    // riser + (impact + downlifter) = 3 cue clips
    expect(cueClips.map((c) => c.bufferId).sort()).toEqual([
      "factory.fx.downlifter",
      "factory.fx.impact",
      "factory.fx.riser",
    ]);
    // cueAssetId metadata now real
    const transitions = next.arrangement.transitions ?? [];
    expect(transitions.find((t) => t.type === "riser")?.cueAssetId).toBe("factory.fx.riser");
    expect(transitions.find((t) => t.type === "drop")?.cueAssetId).toBe("factory.fx.impact");
    // user clip survives
    expect(next.arrangement.audioClips).toContain(userClip);

    // Undo restores the pre-song document exactly (clips, tracks, kit).
    expect(command.undo(withUser)).toBe(withUser);
  });

  it("re-generating replaces the old cue lane instead of stacking tracks or clips", () => {
    const doc = testDoc();
    const first = applySongCommand(doc, fakeBuild("house", "a", 140)).execute(testDoc());
    const trackCount = first.tracks.length;
    const second = applySongCommand(first, fakeBuild("house", "b", 142)).execute(testDoc());

    // Same lane track — no stacking.
    expect(second.tracks.filter((t) => t.name === FX_CUE_TRACK_NAME)).toHaveLength(1);
    expect(second.tracks).toHaveLength(trackCount);
    // Old cue clips replaced by the new build's (ids carry the transition id,
    // which derives from the new pattern ids).
    const fxTrackId = second.tracks.find((t) => t.name === FX_CUE_TRACK_NAME)!.id;
    const cueIds = (second.arrangement.audioClips ?? []).filter((c) => c.trackId === fxTrackId).map((c) => c.id);
    expect(new Set(cueIds).size).toBe(cueIds.length);
    expect(cueIds.every((id) => id.includes("p-hook2-b") || id.includes("p-hook-b"))).toBe(true);
  });

  it("drill/phonk kit colouring swaps pad assets in the same undo step (idempotent)", () => {
    const drill = applySongCommand(testDoc(), fakeBuild("drill", "a", 140)).execute(testDoc());
    const drillPads = drill.tracks.find((t) => t.kind === "drum")!.pads;
    expect(drillPads[0]).toMatchObject({ assetId: "factory.kick.sub808", name: "Kick 808" });
    expect(drillPads[4].assetId).toBe("factory.snare.trap");

    const phonk = applySongCommand(testDoc(), fakeBuild("phonk", "a", 136)).execute(testDoc());
    const phonkPads = phonk.tracks.find((t) => t.kind === "drum")!.pads;
    expect(phonkPads[0].assetId).toBe("factory.kick.trap");
    expect(phonkPads[15]).toMatchObject({ assetId: "factory.perc.cowbell", name: "Cowbell" });

    // house leaves the default kit alone
    const house = applySongCommand(testDoc(), fakeBuild("house", "a", 124)).execute(testDoc());
    const housePads = house.tracks.find((t) => t.kind === "drum")!.pads;
    expect(housePads[0].assetId).toBe("factory.kick.deep");
    expect(housePads[15].assetId).toBe("factory.perc.blip");

    // Idempotent: applying the drill build to an already-drill doc changes nothing.
    const once = applyGenreKitToDoc(drill, "drill");
    expect(once).toBe(drill);
  });

  it("only swaps roles that keep their generation role under inferPadRole", () => {
    // The cowbell rename must not change the pad's semantic role (pad 15 falls
    // back to "fx" by index either way) — pinned via the swap table shape.
    const swaps = GENRE_KIT_SWAPS.phonk ?? [];
    const cowbell = swaps.find((s) => s.assetId === "factory.perc.cowbell");
    expect(cowbell?.index).toBe(15);
  });
});

describe("drill + phonk genre plumbing", () => {
  it("GENRES includes the new genres; grooves registered with unique ids", () => {
    expect(GENRES).toContain("drill");
    expect(GENRES).toContain("phonk");
    expect(getGroovesForGenre("drill").length).toBeGreaterThanOrEqual(3);
    expect(getGroovesForGenre("phonk").length).toBeGreaterThanOrEqual(3);
    const ids = GROOVE_LIBRARY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolveGroove returns drill grooves for the drill genre", () => {
    const groove = resolveGroove("drill", undefined, () => 0);
    expect(groove.genre).toBe("drill");
  });

  it("song forms exist: drill plan has hooks, phonk plan has hooks", () => {
    const drill = planSongForm(normalizeIntent({ genre: "drill", seed: "sq" }));
    expect(drill.sections.map((s) => s.label)).toContain("Hook 1");
    expect(drill.totalBars).toBeGreaterThan(0);
    const phonk = planSongForm(normalizeIntent({ genre: "phonk", seed: "sq" }));
    expect(phonk.sections.map((s) => s.label)).toContain("Hook 1");
  });

  it("parser detects drill/phonk (EN + memphis alias)", () => {
    expect(parseIntentText("dark drill beat 140").input.genre).toBe("drill");
    expect(parseIntentText("phonk").input.genre).toBe("phonk");
    expect(parseIntentText("memphis type beat").input.genre).toBe("phonk");
    expect(parseIntentText("trap beat").input.genre).toBe("trap");
  });

  it("generator accepts the new genres and produces drum content", () => {
    const doc = testDoc();
    for (const genre of ["drill", "phonk"] as const) {
      const pattern = generatePattern(doc, { ...DEFAULT_GENERATE_OPTIONS, genre, seed: `sq-${genre}`, stepCount: 16 });
      const hits = Object.values(pattern.rows).reduce(
        (sum, row) => sum + row.reduce((s, v) => s + (v > 0 ? 1 : 0), 0),
        0,
      );
      expect(hits).toBeGreaterThan(0);
    }
  });

  it("mix profile gives drill/phonk their genre character by default", () => {
    const drill = planMixProfile(normalizeIntent({ genre: "drill", seed: "sq" }));
    expect(drill.summary).toContain("tone: dark");
    expect(drill.summary.some((s) => s.startsWith("punch:"))).toBe(true);

    const phonk = planMixProfile(normalizeIntent({ genre: "phonk", seed: "sq" }));
    expect(phonk.summary).toContain("tone: warm");

    // house keeps the old hands-off default (no tone decision without mood)
    const house = planMixProfile(normalizeIntent({ genre: "house", seed: "sq" }));
    expect(house.summary.some((s) => s.startsWith("tone:"))).toBe(false);
  });

  it("reference punch: character genres ride the MEASURED drum family, legacy keeps -16", () => {
    const drumsRef = FAMILY_REFERENCE.drums;
    // Measured map sanity: punch and tilt present and physically plausible.
    expect(Number.isFinite(drumsRef.integrated)).toBe(true);
    expect(drumsRef.punchPlrDb).toBeGreaterThan(4);
    expect(drumsRef.punchPlrDb).toBeLessThan(30);
    expect(Number.isFinite(drumsRef.tiltDb)).toBe(true);

    const expected = Math.round(Math.max(-30, Math.min(-6, drumsRef.integrated + drumsRef.punchPlrDb - 3)) * 10) / 10;
    const drill = planMixProfile(normalizeIntent({ genre: "drill", seed: "sq" }));
    const drillComp = drill.decisions.find((d) => d.effectType === "compressor" && d.target === "drums");
    expect(drillComp?.params.threshold).toBe(expected);

    // High-energy house (punch fires) keeps the legacy hand-tuned threshold.
    const house = planMixProfile(normalizeIntent({ genre: "house", seed: "sq", energy: 0.9 }));
    const houseComp = house.decisions.find((d) => d.effectType === "compressor" && d.target === "drums");
    expect(houseComp?.params.threshold).toBe(-16);
  });

  it("buildSong end-to-end: drill song carries cue clips and the swapped kit", async () => {
    const doc = testDoc();
    const build = await buildSong(doc, normalizeIntent({ genre: "drill", seed: "sq-e2e" }));
    const next = applySongCommand(doc, build).execute(testDoc());

    const fxTrack = next.tracks.find((t) => t.name === FX_CUE_TRACK_NAME);
    expect(fxTrack).toBeDefined();
    const cueClips = (next.arrangement.audioClips ?? []).filter((c) => c.trackId === fxTrack!.id);
    expect(cueClips.length).toBeGreaterThanOrEqual(3);
    expect(next.tracks.find((t) => t.kind === "drum")!.pads[0].assetId).toBe("factory.kick.sub808");
  });
});
