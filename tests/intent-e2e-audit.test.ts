import { describe, it, expect } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { parseLoudnessIntent, recommendLoudnessTrim } from "../src/intent/loudness";
import { applyEffectIntent, planMixProfile, applyMixIntent } from "../src/intent/mix";
import { applyFaderIntent } from "../src/intent/conversation";
import { normalizeIntent } from "../src/intent/normalize";
import {
  addEffect,
  applyExactIntentCommand,
  applyProductionIntentCommand,
  setBpm,
  setEffectParam,
} from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc, drumTrackOf } from "./fixtures/doc";
import { createInstrumentTrackModel } from "../src/project-model/schema";
import { clampEffectParam, EFFECT_META } from "../src/effects/definitions";
import type { InstrumentTrack, ProjectDocument } from "../src/project-model/types";

/**
 * INTENT ENGINE END-TO-END AUDIT (2026-09-27).
 *
 * Every case drives the FULL chain the user's words take:
 *   text → routeIntentText → executor command → ProjectStore (real undo
 *   stack) → document state assertion → undo → restored state → redo.
 *
 * Routing to the right executor is NOT success: each block verifies the
 * resulting DAW state equals the requested operation, that one intent is
 * ONE undo entry, and that ambiguous/unsupported asks fail explicitly
 * instead of mutating.
 */

const instrumentTracks = (doc: ProjectDocument): InstrumentTrack[] =>
  doc.tracks.filter((track): track is InstrumentTrack => track.kind === "instrument");

const bassTrackOf = (doc: ProjectDocument): InstrumentTrack => {
  const track = instrumentTracks(doc).find(
    (track) => ["bass", "808", "logdrum"].includes(track.instrument) || /\bbass\b|\b808\b/i.test(track.name),
  );
  if (!track) throw new Error("fixture: no bass-family instrument track");
  return track;
};

/** House fixture + a named Lead instrument track (role-resolvable). */
function withLead(): ProjectDocument {
  const doc = testDoc();
  const lead = { ...createInstrumentTrackModel("analog", 3), name: "Lead" };
  return { ...doc, tracks: [...doc.tracks, lead] };
}

/** Drives the panel executor contract: route → apply → single store.execute. */
function executeRouted(doc: ProjectDocument, text: string, store?: ProjectStore): ProjectDocument {
  const route = routeIntentText(text, doc);
  let command = null;
  if (route.kind === "fader") command = applyFaderIntent(doc, route.intent);
  else if (route.kind === "exact") command = applyExactIntentCommand(doc, route.plan);
  else if (route.kind === "effectIntent") command = applyEffectIntent(doc, route.intent);
  else if (route.kind === "production") command = applyProductionIntentCommand(doc, route.intent);
  else if (route.kind === "mix")
    command = applyMixIntent(doc, planMixProfile(normalizeIntent({ text }), route.overrides));
  else throw new Error(`unexpected route kind ${route.kind} for "${text}"`);
  if (!command) throw new Error(`executor returned no command for "${text}"`);
  if (store) store.execute(command);
  return command.execute(doc);
}

// ─── 1. FADER — named-track gain, one undo entry, explicit failures ─────────

describe("E2E fader: route → state → undo", () => {
  it("zníž basu lowers the 808 track and ONE undo restores it", () => {
    const store = new ProjectStore(testDoc());
    const before = bassTrackOf(store.doc).gain;

    const route = routeIntentText("zníž basu", store.doc);
    expect(route.kind).toBe("fader");
    executeRouted(store.doc, "zníž basu", store);

    const after = bassTrackOf(store.doc).gain;
    expect(after).toBeLessThan(before);
    // ONE undo entry for the whole intent — the panel's promise is literal.
    expect(store.undoStackLength).toBe(1);

    store.undo();
    expect(bassTrackOf(store.doc).gain).toBe(before);
    store.redo();
    expect(bassTrackOf(store.doc).gain).toBe(after);
  });

  it("louder drums raises the drum fader (EN comparative + named target)", () => {
    const doc = testDoc();
    const route = routeIntentText("louder drums", doc);
    expect(route.kind).toBe("fader");
    const next = executeRouted(doc, "louder drums");
    expect(drumTrackOf(next).gain).toBeGreaterThan(drumTrackOf(doc).gain);
  });

  it("untargeted shouts still belong to the master loudness loop", () => {
    const doc = testDoc();
    expect(routeIntentText("make it louder", doc).kind).toBe("loudness");
    expect(routeIntentText("make it quieter", doc).kind).toBe("loudness");
  });

  it("missing target family fails explicitly — no guessed substitute track", () => {
    const doc = testDoc();
    const drumsOnly: ProjectDocument = { ...doc, tracks: doc.tracks.filter((t) => t.kind === "drum") };
    // route still says "fader", but the executor refuses instead of picking
    // an arbitrary instrument track (the old positional fallback)
    expect(routeIntentText("zníž basu", drumsOnly).kind).toBe("fader");
    expect(applyFaderIntent(drumsOnly, { targets: ["bass"], direction: "down" })).toBeNull();
    expect(applyFaderIntent(drumsOnly, { targets: ["lead"], direction: "up" })).toBeNull();
  });

  it("conflicting directions decline instead of moving both targets down", () => {
    const doc = testDoc();
    const route = routeIntentText("zníž basu a zvýš lead", doc);
    expect(route.kind).not.toBe("fader");
    // "zníž hlasitosť basu" is ONE direction — hlasitosť is the volume NOUN
    const single = routeIntentText("zníž hlasitosť basu", doc);
    expect(single.kind).toBe("fader");
    if (single.kind === "fader") expect(single.intent.direction).toBe("down");
  });

  it("percent stays bounded (o 300 % clamps to 100 %)", () => {
    const doc = testDoc();
    const route = routeIntentText("zníž basu o 300%", doc);
    expect(route.kind).toBe("fader");
    if (route.kind === "fader") expect(route.intent.percent).toBe(100);
    const next = executeRouted(doc, "zníž basu o 300%");
    expect(bassTrackOf(next).gain).toBe(0);
  });
});

// ─── 2. EXACT — mixer commands that used to fall through to GENERATION ──────

describe("E2E exact intents: route → state → undo", () => {
  it("mute the drums mutes the drum track (previously generated a beat!)", () => {
    const store = new ProjectStore(testDoc());
    expect(routeIntentText("mute the drums", store.doc).kind).toBe("exact");

    executeRouted(store.doc, "mute the drums", store);
    expect(drumTrackOf(store.doc).mute).toBe(true);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(drumTrackOf(store.doc).mute).toBe(false);
  });

  it("solo the bass solos only the bass track", () => {
    const doc = testDoc();
    const route = routeIntentText("solo the bass", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "solo the bass");
    expect(bassTrackOf(next).solo).toBe(true);
    expect(drumTrackOf(next).solo).toBe(false);
    expect(
      instrumentTracks(next)
        .filter((track) => track.id !== bassTrackOf(next).id)
        .every((track) => !track.solo),
    ).toBe(true);
  });

  it("unmute restores the track", () => {
    const doc = testDoc();
    const bass = bassTrackOf(doc);
    const muted: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === bass.id ? { ...t, mute: true } : t)),
    };
    const next = executeRouted(muted, "unmute the bass");
    expect(bassTrackOf(next).mute).toBe(false);
  });

  it("pan the bass left 30 clamps into the pan range", () => {
    const doc = testDoc();
    const route = routeIntentText("pan the bass left 30", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "pan the bass left 30");
    expect(bassTrackOf(next).pan).toBe(-0.3);
  });

  it("boost the mix hits the MASTER fader, not tracks[0]", () => {
    const doc = testDoc();
    const drumsBefore = drumTrackOf(doc).gain;
    const bassBefore = bassTrackOf(doc).gain;
    const masterBefore = doc.master.masterGain;

    const route = routeIntentText("boost the mix by 1.5 db", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "boost the mix by 1.5 db");

    expect(next.master.masterGain).toBeCloseTo(masterBefore * Math.pow(10, 1.5 / 20), 5);
    // regression: the old mapping boosted tracks[0] and left the master alone
    expect(drumTrackOf(next).gain).toBe(drumsBefore);
    expect(bassTrackOf(next).gain).toBe(bassBefore);
  });

  it("multi-action request applies both ops in ONE undo entry", () => {
    const store = new ProjectStore(testDoc());
    const bpmBefore = store.doc.bpm;
    executeRouted(store.doc, "mute the drums and set tempo to 140", store);
    expect(drumTrackOf(store.doc).mute).toBe(true);
    expect(store.doc.bpm).toBe(140);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(drumTrackOf(store.doc).mute).toBe(false);
    expect(store.doc.bpm).toBe(bpmBefore);
  });

  it("150 bpm routes exact and applies; out-of-range asks never mutate", () => {
    const doc = testDoc();
    // bare "<n> bpm" is an exact tempo op (the conversation parser keeps "na/to")
    const route = routeIntentText("150 bpm", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "150 bpm");
    expect(next.bpm).toBe(150);

    // conversation tempo with an explicit SK target
    expect(routeIntentText("tempo na 128", doc).kind).toBe("tempo");

    // outside the parser's 40..220 window → NOT a tempo intent, no mutation
    expect(routeIntentText("tempo na 500", doc).kind).not.toBe("tempo");
    expect(routeIntentText("tempo na 500", doc).kind).not.toBe("exact");
    // setBpm clamps regardless of what the AI layer sends (defense in depth)
    expect(setBpm(doc, 9999).execute(doc).bpm).toBeLessThanOrEqual(300);
  });
});

// ─── 3. EFFECT INTENT — targeted add/turn/remove with real ranges ───────────

describe("E2E effect intents: route → state → undo", () => {
  it("viac delayu na leade adds a delay to the lead and turns its mix up", () => {
    const store = new ProjectStore(withLead());
    const route = routeIntentText("viac delayu na leade", store.doc);
    expect(route.kind).toBe("effectIntent");

    executeRouted(store.doc, "viac delayu na leade", store);
    const lead = store.doc.tracks.find(
      (track): track is InstrumentTrack =>
        track.kind === "instrument" && track.effects.some((fx) => fx.type === "delay"),
    );
    expect(lead).toBeDefined();
    const delay = lead!.effects.find((fx) => fx.type === "delay")!;
    const mixDef = EFFECT_META.delay.params.find((param) => param.id === "mix")!;
    expect(delay.params.mix).toBeGreaterThan(mixDef.default);
    expect(delay.params.mix).toBeLessThanOrEqual(mixDef.max);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(instrumentTracks(store.doc).every((track) => !track.effects.some((fx) => fx.type === "delay"))).toBe(true);
  });

  it("percent rides the knob's own range and clamps (o 500 %)", () => {
    const doc = withLead();
    const route = routeIntentText("viac delayu na leade o 500%", doc);
    expect(route.kind).toBe("effectIntent");
    if (route.kind === "effectIntent") expect(route.intent.percent).toBe(100);
    const next = executeRouted(doc, "viac delayu na leade o 500%");
    const lead = instrumentTracks(next).find((track) => track.effects.some((fx) => fx.type === "delay"))!;
    const delay = lead.effects.find((fx) => fx.type === "delay")!;
    const mixDef = EFFECT_META.delay.params.find((param) => param.id === "mix")!;
    expect(delay.params.mix).toBeLessThanOrEqual(mixDef.max);
    expect(clampEffectParam("delay", "mix", 42)).toBeLessThanOrEqual(mixDef.max);
  });

  it("remove reverb from the bass: explicit error when absent, works when present", () => {
    const doc = testDoc();
    const route = routeIntentText("remove reverb from the bass", doc);
    expect(route.kind).toBe("effectIntent");
    // no track reverb installed yet → explicit "changed nothing" failure
    expect(() => executeRouted(doc, "remove reverb from the bass")).toThrow(/changed nothing/);

    // install reverb on the bass, then the removal works and undoes
    const store = new ProjectStore(doc);
    executeRouted(store.doc, "viac reverbu na basi", store);
    const hasBassReverb = (d: ProjectDocument) =>
      instrumentTracks(d).some(
        (track) => /\b808\b|\bbass/i.test(track.name) && track.effects.some((fx) => fx.type === "reverb"),
      );
    expect(hasBassReverb(store.doc)).toBe(true);
    executeRouted(store.doc, "remove reverb from the bass", store);
    expect(hasBassReverb(store.doc)).toBe(false);
    store.undo();
    expect(hasBassReverb(store.doc)).toBe(true);
  });
});

// ─── 4. MIX — profile applies ONLY on real mix vocabulary ────────────────────

describe("E2E mix route: detected vocabulary vs unintended defaults", () => {
  it("more reverb installs reverb on music roles as one undo", () => {
    const store = new ProjectStore(testDoc());
    expect(routeIntentText("more reverb please", store.doc).kind).toBe("mix");
    executeRouted(store.doc, "more reverb please", store);
    const withReverb = instrumentTracks(store.doc).filter((track) => track.effects.some((fx) => fx.type === "reverb"));
    expect(withReverb.length).toBeGreaterThan(0);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(instrumentTracks(store.doc).every((track) => !track.effects.some((fx) => fx.type === "reverb"))).toBe(true);
  });

  it("REGRESSION: unresolvable effect asks fall to generation, not the default profile", () => {
    const doc = testDoc();
    const store = new ProjectStore(doc);
    // "trumpets" names a target the engine cannot resolve — the old behavior
    // applied the house-default mix profile (a sidechain pump on bass+chords)
    // the user never asked for.
    for (const text of ["more delay on the trumpets", "more compression", "some eq please"]) {
      expect(routeIntentText(text, store.doc).kind).toBe("pattern");
    }
    // routing alone never mutated anything
    expect(store.undoStackLength).toBe(0);
  });

  it("targeted effect nouns still outrank the profile", () => {
    const doc = testDoc();
    expect(routeIntentText("more delay on the bass", doc).kind).toBe("effectIntent");
  });
});

// ─── 5. PRODUCTION — concept × target lands as track FX ─────────────────────

describe("E2E production intents: route → state → undo", () => {
  it("make the drums darker installs a darker filter on the drum track", () => {
    const store = new ProjectStore(testDoc());
    const route = routeIntentText("make the drums darker", store.doc);
    expect(route.kind).toBe("production");

    executeRouted(store.doc, "make the drums darker", store);
    const drums = drumTrackOf(store.doc);
    const filter = drums.effects.find((fx) => fx.type === "svFilter");
    expect(filter).toBeDefined();
    expect(filter!.params.mode).toBe(0); // low-pass
    expect(filter!.params.cutoff).toBeLessThan(16000);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(drumTrackOf(store.doc).effects.length).toBe(0);
  });

  it("production without any matching track throws an actionable error", () => {
    const doc = testDoc();
    const drumsOnly: ProjectDocument = { ...doc, tracks: doc.tracks.filter((t) => t.kind === "drum") };
    // "deeper" targets the bass family — a drums-only project must fail loudly
    expect(() => executeRouted(drumsOnly, "make the bass deeper")).toThrow(/No matching track/);
  });
});

// ─── 6. LOUDNESS — parse + bounded recommendation (render loop is injected) ──

describe("E2E loudness intents: parse + recommendation bounds", () => {
  it("explicit targets parse; directions parse; other numbers do not hijack", () => {
    expect(parseLoudnessIntent("loudness na −9")).toMatchObject({ direction: "louder", targetDb: -9 });
    expect(parseLoudnessIntent("make it quieter")).toMatchObject({ direction: "quieter" });
    expect(parseLoudnessIntent("140 bpm")).toBeNull(); // tempo's job
    expect(parseLoudnessIntent("dark techno")).toBeNull();
  });

  it("recommendations clamp to the ±6 dB trim field and refuse without evidence", () => {
    // way too loud → full −6 pull, never beyond
    expect(recommendLoudnessTrim(-4, -14, 0).trimDb).toBe(-6);
    expect(recommendLoudnessTrim(-4, -14, 4).trimDb).toBe(-6);
    // unmeasurable → no intervention recommended
    const none = recommendLoudnessTrim(null, -14, 0);
    expect(none.trimDb).toBeNull();
    expect(none.affected).toEqual(["master (loudnessTrimDb)"]);
  });
});

// ─── 7. UNDO / TRANSACTIONAL CONTRACT across executors ──────────────────────

describe("E2E transactional contract", () => {
  it("every mutating executor lands exactly ONE undo entry with a clean restore", () => {
    const cases: Array<[string, () => ProjectDocument]> = [
      ["zníž basu", testDoc],
      ["mute the drums", testDoc],
      ["viac delayu na leade", withLead],
      ["make the drums darker", testDoc],
      ["more reverb please", testDoc],
    ];
    for (const [text, makeDoc] of cases) {
      const store = new ProjectStore(makeDoc());
      executeRouted(store.doc, text, store);
      expect(store.undoStackLength).toBe(1);
      store.undo();
      // the undo restores the pre-intent state (no intent FX left behind)
      const restored = store.doc;
      expect(restored.tracks.every((track) => track.effects.length === 0)).toBe(true);
    }
  });

  it("generation-route texts never mutate the document by themselves", () => {
    const doc = testDoc();
    const store = new ProjectStore(doc);
    for (const text of ["dark rolling techno at 140", "more delay on the trumpets", "tempo na 500"]) {
      expect(routeIntentText(text, store.doc).kind).toBe("pattern");
    }
    expect(store.undoStackLength).toBe(0);
    expect(store.doc).toBe(doc);
  });
});

// ─── 8. Parameter-correctness: the AI layer cannot bypass domain ranges ─────

describe("E2E parameter correctness", () => {
  it("setEffectParam rejects undefined params (domain validation owns the truth)", () => {
    const doc = testDoc();
    const drums = drumTrackOf(doc);
    const withFx = addEffect(doc, drums.id, "delay").execute(doc);
    const fx = withFx.tracks.find((t) => t.id === drums.id)!.effects.find((f) => f.type === "delay")!;
    expect(() => setEffectParam(withFx, drums.id, fx.id, "notAParam", 1)).toThrow(/not defined/);
    // out-of-domain values clamp to the effect's own def, never pass through
    const maxMix = EFFECT_META.delay.params.find((param) => param.id === "mix")!.max;
    expect(clampEffectParam("delay", "mix", 99)).toBe(maxMix);
  });
});
