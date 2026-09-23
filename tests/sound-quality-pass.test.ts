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
import { applyMixIntent, genreMasterTiltDb, planMixProfile } from "../src/intent/mix";
import {
  GENRE_REFERENCE,
  SONG_LOUDNESS_TARGET_LUFS,
  SONG_LOUDNESS_TRIM_LIMIT_DB,
} from "../src/intent/genre-reference.generated";
import { generatePattern, resolveGroove } from "../src/ai/generator";
import { GROOVE_LIBRARY, getGroovesForGenre } from "../src/ai/grooves";
import { DEFAULT_GENERATE_OPTIONS, GENRES, type GenerateOptions } from "../src/ai/types";
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

function fakeBuild(genre: GenerateOptions["genre"], suffix: string, bpm: number | null): ApplyBuild {
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
  it("maps transition types to cue assets (fill stays drum-only)", () => {
    expect(transitionCueAsset("riser")).toBe("factory.fx.riser");
    expect(transitionCueAsset("impact")).toBe("factory.fx.impact");
    expect(transitionCueAsset("drop")).toBe("factory.fx.impact");
    expect(transitionCueAsset("break")).toBe("factory.fx.sweep");
    expect(transitionCueAsset("custom")).toBe("factory.fx.noise");
    expect(transitionCueAsset("fill")).toBeNull();
  });

  it("impact = reverse-suck swelling INTO the seam + boom ON it; custom = noise accent", () => {
    const impact = buildTransitionCueClips(
      [{ id: "i1", type: "impact", seamBar: 24, outgoingStartBar: 16 }],
      140,
      "track-fx",
    );
    expect(impact).toHaveLength(2);
    const boom = impact.find((c) => c.bufferId === "factory.fx.impact")!;
    const reverse = impact.find((c) => c.bufferId === "factory.fx.reverse")!;
    expect(boom.startBar).toBe(24);
    expect(reverse.startBar + reverse.lengthBars).toBe(24); // ends at the seam
    expect(reverse.gain).toBeLessThan(1);

    const custom = buildTransitionCueClips(
      [{ id: "c1", type: "custom", seamBar: 24, outgoingStartBar: 16 }],
      140,
      "track-fx",
    );
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ bufferId: "factory.fx.noise", startBar: 24, gain: 0.5 });
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
    expect(drillPads[0]).toMatchObject({ assetId: "factory.kick.drill", name: "Kick 808" });
    expect(drillPads[4].assetId).toBe("factory.snare.trap");

    const phonk = applySongCommand(testDoc(), fakeBuild("phonk", "a", 136)).execute(testDoc());
    const phonkPads = phonk.tracks.find((t) => t.kind === "drum")!.pads;
    expect(phonkPads[0].assetId).toBe("factory.kick.phonk");
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
    expect(next.tracks.find((t) => t.kind === "drum")!.pads[0].assetId).toBe("factory.kick.drill");
  });
});

describe("jersey + dnb genre plumbing (wave 2)", () => {
  it("GENRES includes jersey and dnb; grooves registered with unique ids", () => {
    expect(GENRES).toContain("jersey");
    expect(GENRES).toContain("dnb");
    expect(getGroovesForGenre("jersey").length).toBeGreaterThanOrEqual(3);
    expect(getGroovesForGenre("dnb").length).toBeGreaterThanOrEqual(3);
    const ids = GROOVE_LIBRARY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolveGroove returns the right family", () => {
    expect(resolveGroove("jersey", undefined, () => 0).genre).toBe("jersey");
    expect(resolveGroove("dnb", undefined, () => 0).genre).toBe("dnb");
  });

  it("song forms exist: jersey hooks, dnb drops (Drop 2 via the impact pair)", () => {
    const jersey = planSongForm(normalizeIntent({ genre: "jersey", seed: "sq" }));
    expect(jersey.sections.map((s) => s.label)).toContain("Hook 1");
    const dnb = planSongForm(normalizeIntent({ genre: "dnb", seed: "sq" }));
    expect(dnb.sections.map((s) => s.label)).toContain("Drop 1");
    // The impact transition (reverse + boom) is exercised by Drop 2.
    expect(dnb.sections.find((s) => s.label === "Drop 2")?.transitionIn).toBe("impact");
  });

  it("parser detects jersey/dnb (jersey was a house fold; jungle alias)", () => {
    expect(parseIntentText("jersey club beat").input.genre).toBe("jersey");
    expect(parseIntentText("dnb").input.genre).toBe("dnb");
    expect(parseIntentText("drum and bass").input.genre).toBe("dnb");
    expect(parseIntentText("jungle").input.genre).toBe("dnb");
    expect(parseIntentText("house beat").input.genre).toBe("house");
  });

  it("generator accepts jersey/dnb and produces drum content", () => {
    const doc = testDoc();
    for (const genre of ["jersey", "dnb"] as const) {
      const pattern = generatePattern(doc, { ...DEFAULT_GENERATE_OPTIONS, genre, seed: `sq2-${genre}`, stepCount: 16 });
      const hits = Object.values(pattern.rows).reduce(
        (sum, row) => sum + row.reduce((s, v) => s + (v > 0 ? 1 : 0), 0),
        0,
      );
      expect(hits).toBeGreaterThan(0);
    }
  });

  it("mix character: jersey bright + pump, dnb punched without a tone default", () => {
    const jersey = planMixProfile(normalizeIntent({ genre: "jersey", seed: "sq", energy: 0.7 }));
    expect(jersey.summary).toContain("tone: bright");
    expect(jersey.summary.some((s) => s.startsWith("pump:"))).toBe(true);

    const dnb = planMixProfile(normalizeIntent({ genre: "dnb", seed: "sq" }));
    expect(dnb.summary.some((s) => s.startsWith("punch:"))).toBe(true);
    expect(dnb.summary.some((s) => s.startsWith("tone:"))).toBe(false);
  });

  it("kit colouring: jersey punch kit, dnb pedal-hat kit (idempotent, one undo)", () => {
    const jersey = applyGenreKitToDoc(testDoc(), "jersey");
    const jerseyPads = jersey.tracks.find((t) => t.kind === "drum")!.pads;
    expect(jerseyPads[0].assetId).toBe("factory.kick.jersey");
    expect(jerseyPads[4].assetId).toBe("factory.snare.punch");

    const dnb = applyGenreKitToDoc(testDoc(), "dnb");
    const dnbPads = dnb.tracks.find((t) => t.kind === "drum")!.pads;
    expect(dnbPads[0].assetId).toBe("factory.kick.dnb");
    expect(dnbPads[4].assetId).toBe("factory.snare.punch");
    expect(dnbPads[9].assetId).toBe("factory.hat.pedal");

    expect(applyGenreKitToDoc(dnb, "dnb")).toBe(dnb);
  });
});

describe("master tilt EQ consumption (sound-quality wave 3)", () => {
  it("mix profile emits master tilt ONLY for character genres, following the resolved tone", () => {
    expect(planMixProfile(normalizeIntent({ genre: "drill", seed: "sq" })).masterTiltDb).toBe(2); // dark
    expect(planMixProfile(normalizeIntent({ genre: "phonk", seed: "sq" })).masterTiltDb).toBe(1.5); // warm
    expect(planMixProfile(normalizeIntent({ genre: "jersey", seed: "sq" })).masterTiltDb).toBe(-1.5); // bright
    // dnb has no tone default → no tilt unless the user asks for a tone
    expect(planMixProfile(normalizeIntent({ genre: "dnb", seed: "sq" })).masterTiltDb).toBeUndefined();
    expect(planMixProfile(normalizeIntent({ genre: "dnb", seed: "sq", mood: "dark" })).masterTiltDb).toBe(2);

    // Legacy gate: even an explicit mood word never tilts legacy genres'
    // master — their sound is pinned by rule 50.
    expect(planMixProfile(normalizeIntent({ genre: "house", seed: "sq", mood: "dark" })).masterTiltDb).toBeUndefined();

    // An explicit tone override steers a character genre's tilt.
    expect(planMixProfile(normalizeIntent({ genre: "drill", seed: "sq" }), { tone: "bright" }).masterTiltDb).toBe(-1.5);
  });

  it("genreMasterTiltDb agrees with the mix tone defaults", () => {
    expect(genreMasterTiltDb("drill")).toBe(2);
    expect(genreMasterTiltDb("phonk")).toBe(1.5);
    expect(genreMasterTiltDb("jersey")).toBe(-1.5);
    expect(genreMasterTiltDb("dnb")).toBeUndefined();
    for (const legacy of ["house", "techno", "trap", "ambient"] as const) {
      expect(genreMasterTiltDb(legacy)).toBeUndefined();
    }
  });

  it("applyMixIntent writes the tilt into doc.master inside the undoable snapshot", () => {
    const doc = testDoc();
    const profile = planMixProfile(normalizeIntent({ genre: "drill", seed: "sq" }));
    const command = applyMixIntent(doc, profile);
    const next = command.execute(doc);
    expect(next.master.tiltDb).toBe(2);
    expect(command.undo(doc)).toBe(doc);
  });

  it("applySongCommand carries the genre tilt; legacy genres leave it untouched", () => {
    const drill = applySongCommand(testDoc(), fakeBuild("drill", "a", 140)).execute(testDoc());
    expect(drill.master.tiltDb).toBe(2);

    // house song: whatever the user had (even a custom tilt) survives
    const custom = { ...testDoc(), master: { ...testDoc().master, tiltDb: -2.5 } };
    const house = applySongCommand(custom, fakeBuild("house", "a", 124)).execute(custom);
    expect(house.master.tiltDb).toBe(-2.5);
  });

  it("engine source pins: shelf pair wired DC→low→high→glue, clamped ±4 in applyMasterConfig", () => {
    const source = readFileSync(resolve(process.cwd(), "src/audio-engine/AudioEngine.ts"), "utf8");
    expect(source).toMatch(/masterTiltLow\.type = "lowshelf"/);
    expect(source).toMatch(/masterTiltLow\.frequency\.value = 150/);
    expect(source).toMatch(/masterTiltHigh\.type = "highshelf"/);
    expect(source).toMatch(/masterTiltHigh\.frequency\.value = 5000/);
    // Complementary wiring order (tone shapes the glue/limiter detection).
    const wiring = source.indexOf("this.masterDc!.connect(this.masterTiltLow!)");
    const glueIn = source.indexOf("this.masterTiltHigh!.connect(this.masterGlue!.input)");
    expect(wiring).toBeGreaterThan(0);
    expect(glueIn).toBeGreaterThan(wiring);
    // Clamp keeps a bad document from slamming the master.
    expect(source).toMatch(/Math\.min\(4, Math\.max\(-4, config\.tiltDb \?\? 0\)\)/);
  });
});

describe("genre song references — per-genre loudness trim (sound-quality wave 4)", () => {
  it("generated table covers every genre with MEASURED, plausible values", () => {
    for (const genre of GENRES) {
      const ref = GENRE_REFERENCE[genre];
      expect(ref, `${genre} reference missing`).toBeDefined();
      // bars > 0 distinguishes a real measurement run from the placeholder.
      expect(ref.bars, `${genre} reference not measured (placeholder)`).toBeGreaterThan(0);
      expect(ref.integrated).toBeGreaterThan(-35);
      expect(ref.integrated).toBeLessThan(-5);
      expect(Number.isFinite(ref.punchPlrDb)).toBe(true);
      expect(Number.isFinite(ref.tiltDb)).toBe(true);
    }
  });

  it("applySongCommand trims every genre toward the -14 LUFS target (clamped ±6)", () => {
    for (const genre of GENRES) {
      const ref = GENRE_REFERENCE[genre];
      const expected = Math.max(
        -SONG_LOUDNESS_TRIM_LIMIT_DB,
        Math.min(SONG_LOUDNESS_TRIM_LIMIT_DB, Math.round((SONG_LOUDNESS_TARGET_LUFS - ref.integrated) * 10) / 10),
      );
      const next = applySongCommand(testDoc(), fakeBuild(genre, "a", 124)).execute(testDoc());
      expect(next.master.loudnessTrimDb, `${genre} trim`).toBe(expected);
      // Post-trim projected loudness lands on target (within the clamp).
      const projected = Math.round((ref.integrated + (next.master.loudnessTrimDb ?? 0)) * 10) / 10;
      expect(projected).toBeGreaterThanOrEqual(SONG_LOUDNESS_TARGET_LUFS - SONG_LOUDNESS_TRIM_LIMIT_DB);
      expect(projected).toBeLessThanOrEqual(SONG_LOUDNESS_TARGET_LUFS + SONG_LOUDNESS_TRIM_LIMIT_DB);
    }
  });

  it("trim is deterministic and undoable; tilt and trim share the one undo step", async () => {
    const doc = testDoc();
    const build = await buildSong(doc, normalizeIntent({ genre: "drill", seed: "sq-trim" }));
    const command = applySongCommand(doc, build);
    const first = command.execute(doc);
    const second = applySongCommand(first, build).execute(first);
    expect(second.master.loudnessTrimDb).toBe(first.master.loudnessTrimDb);
    expect(command.undo(doc)).toBe(doc);
    // Character genres get BOTH: tilt from the tone map, trim from the reference.
    expect(first.master.tiltDb).toBe(2); // drill dark
    expect(first.master.loudnessTrimDb).toBeDefined();
  });

  it("engine source pin: trim rides multiplicatively on master gain, clamped ±12", () => {
    const source = readFileSync(resolve(process.cwd(), "src/audio-engine/AudioEngine.ts"), "utf8");
    const apply = source.slice(source.indexOf("private applyMasterConfig"), source.indexOf("if (this.masterTiltLow"));
    expect(apply).toContain("const trimRaw = config.loudnessTrimDb");
    expect(apply).toMatch(/typeof trimRaw === "number" && Number\.isFinite\(trimRaw\)/);
    expect(apply).toMatch(/Math\.min\(12, Math\.max\(-12,/);
    // Multiplicative on the clamped input trim, pre-limiter (before tape/M/S).
    expect(apply).toMatch(/gain \* Math\.pow\(10, trim \/ 20\)/);
  });
});
